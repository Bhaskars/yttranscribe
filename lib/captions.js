// Parsers for the caption formats yt-dlp / YouTube can return (json3 and WebVTT),
// plus the paragraph grouping used by the reader view.

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“'
};

const NOISE = /\[(?:music|applause|laughter|inaudible|silence|cheering|சங்கீதம்|கரவொலி|இசை)\]/gi;

export function cleanText(input) {
  let s = String(input ?? '');
  s = s.replace(/[\u200b-\u200d\ufeff]/g, '');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] && body[1].toLowerCase() === 'x';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const value = NAMED_ENTITIES[body.toLowerCase()];
    return value ?? match;
  });
  s = s.replace(NOISE, ' ');
  s = s.replace(/^>>+\s*/g, '').replace(/\s*>>+\s*/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function parseTimestamp(value) {
  const parts = String(value).trim().replace(',', '.').split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds;
}

function hasContent(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

export function normalizeSegments(raw, { rolling = false } = {}) {
  const out = [];

  for (const item of raw) {
    const text = hasContent(item.text) ? item.text : '';
    if (!text) continue;

    const start = Math.max(0, Number(item.start) || 0);
    const end = Math.max(start + 0.45, Number(item.end) || start + 1.6);
    const seg = { start, end, text };

    const prev = out[out.length - 1];
    if (!prev) {
      out.push(seg);
      continue;
    }

    if (seg.text === prev.text) {
      prev.end = Math.max(prev.end, seg.end);
      continue;
    }

    if (rolling) {
      const merged = mergeRolling(prev, seg);
      if (merged) continue;
    }

    out.push(seg);
  }

  // Keep timings sane and non-decreasing at the start.
  let cursor = 0;
  for (const seg of out) {
    seg.start = Math.max(seg.start, cursor);
    seg.end = Math.max(seg.end, seg.start + 0.5);
    cursor = seg.start;
  }

  return out.map((seg) => ({
    start: Math.round(seg.start * 1000) / 1000,
    end: Math.round(seg.end * 1000) / 1000,
    text: seg.text
  }));
}

// Auto captions scroll: each cue repeats the tail of the previous one.
// If we detect a 3+ word overlap, extend the previous cue and keep only the new words.
function mergeRolling(prev, seg) {
  const prevWords = prev.text.split(' ');
  const nextWords = seg.text.split(' ');
  const maxCheck = Math.min(prevWords.length, nextWords.length, 14);

  for (let n = maxCheck; n >= 3; n--) {
    const tail = prevWords.slice(-n).join(' ').toLowerCase();
    const head = nextWords.slice(0, n).join(' ').toLowerCase();
    if (tail !== head) continue;

    const remainder = nextWords.slice(n).join(' ');
    prev.end = Math.max(prev.end, seg.end);
    if (remainder) {
      prev.text = `${prev.text} ${remainder}`.replace(/\s+/g, ' ').trim();
    }
    return true;
  }

  return false;
}

export function parseJson3(raw) {
  const doc = JSON.parse(raw);
  const events = Array.isArray(doc?.events) ? doc.events : [];
  const rawSegments = [];

  for (const event of events) {
    if (!Array.isArray(event?.segs)) continue;
    const text = cleanText(event.segs.map((s) => s?.utf8 ?? '').join(''));
    if (!text) continue;
    const start = (Number(event.tStartMs) || 0) / 1000;
    const duration = (Number(event.dDurationMs) || 0) / 1000;
    rawSegments.push({ start, end: start + duration, text });
  }

  return normalizeSegments(rawSegments);
}

export function parseVtt(raw) {
  const text = String(raw).replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const rawSegments = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0])) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(lines[0])) continue;

    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex === -1) continue;

    const [left, right] = lines[timeIndex].split('-->');
    const start = parseTimestamp(left);
    const end = parseTimestamp((right || '').split(/\s+/)[0]);
    const body = cleanText(lines.slice(timeIndex + 1).join(' '));
    if (!body) continue;

    rawSegments.push({ start, end, text: body });
  }

  return normalizeSegments(rawSegments, { rolling: true });
}

// Simple <text start="1.2" dur="3.4">...</text> timedtext XML.
export function parseTimedTextXml(raw) {
  const xml = String(raw);
  const re = /<text\b[^>]*\bstart="([\d.]+)"[^>]*?(?:\bdur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  const rawSegments = [];
  let match;
  while ((match = re.exec(xml))) {
    const start = Number(match[1]) || 0;
    const duration = Number(match[2]) || 1.8;
    const body = cleanText(match[3]);
    if (body) rawSegments.push({ start, end: start + duration, text: body });
  }
  return normalizeSegments(rawSegments, { rolling: true });
}

export function parseCaptions(raw, format) {
  const fmt = String(format || '').toLowerCase();
  if (fmt === 'json3' || fmt === 'json') return parseJson3(raw);
  if (fmt === 'vtt' || fmt === 'webvtt') return parseVtt(raw);
  if (fmt === 'xml' || fmt === 'ttml') return parseTimedTextXml(raw);
  throw new Error(`Unsupported caption format: ${format}`);
}

/**
 * Group caption lines into readable paragraphs. Paragraphs are also the unit
 * we translate, so keeping them around 500-700 characters keeps requests small.
 */
export function buildParagraphs(segments, options = {}) {
  const { maxChars = 640, maxLines = 9, pause = 2.4 } = options;
  const paragraphs = [];
  let current = null;

  const flush = () => {
    if (current && current.lines.length) paragraphs.push(current);
    current = null;
  };

  for (const seg of segments) {
    const text = seg.text;
    if (!current) {
      current = { start: seg.start, end: seg.end, lines: [seg], chars: text.length };
      continue;
    }

    const lastText = current.lines[current.lines.length - 1].text;
    const gap = seg.start - current.end;
    const endedSentence = /[.!?।。…]["'”’)]?$/.test(lastText);
    const tooBig = current.chars + text.length > maxChars || current.lines.length >= maxLines;
    const longPause = gap > pause && current.chars > 90;
    const sentenceStop = endedSentence && current.chars > 300;

    if (tooBig || longPause || sentenceStop) {
      flush();
      current = { start: seg.start, end: seg.end, lines: [seg], chars: text.length };
      continue;
    }

    current.lines.push(seg);
    current.end = seg.end;
    current.chars += text.length + 1;
  }

  flush();
  return paragraphs;
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`;
}
