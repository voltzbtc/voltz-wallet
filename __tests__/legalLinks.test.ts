import fs from 'fs'
import path from 'path'
import { LANGUAGES } from '../src/i18n/languages'
import { legalRuns, sitePageUrl } from '../src/i18n/legalLinks'
import { SITE_FOLDER, siteUrl } from './support/sitePages'

const DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales')
const LOCALES = fs.readdirSync(DIR).filter(f => f.endsWith('.json'))
const sentence = (file: string): string =>
  JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')).welcome.terms

test('the site folder table covers every language the app ships', () => {
  expect(Object.keys(SITE_FOLDER).sort()).toEqual(LANGUAGES.map(l => l.code).sort())
})

test.each(LANGUAGES.map(l => l.code))('%s opens the legal pages in its own folder', code => {
  expect(sitePageUrl('terms', code)).toBe(siteUrl(code, 'terms'))
  expect(sitePageUrl('privacy', code)).toBe(siteUrl(code, 'privacy'))
})

// /en-us/ answers 404 on the site, and a language the site does not publish has no folder.
test('English and unknown languages open the root', () => {
  expect(sitePageUrl('terms', 'en-US')).toBe('https://www.usevoltz.app/terms/')
  expect(sitePageUrl('terms', 'nl')).toBe('https://www.usevoltz.app/terms/')
  expect(sitePageUrl('privacy', '')).toBe('https://www.usevoltz.app/privacy/')
  expect(sitePageUrl('privacy', undefined)).toBe('https://www.usevoltz.app/privacy/')
})

test('a tag is matched whatever its case, and a base tag falls back to the first shipped region', () => {
  expect(sitePageUrl('terms', 'PT-br')).toBe('https://www.usevoltz.app/pt-br/terms/')
  expect(sitePageUrl('terms', 'pt')).toBe('https://www.usevoltz.app/pt-br/terms/')
  expect(sitePageUrl('terms', 'fr-BE')).toBe('https://www.usevoltz.app/fr/terms/')
  expect(sitePageUrl('terms', 'en')).toBe('https://www.usevoltz.app/terms/')
})

test('a sentence splits into plain runs and one run per tagged page', () => {
  expect(legalRuns('Read the <terms>Terms</terms> and the <privacy>Policy</privacy>.')).toEqual([
    { text: 'Read the ' },
    { text: 'Terms', page: 'terms' },
    { text: ' and the ' },
    { text: 'Policy', page: 'privacy' },
    { text: '.' },
  ])
  expect(legalRuns('<privacy>Policy</privacy>')).toEqual([{ text: 'Policy', page: 'privacy' }])
  expect(legalRuns('No links here')).toEqual([{ text: 'No links here' }])
  expect(legalRuns('')).toEqual([])
})

test('a mismatched or unknown tag stays plain text', () => {
  expect(legalRuns('a <terms>b</privacy> c')).toEqual([{ text: 'a <terms>b</privacy> c' }])
  expect(legalRuns('a <other>b</other>')).toEqual([{ text: 'a <other>b</other>' }])
})

// A translation that drops or misspells a tag would show the markup, or show the name with no link.
test.each(LOCALES)('%s links each legal page once, with no markup left over', file => {
  const runs = legalRuns(sentence(file))
  const linked = runs.filter(run => run.page)
  expect(linked.map(run => run.page).sort()).toEqual(['privacy', 'terms'])
  expect(linked.every(run => run.text.trim().length > 0)).toBe(true)
  expect(runs.map(run => run.text).join('')).not.toMatch(/[<>]/)
})
