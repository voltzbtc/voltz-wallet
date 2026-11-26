import fs from 'fs'
import path from 'path'
import i18n from '../src/i18n'
import { LANGUAGES } from '../src/i18n/languages'
import { credits, reviewerLink, REVIEWERS, type Reviewer } from '../src/i18n/reviewers'

describe('reviewerLink', () => {
  test.each([
    'https://github.com/ana-weber',
    'https://x.com/layla_r',
    'https://t.me/somchai',
    'https://njump.me/npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m',
  ])('opens %s', link => {
    expect(reviewerLink(link)).toBe(link)
  })

  test.each([
    ['nothing', undefined],
    ['an empty string', ''],
    ['http', 'http://github.com/ana'],
    // eslint-disable-next-line no-script-url -- the point of the case is that this is refused
    ['another scheme', 'javascript:alert(1)'],
    ['a nostr URI, which needs a client', 'nostr:npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m'],
    ['a host off the list', 'https://example.com/ana'],
    ['a subdomain of a listed host', 'https://gist.github.com/ana'],
    ['www ahead of a listed host', 'https://www.github.com/ana'],
    ['a listed host inside a longer one', 'https://github.com.example.com/ana'],
    ['credentials ahead of another host', 'https://github.com@example.com/ana'],
    ['a port', 'https://github.com:443/ana'],
    ['a host in capitals', 'https://GitHub.com/ana'],
    ['no profile', 'https://github.com/'],
    ['no path', 'https://github.com'],
    ['a profile of dots', 'https://github.com/..'],
    ['a second segment', 'https://github.com/ana/repo'],
    ['a trailing slash', 'https://github.com/ana/'],
    ['a query', 'https://github.com/ana?tab=repositories'],
    ['a fragment', 'https://github.com/ana#top'],
    ['a space', 'https://github.com/ana weber'],
    ['a line break after', 'https://github.com/ana\nhttps://example.com'],
    ['a percent escape', 'https://github.com/%2e%2e'],
  ])('refuses %s', (_, link) => {
    expect(reviewerLink(link)).toBeNull()
  })
})

describe('credits', () => {
  const ana: Reviewer = { name: 'Ana Weber' }
  const somchai: Reviewer = { name: 'somchai' }
  const pick = (...codes: string[]) => codes.map(code => LANGUAGES.find(l => l.code === code)!)

  test('one per reviewer, in the order of the languages given', () => {
    const shown = credits(pick('th', 'de'), { de: [ana], th: [somchai, ana] })
    expect(shown.map(c => [c.language.code, c.reviewer.name])).toEqual([
      ['th', 'somchai'],
      ['th', 'Ana Weber'],
      ['de', 'Ana Weber'],
    ])
  })

  test('nobody for a language not given, and nothing for an empty list', () => {
    expect(credits(pick('de'), { th: [somchai] })).toEqual([])
    expect(credits(pick('de', 'th'), {})).toEqual([])
  })
})

// What a new entry gets wrong, as `code: problem`. A link the guard refuses would draw a name with
// nothing to tap and no word why, so it fails here instead.
function listProblems(list: Readonly<Record<string, readonly Reviewer[]>>): string[] {
  const codes = new Set(LANGUAGES.map(l => l.code))
  return Object.entries(list).flatMap(([code, reviewers]) => [
    ...(codes.has(code) ? [] : [`${code}: not a language the picker lists`]),
    ...(reviewers.length === 0 ? [`${code}: no reviewer`] : []),
    ...reviewers.flatMap(({ name, link }) => [
      ...(name.trim() === '' || name !== name.trim() ? [`${code}: name "${name}" is blank or padded`] : []),
      ...(reviewers.filter(r => r.name === name).length > 1 ? [`${code}: name "${name}" twice`] : []),
      ...(link !== undefined && reviewerLink(link) === null ? [`${code}: link ${link} would not open`] : []),
    ]),
  ])
}

describe('the list', () => {
  test('names only languages the picker lists, each person once, with links that open', () => {
    expect(listProblems(REVIEWERS)).toEqual([])
  })

  // Controls for the check above, which an empty list passes by having nothing in it.
  test('the check finds each kind of mistake', () => {
    const planted = {
      xx: [{ name: 'Ana Weber' }],
      de: [{ name: ' Ana' }, { name: 'Bo' }, { name: 'Bo' }, { name: 'Cy', link: 'http://github.com/cy' }],
      th: [],
    }
    expect(listProblems(planted)).toEqual([
      'xx: not a language the picker lists',
      'de: name " Ana" is blank or padded',
      'de: name "Bo" twice',
      'de: name "Bo" twice',
      'de: link http://github.com/cy would not open',
      'th: no reviewer',
    ])
    expect(listProblems({ de: [{ name: 'Ana Weber', link: 'https://github.com/ana' }] })).toEqual([])
  })
})

// The locale suite holds key parity, the em dash and the regulated words for this string with the
// rest; this holds that the title reads in every language rather than falling back to English.
describe('the section title', () => {
  const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales')
  const codes = fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
  const SAME_AS_ENGLISH = new Set(['en-US', 'en-GB'])

  test('is in all 24 locales', () => {
    expect(codes).toHaveLength(24)
  })

  test.each(codes)('%s has its own words for it, with no em dash', code => {
    const title = JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8')).settings.languageReviewers
    expect(typeof title).toBe('string')
    expect(title.trim()).not.toBe('')
    expect(title).not.toContain('\u2014')
    expect(title === i18n.t('settings.languageReviewers', { lng: 'en-US' })).toBe(SAME_AS_ENGLISH.has(code))
  })
})
