// Order does not matter, since the picker sorts by endonym at render. A language spoken across many
// nations takes the most recognizable country as its flag, and omitting one leaves a globe.
export type AppLanguage = { code: string; label: string; country?: string }

// A language's name is written with its own accents and a person types with or without them, so
// both sides are compared bare. A search by tag finds the variants a name alone cannot, as `pt-BR`.
const bare = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()

export function languageMatches(language: AppLanguage, query: string): boolean {
  const wanted = bare(query.trim())
  return bare(language.label).includes(wanted) || bare(language.code).includes(wanted)
}

export const LANGUAGES: AppLanguage[] = [
  { code: 'pt-BR', label: 'Português', country: 'BR' },
  { code: 'pt-PT', label: 'Português (Portugal)', country: 'PT' },
  { code: 'en-US', label: 'English', country: 'US' },
  { code: 'en-GB', label: 'English (UK)', country: 'GB' },
  { code: 'es', label: 'Español', country: 'ES' },
  { code: 'es-MX', label: 'Español (México)', country: 'MX' },
  { code: 'fr', label: 'Français', country: 'FR' },
  { code: 'fr-CA', label: 'Français (Canada)', country: 'CA' },
  { code: 'de', label: 'Deutsch', country: 'DE' },
  { code: 'it', label: 'Italiano', country: 'IT' },
  { code: 'ru', label: 'Русский', country: 'RU' },
  { code: 'tr', label: 'Türkçe', country: 'TR' },
  { code: 'id', label: 'Bahasa Indonesia', country: 'ID' },
  { code: 'vi', label: 'Tiếng Việt', country: 'VN' },
  { code: 'pl', label: 'Polski', country: 'PL' },
  { code: 'zh', label: '简体中文', country: 'CN' },
  { code: 'zh-TW', label: '繁體中文', country: 'TW' },
  { code: 'hi', label: 'हिन्दी', country: 'IN' },
  { code: 'ja', label: '日本語', country: 'JP' },
  { code: 'ko', label: '한국어', country: 'KR' },
  { code: 'th', label: 'ไทย', country: 'TH' },
  { code: 'ar', label: 'العربية', country: 'SA' },
  { code: 'ur', label: 'اردو', country: 'PK' },
  { code: 'he', label: 'עברית', country: 'IL' },
]

// Drives layout mirroring through I18nManager. Matched on the base tag, so 'ar' covers 'ar-EG'.
const RTL_BASE = new Set(['ar', 'he', 'ur', 'fa'])

export function isRTL(lang: string): boolean {
  return RTL_BASE.has(lang.toLowerCase().split('-')[0])
}

// Apple's identifier of a language's .lproj where it differs from the app's code; en-US is the
// development region.
const BUNDLE_LOCALIZATION: Record<string, string> = { 'en-US': 'en', zh: 'zh-Hans', 'zh-TW': 'zh-Hant' }

export function bundleLocalization(code: string): string {
  return BUNDLE_LOCALIZATION[code] ?? code
}

// The resolved language may be a full tag or a base, so an exact match is tried before the base.
export function languageLabel(lang: string): string {
  const l = lang.toLowerCase()
  const exact = LANGUAGES.find(x => x.code.toLowerCase() === l)
  if (exact) {
    return exact.label
  }
  const base = l.split('-')[0]
  return LANGUAGES.find(x => x.code.toLowerCase().split('-')[0] === base)?.label ?? 'English'
}
