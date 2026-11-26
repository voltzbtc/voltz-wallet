import type { AppLanguage } from './languages'

export type Reviewer = {
  // The name or handle the person asked to be shown under, as they wrote it.
  name: string
  // A public profile. It opens only when `reviewerLink` accepts it; otherwise the name is plain text.
  link?: string
}

// The native speakers who reviewed a locale, keyed by its code in `LANGUAGES`, drawn on the language
// picker and thanked on the site. An entry needs the person's consent in writing, in their pull
// request or by email, to be named with exactly this name and link, and comes out when they ask.
// Nobody goes in for a review alone.
export const REVIEWERS: Readonly<Record<string, readonly Reviewer[]>> = {}

// A profile opens in the browser on a tap, so only https to a host where a handle names a person:
// GitHub, X, Telegram, and njump.me, which shows a Nostr profile as a web page with no client or
// account. One path segment, no query, port or credentials, so the address cannot lead anywhere else.
const PROFILE_HOSTS: readonly string[] = ['github.com', 'x.com', 't.me', 'njump.me']
const PROFILE = /^https:\/\/([a-z.]+)\/([A-Za-z0-9_.-]+)$/

export function reviewerLink(link: string | undefined): string | null {
  const parts = link === undefined ? null : PROFILE.exec(link)
  if (!parts || !PROFILE_HOSTS.includes(parts[1]) || !/[A-Za-z0-9]/.test(parts[2])) {
    return null
  }
  return link ?? null
}

export type Credit = { language: AppLanguage; reviewer: Reviewer }

// One credit per reviewer, in the order the languages are given, so the credits follow the list the
// picker shows, search included.
export function credits(
  languages: readonly AppLanguage[],
  list: Readonly<Record<string, readonly Reviewer[]>>,
): Credit[] {
  return languages.flatMap(language => (list[language.code] ?? []).map(reviewer => ({ language, reviewer })))
}
