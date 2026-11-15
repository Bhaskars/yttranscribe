/* ------------------------------------------------------------------ */
/* Vaani — client                                                      */
/* ------------------------------------------------------------------ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const STORE = {
  theme: 'vaani.theme',
  lang: 'vaani.lang',
  bilingual: 'vaani.bilingual',
  timestamps: 'vaani.timestamps',
  scale: 'vaani.scale',
  history: 'vaani.history'
};

const state = {
  running: false,
  finished: false,
  es: null,
  video: null,
  transcript: null,
  renderedBlocks: [],
  chaptersEmitted: new Set(),
  lastChapterStart: -1,
  lastUrl: '',
  jobLang: 'ta',
  previewAbort: null,
  previewTimer: null,
  toastTimer: null,
  scale: 1
};

const el = {
  themeBtn: $('#themeBtn'),
  form: $('#form'),
  url: $('#url'),
  inputWrap: $('#inputWrap'),
  pasteBtn: $('#pasteBtn'),
  urlError: $('#urlError'),
  preview: $('#preview'),
  lang: $('#lang'),
  langNote: $('#langNote'),
  bilingual: $('#bilingual'),
  timestamps: $('#timestamps'),
  goBtn: $('#goBtn'),
  goText: $('.btn-text', $('#goBtn')),
  empty: $('#empty'),
  workCard: $('#workCard'),
  workTitle: $('#workTitle'),
  workPct: $('#workPct'),
  bar: $('.bar', $('#workCard')),
  barFill: $('#barFill'),
  miniSteps: $('#miniSteps'),
  workNote: $('#workNote'),
  errorCard: $('#errorCard'),
  errorTitle: $('#errorTitle'),
  errorMessage: $('#errorMessage'),
  errorHint: $('#errorHint'),
  retryBtn: $('#retryBtn'),
  dismissBtn: $('#dismissBtn'),
  doc: $('#doc'),
  thumbLink: $('#thumbLink'),
  thumbImg: $('#thumbImg'),
  docLangBadge: $('#docLangBadge'),
  docSource: $('#docSource'),
  docTitle: $('#docTitle'),
  docChannel: $('#docChannel'),
  docDuration: $('#docDuration'),
  docStats: $('#docStats'),
  docProgress: $('#docProgress'),
  docProgressText: $('#docProgressText'),
  docBody: $('#docBody'),
  warnBanner: $('#warnBanner'),
  langPrompt: $('#langPrompt'),
  langPromptText: $('#langPromptText'),
  langSwitchBtn: $('#langSwitchBtn'),
  docUrl: $('#docUrl'),
  docActions: $$('.tool'),
  fontDown: $('#fontDown'),
  fontUp: $('#fontUp'),
  recentWrap: $('#recentWrap'),
  recentList: $('#recentList'),
  clearRecent: $('#clearRecent'),
  toast: $('#toast')
};

const FALLBACK_LANGUAGES = [
  { code: 'ta', english: 'Tamil', native: 'தமிழ்', region: 'India' },
  { code: 'en', english: 'English', native: 'English', region: 'India' },
  { code: 'hi', english: 'Hindi', native: 'हिन्दी', region: 'India' },
  { code: 'ar', english: 'Arabic', native: 'العربية', region: 'World' },
  { code: 'fr', english: 'French', native: 'Français', region: 'World' },
  { code: 'es', english: 'Spanish', native: 'Español', region: 'World' }
];

let languages = FALLBACK_LANGUAGES;

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

function extractVideoId(input) {
  const raw = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;

  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./i, '').replace(/^m\./i, '').toLowerCase();
  const valid = (id) => (/^[A-Za-z0-9_-]{11}$/.test(String(id || '')) ? id : null);

  if (host === 'youtu.be') return valid(parsed.pathname.split('/').filter(Boolean)[0]);

  if (!['youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) return null;

  if (parsed.pathname === '/watch') return valid(parsed.searchParams.get('v'));

  const match = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/);
  return match ? match[1] : null;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return 'Live / unknown';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatSrtTime(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rest = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`;
}

function plural(count, word) {
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
}

function slugify(text) {
  return (
    String(text || 'transcript')
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'transcript'
  );
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
}

function setThumbnail(img, src, id) {
  const chain = [
    src,
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
  ].filter(Boolean);

  let index = 0;
  img.onerror = () => {
    index += 1;
    if (index < chain.length) img.src = chain[index];
  };
  img.src = chain[0];
}

function languageByCode(code) {
  return languages.find((l) => l.code === code) || FALLBACK_LANGUAGES[0];
}

/* ------------------------------------------------------------------ */
/* Theme + reading preferences                                         */
/* ------------------------------------------------------------------ */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  el.themeBtn.setAttribute(
    'aria-label',
    theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  );
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#14130f' : '#f7f2e8';
}

function initPreferences() {
  const storedTheme = localStorage.getItem(STORE.theme);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(storedTheme || (prefersDark ? 'dark' : 'light'));

  el.themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(STORE.theme, next);
  });

  el.bilingual.checked = localStorage.getItem(STORE.bilingual) === 'true';
  el.timestamps.checked = localStorage.getItem(STORE.timestamps) !== 'false';

  const storedScale = Number(localStorage.getItem(STORE.scale));
  state.scale = Number.isFinite(storedScale) && storedScale >= 0.9 && storedScale <= 1.3 ? storedScale : 1;
  applyReadOptions();

  el.bilingual.addEventListener('change', () => {
    localStorage.setItem(STORE.bilingual, String(el.bilingual.checked));
    applyReadOptions();
  });

  el.timestamps.addEventListener('change', () => {
    localStorage.setItem(STORE.timestamps, String(el.timestamps.checked));
    applyReadOptions();
  });

  const stepScale = (delta) => {
    state.scale = Math.min(1.3, Math.max(0.9, Math.round((state.scale + delta) * 100) / 100));
    localStorage.setItem(STORE.scale, String(state.scale));
    applyReadOptions();
  };

  el.fontDown.addEventListener('click', () => stepScale(-0.05));
  el.fontUp.addEventListener('click', () => stepScale(0.05));
}

function applyReadOptions() {
  document.body.classList.toggle('hide-original', !el.bilingual.checked);
  document.body.classList.toggle('hide-times', !el.timestamps.checked);
  document.documentElement.style.setProperty('--doc-scale', String(state.scale));
}

/* ------------------------------------------------------------------ */
/* Languages                                                           */
/* ------------------------------------------------------------------ */

async function loadLanguages() {
  try {
    const res = await fetch('/api/languages', { cache: 'no-store' });
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    if (!Array.isArray(data.languages) || !data.languages.length) throw new Error('empty');
    languages = data.languages;
  } catch {
    languages = FALLBACK_LANGUAGES;
  }

  el.lang.innerHTML = '';

  const groups = [
    { label: 'Indian languages', items: languages.filter((l) => l.region === 'India') },
    { label: 'World languages', items: languages.filter((l) => l.region !== 'India') }
  ];

  for (const group of groups) {
    if (!group.items.length) continue;
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const language of group.items) {
      const option = document.createElement('option');
      option.value = language.code;
      option.textContent = `${language.english} — ${language.native}`;
      optgroup.append(option);
    }
    el.lang.append(optgroup);
  }

  const stored = localStorage.getItem(STORE.lang);
  el.lang.value = languageByCode(stored || 'ta').code || 'ta';
  updateLangNote();

  el.lang.addEventListener('change', () => {
    localStorage.setItem(STORE.lang, el.lang.value);
    updateLangNote();
    updateLangPrompt();
  });
}

function updateLangNote() {
  const language = languageByCode(el.lang.value);
  el.langNote.textContent =
    language.code === 'ta'
      ? 'Tamil is selected by default. The source language is detected automatically.'
      : `Output will be in ${language.english} (${language.native}). The source language is detected automatically.`;
}

function updateLangPrompt() {
  const transcript = state.transcript;
  const shown = transcript?.lang?.code ? languageByCode(transcript.lang.code) : null;
  const selected = languageByCode(el.lang.value);

  if (!shown || state.running || shown.code === selected.code) {
    el.langPrompt.hidden = true;
    return;
  }

  el.langPromptText.textContent = `This document is in ${shown.english}.`;
  el.langSwitchBtn.textContent = `Translate to ${selected.native}`;
  el.langPrompt.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Url preview                                                         */
/* ------------------------------------------------------------------ */

el.url.addEventListener('input', () => {
  clearUrlError();
  const value = el.url.value.trim();

  clearTimeout(state.previewTimer);
  if (!value) {
    hidePreview();
    return;
  }

  if (!extractVideoId(value)) {
    hidePreview();
    return;
  }

  state.previewTimer = setTimeout(() => loadPreview(value), 650);
});

el.url.addEventListener('blur', () => {
  const value = el.url.value.trim();
  if (value && extractVideoId(value) && !state.running) loadPreview(value, true);
});

async function loadPreview(rawUrl, immediate = false) {
  clearTimeout(state.previewTimer);
  const videoId = extractVideoId(rawUrl);
  if (!videoId) {
    hidePreview();
    return;
  }

  if (state.previewAbort) state.previewAbort.abort();
  const controller = new AbortController();
  state.previewAbort = controller;

  // Skeleton while the metadata request runs.
  el.preview.hidden = false;
  el.preview.classList.add('is-loading');
  el.preview.innerHTML = `
    <div class="preview-thumb"></div>
    <div class="preview-body">
      <p class="preview-title">Loading video details</p>
      <p class="preview-sub">Reading title and captions…</p>
      <p class="preview-badge">Checking</p>
    </div>
  `;

  try {
    if (immediate) await new Promise((resolve) => setTimeout(resolve, 0));
    const res = await fetch(`/api/info?url=${encodeURIComponent(rawUrl)}`, {
      signal: controller.signal
    });

    if (!res.ok) {
      hidePreview();
      return;
    }

    const data = await res.json();
    if (!data.video) {
      hidePreview();
      return;
    }
    renderPreview(data.video);
  } catch (error) {
    if (error?.name !== 'AbortError') hidePreview();
  }
}

function renderPreview(video) {
  el.preview.hidden = false;
  el.preview.classList.remove('is-loading');
  el.preview.innerHTML = '';

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'preview-thumb';
  const img = document.createElement('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  setThumbnail(img, video.thumb, video.id);
  thumbWrap.append(img);

  const body = document.createElement('div');
  body.className = 'preview-body';

  const title = document.createElement('p');
  title.className = 'preview-title';
  title.textContent = video.title;

  const sub = document.createElement('p');
  sub.className = 'preview-sub';
  sub.textContent = [video.channel, video.duration ? formatDuration(video.duration) : null]
    .filter(Boolean)
    .join(' · ');

  const badge = document.createElement('p');
  badge.className = 'preview-badge';
  if (video.hasCaptions) {
    badge.textContent = `${video.sourceLanguage || 'Caption'} captions${video.track?.auto ? ' · auto' : ''}`;
  } else if (video.hostBlocked) {
    badge.classList.add('warn');
    badge.textContent = 'YouTube is blocking this server';
  } else {
    badge.classList.add('warn');
    badge.textContent = 'No captions found';
  }

  body.append(title, sub, badge);
  el.preview.append(thumbWrap, body);
}

function hidePreview() {
  el.preview.hidden = true;
  el.preview.classList.remove('is-loading');
  el.preview.innerHTML = '';
}

function showUrlError(message) {
  el.urlError.hidden = false;
  el.urlError.textContent = message;
  el.inputWrap.classList.add('invalid');
}

function clearUrlError() {
  el.urlError.hidden = true;
  el.urlError.textContent = '';
  el.inputWrap.classList.remove('invalid');
}

/* ------------------------------------------------------------------ */
/* Paste + samples + history                                           */
/* ------------------------------------------------------------------ */

el.pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      toast('Clipboard is empty');
      return;
    }
    el.url.value = text.trim();
    clearUrlError();
    await loadPreview(el.url.value, true);
    el.url.focus();
  } catch {
    toast('Clipboard access was blocked — paste with ⌘V');
    el.url.focus();
  }
});

$$('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const url = chip.dataset.url;
    if (!url) return;
    el.url.value = url;
    clearUrlError();
    loadPreview(url, true);
    startJob(url);
  });
});

const HISTORY_KEY = STORE.history;

function readHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rememberJob(transcript) {
  const entry = {
    id: transcript.id,
    title: transcript.title,
    channel: transcript.channel,
    thumb: transcript.thumb,
    lang: transcript.lang.code,
    langName: transcript.lang.english,
    at: Date.now()
  };

  const history = readHistory().filter(
    (item) => !(item.id === entry.id && item.lang === entry.lang)
  );
  history.unshift(entry);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 6)));
  renderHistory();
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(timestamp)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function renderHistory() {
  const history = readHistory();
  el.recentWrap.hidden = history.length === 0;
  el.recentList.innerHTML = '';

  for (const entry of history) {
    const li = document.createElement('li');
    li.className = 'recent-item';

    const button = document.createElement('button');
    button.type = 'button';

    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    setThumbnail(img, entry.thumb, entry.id);

    const info = document.createElement('span');
    info.className = 'recent-info';

    const title = document.createElement('span');
    title.className = 'recent-title';
    title.textContent = entry.title;

    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    meta.textContent = `${entry.langName} · ${timeAgo(entry.at)}`;

    info.append(title, meta);
    button.append(img, info);

    button.addEventListener('click', () => {
      const url = `https://www.youtube.com/watch?v=${entry.id}`;
      el.url.value = url;
      if (languages.some((l) => l.code === entry.lang)) {
        el.lang.value = entry.lang;
        updateLangNote();
      }
      clearUrlError();
      loadPreview(url, true);
      startJob(url);
    });

    li.append(button);
    el.recentList.append(li);
  }
}

el.clearRecent.addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
  toast('Recent list cleared');
});

/* ------------------------------------------------------------------ */
/* Doc header                                                          */
/* ------------------------------------------------------------------ */

function renderDocHeader(video) {
  const language = languageByCode(state.jobLang);

  el.thumbLink.href = video.url;
  el.thumbLink.setAttribute('aria-label', `Open “${video.title}” on YouTube`);
  el.thumbImg.alt = video.title;
  setThumbnail(el.thumbImg, video.thumb, video.id);

  el.docTitle.textContent = video.title;
  el.docChannel.textContent = video.channel;
  el.docDuration.textContent = formatDuration(video.duration);
  el.docStats.textContent = 'Preparing transcript…';
  el.docLangBadge.textContent = language.native;
  el.docLangBadge.title = `${language.english} (${language.code})`;
  el.docSource.textContent = video.hasCaptions
    ? `${video.sourceLanguage || 'Caption'} captions${video.track?.auto ? ' · auto-generated' : ''}`
    : 'Checking captions…';
  el.docUrl.textContent = video.url;
  el.docBody.lang = language.code;
  el.docBody.dir = 'auto';
}

function setDocActions(enabled) {
  for (const button of el.docActions) button.disabled = !enabled;
}

/* ------------------------------------------------------------------ */
/* Rendering transcript                                                */
/* ------------------------------------------------------------------ */

function maybeChapter(startSeconds, fragment) {
  const chapters = state.video?.chapters || [];
  if (!chapters.length) return;

  let candidate = null;
  for (const chapter of chapters) {
    if (chapter.start > startSeconds + 0.05) break;
    const key = `${chapter.start}|${chapter.title}`;
    if (state.chaptersEmitted.has(key)) continue;
    candidate = chapter;
    candidate.__key = key;
  }

  if (!candidate) return;
  if (candidate.start <= state.lastChapterStart) return;

  state.chaptersEmitted.add(candidate.__key);
  state.lastChapterStart = candidate.start;

  const heading = document.createElement('div');
  heading.className = 'chapter';

  const label = document.createElement('span');
  label.className = 'chapter-label';
  label.textContent = 'Chapter';

  const title = document.createElement('span');
  title.className = 'chapter-title';
  title.textContent = candidate.title;

  heading.append(label, title);
  fragment.append(heading);
}

function appendBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return;

  const fragment = document.createDocumentFragment();

  for (const block of blocks) {
    maybeChapter(block.s, fragment);

    const para = document.createElement('div');
    para.className = 'para';

    const time = document.createElement('div');
    time.className = 'para-time';
    time.textContent = formatClock(block.s);

    const textWrap = document.createElement('div');
    textWrap.className = 'para-text';

    const translated = document.createElement('p');
    translated.className = 'tr';
    translated.dir = 'auto';
    translated.textContent = block.t;
    textWrap.append(translated);

    if (block.o && block.o.trim()) {
      const original = document.createElement('p');
      original.className = 'orig';
      original.dir = 'auto';
      original.textContent = block.o;
      textWrap.append(original);
    }

    para.append(time, textWrap);
    fragment.append(para);
    state.renderedBlocks.push(block);
  }

  el.docBody.append(fragment);
}

function updateProgress(completed, total, detected) {
  if (!total) return;
  const ratio = Math.min(1, completed / total);

  el.bar.classList.remove('indeterminate');
  el.barFill.style.width = `${Math.max(6, Math.round(ratio * 100))}%`;
  el.workPct.textContent = `${Math.round(ratio * 100)}%`;

  const language = languageByCode(state.jobLang);
  el.docProgress.hidden = false;
  el.docProgressText.textContent =
    ratio >= 1
      ? `Finishing the ${language.english} document…`
      : `Translating — ${completed} of ${total} passages`;

  if (detected && detected !== language.code) {
    el.docSource.textContent = `From ${formatDetected(detected)} captions`;
  }
}

function formatDetected(code) {
  const found = languages.find((l) => l.code.toLowerCase() === String(code).toLowerCase());
  return found ? found.english : String(code).toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Job lifecycle                                                       */
/* ------------------------------------------------------------------ */

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitFromForm();
});

// Clicking a <span> inside the button does not always trigger implicit form
// submission, so wire the button's own click explicitly as well.
el.goBtn.addEventListener('click', (event) => {
  event.preventDefault();
  submitFromForm();
});

function submitFromForm() {
  const raw = el.url.value.trim();
  if (!raw) {
    showUrlError('Paste a YouTube link to begin.');
    el.url.focus();
    return;
  }
  if (!extractVideoId(raw)) {
    showUrlError('That does not look like a YouTube video link. Try youtube.com/watch?v=…');
    el.url.focus();
    return;
  }
  clearUrlError();
  startJob(raw);
}

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    submitFromForm();
  }
});

function resetStage() {
  state.transcript = null;
  state.renderedBlocks = [];
  state.chaptersEmitted = new Set();
  state.lastChapterStart = -1;
  state.finished = false;

  el.empty.hidden = true;
  el.errorCard.hidden = true;
  el.doc.hidden = true;
  el.docBody.innerHTML = '';
  el.docBody.removeAttribute('dir');
  el.warnBanner.hidden = true;
  el.warnBanner.textContent = '';
  el.langPrompt.hidden = true;
  el.docProgress.hidden = true;
  el.docProgressText.textContent = 'Fetching captions…';
  setDocActions(false);

  el.workCard.hidden = false;
  el.workCard.classList.remove('hidden');
  el.workTitle.textContent = 'Reading the video…';
  el.workPct.textContent = '0%';
  el.workNote.textContent = 'Hang tight — longer videos take a little longer.';
  el.bar.classList.add('indeterminate');
  el.barFill.style.width = '0%';

  for (const item of $$('#miniSteps li')) {
    item.classList.toggle('active', item.dataset.step === '0');
    item.classList.remove('done');
  }
}

function setBusy(busy) {
  state.running = busy;
  el.goBtn.disabled = busy;
  el.goBtn.classList.toggle('is-busy', busy);
  el.goText.textContent = busy ? 'Preparing transcript…' : 'Transcribe & translate';
  $('#stage').setAttribute('aria-busy', String(busy));
}

function startJob(rawUrl) {
  const videoId = extractVideoId(rawUrl);
  const language = el.lang.value || 'ta';

  if (!videoId) {
    showUrlError('Paste a valid YouTube video link.');
    return;
  }

  if (state.es) {
    state.es.close();
    state.es = null;
  }

  state.lastUrl = rawUrl;
  state.jobLang = language;
  resetStage();
  setBusy(true);

  el.docProgressText.textContent = `Preparing ${languageByCode(language).english} transcript…`;

  const params = new URLSearchParams({ url: rawUrl, lang: language });
  const source = new EventSource(`/api/process?${params.toString()}`);
  state.es = source;

  source.addEventListener('meta', (event) => {
    const data = JSON.parse(event.data);
    if (!data.video) return;
    state.video = data.video;
    renderDocHeader(data.video);

    el.workCard.hidden = true;
    el.doc.hidden = false;
    el.empty.hidden = true;
    el.docProgress.hidden = false;
    el.docProgressText.textContent = 'Fetching the caption track…';

    if (window.matchMedia('(max-width: 940px)').matches) {
      requestAnimationFrame(() => {
        el.doc.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  });

  source.addEventListener('stage', (event) => {
    const data = JSON.parse(event.data);
    if (typeof data.step === 'number') updateStep(data.step, data.message);
    if (data.message) {
      el.workNote.textContent = data.message;
      if (!el.doc.hidden) el.docProgressText.textContent = data.message;
    }
    if (typeof data.progress === 'number') {
      el.bar.classList.remove('indeterminate');
      el.barFill.style.width = `${Math.max(4, Math.round(data.progress * 100))}%`;
      el.workPct.textContent = `${Math.round(data.progress * 100)}%`;
    }
  });

  source.addEventListener('progress', (event) => {
    const data = JSON.parse(event.data);
    appendBlocks(data.blocks);
    updateProgress(data.completed, data.total, data.detected);
    el.docProgress.hidden = false;
  });

  source.addEventListener('done', (event) => {
    const data = JSON.parse(event.data);
    finishJob(data.transcript);
  });

  source.addEventListener('fail', (event) => {
    const data = JSON.parse(event.data);
    failJob(data);
  });

  source.onerror = () => {
    if (state.finished) return;
    source.close();
    state.es = null;
    failJob({
      title: 'The connection ended',
      message: 'The transcript stream stopped before it finished.',
      hint: 'Try again. Completed videos stay cached, so a retry is usually quick.'
    });
  };
}

function updateStep(step, message) {
  for (const item of $$('#miniSteps li')) {
    const index = Number(item.dataset.step);
    item.classList.toggle('active', index === step);
    item.classList.toggle('done', index < step);
  }

  const labels = ['Reading the video…', 'Fetching captions…', 'Translating…', 'Preparing your document…'];
  if (!message) el.workTitle.textContent = labels[step] || 'Working…';
  else el.workTitle.textContent = message;

  if (step >= 2) {
    el.bar.classList.remove('indeterminate');
    if (!el.workPct.textContent || el.workPct.textContent === '0%') el.barFill.style.width = '6%';
  }
}

function finishJob(transcript) {
  state.finished = true;
  state.transcript = transcript;
  state.video = {
    ...(state.video || {}),
    chapters: transcript.chapters || state.video?.chapters || []
  };

  if (state.es) {
    state.es.close();
    state.es = null;
  }

  if (transcript.blocks?.length && state.renderedBlocks.length !== transcript.blocks.length) {
    // A batch was missed (or arrived twice): rebuild the whole document.
    state.renderedBlocks = [];
    state.chaptersEmitted = new Set();
    state.lastChapterStart = -1;
    el.docBody.innerHTML = '';
    appendBlocks(transcript.blocks);
  }

  el.workCard.hidden = true;
  el.doc.hidden = false;
  el.empty.hidden = true;
  el.errorCard.hidden = true;

  el.docLangBadge.textContent = transcript.lang.native;
  el.docLangBadge.title = `${transcript.lang.english} (${transcript.lang.code})`;
  el.docTitle.textContent = transcript.title;
  el.docChannel.textContent = transcript.channel;
  el.docDuration.textContent = formatDuration(transcript.duration);
  el.docStats.textContent = `${plural(transcript.words, 'word')} · ${plural(transcript.blocks.length, 'passage')}`;
  el.docSource.textContent = transcript.translated
    ? `From ${transcript.source.name}${transcript.source.auto ? ' · auto' : ''} → ${transcript.lang.english}`
    : `Already in ${transcript.lang.english}`;

  const warnings = [...(transcript.warnings || [])];
  if (transcript.cached) warnings.push('Opened from this session’s cache — instant and identical.');
  if (warnings.length) {
    el.warnBanner.hidden = false;
    el.warnBanner.textContent = warnings.join(' ');
  } else {
    el.warnBanner.hidden = true;
  }

  el.bar.classList.remove('indeterminate');
  el.barFill.style.width = '100%';
  el.workPct.textContent = '100%';

  for (const item of $$('#miniSteps li')) {
    item.classList.remove('active');
    item.classList.add('done');
  }

  el.docProgress.hidden = false;
  el.docProgressText.textContent =
    transcript.cached
      ? 'Ready — opened from cache'
      : `Ready in ${Math.max(1, Math.round((transcript.elapsed || 0) / 1000))}s`;

  setTimeout(() => {
    if (state.transcript === transcript) el.docProgress.hidden = true;
  }, 2600);

  setDocActions(true);
  setBusy(false);
  updateLangPrompt();
  rememberJob(transcript);
  toast(transcript.cached ? 'Opened from cache' : 'Transcript ready');
}

function failJob(data) {
  if (state.es) {
    state.es.close();
    state.es = null;
  }

  state.finished = true;
  setBusy(false);
  el.workCard.hidden = true;
  el.docProgress.hidden = true;

  if (state.renderedBlocks.length) {
    // Keep whatever translated text arrived and explain what is missing.
    el.doc.hidden = false;
    el.errorCard.hidden = true;
    el.warnBanner.hidden = false;
    el.warnBanner.textContent = `${data.title || 'Stopped early'} — ${data.message || 'The transcript could not be completed.'}`;
    buildPartialTranscript();
    setDocActions(true);
    updateLangPrompt();
    toast('Partial transcript ready');
    return;
  }

  el.doc.hidden = true;
  el.errorCard.hidden = false;
  el.empty.hidden = true;
  el.errorTitle.textContent = data.title || 'Something went wrong';
  el.errorMessage.textContent = data.message || 'The transcript could not be prepared.';
  el.errorHint.textContent = data.hint || '';
  el.errorCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function buildPartialTranscript() {
  const language = languageByCode(state.jobLang);
  state.transcript = {
    id: state.video?.id || extractVideoId(state.lastUrl) || '',
    title: state.video?.title || 'Partial transcript',
    channel: state.video?.channel || '',
    duration: state.video?.duration || 0,
    thumb: state.video?.thumb || '',
    url: state.video?.url || state.lastUrl,
    chapters: state.video?.chapters || [],
    lang: { code: language.code, english: language.english, native: language.native },
    source: {
      code: '',
      name: state.video?.sourceLanguage || 'YouTube',
      auto: Boolean(state.video?.track?.auto)
    },
    detected: '',
    translated: true,
    blocks: state.renderedBlocks,
    segments: state.renderedBlocks.map((block) => ({
      s: block.s,
      e: block.e,
      t: block.t,
      o: block.o
    })),
    words: state.renderedBlocks.map((b) => b.t).join(' ').trim().split(/\s+/).filter(Boolean).length,
    warnings: ['This is a partial transcript — the connection stopped before translation finished.'],
    createdAt: new Date().toISOString(),
    cached: false
  };

  el.docStats.textContent = `${plural(state.transcript.words, 'word')} · ${plural(
    state.transcript.blocks.length,
    'passage'
  )}`;
}

el.retryBtn.addEventListener('click', () => {
  if (!state.lastUrl) {
    el.errorCard.hidden = true;
    el.empty.hidden = false;
    return;
  }
  startJob(state.lastUrl);
});

el.dismissBtn.addEventListener('click', () => {
  el.errorCard.hidden = true;
  if (!state.transcript) el.empty.hidden = false;
});

el.langSwitchBtn.addEventListener('click', () => {
  if (state.running) return;
  const url = state.transcript?.url || state.lastUrl;
  if (url) startJob(url);
});

/* ------------------------------------------------------------------ */
/* Toolbar actions                                                     */
/* ------------------------------------------------------------------ */

function buildPlainText() {
  const transcript = state.transcript;
  if (!transcript) return '';

  const lines = [];
  lines.push(transcript.title);
  const meta = [transcript.channel];
  if (transcript.duration) meta.push(formatDuration(transcript.duration));
  meta.push(plural(transcript.words, 'word'));
  lines.push(meta.filter(Boolean).join(' · '));
  lines.push(`Source: ${transcript.url}`);
  lines.push(`Language: ${transcript.lang.english} (${transcript.lang.native})`);
  lines.push(
    `Captions: ${transcript.source.name}${transcript.source.auto ? ' (auto-generated)' : ''}`
  );
  lines.push(`Prepared: ${new Date(transcript.createdAt).toLocaleString()}`);
  lines.push('');
  lines.push('TRANSCRIPT');
  lines.push('—'.repeat(24));

  for (const block of transcript.blocks) {
    const prefix = el.timestamps.checked ? `[${formatClock(block.s)}] ` : '';
    lines.push(`${prefix}${block.t}`.trim());
    if (el.bilingual.checked && block.o && block.o !== block.t) {
      lines.push(`    ${block.o}`);
    }
    lines.push('');
  }

  lines.push('—'.repeat(24));
  lines.push('Machine translation via Vaani. Verify important details against the original.');
  return lines.join('\n');
}

function buildSrt() {
  const transcript = state.transcript;
  if (!transcript) return '';

  const cues = (transcript.segments || []).filter((cue) => String(cue.t || '').trim());
  if (!cues.length) {
    // Fall back to paragraph timings for transcripts without line data.
    return transcript.blocks
      .map((block, index) => {
        return `${index + 1}\n${formatSrtTime(block.s)} --> ${formatSrtTime(block.e)}\n${block.t}\n`;
      })
      .join('\n');
  }

  return cues
    .map((cue, index) => {
      const start = formatSrtTime(cue.s);
      const end = formatSrtTime(Math.max(cue.e, cue.s + 0.6));
      return `${index + 1}\n${start} --> ${end}\n${cue.t}\n`;
    })
    .join('\n');
}

function download(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

async function copyTranscript() {
  const text = buildPlainText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Transcript copied to clipboard');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('Transcript copied');
    } catch {
      toast('Copy failed — try downloading the .txt instead');
    }
    area.remove();
  }
}

$$('.tool').forEach((button) => {
  button.addEventListener('click', () => {
    if (!state.transcript) return;
    const action = button.dataset.act;
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `${slugify(state.transcript.title)}-${state.transcript.lang.code}-${stamp}`;

    if (action === 'copy') copyTranscript();
    if (action === 'txt') {
      download(`${base}.txt`, buildPlainText());
      toast('Text file downloaded');
    }
    if (action === 'srt') {
      download(`${base}.srt`, buildSrt(), 'application/x-subrip;charset=utf-8');
      toast('Subtitle file downloaded');
    }
    if (action === 'print') {
      window.print();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

initPreferences();
renderHistory();
loadLanguages();

// Keep relative times in the recent list honest.
setInterval(() => {
  if (!el.recentWrap.hidden) renderHistory();
}, 60000);
