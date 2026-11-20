// The site's folder for each language the app ships, as the site publishes them: English at the root,
// every other language under the app's code in lower case. Written out rather than derived, so a
// change in how the app builds the path has to agree with the site, not with itself.
export const SITE_FOLDER: Record<string, string> = {
  'pt-BR': '/pt-br',
  'pt-PT': '/pt-pt',
  'en-US': '',
  'en-GB': '/en-gb',
  es: '/es',
  'es-MX': '/es-mx',
  fr: '/fr',
  'fr-CA': '/fr-ca',
  de: '/de',
  it: '/it',
  ru: '/ru',
  tr: '/tr',
  id: '/id',
  vi: '/vi',
  pl: '/pl',
  zh: '/zh',
  'zh-TW': '/zh-tw',
  hi: '/hi',
  ja: '/ja',
  ko: '/ko',
  th: '/th',
  ar: '/ar',
  ur: '/ur',
  he: '/he',
}

export const siteUrl = (code: string, page: 'terms' | 'privacy'): string =>
  `https://www.usevoltz.app${SITE_FOLDER[code]}/${page}/`
