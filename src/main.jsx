import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Download,
  FileAudio,
  FileVideo,
  Languages,
  LoaderCircle,
  Music2,
  Upload,
  Wand2,
  CheckCircle2,
  Copy,
  Check,
  Play,
  Pause,
  Film
} from 'lucide-react';
import './styles.css';

const apiBase = import.meta.env.VITE_API_BASE || '';

const LANGUAGES = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'my', label: 'Myanmar (မြန်မာ)' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: 'Japanese (日本語)' },
  { code: 'ko', label: 'Korean (한국어)' },
  { code: 'zh', label: 'Chinese (中文)' },
  { code: 'th', label: 'Thai (ไทย)' },
  { code: 'hi', label: 'Hindi (हिन्दी)' },
  { code: 'es', label: 'Spanish (Español)' },
  { code: 'fr', label: 'French (Français)' },
  { code: 'other', label: 'Other…' }
];

const formatDuration = (seconds = 0) => {
  const safe = Math.round(seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
};

const formatBytes = (bytes = 0) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
};

const parseCueCount = (srt) => {
  const matches = srt.match(/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/g);
  return matches?.length || 0;
};

/* ─── SRT Parser ─── */
const parseSrtTime = (timeStr) => {
  const m = timeStr.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
};

const parseSrtToCues = (srtText) => {
  if (!srtText) return [];
  const cleaned = srtText.replace(/\r/g, '').trim();
  const blocks = cleaned.split(/\n\n+/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;

    const [startRaw, endRaw] = lines[timingIdx].split('-->').map((s) => s.trim());
    const start = parseSrtTime(startRaw);
    const end = parseSrtTime(endRaw);
    const text = lines.slice(timingIdx + 1).join('\n').trim();
    if (text) cues.push({ start, end, text });
  }

  return cues;
};

const formatSrtTimeFromSeconds = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

const updateSrtCueText = (srtText, cueIndex, newText) => {
  const blocks = srtText.replace(/\r/g, '').trim().split(/\n\n+/);
  if (!blocks[cueIndex]) return srtText;
  
  const lines = blocks[cueIndex].split('\n');
  const timingIdx = lines.findIndex((l) => l.includes('-->'));
  if (timingIdx === -1) return srtText;
  
  // Keep index and timing lines, replace everything after with the new text
  const newBlock = [...lines.slice(0, timingIdx + 1), newText].join('\n');
  blocks[cueIndex] = newBlock;
  return blocks.join('\n\n');
};

const updateSrtCueTiming = (srtText, cueIndex, newStart, newEnd) => {
  const blocks = srtText.replace(/\r/g, '').trim().split(/\n\n+/);
  if (!blocks[cueIndex]) return srtText;
  
  const lines = blocks[cueIndex].split('\n');
  const timingIdx = lines.findIndex((l) => l.includes('-->'));
  if (timingIdx === -1) return srtText;
  
  // Update timing line
  lines[timingIdx] = `${formatSrtTimeFromSeconds(newStart)} --> ${formatSrtTimeFromSeconds(newEnd)}`;
  blocks[cueIndex] = lines.join('\n');
  return blocks.join('\n\n');
};

/* ─── Subtitle Preview Component ─── */
function SubtitlePreview({ previewUrl, mediaKind, srt }) {
  const mediaRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const animRef = useRef(null);

  const cues = useMemo(() => parseSrtToCues(srt), [srt]);

  const activeCue = useMemo(() => {
    for (const cue of cues) {
      if (currentTime >= cue.start && currentTime < cue.end) return cue;
    }
    return null;
  }, [cues, currentTime]);

  /* Use requestAnimationFrame for smoother subtitle sync */
  const tick = useCallback(() => {
    if (mediaRef.current) {
      setCurrentTime(mediaRef.current.currentTime);
    }
    animRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [tick]);

  const handlePlay = () => setIsPlaying(true);
  const handlePause = () => setIsPlaying(false);
  const handleLoadedMetadata = () => {
    if (mediaRef.current) setDuration(mediaRef.current.duration);
  };

  const togglePlay = () => {
    if (!mediaRef.current) return;
    if (mediaRef.current.paused) {
      mediaRef.current.play();
    } else {
      mediaRef.current.pause();
    }
  };

  const handleSeek = (e) => {
    if (!mediaRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, x / rect.width));
    mediaRef.current.currentTime = fraction * duration;
  };

  const progress = duration ? (currentTime / duration) * 100 : 0;

  if (mediaKind === 'video') {
    return (
      <div className="subtitle-preview">
        <div className="subtitle-viewport video-viewport" onClick={togglePlay}>
          <video
            ref={mediaRef}
            src={previewUrl}
            onPlay={handlePlay}
            onPause={handlePause}
            onLoadedMetadata={handleLoadedMetadata}
            playsInline
          />
          {activeCue && (
            <div className="subtitle-overlay">
              <span className="subtitle-text">{activeCue.text}</span>
            </div>
          )}
          {!isPlaying && (
            <div className="play-overlay">
              <Play size={48} fill="white" />
            </div>
          )}
        </div>
        <div className="subtitle-controls">
          <button className="ctrl-btn" onClick={togglePlay}>
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <div className="seek-bar" onClick={handleSeek}>
            <div className="seek-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="ctrl-time">{formatDuration(currentTime)} / {formatDuration(duration)}</span>
        </div>
      </div>
    );
  }

  /* Audio: black canvas with white text */
  return (
    <div className="subtitle-preview">
      <div className="subtitle-viewport audio-viewport" onClick={togglePlay}>
        <audio
          ref={mediaRef}
          src={previewUrl}
          onPlay={handlePlay}
          onPause={handlePause}
          onLoadedMetadata={handleLoadedMetadata}
        />
        <div className="audio-sub-canvas">
          {activeCue ? (
            <span className="audio-sub-text">{activeCue.text}</span>
          ) : (
            <span className="audio-sub-text dimmed">
              {isPlaying ? '♪ ♪ ♪' : 'Press play to preview subtitles'}
            </span>
          )}
        </div>
        {!isPlaying && (
          <div className="play-overlay dark">
            <Play size={48} fill="white" />
          </div>
        )}
      </div>
      <div className="subtitle-controls">
        <button className="ctrl-btn" onClick={togglePlay}>
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <div className="seek-bar" onClick={handleSeek}>
          <div className="seek-fill" style={{ width: `${progress}%` }} />
        </div>
        <span className="ctrl-time">{formatDuration(currentTime)} / {formatDuration(duration)}</span>
      </div>
    </div>
  );
}

/* ─── Main App ─── */
function App() {
  const fileInputRef = useRef(null);
  const [mode, setMode] = useState('video');
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [status, setStatus] = useState('Ready');
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState(null);
  const [srt, setSrt] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [subtitleLang, setSubtitleLang] = useState('auto');
  const [customLang, setCustomLang] = useState('');
  const [editorMode, setEditorMode] = useState('list'); // 'list' or 'raw'
  const [isBurning, setIsBurning] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);

  const cueCount = useMemo(() => parseCueCount(srt), [srt]);
  const parsedCues = useMemo(() => parseSrtToCues(srt), [srt]);
  const mediaKind = file?.type?.startsWith('video/') ? 'video' : 'audio';
  const baseName = (file?.name || 'subtitle').replace(/\.[^.]+$/, '');

  const selectFile = (selectedFile) => {
    if (!selectedFile) return;
    setFile(selectedFile);
    setResult(null);
    setSrt('');
    setError('');
    setStatus(`${selectedFile.name} selected`);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(selectedFile));
    setMode(selectedFile.type.startsWith('audio/') ? 'audio' : 'video');
  };

  const transcribe = async () => {
    if (!file || isProcessing) return;

    const body = new FormData();
    body.append('media', file);
    body.append('language', 'auto'); // Force original language initially

    setIsProcessing(true);
    setError('');
    setSrt('');
    setResult(null);
    setStatus('Uploading media…');

    try {
      const timers = [];
      if (mediaKind === 'video') {
        timers.push(setTimeout(() => setStatus('Extracting audio from video…'), 1500));
        timers.push(setTimeout(() => setStatus('Optimizing & splitting into 1-min chunks…'), 4000));
        timers.push(setTimeout(() => setStatus('Sending chunks to Gemini for transcription…'), 8000));
        timers.push(setTimeout(() => setStatus('Transcribing… this may take a minute'), 15000));
        timers.push(setTimeout(() => setStatus('Still processing — please wait…'), 30000));
        timers.push(setTimeout(() => setStatus('Almost there…'), 60000));
      } else {
        timers.push(setTimeout(() => setStatus('Optimizing & splitting audio…'), 1500));
        timers.push(setTimeout(() => setStatus('Sending chunks to Gemini…'), 4000));
        timers.push(setTimeout(() => setStatus('Transcribing… this may take a minute'), 12000));
        timers.push(setTimeout(() => setStatus('Still processing — please wait…'), 30000));
        timers.push(setTimeout(() => setStatus('Almost there…'), 60000));
      }

      const response = await fetch(`${apiBase}/api/transcribe`, {
        method: 'POST',
        body
      });

      timers.forEach(clearTimeout);

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Transcription failed');
      }

      setResult(payload);
      setSrt(payload.srt || '');
      setStatus(`✅ Done — ${parseCueCount(payload.srt || '')} subtitle cues generated`);
    } catch (transcribeError) {
      setError(transcribeError.message);
      setStatus('Failed');
    } finally {
      setIsProcessing(false);
    }
  };

  const translateSrt = async () => {
    if (!srt) return;
    const lang = subtitleLang === 'other' ? customLang.trim() : subtitleLang;
    if (lang === 'auto') {
      setError('Please select a target language to translate into.');
      return;
    }
    if (subtitleLang === 'other' && !customLang.trim()) {
      setError('Please enter a custom language.');
      return;
    }

    setIsTranslating(true);
    setStatus(`Translating subtitles into ${lang}…`);
    try {
      const response = await fetch(`${apiBase}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ srt, language: lang })
      });
      const data = await response.json();
      
      if (!response.ok) throw new Error(data.error || 'Failed to translate');
      
      setSrt(data.translatedSrt);
      setStatus('✅ Translation complete');
    } catch (err) {
      setError(err.message);
      setStatus('Translation failed');
    } finally {
      setIsTranslating(false);
    }
  };

  const downloadSrt = () => {
    if (!srt) return;
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

  const copySrt = async () => {
    if (!srt) return;
    try {
      await navigator.clipboard.writeText(srt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard might be blocked */ }
  };

  const burnSubtitles = async () => {
    if (!result?.mediaUrl || !srt || mediaKind !== 'video') return;
    setIsBurning(true);
    setStatus('Burning subtitles into video (this may take a few minutes depending on length)…');
    
    try {
      // Extract the actual saved filename from mediaUrl (e.g. /media/1234.mp4 -> 1234.mp4)
      const actualFileName = result.mediaUrl.replace('/media/', '');
      const response = await fetch(`${apiBase}/api/burn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: actualFileName, srt })
      });
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to burn subtitles');
      }
      
      setStatus('✅ Video rendered with subtitles! Downloading...');
      
      // Auto-download the burned video
      const link = document.createElement('a');
      link.href = `${apiBase}${data.burnedUrl}`;
      link.download = `${baseName}_hardsubbed.mp4`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      setError(err.message);
      setStatus('Burn failed');
    } finally {
      setIsBurning(false);
    }
  };

  return (
    <main className="app-shell">
      <section className="workspace">
        <div className="topbar">
          <div>
            <p className="eyebrow">V2T Subtitle Studio</p>
            <h1>Video / Audio to editable SRT</h1>
          </div>
          <div className="mode-switch" aria-label="Upload type">
            <button className={mode === 'video' ? 'active' : ''} onClick={() => setMode('video')}>
              <FileVideo size={18} />
              Video
            </button>
            <button className={mode === 'audio' ? 'active' : ''} onClick={() => setMode('audio')}>
              <FileAudio size={18} />
              Audio
            </button>
          </div>
        </div>

        {/* ─── Subtitle Preview (shown when SRT is ready) ─── */}
        {srt && previewUrl && (
          <section className="panel preview-panel">
            <div className="preview-panel-head">
              <div>
                <p className="eyebrow">Subtitle Preview</p>
                <h2>Live playback with subtitles</h2>
              </div>
            </div>
            <SubtitlePreview previewUrl={previewUrl} mediaKind={mediaKind} srt={srt} />
          </section>
        )}

        <div className="main-grid">
          <section className="panel upload-panel">
            <input
              ref={fileInputRef}
              type="file"
              accept={mode === 'video' ? 'video/*,audio/*' : 'audio/*,video/*'}
              onChange={(event) => selectFile(event.target.files?.[0])}
              hidden
            />
            <button
              className="dropzone"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                selectFile(event.dataTransfer.files?.[0]);
              }}
            >
              <Upload size={34} />
              <span>{file ? file.name : 'Upload video or audio'}</span>
              <small>Maximum 1 hour • chunks are processed one minute at a time</small>
            </button>

            {/* Show raw preview only when no SRT yet */}
            {!srt && (
              <div className="preview-frame">
                {previewUrl ? (
                  mediaKind === 'video' ? (
                    <video src={previewUrl} controls />
                  ) : (
                    <div className="audio-preview">
                      <Music2 size={46} />
                      <audio src={previewUrl} controls />
                    </div>
                  )
                ) : (
                  <div className="empty-preview">
                    <Wand2 size={40} />
                    <span>No media selected</span>
                  </div>
                )}
              </div>
            )}

            <button className="primary-action" disabled={!file || isProcessing} onClick={transcribe}>
              {isProcessing ? <LoaderCircle className="spin" size={19} /> : <Wand2 size={19} />}
              {isProcessing ? 'Processing…' : 'Generate SRT'}
            </button>

            <div className="status-row">
              <span className={isProcessing ? 'pulse-dot' : 'solid-dot'} />
              <strong>{status}</strong>
            </div>
            {error && <p className="error-text">{error}</p>}
          </section>

          <section className="panel editor-panel">
            <div className="editor-head">
              <div>
                <p className="eyebrow">Live editor</p>
                <h2>{cueCount} subtitle cues</h2>
                {srt && (
                  <div className="editor-tabs">
                    <button className={editorMode === 'list' ? 'active' : ''} onClick={() => setEditorMode('list')}>Visual List</button>
                    <button className={editorMode === 'raw' ? 'active' : ''} onClick={() => setEditorMode('raw')}>Raw SRT</button>
                  </div>
                )}
              </div>
              <div className="editor-actions">
                {mediaKind === 'video' && srt && (
                  <button className="icon-button burn-button" disabled={isBurning} onClick={burnSubtitles} title="Hardsub & Download Video">
                    {isBurning ? <LoaderCircle className="spin" size={20} /> : <Film size={20} />}
                  </button>
                )}
                <button className="icon-button" disabled={!srt} onClick={copySrt} title="Copy to clipboard">
                  {copied ? <Check size={20} /> : <Copy size={20} />}
                </button>
                <button className="icon-button" disabled={!srt} onClick={downloadSrt} title="Download .srt">
                  <Download size={20} />
                </button>
              </div>
            </div>

            {srt ? (
              editorMode === 'raw' ? (
                <textarea
                  value={srt}
                  onChange={(event) => setSrt(event.target.value)}
                  spellCheck="false"
                  placeholder="Generated .srt content will appear here for live editing."
                />
              ) : (
                <div className="cue-list-editor">
                  {parsedCues.map((cue, index) => (
                    <div key={index} className="cue-row">
                      <div className="cue-time">
                        <span className="cue-index">{index + 1}</span>
                        <div className="cue-timing-controls">
                          <input 
                            type="number" 
                            step="0.1" 
                            value={Number(cue.start).toFixed(1)} 
                            onChange={(e) => setSrt(updateSrtCueTiming(srt, index, parseFloat(e.target.value) || 0, cue.end))} 
                            title="Start time (seconds)"
                          />
                          <span>→</span>
                          <input 
                            type="number" 
                            step="0.1" 
                            value={Number(cue.end).toFixed(1)} 
                            onChange={(e) => setSrt(updateSrtCueTiming(srt, index, cue.start, parseFloat(e.target.value) || 0))} 
                            title="End time (seconds)"
                          />
                        </div>
                      </div>
                      <textarea
                        className="cue-input"
                        value={cue.text}
                        onChange={(e) => setSrt(updateSrtCueText(srt, index, e.target.value))}
                        rows={cue.text.split('\n').length || 1}
                      />
                    </div>
                  ))}
                </div>
              )
            ) : (
              <textarea
                value=""
                readOnly
                placeholder="Generated .srt content will appear here for live editing."
              />
            )}

            {srt && (
              <div className="download-bar">
                <div className="download-info">
                  <CheckCircle2 size={22} className="download-check-icon" />
                  <div>
                    <strong>{baseName}.srt</strong>
                    <small>{cueCount} cues • {srt.length.toLocaleString()} characters</small>
                  </div>
                </div>
                <button className="download-action" onClick={downloadSrt}>
                  <Download size={18} />
                  Download .srt
                </button>
              </div>
            )}

            {srt && (
              <div className="translation-box">
                <div className="lang-selector">
                  <div className="lang-label">
                    <Languages size={16} />
                    <span>Translate subtitles to</span>
                  </div>
                  <div className="lang-options">
                    {LANGUAGES.filter(l => l.code !== 'auto').map((lang) => (
                      <button
                        key={lang.code}
                        className={`lang-chip${subtitleLang === lang.code ? ' active' : ''}`}
                        onClick={() => setSubtitleLang(lang.code)}
                      >
                        {lang.label}
                      </button>
                    ))}
                  </div>
                  {subtitleLang === 'other' && (
                    <input
                      className="lang-custom-input"
                      type="text"
                      value={customLang}
                      onChange={(e) => setCustomLang(e.target.value)}
                      placeholder="e.g. Vietnamese, Arabic…"
                      autoFocus
                    />
                  )}
                  <button 
                    className="primary-action translate-btn" 
                    disabled={isTranslating || subtitleLang === 'auto'} 
                    onClick={translateSrt}
                  >
                    {isTranslating ? <LoaderCircle className="spin" size={16} /> : <Languages size={16} />}
                    {isTranslating ? 'Translating…' : 'Translate'}
                  </button>
                </div>
              </div>
            )}

            <div className="metrics">
              <span>Model: {result?.model || '—'}</span>
              <span>Chunks: {result?.chunkCount || 0}</span>
              <span>Duration: {result ? formatDuration(result.duration) : '0:00'}</span>
              <span>Optimized: {result ? formatBytes(result.optimizedAudioBytes) : '0 B'}</span>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
