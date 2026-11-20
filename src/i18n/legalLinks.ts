import { LANGUAGES } from './languages'

// The site's legal pages, opened in the app's language. The site serves English at its root and
// every other language the app ships under the app's code in lower case (/pt-br/privacy/), and
// /en-us/ answers 404, so en-US and any language the app does not ship open the root.
const SITE = 'https://www.usevoltz.app'
const ROOT_LANGUAGE = 'en-US'

export type SitePage = 'terms' | 'privacy'

export function sitePageUrl(page: SitePage, language: string | undefined): string {
  const code = shippedLanguage(language ?? '')
  const prefix = code === undefined || code === ROOT_LANGUAGE ? '' : `/${code.toLowerCase()}`
  return `${SITE}${prefix}/${page}/`
}

// The resolved language may be a full tag or a base, so an exact match is tried before the base,
// as languageLabel does.
function shippedLanguage(language: string): string | undefined {
  const l = language.toLowerCase()
  const exact = LANGUAGES.find(x => x.code.toLowerCase() === l)
  if (exact) {
    return exact.code
  }
  const base = l.split('-')[0]
  return LANGUAGES.find(x => x.code.toLowerCase().split('-')[0] === base)?.code
}

export type LegalRun = { text: string; page?: SitePage }

// A sentence that names the legal pages marks each name with the page's tag, as in
// "you accept the <terms>Terms of use</terms>", so every language words and inflects the link
// inside its own grammar rather than around a fixed label. Text outside a tag is plain.
const TAGGED = /<(terms|privacy)>(.*?)<\/\1>/g

export function legalRuns(sentence: string): LegalRun[] {
  const runs: LegalRun[] = []
  let at = 0
  for (const m of sentence.matchAll(TAGGED)) {
    const start = m.index ?? 0
    if (start > at) {
      runs.push({ text: sentence.slice(at, start) })
    }
    runs.push({ text: m[2], page: m[1] as SitePage })
    at = start + m[0].length
  }
  if (at < sentence.length) {
    runs.push({ text: sentence.slice(at) })
  }
  return runs
}
