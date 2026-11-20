import fs from 'fs'
import path from 'path'
import { PluralRules, installPluralRules } from '../src/i18n/pluralRules'

// Hermes has no Intl.PluralRules, so on a device i18next reads the bundled rules while this suite,
// on Node, reads ICU. Holding the two equal for every shipped locale is what makes the plural forms
// the locale tests check the ones a device shows.
const codes = fs
  .readdirSync(path.join(__dirname, '..', 'src', 'i18n', 'locales'))
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''))

const CLDR_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other']
const sorted = (categories: string[]) =>
  [...categories].sort((a, b) => CLDR_ORDER.indexOf(a) - CLDR_ORDER.indexOf(b))

// Every whole number to 1100 covers each rule's cycles of 10 and 100 with their teens, then round
// millions and their neighbours, negatives, fractions up to the three digits ICU shows, and the
// values that are not finite.
const COUNTS = [
  ...Array.from({ length: 1101 }, (_, n) => n),
  10_000, 100_000, 999_999, 1_000_000, 1_000_001, 2_000_000, 10_000_000, 1_000_000_000,
  -1, -2, -3, -5, -11, -21, -1_000_000,
  0.001, 0.1, 0.5, 1.5, 1.25, 2.125, 2.5, 3.5, 10.1, 11.5, 21.5, 100.5, 1_000_000.5,
  NaN, Infinity, -Infinity,
]

const NativePluralRules = Intl.PluralRules
const withoutNativeRules = (): void => {
  delete (Intl as { PluralRules?: unknown }).PluralRules
}
afterEach(() => {
  Object.defineProperty(Intl, 'PluralRules', {
    value: NativePluralRules,
    writable: true,
    configurable: true,
  })
})

test('the oracle is ICU with CLDR rules, not a single-category stand-in', () => {
  expect(new Intl.PluralRules('ru').select(24)).toBe('few')
  expect(new Intl.PluralRules('ar').select(0)).toBe('zero')
  expect(COUNTS.length).toBeGreaterThan(1100)
})

test.each(codes)('%s: the bundled rule has the categories ICU reports', code => {
  expect(sorted(new PluralRules(code).resolvedOptions().pluralCategories)).toEqual(
    sorted(new Intl.PluralRules(code).resolvedOptions().pluralCategories),
  )
})

test.each(codes)('%s: the bundled rule picks what ICU picks for every count', code => {
  const ours = new PluralRules(code)
  const icu = new Intl.PluralRules(code)
  const differ = COUNTS.filter(n => ours.select(n) !== icu.select(n)).map(
    n => `${n}: ${ours.select(n)}, ICU ${icu.select(n)}`,
  )
  expect(differ).toEqual([])
})

// ICU's answers for counts this large are not bundled, so the bundled rules only have to answer.
test.each(codes)('%s: a count of 1e21 or more picks a category instead of throwing', code => {
  const categories = new PluralRules(code).resolvedOptions().pluralCategories
  expect(categories).toContain(new PluralRules(code).select(1e21))
  expect(categories).toContain(new PluralRules(code).select(-1e22))
})

test('asking for ordinal rules throws instead of answering with cardinal ones', () => {
  expect(() => new PluralRules('en', { type: 'ordinal' })).toThrow(RangeError)
})

describe('installPluralRules', () => {
  test('fills in the rules where the engine has none, as on Hermes', () => {
    withoutNativeRules()
    expect(typeof Intl.PluralRules).toBe('undefined')
    installPluralRules()
    expect(Intl.PluralRules).toBe(PluralRules)
  })

  test('keeps the engine rules where they exist', () => {
    installPluralRules()
    expect(Intl.PluralRules).toBe(NativePluralRules)
  })
})

// The app's own i18next on an engine without Intl.PluralRules, as Hermes is.
test('the app picks each language form on an engine without Intl.PluralRules', async () => {
  withoutNativeRules()
  let i18n: typeof import('../src/i18n').default | undefined
  jest.isolateModules(() => {
    i18n = require('../src/i18n').default
  })
  const t = (lng: string, count: number) => i18n!.getFixedT(lng)('welcome.words', { count })
  expect(t('ru', 12)).toBe('12 слов')
  expect(t('ru', 24)).toBe('24 слова')
  expect(t('ru', 21)).toBe('21 слово')
  expect(t('pl', 24)).toBe('24 słowa')
  expect(t('ar', 5)).toBe('5 كلمات')
  expect(t('ar', 2)).toBe('كلمتان 2')
  expect(t('he', 2)).toBe('2 מילים')
  expect(t('pt-BR', 1_000_000)).toBe('1000000 de palavras')
  expect(t('en-US', 1)).toBe('1 word')
  const guests = (count: number) =>
    i18n!.getFixedT('ru')('deleteData.domain', { domain: 'a.com', count })
  expect(guests(3)).toContain('3 кошелька теряют')
  expect(guests(5)).toContain('5 кошельков теряют')
})
