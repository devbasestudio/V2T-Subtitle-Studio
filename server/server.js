import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const uploadDir = path.join(__dirname, 'uploads');
const workDir = path.join(__dirname, 'work');
const port = Number(process.env.PORT || 4000);
const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const maxDurationSeconds = 60 * 60;
const chunkDurationSeconds = 60;
const MAX_RETRIES = 5;
const INTER_CHUNK_DELAY_MS = 3500; // ~17 req/min per key, stays under 20/min free tier

/* Support multiple API keys (comma-separated in .env) for round-robin rotation */
const apiKeys = (process.env.GEMINI_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);
let keyIndex = 0;

const getNextAiClient = () => {
  if (!apiKeys.length) throw new Error('GEMINI_API_KEY is missing in .env.');
  const key = apiKeys[keyIndex % apiKeys.length];
  keyIndex += 1;
  return new GoogleGenAI({ apiKey: key });
};

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(workDir, { recursive: true });

const app = express();
const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 1024 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/media', express.static(uploadDir));
app.use(express.static(path.join(rootDir, 'dist')));

const runFfmpeg = (configure) =>
  new Promise((resolve, reject) => {
    const command = configure(ffmpeg());
    command.on('end', resolve).on('error', reject).run();
  });

const getDuration = (filePath) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Number(metadata.format.duration || 0));
    });
  });

const secondsToSrtTime = (seconds) => {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = Math.floor(safeSeconds % 60);
  const millis = Math.round((safeSeconds - Math.floor(safeSeconds)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
};

const parseSrtTime = (time) => {
  const match = time.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) return 0;
  const [, hours, minutes, seconds, millis] = match.map(Number);
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
};

const extractSrtBlocks = (text) => {
  const cleaned = text
    .replace(/```(?:srt)?/gi, '')
    .replace(/```/g, '')
    .replace(/\r/g, '')
    .trim();

  const blocks = cleaned
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(block));

  return blocks.map((block) => {
    const lines = block.split('\n').filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    return {
      timing: lines[timingIndex],
      text: lines.slice(timingIndex + 1).join('\n').trim()
    };
  });
};

const offsetSrtBlocks = (rawSrt, offsetSeconds, startingIndex) => {
  const blocks = extractSrtBlocks(rawSrt);
  let cursor = startingIndex;

  const shifted = blocks.map((block) => {
    const [startRaw, endRaw] = block.timing.split('-->').map((part) => part.trim());
    const start = secondsToSrtTime(parseSrtTime(startRaw) + offsetSeconds);
    const end = secondsToSrtTime(parseSrtTime(endRaw) + offsetSeconds);
    const output = `${cursor}\n${start} --> ${end}\n${block.text}`;
    cursor += 1;
    return output;
  });

  return { text: shifted.join('\n\n'), nextIndex: cursor };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Transcribe a single audio chunk using inline base64 data
 * instead of the Files API (avoids location-restricted upload endpoint).
 */
const transcribeChunk = async ({ chunkPath, chunkNumber, totalChunks, language }) => {
  const audioBuffer = await fs.readFile(chunkPath);
  const base64Audio = audioBuffer.toString('base64');

  const langInstruction = !language || language === 'auto'
    ? 'Preserve the original spoken language exactly as spoken. Do not translate.'
    : `Output the subtitles in ${language}. If the spoken language differs, translate to ${language}.`;

  const prompt = `
You are creating subtitles for a video editor.
Transcribe every spoken word in this one-minute audio segment as accurately as possible.
${langInstruction}

CRITICAL RULES TO PREVENT HALLUCINATION:
1. If there is NO speech, or only background noise, static, or music, DO NOT output any subtitles. You must return absolutely nothing.
2. DO NOT invent, guess, or hallucinate text. NEVER add random commentary, conversational fillers, or political statements that are not explicitly spoken in the audio.
3. Transcribe ONLY what is clearly spoken by humans.

Return only valid SubRip (.srt) content. Do not wrap it in Markdown.
Start timestamps at 00:00:00,000 for this segment.
Use short subtitle cues that are natural for on-screen subtitles.
Segment ${chunkNumber} of ${totalChunks}.
`.trim();

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ai = getNextAiClient();
      const currentKey = ((keyIndex - 1) % apiKeys.length) + 1;
      console.log(`[Chunk ${chunkNumber}/${totalChunks}] Attempt ${attempt} (using key ${currentKey}/${apiKeys.length})`);

      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/mpeg',
                  data: base64Audio
                }
              },
              { text: prompt }
            ]
          }
        ]
      });

      return response.text || '';
    } catch (error) {
      lastError = error;
      const msg = error.message || '';
      const statusMatch = msg.match(/429|QUOTA|RESOURCE_EXHAUSTED/i);
      console.error(`[Chunk ${chunkNumber}] Error:`, statusMatch ? 'Rate limit / Quota exceeded' : msg);

      /* If we have multiple keys, we can just swap to the next key and retry quickly */
      let delay = 1500;
      const retryMatch = msg.match(/retry in ([\d.]+)s/i);

      if (retryMatch && apiKeys.length === 1) {
        // If we ONLY have 1 key, we MUST wait the full penalty time
        delay = Math.ceil(parseFloat(retryMatch[1]) * 1000) + 500;
        console.log(`Rate limited — waiting ${(delay / 1000).toFixed(1)}s before retry...`);
      } else if (attempt < MAX_RETRIES) {
        console.log(`Swapping API key... retrying in ${(delay / 1000).toFixed(1)}s`);
      }

      if (attempt < MAX_RETRIES) {
        await sleep(delay);
      }
    }
  }
  throw lastError;
};

const normalizeError = (error) => {
  const rawMessage = error?.message || 'Transcription failed.';
  try {
    const parsed = JSON.parse(rawMessage);
    const message = parsed?.error?.message;
    if (message) return message;
  } catch {
    // SDK errors are sometimes JSON strings and sometimes plain text.
  }
  return rawMessage;
};

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, model });
});

app.post('/api/burn', async (request, response) => {
  const { fileName, srt } = request.body;
  if (!fileName || !srt) return response.status(400).json({ error: 'Missing fileName or srt' });

  const safeFileName = path.basename(fileName);
  const originalPath = path.join(uploadDir, safeFileName);
  if (!existsSync(originalPath)) return response.status(404).json({ error: 'Original media not found on server. Please re-upload.' });

  const isVideo = ['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(path.extname(safeFileName).toLowerCase());
  if (!isVideo) return response.status(400).json({ error: 'Only video files can have burned subtitles.' });

  const jobId = `burn-${Date.now()}`;
  const jobDir = path.join(workDir, jobId);
  
  try {
    await fs.mkdir(jobDir, { recursive: true });
    const srtPath = path.join(jobDir, 'subs.srt');
    await fs.writeFile(srtPath, srt, 'utf8');

    const outExt = '.mp4'; // Output as MP4 for best web compatibility
    const outName = `${path.parse(safeFileName).name}_burned${outExt}`;
    const outPath = path.join(uploadDir, outName);

    console.log(`[${jobId}] Burning subtitles into ${safeFileName}...`);
    // Escape path for ffmpeg subtitles filter (replace \ with / and escape colons/quotes)
    const escapedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\\\:').replace(/'/g, "\\\\'");

    await runFfmpeg((command) =>
      command
        .input(originalPath)
        .videoFilters(`subtitles='${escapedSrtPath}'`)
        .outputOptions([
          '-c:v libx264',
          '-preset ultrafast', // Fast encoding so user doesn't wait forever
          '-crf 28',           // Reasonable quality
          '-c:a copy'          // Copy audio directly
        ])
        .output(outPath)
    );

    console.log(`[${jobId}] Burn complete: ${outName}`);
    response.json({ burnedUrl: `/media/${outName}` });
  } catch (error) {
    console.error(`[${jobId}] Burn error:`, error);
    response.status(500).json({ error: error.message || 'Failed to burn subtitles' });
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.post('/api/transcribe', upload.single('media'), async (request, response) => {
  const uploadedFile = request.file;
  const language = request.body?.language || 'auto';
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const jobDir = path.join(workDir, jobId);

  try {
    if (!apiKeys.length) {
      response.status(500).json({ error: 'GEMINI_API_KEY is missing in .env.' });
      return;
    }

    if (!uploadedFile) {
      response.status(400).json({ error: 'Please upload a video or audio file.' });
      return;
    }

    await fs.mkdir(jobDir, { recursive: true });

    const originalName = uploadedFile.originalname || 'media';
    const originalExt = path.extname(originalName) || '';
    const savedOriginal = path.join(uploadDir, `${jobId}${originalExt}`);
    await fs.rename(uploadedFile.path, savedOriginal);

    const duration = await getDuration(savedOriginal);
    if (!duration || Number.isNaN(duration)) {
      response.status(400).json({ error: 'Could not read media duration.' });
      return;
    }

    if (duration > maxDurationSeconds) {
      response.status(400).json({ error: 'Please upload media that is 1 hour or shorter.' });
      return;
    }

    /* Step 1: Extract and optimize audio to mono 16kHz MP3 */
    console.log(`[${jobId}] Extracting audio from ${originalName} (${Math.round(duration)}s)`);
    const optimizedAudio = path.join(jobDir, 'optimized.mp3');
    await runFfmpeg((command) =>
      command
        .input(savedOriginal)
        .noVideo()
        .audioChannels(1)
        .audioFrequency(16000)
        .audioBitrate('32k')
        .format('mp3')
        .output(optimizedAudio)
    );

    /* Step 2: Split into 1-minute chunks */
    const totalChunks = Math.ceil(duration / chunkDurationSeconds);
    const chunkPaths = [];

    console.log(`[${jobId}] Splitting into ${totalChunks} chunk(s)`);
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkDurationSeconds;
      const remaining = Math.max(0.1, Math.min(chunkDurationSeconds, duration - start));
      const chunkPath = path.join(jobDir, `chunk-${String(index + 1).padStart(2, '0')}.mp3`);
      await runFfmpeg((command) =>
        command
          .input(optimizedAudio)
          .seekInput(start)
          .duration(remaining)
          .audioChannels(1)
          .audioFrequency(16000)
          .audioBitrate('32k')
          .format('mp3')
          .output(chunkPath)
      );
      chunkPaths.push(chunkPath);
    }

    /* Step 3: Transcribe all chunks with Gemini (round-robin keys + rate-limit delay) */
    const rawChunks = [];
    let finalSrt = '';
    let nextIndex = 1;

    console.log(`[${jobId}] Sending ${totalChunks} chunk(s) to ${model} using ${apiKeys.length} API key(s) (lang: ${language})`);
    for (let index = 0; index < chunkPaths.length; index += 1) {
      /* Delay between chunks to avoid rate-limit bursts */
      if (index > 0) {
        await sleep(INTER_CHUNK_DELAY_MS);
      }

      const raw = await transcribeChunk({
        chunkPath: chunkPaths[index],
        chunkNumber: index + 1,
        totalChunks,
        language
      });
      rawChunks.push(raw);
      const shifted = offsetSrtBlocks(raw, index * chunkDurationSeconds, nextIndex);
      nextIndex = shifted.nextIndex;
      finalSrt += `${finalSrt ? '\n\n' : ''}${shifted.text}`;
    }

    const optimizedStats = await fs.stat(optimizedAudio);
    const mediaUrl = `/media/${path.basename(savedOriginal)}`;

    console.log(`[${jobId}] Done — ${nextIndex - 1} subtitle cues generated`);

    response.json({
      fileName: originalName,
      mediaType: uploadedFile.mimetype,
      mediaUrl,
      duration,
      chunkCount: totalChunks,
      optimizedAudioBytes: optimizedStats.size,
      model,
      srt: finalSrt.trim(),
      rawChunks
    });
  } catch (error) {
    console.error(`[${jobId}] Error:`, error);
    response.status(500).json({
      error: normalizeError(error)
    });
  } finally {
    if (uploadedFile?.path && existsSync(uploadedFile.path)) {
      await fs.rm(uploadedFile.path, { force: true }).catch(() => {});
    }
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get('*splat', async (_request, response) => {
  const indexPath = path.join(rootDir, 'dist', 'index.html');
  if (existsSync(indexPath)) {
    response.type('html');
    createReadStream(indexPath).pipe(response);
    return;
  }
  response.status(404).send('Run npm run dev for the Vite frontend.');
});

app.listen(port, () => {
  console.log(`V2T API is running on http://localhost:${port}`);
});
