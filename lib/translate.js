// Translation helpers.
//
// Default path uses Google's public translate endpoint (no API key), which
// preserves newlines when lines are sent as separate lines. That lets us keep
// caption timings aligned. If GOOGLE_TRANSLATE_API_KEY is set, the official
// v2 API is used instead.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const CHUNK_BUDGET = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

async function translateOfficial(text, target, key) {
  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, target, format: 'text' }),
      signal: AbortSignal.timeout(25000)
    }
  );
  if (!res.ok) throw new Error(`translate ${res.status}`);
  const data = await res.json();
  const translated = data?.data?.translations?.[0];
  if (!translated) throw new Error('translate: empty response');
  return {
    text: decodeEntities(translated.translatedText ?? ''),
    detected: translated.detectedSourceLanguage || ''
  };
}

async function translateFree(text, target) {
  const params = new URLSearchParams({ q: text });
  const res = await fetch(
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': UA
      },
      body: params.toString(),
      signal: AbortSignal.timeout(25000)
    }
  );
  if (!res.ok) {
    const error = new Error(`translate ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  if (!Array.isArray(data?.[0])) throw new Error('translate: unexpected response');
  const output = data[0].map((part) => part?.[0] ?? '').join('');
  return { text: output, detected: typeof data[2] === 'string' ? data[2] : '' };
}

async function once(text, target) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  return key ? translateOfficial(text, target, key) : translateFree(text, target);
}

async function withRetry(fn, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) break;
      const rateLimited = error?.status === 429;
      await sleep((rateLimited ? 2200 : 550) * (i + 1));
    }
  }
  throw lastError;
}

export async function translateText(text, target) {
  const value = String(text ?? '').trim();
  if (!value) return { text: '', detected: '' };
  return withRetry(() => once(value, target));
}

/**
 * Translate an array of caption lines while keeping a 1:1 mapping.
 * Returns lines: null when Google merged/split lines and the caller
 * should fall back to a paragraph-level translation.
 */
export async function translateLines(lines, target) {
  if (!lines.length) return { lines: [], detected: '' };
  const joined = lines.join('\n');
  const result = await translateText(joined, target);
  let parts = result.text.replace(/\n+$/, '').split('\n');

  if (parts.length === lines.length) {
    return {
      lines: parts.map((line) => line.replace(/\s+/g, ' ').trim()),
      detected: result.detected
    };
  }

  return { lines: null, text: result.text, detected: result.detected };
}

function batchParagraphs(paragraphs, budget = CHUNK_BUDGET) {
  const batches = [];
  let batch = [];
  let chars = 0;

  for (const paragraph of paragraphs) {
    const size = paragraph.lines.reduce((total, line) => total + line.text.length + 1, 0);
    if (batch.length && chars + size > budget) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(paragraph);
    chars += size;
  }
  if (batch.length) batches.push(batch);

  return batches;
}

// Last-resort split when the service returns one blob for several lines.
function distribute(lines, translatedText) {
  const words = String(translatedText).split(/\s+/).filter(Boolean);
  if (!words.length) {
    lines.forEach((line) => {
      line.translated = line.text;
    });
    return;
  }

  const weights = lines.map((line) => Math.max(1, line.text.split(/\s+/).length));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  let used = 0;

  lines.forEach((line, index) => {
    const isLast = index === lines.length - 1;
    const count = isLast
      ? words.length - used
      : Math.max(1, Math.round((words.length * weights[index]) / totalWeight));
    line.translated = words.slice(used, used + count).join(' ');
    used += count;
  });

  if (used < words.length) {
    lines[lines.length - 1].translated += ` ${words.slice(used).join(' ')}`;
  }
}

/**
 * Translate paragraphs in batches, emitting progress as we go.
 * Every caption line receives a `.translated` value.
 */
export async function translateParagraphs(paragraphs, target, onBatch) {
  const batches = batchParagraphs(paragraphs);
  let completed = 0;
  let detected = '';
  let failures = 0;

  for (const batch of batches) {
    const lines = batch.flatMap((paragraph) => paragraph.lines);

    try {
      const result = await withRetry(() => translateLines(lines.map((line) => line.text), target));
      if (result.detected) detected = detected || result.detected;

      if (result.lines) {
        let index = 0;
        for (const line of lines) line.translated = result.lines[index++];
      } else {
        for (const paragraph of batch) {
          const text = paragraph.lines.map((line) => line.text).join(' ');
          const translated = await withRetry(() => translateText(text, target));
          if (translated.detected) detected = detected || translated.detected;
          distribute(paragraph.lines, translated.text);
        }
      }
    } catch (error) {
      failures += 1;
      console.warn('[translate] batch failed:', error?.message || error);
      for (const line of lines) line.translated = line.text;
    }

    completed += batch.length;
    onBatch?.(batch, {
      completed,
      total: paragraphs.length,
      detected,
      failures
    });
  }

  return { detected, failures, batches: batches.length };
}
