// Supported translation targets. Codes follow the Google Translate language set.
// `native` is used for the select menu and for printed documents.
export const LANGUAGES = [
  { code: 'ta', english: 'Tamil', native: 'தமிழ்', region: 'India', featured: true },
  { code: 'en', english: 'English', native: 'English', region: 'India' },
  { code: 'hi', english: 'Hindi', native: 'हिन्दी', region: 'India' },
  { code: 'te', english: 'Telugu', native: 'తెలుగు', region: 'India' },
  { code: 'ml', english: 'Malayalam', native: 'മലയാളം', region: 'India' },
  { code: 'kn', english: 'Kannada', native: 'ಕನ್ನಡ', region: 'India' },
  { code: 'bn', english: 'Bengali', native: 'বাংলা', region: 'India' },
  { code: 'mr', english: 'Marathi', native: 'मराठी', region: 'India' },
  { code: 'gu', english: 'Gujarati', native: 'ગુજરાતી', region: 'India' },
  { code: 'pa', english: 'Punjabi', native: 'ਪੰਜਾਬੀ', region: 'India' },
  { code: 'or', english: 'Odia', native: 'ଓଡ଼ିଆ', region: 'India' },
  { code: 'as', english: 'Assamese', native: 'অসমীয়া', region: 'India' },
  { code: 'ur', english: 'Urdu', native: 'اردو', region: 'India' },
  { code: 'si', english: 'Sinhala', native: 'සිංහල', region: 'India' },

  { code: 'ar', english: 'Arabic', native: 'العربية', region: 'World' },
  { code: 'fa', english: 'Persian', native: 'فارسی', region: 'World' },
  { code: 'he', english: 'Hebrew', native: 'עברית', region: 'World' },
  { code: 'tr', english: 'Turkish', native: 'Türkçe', region: 'World' },
  { code: 'ru', english: 'Russian', native: 'Русский', region: 'World' },
  { code: 'uk', english: 'Ukrainian', native: 'Українська', region: 'World' },
  { code: 'de', english: 'German', native: 'Deutsch', region: 'World' },
  { code: 'fr', english: 'French', native: 'Français', region: 'World' },
  { code: 'es', english: 'Spanish', native: 'Español', region: 'World' },
  { code: 'pt', english: 'Portuguese', native: 'Português', region: 'World' },
  { code: 'it', english: 'Italian', native: 'Italiano', region: 'World' },
  { code: 'nl', english: 'Dutch', native: 'Nederlands', region: 'World' },
  { code: 'sv', english: 'Swedish', native: 'Svenska', region: 'World' },
  { code: 'no', english: 'Norwegian', native: 'Norsk', region: 'World' },
  { code: 'da', english: 'Danish', native: 'Dansk', region: 'World' },
  { code: 'fi', english: 'Finnish', native: 'Suomi', region: 'World' },
  { code: 'pl', english: 'Polish', native: 'Polski', region: 'World' },
  { code: 'cs', english: 'Czech', native: 'Čeština', region: 'World' },
  { code: 'el', english: 'Greek', native: 'Ελληνικά', region: 'World' },
  { code: 'ro', english: 'Romanian', native: 'Română', region: 'World' },
  { code: 'hu', english: 'Hungarian', native: 'Magyar', region: 'World' },
  { code: 'id', english: 'Indonesian', native: 'Bahasa Indonesia', region: 'World' },
  { code: 'ms', english: 'Malay', native: 'Bahasa Melayu', region: 'World' },
  { code: 'vi', english: 'Vietnamese', native: 'Tiếng Việt', region: 'World' },
  { code: 'th', english: 'Thai', native: 'ไทย', region: 'World' },
  { code: 'fil', english: 'Filipino', native: 'Filipino', region: 'World' },
  { code: 'ja', english: 'Japanese', native: '日本語', region: 'World' },
  { code: 'ko', english: 'Korean', native: '한국어', region: 'World' },
  { code: 'zh-CN', english: 'Chinese (Simplified)', native: '简体中文', region: 'World' },
  { code: 'zh-TW', english: 'Chinese (Traditional)', native: '繁體中文', region: 'World' },
  { code: 'sw', english: 'Swahili', native: 'Kiswahili', region: 'World' }
];

export const LANGUAGE_MAP = new Map(LANGUAGES.map((l) => [l.code, l]));

export function getLanguage(code) {
  return LANGUAGE_MAP.get(code) || null;
}

export function isSupported(code) {
  return LANGUAGE_MAP.has(code);
}

// Human label for a raw caption code such as "en-US", "en-orig" or "zh-Hans".
const CAPTION_LABELS = {
  en: 'English',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  kn: 'Kannada',
  bn: 'Bengali',
  mr: 'Marathi',
  gu: 'Gujarati',
  pa: 'Punjabi',
  ur: 'Urdu',
  ar: 'Arabic',
  fa: 'Persian',
  he: 'Hebrew',
  iw: 'Hebrew',
  tr: 'Turkish',
  ru: 'Russian',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  id: 'Indonesian',
  vi: 'Vietnamese',
  th: 'Thai',
  fil: 'Filipino',
  nl: 'Dutch',
  pl: 'Polish',
  sv: 'Swedish',
  no: 'Norwegian',
  da: 'Danish',
  fi: 'Finnish',
  el: 'Greek',
  cs: 'Czech',
  ro: 'Romanian',
  hu: 'Hungarian',
  uk: 'Ukrainian',
  sw: 'Swahili',
  si: 'Sinhala',
  or: 'Odia',
  as: 'Assamese'
};

export function captionLanguageLabel(code) {
  if (!code) return 'Unknown';
  const base = String(code).toLowerCase().split(/[-_]/)[0];
  const found = LANGUAGES.find((l) => l.code.toLowerCase() === String(code).toLowerCase());
  if (found) return found.english;
  return CAPTION_LABELS[base] || base.toUpperCase();
}

export function isRtl(code) {
  return ['ar', 'fa', 'he', 'ur'].includes(String(code).split('-')[0]);
}
