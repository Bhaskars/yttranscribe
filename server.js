import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANGUAGES, getLanguage, isSupported, captionLanguageLabel } from './lib/languages.js';
import { buildParagraphs } from './lib/captions.js';
import { translateParagraphs } from './lib/translate.js';
import { extractVideoId, getInfo, fetchSegments, publicInfo, hasYtdlp } from './lib/youtube.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';

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

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 15000);

  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
  });

  return {
    get closed() {
      return closed;
    },
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

async function runJob(stream, videoId, target) {
  const language = getLanguage(target);
  const started = Date.now();

  const cached = readCache(`${videoId}:${target}`);
  const info = await getInfo(videoId);

  stream.send('meta', { video: publicInfo(info) });

  if (!info.track) {
    const error = new Error('No captions available');
    error.code = 'NO_CAPTIONS';
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

  const paragraphs = buildParagraphs(segments);
  if (!paragraphs.length) {
    const error = new Error('No captions available');
    error.code = 'NO_CAPTIONS';
    throw error;
  }

  const alreadyInTarget = sameLanguage(info.language || info.track.lang, target);

  stream.send('stage', {
    step: 2,
    message: alreadyInTarget
      ? 'The video is already in your chosen language — tidying the text'
      : `Translating ${paragraphs.length} passages into ${language.english}`,
    progress: 0
  });

  let detected = normaliseLanguage(info.track.lang).split('-')[0];
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
      failures: 0
    });
  } else {
    const result = await translateParagraphs(paragraphs, target, (batch, stats) => {
      if (stream.closed) return;
      if (stats.detected) detected = normaliseLanguage(stats.detected).split('-')[0];
      stream.send('progress', {
        blocks: batch.map(toBlock),
        completed: stats.completed,
        total: stats.total,
        detected
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
    id: videoId,
    title: publicVideo.title,
    channel: publicVideo.channel,
    duration: publicVideo.duration,
    thumb: publicVideo.thumb,
    url: publicVideo.url,
    chapters: publicVideo.chapters,
    lang: { code: language.code, english: language.english, native: language.native },
    source: {
      code: normaliseLanguage(info.track.lang),
      name: info.track.name || captionLanguageLabel(info.track.lang),
      auto: Boolean(info.track.auto)
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

  writeCache(`${videoId}:${target}`, transcript);
  stream.send('done', { transcript });
}

/* ------------------------------------------------------------------ */
/* Request handler                                                     */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    if (pathname === '/api/health') {
      const yt = await hasYtdlp();
      sendJson(res, 200, {
        ok: true,
        ytdlp: yt.available,
        ytdlpVersion: yt.version,
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
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Vaani · transcript studio`);
  console.log(`  → http://localhost:${PORT}\n`);
  hasYtdlp().then((yt) => {
    console.log(
      yt.available
        ? `  yt-dlp ${yt.version} ready`
        : '  yt-dlp not found — falling back to YouTube captions API'
    );
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200).unref();
  });
}
