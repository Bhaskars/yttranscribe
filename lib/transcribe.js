// Speech-to-text for uploaded files.
//
// yt-dlp can read YouTube captions, but a file you upload has no caption track.
// So we extract a mono 16 kHz audio track with ffmpeg and transcribe it with
// OpenAI Whisper (the local `whisper` CLI). Everything stays on this machine.
//
// Requirements: ffmpeg (or ffprobe) on PATH, and `pip install -U openai-whisper`.
// The first run downloads the chosen model into ~/.cache/whisper.

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cleanText, normalizeSegments } from './captions.js';
import { captionLanguageLabel } from './languages.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const WHISPER = process.env.WHISPER_BIN || 'whisper';
const MODEL = process.env.WHISPER_MODEL || 'base';

// `whisper --help` exists in every version we need. Cache the answer.
let whisperCache = null;
let ffmpegCache = null;

function probeBinary(binary, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export async function hasWhisper({ refresh = false } = {}) {
  if (!refresh && whisperCache) return whisperCache;
  const available = await probeBinary(WHISPER, ['--help']);
  whisperCache = { available, binary: WHISPER, model: MODEL };
  return whisperCache;
}

export async function hasFfmpeg({ refresh = false } = {}) {
  if (!refresh && ffmpegCache) return ffmpegCache;
  const available =
    (await probeBinary(FFMPEG, ['-version'])) && (await probeBinary(FFPROBE, ['-version']));
  ffmpegCache = { available, binary: FFMPEG, probe: FFPROBE };
  return ffmpegCache;
}

function modelPaths() {
  const dirs = [process.env.WHISPER_MODEL_DIR, path.join(os.homedir(), '.cache', 'whisper')].filter(
    Boolean
  );
  return dirs.map((dir) => path.join(dir, `${MODEL}.pt`));
}

export async function modelReady() {
  for (const candidate of modelPaths()) {
    try {
      await access(candidate, fsConstants.R_OK);
      const info = await stat(candidate);
      if (info.size > 1_000_000) return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

export function whisperModel() {
  return MODEL;
}

/* ------------------------------------------------------------------ */
/* ffprobe / ffmpeg                                                    */
/* ------------------------------------------------------------------ */

function runProcess(binary, args, { timeout = 120000, onStderr, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const stop = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      stop();
      const error = new Error('That took too long');
      error.code = 'TIMEOUT';
      reject(error);
    }, timeout);

    const onAbort = () => {
      clearTimeout(timer);
      stop();
      const error = new Error('Cancelled');
      error.code = 'CANCELLED';
      reject(error);
    };

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
      if (onStderr) onStderr(stderr);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error.code === 'ENOENT') {
        const missing = new Error(`Not installed: ${binary}`);
        missing.code = 'TOOL_MISSING';
        reject(missing);
      } else {
        reject(error);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(stderr.trim().split('\n').slice(-3).join(' ') || `${binary} failed`);
      error.stderr = stderr;
      error.code = code;
      reject(error);
    });
  });
}

export async function probeMedia(file) {
  if (!(await hasFfmpeg()).available) {
    const error = new Error('ffmpeg is not installed');
    error.code = 'NO_FFMPEG';
    throw error;
  }

  const { stdout } = await runProcess(
    FFPROBE,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file
    ],
    { timeout: 45000 }
  );

  let data = {};
  try {
    data = JSON.parse(stdout);
  } catch {
    /* fall through with defaults */
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const video = streams.find(
    (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1
  );
  const duration = Number(data.format?.duration) || Number(audio?.duration) || Number(video?.duration) || 0;

  return {
    duration: Number.isFinite(duration) ? duration : 0,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    container: data.format?.format_name || ''
  };
}

export async function extractAudio(input, workdir, { signal } = {}) {
  if (!(await hasFfmpeg()).available) {
    const error = new Error('ffmpeg is not installed');
    error.code = 'NO_FFMPEG';
    throw error;
  }

  const output = path.join(workdir, 'audio.flac');
  await runProcess(
    FFMPEG,
    [
      '-nostdin',
      '-y',
      '-i',
      input,
      '-vn',
      '-sn',
      '-dn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'flac',
      output
    ],
    { timeout: 600000, signal }
  );

  if (signal?.aborted) {
    const error = new Error('Cancelled');
    error.code = 'CANCELLED';
    throw error;
  }

  return output;
}

/* ------------------------------------------------------------------ */
/* Whisper                                                             */
/* ------------------------------------------------------------------ */

// Whisper prints its tqdm progress bar to stderr, e.g.
//   42%|████      | 5/12 [00:20<00:28, 4.2s/it]
function lastPercent(text) {
  let percent = null;
  const matches = text.matchAll(/(\d{1,3})%\|/g);
  for (const match of matches) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 0 && value <= 100) percent = value;
  }
  return percent;
}

function parseWhisperJson(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const segments = Array.isArray(data.segments) ? data.segments : [];
  return {
    language: data.language || '',
    segments: segments.map((segment) => ({
      start: Number(segment.start) || 0,
      end: Number(segment.end) || 0,
      text: cleanText(segment.text)
    }))
  };
}

export async function transcribeAudio(audioFile, { onProgress, onNote, signal } = {}) {
  const tool = await hasWhisper();
  if (!tool.available) {
    const error = new Error('Whisper is not installed');
    error.code = 'NO_WHISPER';
    throw error;
  }

  const dir = path.dirname(audioFile);
  const args = [
    audioFile,
    '--model',
    MODEL,
    '--task',
    'transcribe',
    '--output_format',
    'json',
    '--output_dir',
    dir,
    '--verbose',
    'False',
    '--fp16',
    'False'
  ];

  let lastSent = -1;

  let outcome;
  try {
    outcome = await runProcess(WHISPER, args, {
      // Generous: whisper typically runs faster than real time, but first run
      // may download the model, and long files on CPU are slow.
      timeout: Number(process.env.WHISPER_TIMEOUT_MS) || 90 * 60 * 1000,
      signal,
      onStderr(text) {
        const percent = lastPercent(text);
        if (percent !== null && percent !== lastSent) {
          lastSent = percent;
          onProgress?.(percent);
        }
        const detected = text.match(/Detected language:\s*([^\n]+)/i);
        if (detected) onNote?.(detected[1].trim());
      }
    });
  } catch (error) {
    if (['CANCELLED', 'TIMEOUT', 'TOOL_MISSING', 'NO_WHISPER'].includes(error.code)) throw error;
    const wrapped = new Error(`Whisper could not transcribe this file: ${error.message}`);
    wrapped.code = 'TRANSCRIBE_FAILED';
    wrapped.stderr = error.stderr || '';
    throw wrapped;
  }

  const { stderr } = outcome;

  if (signal?.aborted) {
    const error = new Error('Cancelled');
    error.code = 'CANCELLED';
    throw error;
  }

  const base = path.basename(audioFile, path.extname(audioFile));
  let raw = '';
  try {
    raw = await readFile(path.join(dir, `${base}.json`), 'utf8');
  } catch {
    const error = new Error(stderr.trim().split('\n').slice(-2).join(' ') || 'Whisper produced no transcript');
    error.code = 'TRANSCRIBE_FAILED';
    throw error;
  }

  const parsed = parseWhisperJson(raw);
  if (!parsed) {
    const error = new Error('Whisper returned an unreadable transcript');
    error.code = 'TRANSCRIBE_FAILED';
    throw error;
  }

  const segments = normalizeSegments(parsed.segments);
  return {
    segments,
    language: parsed.language || '',
    languageName: parsed.language ? captionLanguageLabel(parsed.language) : 'Unknown',
    model: MODEL
  };
}

/* ------------------------------------------------------------------ */
/* One-shot helper                                                     */
/* ------------------------------------------------------------------ */

export async function transcribeFile(
  file,
  { onStage, onProgress, signal, removeSource = false } = {}
) {
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'vaani-upload-'));
  try {
    onStage?.({ step: 1, message: 'Listening to the audio…', progress: 0.1 });

    const media = await probeMedia(file);
    if (!media.hasAudio) {
      const error = new Error('This file has no audio track');
      error.code = 'NO_AUDIO';
      throw error;
    }

    const audio = await extractAudio(file, workdir, { signal });
    // Only the extracted audio is needed from here on, so drop the original
    // video as early as possible.
    if (removeSource) await rm(file, { force: true }).catch(() => {});
    onStage?.({ step: 1, message: 'Transcribing the audio…', progress: 0.15 });

    const result = await transcribeAudio(audio, {
      signal,
      onProgress: (percent) =>
        onStage?.({
          step: 1,
          message: `Listening to the audio — ${percent}%`,
          progress: 0.15 + (percent / 100) * 0.4
        })
    });

    return { ...result, media };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
