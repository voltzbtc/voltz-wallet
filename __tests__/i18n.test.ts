import i18n from '../src/i18n'
import { decimalMark } from '../src/wallet/fiat'

afterEach(async () => {
  await i18n.changeLanguage('pt-BR')
})

describe('welcome.words pluralizes for real (one form per CLDR category)', () => {
  // The two lengths the seed pickers offer. Russian and Polish write each with a different form, and
  // Arabic writes both with its 11 to 99 form; a form the locale lacks would render in English.
  it.each([
    ['ru', '12 слов', '24 слова'],
    ['pl', '12 słów', '24 słowa'],
    ['ar', '12 كلمة', '24 كلمة'],
    ['he', '12 מילים', '24 מילים'],
  ])('%s: the form its grammar takes for 12 and for 24', async (lng, twelve, twentyFour) => {
    await i18n.changeLanguage(lng)
    expect(i18n.t('welcome.words', { count: 12 })).toBe(twelve)
    expect(i18n.t('welcome.words', { count: 24 })).toBe(twentyFour)
  })

  it('a round million takes the form read "un million de" in the Romance languages', async () => {
    const million = (lng: string) => i18n.getFixedT(lng)('welcome.words', { count: 1_000_000 })
    expect(million('pt-BR')).toBe('1000000 de palavras')
    expect(million('es-MX')).toBe('1000000 de palabras')
    expect(million('fr-CA')).toBe('1000000 de mots')
    expect(million('it')).toBe('1000000 di parole')
    expect(i18n.getFixedT('pt-BR')('welcome.words', { count: 1_000_001 })).toBe('1000001 palavras')
  })

  it('en-US: singular for 1, plural for many', async () => {
    await i18n.changeLanguage('en-US')
    expect(i18n.t('welcome.words', { count: 1 })).toBe('1 word')
    expect(i18n.t('welcome.words', { count: 24 })).toBe('24 words')
  })

  it('pt-BR: singular for 1, plural for many', async () => {
    await i18n.changeLanguage('pt-BR')
    expect(i18n.t('welcome.words', { count: 1 })).toBe('1 palavra')
    expect(i18n.t('welcome.words', { count: 12 })).toBe('12 palavras')
  })

  it('es: singular for 1, plural for many', async () => {
    await i18n.changeLanguage('es')
    expect(i18n.t('welcome.words', { count: 1 })).toBe('1 palabra')
    expect(i18n.t('welcome.words', { count: 2 })).toBe('2 palabras')
  })
})

describe('i18n config is international', () => {
  it('falls back to English, not Portuguese, when a key is missing', () => {
    // i18next normalizes fallbackLng to an array.
    expect(([] as string[]).concat(i18n.options.fallbackLng as string[])).toContain('en-US')
  })
})

// Home configures the fiat registry only for a currency beyond BRL and USD, so for a wallet showing
// either one the language change is the only thing that moves the decimal mark.
describe('the decimal mark follows a language change', () => {
  it('turns to a comma in Portuguese and back to a dot in English', async () => {
    await i18n.changeLanguage('pt-PT')
    expect(decimalMark()).toBe(',')
    await i18n.changeLanguage('en-US')
    expect(decimalMark()).toBe('.')
  })
})
