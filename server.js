import http from 'node:http';
import { open, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LANGUAGES, getLanguage, isSupported, captionLanguageLabel } from './lib/languages.js';
import { buildParagraphs } from './lib/captions.js';
import { translateParagraphs } from './lib/translate.js';
import { extractVideoId, getInfo, fetchSegments, publicInfo, hasYtdlp } from './lib/youtube.js';
import {
  hasWhisper,
  hasFfmpeg,
  modelReady,
  whisperModel,
  probeMedia,
  transcribeFile
} from './lib/transcribe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';

// Vercel caps function request bodies at ~4.5 MB, so be explicit there. Locally
// the limit is generous because the file never leaves the machine.
const UPLOAD_MAX_MB =
  Number(process.env.MAX_UPLOAD_MB) || (process.env.VERCEL ? 4 : 500);

// Optional HTTP basic auth. Turn it on when the app is exposed through a
// tunnel or otherwise reachable from the internet; local use needs no auth.
const AUTH_USER = process.env.VAANI_USER || '';
const AUTH_PASS = process.env.VAANI_PASS || '';
const AUTH_ON = Boolean(AUTH_USER && AUTH_PASS);

function isAuthorized(req, res) {
  if (!AUTH_ON) return true;

  const header = String(req.headers.authorization || '');
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, ...rest] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (user === AUTH_USER && rest.join(':') === AUTH_PASS) return true;
  }

  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Vaani", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end('Vaani is private. Sign in to continue.');
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function normaliseLanguage(code) {
  return String(code || '').toLowerCase().replace(/_/g, '-');
}

function sameLanguage(a, b) {
  const left = normaliseLanguage(a);
  const right = normaliseLanguage(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const leftBase = left.split('-')[0];
  const rightBase = right.split('-')[0];
  if (leftBase !== rightBase) return false;
  // Chinese scripts are distinct translation targets.
  if (leftBase === 'zh') return false;
  return true;
}

function friendlyError(error) {
  const text = `${error?.message || ''} ${error?.stderr || ''}`;
  if (error?.code === 'FILE_TOO_LARGE') {
    return {
      code: 'FILE_TOO_LARGE',
      title: 'That file is too large',
      message: `Uploads are limited to ${error.limitMb || UPLOAD_MAX_MB} MB on this server.`,
      hint: 'Trim the video, export a smaller version, or extract just the audio track and upload that instead.'
    };
  }
  if (error?.code === 'EMPTY_UPLOAD') {
    return {
      code: 'EMPTY_UPLOAD',
      title: 'No file arrived',
      message: 'The upload was empty, so there was nothing to transcribe.',
      hint: 'Choose a video or audio file and try again.'
    };
  }
  if (error?.code === 'NO_WHISPER') {
    return {
      code: 'NO_WHISPER',
      title: 'Speech recognition is not available here',
      message:
        'Uploaded files have no caption track, so Vaani needs Whisper to listen to them. This server does not have it installed.',
      hint: process.env.VERCEL
        ? 'Uploads run on the machine hosting Vaani. Run the app locally with `npm start` to transcribe your own files — the public deployment only reads YouTube captions.'
        : 'Install it with `pip install -U openai-whisper` (ffmpeg is required too), then restart Vaani. You can point WHISPER_BIN at a different path.'
    };
  }
  if (error?.code === 'NO_FFMPEG') {
    return {
      code: 'NO_FFMPEG',
      title: 'The audio helper is missing',
      message: 'Vaani uses ffmpeg to pull the audio out of your file, and it could not be found.',
      hint: 'Install ffmpeg (macOS: `brew install ffmpeg`, Ubuntu: `sudo apt install ffmpeg`), then restart the app.'
    };
  }
  if (error?.code === 'NO_AUDIO') {
    return {
      code: 'NO_AUDIO',
      title: 'That file has no sound',
      message: 'Vaani could not find an audio track in this file, so there is nothing to transcribe.',
      hint: 'Upload a video or audio file that contains speech.'
    };
  }
  if (error?.code === 'BAD_MEDIA') {
    return {
      code: 'BAD_MEDIA',
      title: 'That file could not be read',
      message: 'It may be damaged, still being uploaded, or in a container the audio tools do not understand.',
      hint: 'Try MP4, MOV, WEBM, MP3, WAV or M4A. Re-exporting the file usually fixes odd containers.'
    };
  }
  if (error?.code === 'SILENT_AUDIO') {
    return {
      code: 'SILENT_AUDIO',
      title: 'No speech found',
      message: 'The audio was read, but no recognisable speech came back.',
      hint: 'Check that the recording has audible speech, or try a quieter, clearer section.'
    };
  }
  if (error?.code === 'HOST_BLOCKED' || /not a bot|confirm you.{0,10}re not a bot/i.test(text)) {
    return {
      code: 'HOST_BLOCKED',
      title: 'YouTube blocked this server',
      message: 'YouTube is refusing caption requests from this deployment’s network. Cloud hosts are commonly challenged this way.',
      hint: 'Run Vaani locally for unrestricted access. If you run this deployment yourself, set YOUTUBE_COOKIES_B64 (your exported YouTube cookies) in the project’s environment variables and redeploy.'
    };
  }
  if (error?.code === 'NO_CAPTIONS') {
    return {
      code: 'NO_CAPTIONS',
      title: 'No captions on this video',
      message: 'This video does not have a caption track that we can read.',
      hint: 'Try a video where people speak — most talks, interviews and tutorials have auto-generated captions. You can also enable captions on the video in YouTube first.'
    };
  }
  if (/429|too many requests|rate.?limit/i.test(text)) {
    return {
      code: 'RATE_LIMITED',
      title: 'YouTube is asking us to slow down',
      message: 'Caption requests are being rate-limited from this connection right now.',
      hint: 'Wait a minute, then run the same link again. Videos you have already processed are cached and open instantly.'
    };
  }
  if (error?.code === 'TRANSCRIBE_FAILED') {
    const downloadIssue = /download|urlopen|ssl|certificate|connection|resolve|timed out/i.test(text);
    return {
      code: 'TRANSCRIBE_FAILED',
      title: downloadIssue ? 'The speech model could not be loaded' : 'The audio could not be transcribed',
      message: downloadIssue
        ? 'Whisper needs to download its speech model on first use, and that download failed on this machine.'
        : 'Whisper ran but could not produce a transcript for this file.',
      hint: downloadIssue
        ? 'Check the connection, or download the model once and place it in ~/.cache/whisper (set WHISPER_MODEL_DIR to use another folder).'
        : 'Try a shorter or clearer recording, or choose a different file.'
    };
  }
  if (/private|age|sign in|unavailable|not available/i.test(text)) {
    return {
      code: 'UNAVAILABLE',
      title: 'This video cannot be opened',
      message: 'It may be private, age-restricted, region-locked, or removed.',
      hint: 'Check that the link opens in a browser without signing in, then try again.'
    };
  }
  if (/timed out|timeout/i.test(text)) {
    return {
      code: 'TIMEOUT',
      title: 'That took too long',
      message: 'YouTube did not respond in time while fetching this video.',
      hint: 'Try again in a moment. Very long videos can take longer to prepare.'
    };
  }
  if (/Not installed: yt-dlp/i.test(text)) {
    return {
      code: 'NO_YTDLP',
      title: 'The caption helper is missing',
      message: 'The server could not find yt-dlp, which it uses to read captions.',
      hint: 'Install yt-dlp (pip install -U yt-dlp) and restart the app, or set YTDLP_PATH to its location.'
    };
  }
  if (/playlist/i.test(text)) {
    return {
      code: 'PLAYLIST',
      title: 'One video at a time',
      message: 'That link points to a playlist rather than a single video.',
      hint: 'Open the video you want and paste its own link.'
    };
  }
  return {
    code: 'FAILED',
    title: 'Something went wrong',
    message: error?.message || 'The transcript could not be prepared.',
    hint: 'Try the link again, or paste a different video.'
  };
}

function toBlock(paragraph) {
  const translated = paragraph.lines
    .map((line) => line.translated ?? line.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const original = paragraph.lines
    .map((line) => line.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    s: Math.round(paragraph.start * 100) / 100,
    e: Math.round(paragraph.end * 100) / 100,
    t: translated,
    o: original
  };
}

function countWords(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

/* ------------------------------------------------------------------ */
/* Transcript cache                                                    */
/* ------------------------------------------------------------------ */

const cache = new Map();
const CACHE_TTL = 45 * 60 * 1000;
const CACHE_MAX = 40;

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function writeCache(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');
    const body = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  } catch {
    if (pathname === '/') {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('UI files are missing. Run `npm start` from the project folder.');
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  }
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write('retry: 60000\n\n');

  const controller = new AbortController();
  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 15000);

  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    controller.abort();
  });

  return {
    get closed() {
      return closed;
    },
    signal: controller.signal,
    send(event, payload) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    },
    end() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      res.end();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Job                                                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Translating + assembling the document                               */
/* ------------------------------------------------------------------ */

// Shared by YouTube jobs and uploads. `overallBase` lets the progress bar keep
// climbing across the earlier speech-to-text phases of an upload.
async function deliverTranscript(stream, options) {
  const {
    video,
    segments,
    source,
    target,
    started,
    cacheKey = null,
    overallBase = null
  } = options;

  const language = getLanguage(target);
  const paragraphs = buildParagraphs(segments);
  if (!paragraphs.length) {
    const error = new Error('No speech found');
    error.code = 'SILENT_AUDIO';
    throw error;
  }

  const alreadyInTarget = sameLanguage(source.code, target);
  const startProgress = overallBase ?? 0;

  stream.send('stage', {
    step: 2,
    message: alreadyInTarget
      ? 'The audio is already in your chosen language — tidying the text'
      : `Translating ${paragraphs.length} passages into ${language.english}`,
    progress: startProgress || 0
  });

  let detected = normaliseLanguage(source.code).split('-')[0];
  let failures = 0;

  if (alreadyInTarget) {
    for (const paragraph of paragraphs) {
      for (const line of paragraph.lines) line.translated = line.text;
    }
    stream.send('progress', {
      blocks: paragraphs.map(toBlock),
      completed: paragraphs.length,
      total: paragraphs.length,
      detected,
      failures: 0,
      ...(overallBase === null ? {} : { overall: Math.min(0.96, overallBase + 0.4) })
    });
  } else {
    const result = await translateParagraphs(paragraphs, target, (batch, stats) => {
      if (stream.closed) return;
      if (stats.detected) detected = normaliseLanguage(stats.detected).split('-')[0];
      const ratio = stats.total ? Math.min(1, stats.completed / stats.total) : 0;
      stream.send('progress', {
        blocks: batch.map(toBlock),
        completed: stats.completed,
        total: stats.total,
        detected,
        ...(overallBase === null
          ? {}
          : { overall: Math.min(0.96, overallBase + ratio * 0.4) })
      });
    });
    failures = result.failures;
    if (result.detected) detected = normaliseLanguage(result.detected).split('-')[0];
  }

  const blocks = paragraphs.map(toBlock);
  const translatedSegments = segments.map((segment) => ({
    s: Math.round(segment.start * 100) / 100,
    e: Math.round(segment.end * 100) / 100,
    t: segment.translated ?? segment.text,
    o: segment.text
  }));

  const words = countWords(blocks.map((block) => block.t).join(' '));

  const transcript = {
    id: video.id,
    title: video.title,
    channel: video.channel,
    duration: video.duration,
    thumb: video.thumb,
    url: video.url || '',
    uploaded: Boolean(video.uploaded),
    chapters: video.chapters || [],
    lang: { code: language.code, english: language.english, native: language.native },
    source: {
      code: normaliseLanguage(source.code),
      name: source.name,
      auto: Boolean(source.auto)
    },
    detected,
    translated: !alreadyInTarget,
    blocks,
    segments: translatedSegments,
    words,
    warnings:
      failures > 0
        ? ['Some passages could not be translated and are shown in the original language.']
        : [],
    createdAt: new Date().toISOString(),
    cached: false,
    elapsed: Date.now() - started
  };

  stream.send('stage', {
    step: 3,
    message: 'Preparing your document',
    progress: 1
  });

  if (cacheKey) writeCache(cacheKey, transcript);
  stream.send('done', { transcript });
}

/* ------------------------------------------------------------------ */
/* YouTube job                                                         */
/* ------------------------------------------------------------------ */

async function runJob(stream, videoId, target) {
  const started = Date.now();

  const cached = readCache(`${videoId}:${target}`);
  const info = await getInfo(videoId);

  stream.send('meta', { video: publicInfo(info) });

  if (!info.track) {
    const error = new Error(
      info.hostBlocked ? 'YouTube requires a sign-in from this host' : 'No captions available'
    );
    error.code = info.hostBlocked ? 'HOST_BLOCKED' : 'NO_CAPTIONS';
    throw error;
  }

  const publicVideo = publicInfo(info);

  if (cached) {
    stream.send('stage', {
      step: 3,
      message: 'Ready from your recent session',
      progress: 1
    });
    stream.send('done', {
      transcript: { ...cached, cached: true, elapsed: Date.now() - started }
    });
    return;
  }

  stream.send('stage', {
    step: 1,
    message: `Fetching the ${info.track.auto ? 'auto-generated' : 'manual'} ${info.track.name || captionLanguageLabel(info.track.lang)} captions`,
    progress: null
  });

  const { segments } = await fetchSegments(videoId, info.track);
  if (!segments.length) {
    const error = new Error('No captions available');
    error.code = 'NO_CAPTIONS';
    throw error;
  }

  await deliverTranscript(stream, {
    video: publicVideo,
    segments,
    source: {
      code: info.track.lang,
      name: info.track.name || captionLanguageLabel(info.track.lang),
      auto: Boolean(info.track.auto)
    },
    target,
    started,
    cacheKey: `${videoId}:${target}`
  });
}

/* ------------------------------------------------------------------ */
/* Uploaded file job                                                   */
/* ------------------------------------------------------------------ */

function uploadTitle(name) {
  let value = String(name || '').trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep the raw name */
  }
  value = path
    .basename(value)
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (value || 'Uploaded recording').slice(0, 140);
}

async function saveUpload(req, file) {
  const maxBytes = UPLOAD_MAX_MB * 1024 * 1024;
  const declared = Number(req.headers['content-length']) || 0;
  if (declared > maxBytes) {
    const error = new Error('File too large');
    error.code = 'FILE_TOO_LARGE';
    error.limitMb = UPLOAD_MAX_MB;
    throw error;
  }

  const handle = await open(file, 'w');
  let bytes = 0;

  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = new Error('File too large');
        error.code = 'FILE_TOO_LARGE';
        error.limitMb = UPLOAD_MAX_MB;
        throw error;
      }
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }

  return bytes;
}

function uploadError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function runUploadJob(stream, { req, target, name, started }) {
  // Do this before reading the body: if speech recognition is unavailable,
  // there is no point accepting a large upload.
  const whisper = await hasWhisper();
  if (!whisper.available) throw uploadError('NO_WHISPER', 'Whisper is not installed');
  const ffmpeg = await hasFfmpeg();
  if (!ffmpeg.available) throw uploadError('NO_FFMPEG', 'ffmpeg is not installed');

  const workdir = await mkdtemp(path.join(os.tmpdir(), 'vaani-src-'));
  const file = path.join(workdir, 'upload.bin');

  try {
    stream.send('stage', {
      step: 0,
      message: 'Receiving the file…',
      progress: 0.02
    });

    const bytes = await saveUpload(req, file);
    if (!bytes) throw uploadError('EMPTY_UPLOAD', 'The upload was empty');

    stream.send('stage', {
      step: 0,
      message: 'Checking the media…',
      progress: 0.06
    });

    const media = await probeMedia(file).catch((error) => {
      if (error?.code === 'NO_FFMPEG' || error?.code === 'TIMEOUT') throw error;
      throw uploadError('BAD_MEDIA', error?.message || 'The file could not be read');
    });
    if (!media.hasAudio) throw uploadError('NO_AUDIO', 'This file has no audio track');

    const title = uploadTitle(name);
    const video = {
      id: `upload-${Date.now().toString(36)}`,
      title,
      channel: 'Uploaded file',
      duration: Math.round(media.duration || 0),
      thumb: '',
      url: '',
      language: '',
      sourceLanguage: null,
      track: null,
      hasCaptions: true,
      hostBlocked: false,
      captionCount: 0,
      chapters: [],
      uploaded: true
    };

    stream.send('meta', { video });

    const firstRun = (await modelReady()) ? '' : ` — first run downloads the ${whisperModel()} model`;
    stream.send('stage', {
      step: 1,
      message: `Extracting the audio${firstRun}`,
      progress: 0.1
    });

    const result = await transcribeFile(file, {
      signal: stream.signal,
      removeSource: true,
      onStage: (stage) => stream.send('stage', stage)
    });

    if (!result.segments.length) {
      throw uploadError('SILENT_AUDIO', 'No speech found in the audio');
    }

    video.duration =
      Math.round(media.duration || result.segments[result.segments.length - 1].end || 0) || 0;

    await deliverTranscript(stream, {
      video,
      segments: result.segments,
      source: {
        code: result.language,
        name: `${result.languageName} audio`,
        auto: false
      },
      target,
      started,
      overallBase: 0.55
    });
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Request handler                                                     */
/* ------------------------------------------------------------------ */

export async function handler(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendJson(res, 400, { error: 'Bad request' });
    return;
  }

  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (!isAuthorized(req, res)) return;

  const isUpload = req.method === 'POST' && pathname === '/api/upload';
  if (!isUpload && req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    if (pathname === '/api/health') {
      const yt = await hasYtdlp();
      const whisper = await hasWhisper();
      const ffmpeg = await hasFfmpeg();
      sendJson(res, 200, {
        ok: true,
        ytdlp: yt.available,
        ytdlpVersion: yt.version,
        whisper: whisper.available,
        whisperModel: whisper.model,
        ffmpeg: ffmpeg.available,
        maxUploadMb: UPLOAD_MAX_MB,
        cookies: Boolean(process.env.YOUTUBE_COOKIES_B64 || process.env.YOUTUBE_COOKIES),
        proxy: Boolean(process.env.YTDLP_PROXY),
        languages: LANGUAGES.length,
        uptime: Math.round(process.uptime())
      });
      return;
    }

    if (pathname === '/api/languages') {
      sendJson(res, 200, { languages: LANGUAGES });
      return;
    }

    if (pathname === '/api/info') {
      const videoId = extractVideoId(url.searchParams.get('url') || '');
      if (!videoId) {
        sendJson(res, 400, {
          error: { code: 'INVALID_URL', message: 'Paste a YouTube video link.' }
        });
        return;
      }

      try {
        const info = await getInfo(videoId);
        sendJson(res, 200, { video: publicInfo(info) });
      } catch (error) {
        const friendly = friendlyError(error);
        sendJson(res, 422, { error: friendly });
      }
      return;
    }

    if (pathname === '/api/upload' && req.method === 'POST') {
      const target = url.searchParams.get('lang') || 'ta';
      if (!isSupported(target)) {
        sendJson(res, 400, {
          error: { code: 'BAD_LANGUAGE', message: 'That language is not supported yet.' }
        });
        return;
      }

      const stream = openStream(req, res);
      const name = url.searchParams.get('name') || req.headers['x-file-name'] || '';

      runUploadJob(stream, { req, target, name, started: Date.now() })
        .catch((error) => {
          if (error?.code !== 'CANCELLED' && !stream.closed) {
            console.warn('[upload] failed:', error?.message || error);
            stream.send('fail', friendlyError(error));
          }
        })
        .finally(() => stream.end());
      return;
    }

    if (pathname === '/api/process') {
      const videoId = extractVideoId(url.searchParams.get('url') || '');
      const target = url.searchParams.get('lang') || 'ta';

      if (!videoId) {
        sendJson(res, 400, {
          error: { code: 'INVALID_URL', message: 'Paste a valid YouTube video link.' }
        });
        return;
      }
      if (!isSupported(target)) {
        sendJson(res, 400, {
          error: { code: 'BAD_LANGUAGE', message: 'That language is not supported yet.' }
        });
        return;
      }

      const stream = openStream(req, res);
      req.on('close', () => {
        if (!stream.closed) stream.end();
      });

      runJob(stream, videoId, target)
        .catch((error) => {
          console.warn('[job] failed:', error?.message || error);
          stream.send('fail', friendlyError(error));
        })
        .finally(() => stream.end());
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Unknown endpoint' });
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    console.error('[server]', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
    else res.end();
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const server = http.createServer(handler);
  // Uploads can take a while to arrive on slow connections.
  server.requestTimeout = 0;

  server.listen(PORT, HOST, () => {
    console.log(`\n  Vaani · transcript studio`);
    console.log(`  → http://localhost:${PORT}\n`);
    if (AUTH_ON) console.log(`  Basic auth on (user: ${AUTH_USER})\n`);
    hasYtdlp().then((yt) => {
      console.log(
        yt.available
          ? `  yt-dlp ${yt.version} ready`
          : '  yt-dlp not found — falling back to YouTube captions API'
      );
    });
    hasWhisper().then((whisper) => {
      console.log(
        whisper.available
          ? `  Whisper ready (${whisper.model} model) — uploads enabled`
          : '  Whisper not found — uploads disabled, YouTube captions still work'
      );
    });
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use — Vaani may already be running.`);
      console.error(`  Open http://localhost:${PORT} or start on another port: PORT=4174 npm start\n`);
      process.exit(1);
    }
    throw error;
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1200).unref();
    });
  }
}
