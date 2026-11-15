// YouTube metadata + caption retrieval.
//
// Primary path: yt-dlp (best coverage of manual and auto-generated captions).
// Fallback: YouTube's innertube player API + oEmbed metadata, so the app still
// works on machines without yt-dlp.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captionLanguageLabel } from './languages.js';
import { parseCaptions } from './captions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Vercel builds download Linux yt-dlp builds into bin/. Local development (and
// any non-Linux host) keeps using the binary on PATH.
const ytDlpArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const bundledYtdlp =
  process.platform === 'linux'
    ? [
        path.join(__dirname, '..', 'bin', `yt-dlp-${ytDlpArch}`),
        path.join(__dirname, '..', 'bin', 'yt-dlp'),
        '/var/task/bin/yt-dlp'
      ]
    : [];
const ytdlpCandidates = [process.env.YTDLP_PATH, ...bundledYtdlp].filter(Boolean);
const YTDLP = ytdlpCandidates.find((candidate) => existsSync(candidate)) || 'yt-dlp';

// Cloud hosts are often asked to "sign in to confirm you're not a bot".
// Supplying your own YouTube cookies (or a proxy) restores caption access.
const COOKIE_SOURCE = process.env.YOUTUBE_COOKIES_B64 || process.env.YOUTUBE_COOKIES || '';
const PROXY_ARGS = process.env.YTDLP_PROXY ? ['--proxy', process.env.YTDLP_PROXY] : [];

let cookieFile = null;

async function authArgs() {
  if (!COOKIE_SOURCE) return PROXY_ARGS;
  if (!cookieFile) {
    const raw = process.env.YOUTUBE_COOKIES_B64
      ? Buffer.from(COOKIE_SOURCE, 'base64').toString('utf8')
      : COOKIE_SOURCE;
    const file = path.join(os.tmpdir(), 'vaani-youtube-cookies.txt');
    await writeFile(file, raw, { mode: 0o600 });
    cookieFile = file;
  }
  return ['--cookies', cookieFile, ...PROXY_ARGS];
}
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;

export function extractVideoId(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (videoIdPattern.test(raw)) return raw;

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, '').replace(/^m\./i, '').toLowerCase();
  const youtubeHosts = new Set(['youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return videoIdPattern.test(id || '') ? id : null;
  }

  if (!youtubeHosts.has(host)) return null;

  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v');
    return videoIdPattern.test(id || '') ? id : null;
  }

  const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ */
/* Process helpers                                                     */
/* ------------------------------------------------------------------ */

function makeLimiter(max) {
  let active = 0;
  const waiting = [];

  return async function limit(task) {
    if (active >= max) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  };
}

const limitDownload = makeLimiter(2);
const limitInfo = makeLimiter(3);

function runProcess(command, args, { timeout = 120000, maxBuffer = 40 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let size = 0;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`Timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBuffer) {
        child.kill('SIGKILL');
        finish(reject, new Error('Process output too large'));
        return;
      }
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    child.on('error', (error) => {
      const wrapped = new Error(
        error.code === 'ENOENT' ? `Not installed: ${command}` : error.message
      );
      wrapped.code = error.code;
      finish(reject, wrapped);
    });

    child.on('close', (code) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
        return;
      }
      const error = new Error(stderr.trim().split('\n').filter(Boolean).at(-1) || `Exited with code ${code}`);
      error.code = code;
      error.stderr = stderr;
      finish(reject, error);
    });
  });
}

let ytdlpCheck = null;

export function hasYtdlp() {
  if (!ytdlpCheck) {
    ytdlpCheck = runProcess(YTDLP, ['--version'], { timeout: 10000 })
      .then(({ stdout }) => ({ available: true, version: stdout.trim() }))
      .catch(() => ({ available: false, version: null }));
  }
  return ytdlpCheck;
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

const infoCache = new Map(); // id -> { at, info, raw }
const INFO_TTL = 30 * 60 * 1000;

function trackFromMeta(meta) {
  const manual = meta?.subtitles || {};
  const auto = meta?.automatic_captions || {};
  const tracks = [];

  for (const [lang, entries] of Object.entries(manual)) {
    tracks.push({ lang, auto: false, name: entries?.[0]?.name || captionLanguageLabel(lang) });
  }
  for (const [lang, entries] of Object.entries(auto)) {
    tracks.push({ lang, auto: true, name: entries?.[0]?.name || captionLanguageLabel(lang) });
  }

  return tracks;
}

function chooseTrack(tracks, language) {
  if (!tracks.length) return null;
  const base = String(language || '').toLowerCase().split(/[-_]/)[0];
  const norm = (code) => String(code).toLowerCase().split(/[-_]/)[0];

  // 1. The video's own language, preferring manual captions.
  if (base) {
    const manual = tracks.find((t) => !t.auto && norm(t.lang) === base);
    if (manual) return manual;
    const auto = tracks.find((t) => t.auto && t.lang.toLowerCase() === base);
    if (auto) return auto;
  }

  // 2. Manual English, then any manual track.
  const manualEn = tracks.find((t) => !t.auto && norm(t.lang) === 'en');
  if (manualEn) return manualEn;
  const manualAny = tracks.find((t) => !t.auto);
  if (manualAny) return manualAny;

  // 3. Auto English original / en, then anything.
  const orig = tracks.find((t) => t.auto && t.lang.toLowerCase() === 'en-orig');
  if (orig) return orig;
  const autoEn = tracks.find((t) => t.auto && t.lang.toLowerCase() === 'en');
  if (autoEn) return autoEn;
  const autoSimple = tracks.find((t) => t.auto && !t.lang.includes('-'));
  return autoSimple || tracks[0];
}

function pickThumb(meta, id) {
  const thumbs = (meta?.thumbnails || []).filter((t) => t?.url);
  if (thumbs.length) {
    const sorted = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0));
    const wide = sorted.find((t) => (t.width || 0) <= 1600) || sorted[0];
    return wide.url;
  }
  return `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
}

function publicInfo(info) {
  return {
    id: info.id,
    title: info.title,
    channel: info.channel,
    duration: info.duration,
    thumb: info.thumb,
    url: `https://www.youtube.com/watch?v=${info.id}`,
    language: info.language,
    sourceLanguage: info.track ? captionLanguageLabel(info.track.lang) : null,
    track: info.track
      ? {
          lang: info.track.lang,
          auto: info.track.auto,
          name: info.track.name || captionLanguageLabel(info.track.lang)
        }
      : null,
    hasCaptions: Boolean(info.track),
    hostBlocked: Boolean(info.hostBlocked),
    captionCount: info.tracks?.length || 0,
    chapters: info.chapters || []
  };
}

export { publicInfo };

async function infoFromYtdlp(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const auth = await authArgs();
  const { stdout } = await limitInfo(() =>
    runProcess(
      YTDLP,
      ['-J', '--no-warnings', '--no-playlist', '--socket-timeout', '15', ...auth, url],
      { timeout: 75000 }
    )
  );

  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .at(-1);
  if (!line) throw new Error('Could not read video metadata');

  const meta = JSON.parse(line);
  if (meta?._type === 'playlist' || meta?.entries?.length) {
    throw new Error('Playlists are not supported — paste a single video link');
  }
  if (meta?.is_live) {
    // Live streams can still have captions; keep going if tracks exist.
  }

  const tracks = trackFromMeta(meta);
  const track = chooseTrack(tracks, meta.language);

  return {
    id: videoId,
    title: meta.title || 'Untitled video',
    channel: meta.uploader || meta.channel || 'Unknown channel',
    duration: Number(meta.duration) || 0,
    thumb: pickThumb(meta, videoId),
    language: meta.language || track?.lang || '',
    tracks,
    track,
    chapters: (meta.chapters || [])
      .map((c) => ({ title: String(c.title || '').trim(), start: Number(c.start_time) || 0 }))
      .filter((c) => c.title && Number.isFinite(c.start)),
    via: 'yt-dlp'
  };
}

/* ------------------------------------------------------------------ */
/* Innertube fallback                                                  */
/* ------------------------------------------------------------------ */

const CLIENTS = [
  {
    name: 'WEB',
    version: '2.20240726.00.00',
    userAgent: UA,
    headers: { 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': '2.20240726.00.00' }
  },
  {
    name: 'IOS',
    version: '19.45.4',
    userAgent: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)',
    headers: { 'X-Youtube-Client-Name': '5', 'X-Youtube-Client-Version': '19.45.4' }
  },
  {
    name: 'ANDROID',
    version: '19.44.38',
    userAgent: 'com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip',
    headers: { 'X-Youtube-Client-Name': '3', 'X-Youtube-Client-Version': '19.44.38' }
  }
];

async function innertubePlayer(videoId) {
  let lastError;

  for (const client of CLIENTS) {
    try {
      const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': client.userAgent,
          ...client.headers
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: client.name,
              clientVersion: client.version,
              hl: 'en',
              gl: 'US'
            }
          },
          videoId
        }),
        signal: AbortSignal.timeout(12000)
      });

      if (!res.ok) {
        lastError = new Error(`YouTube said ${res.status}`);
        continue;
      }

      const data = await res.json();
      const status = data?.playabilityStatus?.status;
      const hasDetails = Boolean(data?.videoDetails?.title);
      if (!hasDetails || status === 'ERROR') {
        lastError = new Error(data?.playabilityStatus?.reason || 'Video unavailable');
        continue;
      }

      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Could not reach YouTube');
}

const playerCache = new Map(); // id -> { at, data }
const PLAYER_TTL = 15 * 60 * 1000;

async function getPlayer(videoId) {
  const cached = playerCache.get(videoId);
  if (cached && Date.now() - cached.at < PLAYER_TTL) return cached.data;
  const data = await innertubePlayer(videoId);
  playerCache.set(videoId, { at: Date.now(), data });
  return data;
}

function tracksFromPlayer(player) {
  const list =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  return list
    .filter((track) => track?.baseUrl)
    .map((track) => ({
      lang: track.languageCode || 'en',
      auto: track.kind === 'asr',
      name:
        track.name?.runs?.map((r) => r.text).join('') ||
        track.name?.simpleText ||
        captionLanguageLabel(track.languageCode),
      url: track.baseUrl
    }));
}

async function infoFromInnertube(videoId) {
  const player = await getPlayer(videoId);
  const details = player.videoDetails || {};
  const tracks = tracksFromPlayer(player);
  const track = chooseTrack(tracks, details.defaultAudioLanguage || details.language);

  let channel = details.author || 'Unknown channel';
  let thumb = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        `https://www.youtube.com/watch?v=${videoId}`
      )}&format=json`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = await res.json();
      channel = data.author_name || channel;
      thumb = data.thumbnail_url || thumb;
    }
  } catch {
    /* thumbnail fallback is fine */
  }

  return {
    id: videoId,
    title: details.title || 'Untitled video',
    channel,
    duration: Number(details.lengthSeconds) || 0,
    thumb,
    language: details.defaultAudioLanguage || details.language || track?.lang || '',
    tracks,
    track,
    chapters: [],
    via: 'innertube'
  };
}

async function infoFromOembed(videoId) {
  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}&format=json`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error('This video could not be found');
  const data = await res.json();
  return {
    id: videoId,
    title: data.title || 'Untitled video',
    channel: data.author_name || 'Unknown channel',
    duration: 0,
    thumb: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    language: '',
    tracks: [],
    track: null,
    chapters: [],
    via: 'oembed'
  };
}

export async function getInfo(videoId, { force = false } = {}) {
  const cached = infoCache.get(videoId);
  if (!force && cached && Date.now() - cached.at < INFO_TTL) return cached.info;

  const { available } = await hasYtdlp();
  let info = null;
  let lastError = null;
  let hostBlocked = false;

  if (available) {
    try {
      info = await infoFromYtdlp(videoId);
    } catch (error) {
      lastError = error;
      if (/not a bot|confirm you.{0,10}re not a bot/i.test(`${error.message} ${error.stderr || ''}`)) {
        hostBlocked = true;
      }
      console.warn('[youtube] yt-dlp metadata failed:', error.message);
    }
  }

  if (!info) {
    try {
      info = await infoFromInnertube(videoId);
    } catch (error) {
      lastError = error;
      if (/not a bot|confirm you.{0,10}re not a bot/i.test(`${error.message} ${error.stderr || ''}`)) {
        hostBlocked = true;
      }
      console.warn('[youtube] innertube metadata failed:', error.message);
    }
  }

  if (!info) {
    try {
      info = await infoFromOembed(videoId);
      if (hostBlocked) info.hostBlocked = true;
    } catch (error) {
      lastError = error;
    }
  }

  if (!info) {
    const error = new Error(
      'This video could not be read. It may be private, age-restricted, or removed.'
    );
    error.cause = lastError;
    throw error;
  }

  infoCache.set(videoId, { at: Date.now(), info });
  return info;
}

/* ------------------------------------------------------------------ */
/* Captions                                                            */
/* ------------------------------------------------------------------ */

function pickCaptionFile(files, lang) {
  const candidates = files.filter((f) => /\.(json3|vtt|srt)$/i.test(f));
  if (!candidates.length) return null;

  const exact = candidates.find((f) => f.includes(`.${lang}.`));
  const preferred = exact || candidates[0];
  return preferred;
}

async function downloadWithYtdlp(videoId, track) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vaani-'));
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const auth = await authArgs();
  const base = [
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout',
    '15',
    '--sub-format',
    'json3/vtt',
    ...auth,
    '-o',
    path.join(dir, 'cap')
  ];

  const baseLang = String(track.lang).split('-')[0];
  const attempts = [
    { lang: track.lang, extra: [] },
    { lang: baseLang, extra: [] },
    {
      lang: track.lang,
      extra: ['--extractor-args', 'youtube:player_client=web_safari,tv']
    }
  ];

  let lastError = null;
  const tried = new Set();

  try {
    for (const attempt of attempts) {
      if (tried.has(attempt.lang) && !attempt.extra.length) continue;
      tried.add(attempt.lang);
      try {
        await limitDownload(() =>
          runProcess(YTDLP, [...base, '--write-subs', '--write-auto-subs', '--sub-langs', attempt.lang, ...attempt.extra, url], {
            timeout: 90000
          })
        );
      } catch (error) {
        lastError = error;
      }

      const files = await readdir(dir);
      const name = pickCaptionFile(files, attempt.lang);
      if (!name) continue;

      const raw = await readFile(path.join(dir, name), 'utf8');
      const ext = name.split('.').pop().toLowerCase();
      const segments = parseCaptions(raw, ext);
      if (segments.length) return { segments, format: ext };
      lastError = new Error('Caption file was empty');
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  throw lastError || new Error('No caption file was produced');
}

async function fetchTrackUrl(track, videoId) {
  let url = track?.url;
  if (!url) {
    const player = await getPlayer(videoId);
    const tracks = tracksFromPlayer(player);
    const match =
      tracks.find((t) => t.lang === track?.lang) ||
      tracks.find((t) => t.lang.split('-')[0] === String(track?.lang || '').split('-')[0]) ||
      tracks[0];
    url = match?.url;
  }
  if (!url) throw new Error('No caption track URL available');
  return url;
}

async function downloadWithInnertube(videoId, track) {
  const baseUrl = await fetchTrackUrl(track, videoId);
  const urls = [];

  try {
    const parsed = new URL(baseUrl);
    parsed.searchParams.set('fmt', 'json3');
    urls.push(parsed.toString());
    parsed.searchParams.set('fmt', 'vtt');
    urls.push(parsed.toString());
  } catch {
    urls.push(baseUrl);
  }

  let lastError = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) throw new Error(`Caption request failed (${res.status})`);
      const raw = await res.text();
      if (!raw.trim()) throw new Error('Caption response was empty');

      if (raw.trimStart().startsWith('{')) {
        return { segments: parseCaptions(raw, 'json3'), format: 'json3' };
      }
      if (/^\s*WEBVTT/i.test(raw)) {
        return { segments: parseCaptions(raw, 'vtt'), format: 'vtt' };
      }
      return { segments: parseCaptions(raw, 'xml'), format: 'xml' };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Could not download captions');
}

export async function fetchSegments(videoId, track) {
  if (!track) {
    const error = new Error('No captions available');
    error.code = 'NO_CAPTIONS';
    throw error;
  }

  const { available } = await hasYtdlp();
  let lastError = null;

  if (available) {
    try {
      const result = await downloadWithYtdlp(videoId, track);
      if (result.segments.length) return result;
    } catch (error) {
      lastError = error;
      console.warn('[youtube] yt-dlp captions failed:', error.message);
    }
  }

  try {
    const result = await downloadWithInnertube(videoId, track);
    if (result.segments.length) return result;
  } catch (error) {
    lastError = error;
    console.warn('[youtube] innertube captions failed:', error.message);
  }

  const error = new Error(
    lastError?.message || 'Captions could not be downloaded for this video.'
  );
  error.code = 'CAPTION_FETCH_FAILED';
  throw error;
}
