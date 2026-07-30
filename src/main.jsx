import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  FileText,
  FileVideo,
  Film,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Upload
} from 'lucide-react';
import './styles.css';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const formatDuration = (seconds = 0) => {
  const safe = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
};

const formatSrtTime = (seconds = 0) => {
  const safe = Math.max(0, seconds);
  const totalMillis = Math.round(safe * 1000);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const rest = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
};

const parseSrtTime = (value = '') => {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) return null;
  const [, hours, minutes, seconds, millis] = match.map(Number);
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
};

const parseSrtToCues = (srtText = '') => {
  if (!srtText.trim()) return [];

  return srtText
    .replace(/\r/g, '')
    .trim()
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split('\n').filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex === -1) return null;

      const [startRaw, endRaw] = lines[timingIndex].split('-->').map((part) => part.trim());
      const start = parseSrtTime(startRaw);
      const end = parseSrtTime(endRaw);
      const text = lines.slice(timingIndex + 1).join('\n').trim();

      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      return { start, end, text };
    })
    .filter(Boolean);
};

const serializeCuesToSrt = (cues) =>
  cues
    .map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}`)
    .join('\n\n');

const findActiveCue = (cues, time) => cues.find((cue) => time >= cue.start && time < cue.end);

const subtitleFont = (fontSize) =>
  `800 ${fontSize}px "SamsungMyanmar", "Samsung Myanmar", "Noto Sans Myanmar", "Myanmar Text", Padauk, system-ui, -apple-system, sans-serif`;

const wrapMeasuredLine = (ctx, rawLine, maxWidth) => {
  const tokens = rawLine.split(/(\s+)/).filter(Boolean);
  const lines = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) lines.push(current.trim());
    current = '';
  };

  const splitLongToken = (token) => {
    let piece = '';
    for (const char of [...token]) {
      const next = `${piece}${char}`;
      if (piece && ctx.measureText(next).width > maxWidth) {
        lines.push(piece);
        piece = char;
      } else {
        piece = next;
      }
    }
    return piece;
  };

  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (current && !current.endsWith(' ')) current += ' ';
      continue;
    }

    if (ctx.measureText(token).width > maxWidth) {
      pushCurrent();
      current = splitLongToken(token);
      continue;
    }

    const candidate = current ? `${current.trimEnd()} ${token}` : token;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      pushCurrent();
      current = token;
    } else {
      current = candidate;
    }
  }

  pushCurrent();
  return lines;
};

const makeSubtitleLayout = (ctx, text, width, height) => {
  const marginX = clamp(Math.round(width * 0.08), 32, 180);
  const maxWidth = width - marginX * 2;
  const minSide = Math.min(width, height);
  let fontSize = clamp(Math.round(minSide * 0.061), 30, 78);
  const minFontSize = clamp(Math.round(minSide * 0.038), 22, 42);

  while (fontSize >= minFontSize) {
    ctx.font = subtitleFont(fontSize);
    const lines = text
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .flatMap((line) => wrapMeasuredLine(ctx, line, maxWidth));
    const lineHeight = Math.round(fontSize * 1.28);
    const blockHeight = lines.length * lineHeight;

    if (blockHeight <= height * 0.34 || fontSize <= minFontSize) {
      return {
        lines,
        fontSize,
        lineHeight,
        maxWidth,
        bottom: clamp(Math.round(height * 0.095), 42, 130),
        outline: clamp(Math.round(fontSize * 0.085), 3, 8),
        shadow: clamp(Math.round(fontSize * 0.035), 1, 4)
      };
    }

    fontSize -= 2;
  }

  return {
    lines: [text],
    fontSize: minFontSize,
    lineHeight: Math.round(minFontSize * 1.28),
    maxWidth,
    bottom: clamp(Math.round(height * 0.095), 42, 130),
    outline: 4,
    shadow: 2
  };
};

const drawSubtitle = (ctx, cue, width, height) => {
  if (!cue?.text) return;

  const layout = makeSubtitleLayout(ctx, cue.text, width, height);
  const blockHeight = layout.lines.length * layout.lineHeight;
  let y = height - layout.bottom - blockHeight + layout.lineHeight * 0.82;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = subtitleFont(layout.fontSize);
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = layout.outline;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = layout.shadow;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = layout.shadow;

  for (const line of layout.lines) {
    ctx.strokeText(line, width / 2, y, layout.maxWidth);
    ctx.fillText(line, width / 2, y, layout.maxWidth);
    y += layout.lineHeight;
  }

  ctx.restore();
};

const chooseRecorderMimeType = () => {
  if (!window.MediaRecorder) return '';
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
};

const extensionForType = (type = '') => (type.includes('mp4') ? 'mp4' : 'webm');

const waitForVideoMetadata = (video) =>
  new Promise((resolve, reject) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('Could not load the selected video.'));
  });

function SubtitlePreview({ previewUrl, cues, mediaRef, currentTime, duration, setDuration, setCurrentTime }) {
  const [ratio, setRatio] = useState('16 / 9');
  const [isPlaying, setIsPlaying] = useState(false);
  const activeCue = useMemo(() => findActiveCue(cues, currentTime), [cues, currentTime]);

  const togglePlay = () => {
    if (!mediaRef.current) return;
    if (mediaRef.current.paused) mediaRef.current.play();
    else mediaRef.current.pause();
  };

  const seek = (event) => {
    if (!mediaRef.current) return;
    const nextTime = Number(event.target.value);
    mediaRef.current.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  return (
    <div className="preview-tool">
      <div className="video-stage" style={{ aspectRatio: ratio }} onClick={togglePlay}>
        {previewUrl ? (
          <video
            ref={mediaRef}
            src={previewUrl}
            playsInline
            onLoadedMetadata={() => {
              const media = mediaRef.current;
              setDuration(media?.duration || 0);
              if (media?.videoWidth && media?.videoHeight) {
                setRatio(`${media.videoWidth} / ${media.videoHeight}`);
              }
            }}
            onTimeUpdate={() => setCurrentTime(mediaRef.current?.currentTime || 0)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
          />
        ) : (
          <div className="empty-video">
            <FileVideo size={36} />
          </div>
        )}
        {activeCue && <span className="preview-subtitle">{activeCue.text}</span>}
        {previewUrl && !isPlaying && (
          <button className="play-button" type="button" aria-label="Play preview">
            <Play size={34} fill="currentColor" />
          </button>
        )}
      </div>

      <div className="playback-row">
        <button className="icon-button" type="button" onClick={togglePlay} disabled={!previewUrl} aria-label={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <input
          className="seek-bar"
          type="range"
          min="0"
          max={duration || 0}
          step="0.01"
          value={Math.min(currentTime, duration || 0)}
          onChange={seek}
          onInput={seek}
          disabled={!duration}
          aria-label="Preview timeline"
          style={{ '--seek-progress': `${duration ? (currentTime / duration) * 100 : 0}%` }}
        />
        <span className="time-readout">{formatDuration(currentTime)} / {formatDuration(duration)}</span>
      </div>
    </div>
  );
}

function CueRow({ cue, index, onChange, onDelete, onPlay, active }) {
  const [text, setText] = useState(cue.text);
  const [start, setStart] = useState(formatSrtTime(cue.start));
  const [end, setEnd] = useState(formatSrtTime(cue.end));

  useEffect(() => setText(cue.text), [cue.text]);
  useEffect(() => setStart(formatSrtTime(cue.start)), [cue.start]);
  useEffect(() => setEnd(formatSrtTime(cue.end)), [cue.end]);

  const updateTime = (field, value, setter) => {
    const parsed = parseSrtTime(value);
    if (parsed === null) {
      setter(formatSrtTime(cue[field]));
      return;
    }
    onChange(index, field, parsed);
  };

  return (
    <article className={`cue-row ${active ? 'active' : ''}`}>
      <div className="cue-time-row">
        <button className="icon-button small" type="button" onClick={() => onPlay(cue.start)} aria-label="Play cue">
          <Play size={14} />
        </button>
        <input value={start} onChange={(event) => setStart(event.target.value)} onBlur={() => updateTime('start', start, setStart)} />
        <span>to</span>
        <input value={end} onChange={(event) => setEnd(event.target.value)} onBlur={() => updateTime('end', end, setEnd)} />
        <button className="icon-button small danger" type="button" onClick={() => onDelete(index)} aria-label="Delete cue">
          <Trash2 size={14} />
        </button>
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => onChange(index, 'text', text)}
        spellCheck="false"
      />
    </article>
  );
}

function App() {
  const videoInputRef = useRef(null);
  const srtInputRef = useRef(null);
  const previewMediaRef = useRef(null);
  const previewUrlRef = useRef('');
  const outputUrlRef = useRef('');

  const [videoFile, setVideoFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [srt, setSrt] = useState('');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState('');
  const [isBurning, setIsBurning] = useState(false);
  const [burnProgress, setBurnProgress] = useState(0);
  const [output, setOutput] = useState(null);
  const [copied, setCopied] = useState(false);

  const cues = useMemo(() => parseSrtToCues(srt), [srt]);
  const activeCueIndex = useMemo(
    () => cues.findIndex((cue) => currentTime >= cue.start && currentTime < cue.end),
    [cues, currentTime]
  );
  const baseName = (videoFile?.name || 'pda-v2t-video').replace(/\.[^.]+$/, '');
  const canBurn = Boolean(videoFile && previewUrl && cues.length && !isBurning);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
    };
  }, []);

  const setNewPreviewUrl = (file) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const nextUrl = URL.createObjectURL(file);
    previewUrlRef.current = nextUrl;
    setPreviewUrl(nextUrl);
  };

  const setNewOutput = (blob, type) => {
    if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
    const url = URL.createObjectURL(blob);
    outputUrlRef.current = url;
    const ext = extensionForType(type || blob.type);
    setOutput({ url, blob, type: type || blob.type, fileName: `${baseName}_subtitled.${ext}` });
  };

  const selectVideo = (file) => {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setError('Please choose a video file.');
      return;
    }
    setVideoFile(file);
    setNewPreviewUrl(file);
    setOutput(null);
    setError('');
    setStatus(`${file.name} selected`);
    setCurrentTime(0);
    setDuration(0);
  };

  const importSrt = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      setSrt(text.trim());
      setOutput(null);
      setError('');
      setStatus(`${file.name} loaded`);
    } catch {
      setError('Could not read the SRT file.');
    }
  };

  const updateCue = (index, field, value) => {
    const nextCues = [...cues];
    nextCues[index] = { ...nextCues[index], [field]: value };

    if (field === 'start' && nextCues[index].end <= value) {
      nextCues[index].end = value + 2;
    }
    if (field === 'end' && nextCues[index].start >= value) {
      nextCues[index].start = Math.max(0, value - 2);
    }

    setSrt(serializeCuesToSrt(nextCues.sort((a, b) => a.start - b.start)));
    setOutput(null);
  };

  const deleteCue = (index) => {
    setSrt(serializeCuesToSrt(cues.filter((_, cueIndex) => cueIndex !== index)));
    setOutput(null);
  };

  const addCue = () => {
    const start = previewMediaRef.current?.currentTime || cues[cues.length - 1]?.end || 0;
    const nextCue = { start, end: start + 3, text: 'New subtitle' };
    setSrt(serializeCuesToSrt([...cues, nextCue].sort((a, b) => a.start - b.start)));
    setOutput(null);
  };

  const playCue = (time) => {
    if (!previewMediaRef.current) return;
    previewMediaRef.current.currentTime = time;
    previewMediaRef.current.play();
  };

  const copySrt = async () => {
    try {
      await navigator.clipboard.writeText(srt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Clipboard access was blocked.');
    }
  };

  const downloadSrt = () => {
    const blob = new Blob([srt], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${baseName}.srt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const burnOnDevice = async () => {
    if (!canBurn) return;
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      setError('This browser cannot export burned video. Please use Safari 17+, Chrome, or Edge.');
      return;
    }

    setIsBurning(true);
    setBurnProgress(0);
    setOutput(null);
    setError('');
    setStatus('Preparing export');

    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    let recorder;
    let audioContext;
    let wakeLock;
    let animationId;

    try {
      await document.fonts?.load?.(subtitleFont(48));
      wakeLock = await navigator.wakeLock?.request?.('screen').catch(() => null);
      video.src = previewUrl;
      video.playsInline = true;
      video.preload = 'auto';
      video.muted = false;

      await waitForVideoMetadata(video);

      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      canvas.width = width;
      canvas.height = height;

      const frameRate = width * height > 2_100_000 ? 24 : 30;
      const canvasStream = canvas.captureStream(frameRate);
      const tracks = [...canvasStream.getVideoTracks()];

      try {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (AudioCtor) {
          audioContext = new AudioCtor();
          await audioContext.resume();
          const source = audioContext.createMediaElementSource(video);
          const destination = audioContext.createMediaStreamDestination();
          source.connect(destination);
          tracks.push(...destination.stream.getAudioTracks());
        }
      } catch {
        setStatus('Exporting video without captured audio');
      }

      const stream = new MediaStream(tracks);
      const mimeType = chooseRecorderMimeType();
      const chunks = [];
      const recorderOptions = mimeType
        ? { mimeType, videoBitsPerSecond: Math.max(4_000_000, Math.round(width * height * 2.6)) }
        : { videoBitsPerSecond: Math.max(4_000_000, Math.round(width * height * 2.6)) };

      try {
        recorder = new MediaRecorder(stream, recorderOptions);
      } catch {
        recorder = new MediaRecorder(stream);
      }

      const stopped = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data?.size) chunks.push(event.data);
        };
        recorder.onerror = () => reject(new Error('Video export failed while recording.'));
        recorder.onstop = resolve;
      });

      const renderFrame = () => {
        ctx.drawImage(video, 0, 0, width, height);
        drawSubtitle(ctx, findActiveCue(cues, video.currentTime), width, height);
        setBurnProgress(duration ? clamp((video.currentTime / duration) * 100, 0, 99) : 0);
        if (!video.ended && !video.paused) animationId = requestAnimationFrame(renderFrame);
      };

      recorder.start(1000);
      setStatus('Burning subtitles on this device');
      await video.play();
      renderFrame();

      await new Promise((resolve) => {
        video.onended = resolve;
      });

      ctx.drawImage(video, 0, 0, width, height);
      recorder.stop();
      await stopped;

      tracks.forEach((track) => track.stop());
      const type = recorder.mimeType || mimeType || 'video/webm';
      setNewOutput(new Blob(chunks, { type }), type);
      setBurnProgress(100);
      setStatus('Export ready');
    } catch (burnError) {
      setError(burnError.message || 'Could not burn subtitles on this device.');
      setStatus('Export failed');
    } finally {
      if (animationId) cancelAnimationFrame(animationId);
      if (recorder?.state === 'recording') recorder.stop();
      await audioContext?.close?.().catch(() => {});
      await wakeLock?.release?.().catch(() => {});
      video.removeAttribute('src');
      video.load();
      setIsBurning(false);
    }
  };

  const resetProject = () => {
    setVideoFile(null);
    setSrt('');
    setDuration(0);
    setCurrentTime(0);
    setStatus('Ready');
    setError('');
    setOutput(null);
    setBurnProgress(0);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = '';
    setPreviewUrl('');
    if (outputUrlRef.current) URL.revokeObjectURL(outputUrlRef.current);
    outputUrlRef.current = '';
  };

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <img className="brand-logo" src="/brand/pda-black.png" alt="PhyoDynamic Academy" />
          <div>
            <p className="eyebrow">PhyoDynamic Academy</p>
            <h1>Subtitle Burner</h1>
          </div>
          <button className="secondary-action top-action" type="button" onClick={resetProject}>
            <RotateCcw size={17} />
            New
          </button>
        </header>

        <section className="tool-grid">
          <div className="left-column">
            <section className="panel source-panel">
              <div className="section-head">
                <span className="step-pill">1</span>
                <div>
                  <p className="eyebrow">Source</p>
                  <h2>Video</h2>
                </div>
              </div>

              <input
                ref={videoInputRef}
                type="file"
                accept="video/*"
                hidden
                onChange={(event) => selectVideo(event.target.files?.[0])}
              />

              <button
                className="dropzone"
                type="button"
                onClick={() => videoInputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  selectVideo(event.dataTransfer.files?.[0]);
                }}
              >
                <Upload size={28} />
                <strong>{videoFile ? videoFile.name : 'Choose video'}</strong>
                <span>{videoFile ? `${formatDuration(duration)} selected` : 'MP4, MOV, WebM'}</span>
              </button>
            </section>

            <section className="panel srt-panel">
              <div className="section-head">
                <span className="step-pill">2</span>
                <div>
                  <p className="eyebrow">Subtitles</p>
                  <h2>SRT input</h2>
                </div>
              </div>

              <input
                ref={srtInputRef}
                type="file"
                accept=".srt,.txt,text/plain,application/x-subrip"
                hidden
                onChange={(event) => importSrt(event.target.files?.[0])}
              />

              <div className="srt-actions">
                <button className="secondary-action" type="button" onClick={() => srtInputRef.current?.click()}>
                  <FileText size={17} />
                  Import
                </button>
                <button className="icon-button" type="button" onClick={copySrt} disabled={!srt} aria-label="Copy SRT">
                  {copied ? <Check size={18} /> : <Copy size={18} />}
                </button>
                <button className="icon-button" type="button" onClick={downloadSrt} disabled={!srt} aria-label="Download SRT">
                  <Download size={18} />
                </button>
              </div>

              <textarea
                className="srt-input"
                value={srt}
                onChange={(event) => {
                  setSrt(event.target.value);
                  setOutput(null);
                  setError('');
                  setStatus(event.target.value.trim() ? 'SRT ready' : 'Ready');
                }}
                spellCheck="false"
                placeholder={`1\n00:00:00,000 --> 00:00:03,000\nPaste subtitle text here`}
              />

              <div className="cue-summary">
                <span>{cues.length} cues</span>
                <button className="text-button" type="button" onClick={addCue}>
                  <Plus size={15} />
                  Add cue
                </button>
              </div>
            </section>
          </div>

          <section className="panel preview-panel">
            <div className="section-head">
              <span className="step-pill">3</span>
              <div>
                <p className="eyebrow">Preview</p>
                <h2>Check frame</h2>
              </div>
            </div>

            <SubtitlePreview
              previewUrl={previewUrl}
              cues={cues}
              mediaRef={previewMediaRef}
              currentTime={currentTime}
              duration={duration}
              setDuration={setDuration}
              setCurrentTime={setCurrentTime}
            />

            <div className="status-strip">
              <span className={isBurning ? 'pulse-dot' : 'solid-dot'} />
              <strong>{status}</strong>
            </div>

            {isBurning && (
              <div className="progress-wrap" aria-label="Export progress">
                <span style={{ width: `${burnProgress}%` }} />
              </div>
            )}

            {error && (
              <div className="error-box">
                <AlertCircle size={18} />
                <span>{error}</span>
              </div>
            )}

            <button className="primary-action burn-action" type="button" disabled={!canBurn} onClick={burnOnDevice}>
              {isBurning ? <LoaderCircle className="spin" size={19} /> : <Film size={19} />}
              {isBurning ? `${Math.floor(burnProgress)}%` : 'Burn Video'}
            </button>

            {output && (
              <div className="export-box">
                <video src={output.url} controls playsInline />
                <a className="download-action" href={output.url} download={output.fileName}>
                  <Download size={17} />
                  Download {output.type.includes('mp4') ? 'MP4' : 'Video'}
                </a>
              </div>
            )}
          </section>
        </section>

        {cues.length > 0 && (
          <section className="panel cue-editor">
            <div className="section-head">
              <span className="step-pill">4</span>
              <div>
                <p className="eyebrow">Timing</p>
                <h2>Edit cues</h2>
              </div>
            </div>

            <div className="cue-list">
              {cues.map((cue, index) => (
                <CueRow
                  key={`${cue.start}-${cue.end}-${index}`}
                  cue={cue}
                  index={index}
                  active={index === activeCueIndex}
                  onChange={updateCue}
                  onDelete={deleteCue}
                  onPlay={playCue}
                />
              ))}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
