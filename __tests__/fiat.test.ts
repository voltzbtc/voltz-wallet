import fs from 'fs'
import path from 'path'
import {
  satsToFiat,
  fiatToSats,
  assetFiatValue,
  walletFiatTotal,
  formatBrl,
  formatUsd,
  formatFiat,
  formatFiatGeneric,
  fiatSymbol,
  configureFiatFormats,
  defaultFiatForLocale,
  pickDefaultFiat,
  currencyCountry,
  fiatFractionSize,
  setNumberLanguage,
  localizeAmount,
  decimalMark,
  fiatAffixes,
  setLocalCurrency,
} from '../src/wallet/fiat'

const NBSP = '\u00a0'
const RLM = '\u200f'

// A pegged token is valued through the currency it tracks, then crossed into the display one.
const RATES = { USD: 100_000, BRL: 550_000 }

describe('fiatToSats', () => {
  it('converts a fiat amount to whole sats at the quote rate', () => {
    expect(fiatToSats(50, 500_000)).toBe(10_000)
  })

  it('rounds to the nearest sat', () => {
    expect(fiatToSats(4.9035, 350_000)).toBe(1401)
  })

  it('is the inverse of satsToFiat', () => {
    expect(fiatToSats(satsToFiat(25_000, 350_000), 350_000)).toBe(25_000)
  })

  it('returns zero for a zero or invalid rate instead of dividing by zero', () => {
    expect(fiatToSats(50, 0)).toBe(0)
  })
})

describe('satsToFiat', () => {
  it('converts 1 whole BTC at the quote rate', () => {
    expect(satsToFiat(100_000_000, 350_000)).toBe(350_000)
  })

  it('converts a partial sats value', () => {
    expect(satsToFiat(1401, 350_000)).toBeCloseTo(4.9035, 4)
  })

  it('zero sats is worth zero', () => {
    expect(satsToFiat(0, 350_000)).toBe(0)
  })

  it('scales linearly with the quote rate', () => {
    expect(satsToFiat(50_000_000, 350_000)).toBe(175_000)
  })
})

// Every figure here is written in the app language's convention, BRL and USD included, so each
// block states which language it reads in.
describe('formatBrl', () => {
  beforeEach(() => setNumberLanguage('pt-BR'))
  afterEach(() => setNumberLanguage('en-US'))

  it('formats with decimal comma and two decimal places', () => {
    expect(formatBrl(4.9)).toBe(`R$${NBSP}4,90`)
  })

  it('uses dot as thousands separator', () => {
    expect(formatBrl(1234.56)).toBe(`R$${NBSP}1.234,56`)
  })

  it('separates thousands in large values', () => {
    expect(formatBrl(1_000_000)).toBe(`R$${NBSP}1.000.000,00`)
  })

  it('formats zero', () => {
    expect(formatBrl(0)).toBe(`R$${NBSP}0,00`)
  })

  it('rounds to two decimal places', () => {
    expect(formatBrl(4.9035)).toBe(`R$${NBSP}4,90`)
  })

  it('does not add thousands separator below one thousand', () => {
    expect(formatBrl(999.99)).toBe(`R$${NBSP}999,99`)
  })

  it('reads in English the English way, separators and symbol placement both', () => {
    setNumberLanguage('en-US')
    expect(formatBrl(1234.56)).toBe('R$1,234.56')
  })
})

describe('formatUsd, on a device whose own currency is USD', () => {
  beforeEach(() => setLocalCurrency(['USD']))
  afterEach(() => {
    setNumberLanguage('en-US')
    setLocalCurrency([])
  })

  it('English writes a bare $ against the digits', () => {
    expect(formatUsd(3.15)).toBe('$3.15')
    expect(formatUsd(1234.56)).toBe('$1,234.56')
  })

  it('formats a small value with two decimal places', () => {
    expect(formatUsd(4.9)).toBe('$4.90')
  })

  it('separates thousands in large values', () => {
    expect(formatUsd(1_000_000)).toBe('$1,000,000.00')
  })

  it('Portuguese keeps US$ and a no-break space', () => {
    setNumberLanguage('pt-BR')
    expect(formatUsd(3.15)).toBe(`US$${NBSP}3,15`)
    expect(formatUsd(12.62)).toBe(`US$${NBSP}12,62`)
  })

  it('rounds as before, by toFixed, whatever the language', () => {
    expect(formatUsd(1.005)).toBe('$1.00')
    setNumberLanguage('de')
    expect(formatUsd(1.005)).toBe(`1,00${NBSP}$`)
  })
})

describe('formatFiatGeneric', () => {
  afterEach(() => setNumberLanguage('en-US'))

  it('Portuguese: symbol first with a no-break space, dot thousands, comma decimal', () => {
    setNumberLanguage('pt-BR')
    expect(formatFiatGeneric(1234567.5, '€', 2)).toBe(`€${NBSP}1.234.567,50`)
  })

  it('English: a currency sign sits against the digits', () => {
    expect(formatFiatGeneric(1234567.5, '€', 2)).toBe('€1,234,567.50')
  })

  it('a zero-decimal currency (e.g. JPY) shows no decimal part', () => {
    expect(formatFiatGeneric(1234, '¥', 0)).toBe('¥1,234')
  })

  it('a symbol ending in a letter takes a no-break space where the pattern has none', () => {
    expect(formatFiatGeneric(1234.56, 'kr', 2)).toBe(`kr${NBSP}1,234.56`)
    expect(formatFiatGeneric(1234, 'Ft', 0)).toBe(`Ft${NBSP}1,234`)
  })

  it('German puts every symbol after the amount', () => {
    setNumberLanguage('de')
    expect(formatFiatGeneric(1234.56, 'kr', 2)).toBe(`1.234,56${NBSP}kr`)
    expect(formatFiatGeneric(1234.56, '€', 2)).toBe(`1.234,56${NBSP}€`)
  })

  it('a minus goes before a leading symbol, as CLDR writes it', () => {
    expect(formatFiatGeneric(-5, '€', 2)).toBe('-€5.00')
    setNumberLanguage('pt-BR')
    expect(formatFiatGeneric(-5, '€', 2)).toBe(`-€${NBSP}5,00`)
  })

  it('writes a $ in the symbol literally, never as a replacement pattern', () => {
    expect(formatFiatGeneric(1, "$&$'", 2)).toBe(`$&$'${NBSP}1.00`)
  })
})

// The separators come from a table rather than Intl at run time, so a device writes exactly what
// this measures whatever Intl its JavaScript engine ships. The table is checked here against CLDR,
// through Node's ICU, with Latin digits, which is what every other number in the app uses.
describe('every shipped language writes numbers the CLDR way', () => {
  const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales')
  const locales = fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => name.replace('.json', ''))
  const cldr = (locale: string, n: number, fraction: [number, number] = [0, 8]): string =>
    new Intl.NumberFormat(`${locale}-u-nu-latn`, {
      minimumFractionDigits: fraction[0],
      maximumFractionDigits: fraction[1],
    }).format(n)
  afterEach(() => setNumberLanguage('en-US'))

  // Guards the comparison itself, which would pass for a formatter that ignores the language if
  // every language happened to agree.
  it('covers the 24 languages, which do not all agree', () => {
    expect(locales.length).toBeGreaterThanOrEqual(24)
    expect(new Set(locales.map(locale => cldr(locale, 1234567.5))).size).toBeGreaterThanOrEqual(5)
  })

  it.each(locales)('%s', locale => {
    setNumberLanguage(locale)
    for (const whole of ['7', '1234', '12345', '123456789']) {
      expect(localizeAmount(whole)).toBe(cldr(locale, Number(whole)))
    }
    for (const amount of ['1234.5', '0.00052321', '12345.678901']) {
      expect(localizeAmount(amount)).toBe(cldr(locale, Number(amount)))
    }
    expect(decimalMark()).toBe(cldr(locale, 1.5).charAt(1))
  })
})

// The symbol, its side and the space between it and the digits come from a table as well, checked
// here against CLDR's currency format for every shipped language.
describe('every shipped language writes money the CLDR way', () => {
  const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales')
  const locales = fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => name.replace('.json', ''))
  const currencyFormat = (locale: string, currency: string): Intl.NumberFormat =>
    new Intl.NumberFormat(`${locale}-u-nu-latn`, { style: 'currency', currency })
  const VALUES = [3.15, 1234567.89, 0, -5]
  afterEach(() => setNumberLanguage('en-US'))

  it('covers the 24 languages, which place the dollar in more than one way', () => {
    expect(locales.length).toBeGreaterThanOrEqual(24)
    const dollars = new Set(locales.map(locale => currencyFormat(locale, 'USD').format(3.15)))
    expect(dollars.size).toBeGreaterThanOrEqual(8)
  })

  it.each(locales)('%s: USD and BRL, each on a device whose own currency it is', locale => {
    setNumberLanguage(locale)
    for (const currency of ['USD', 'BRL']) {
      setLocalCurrency([currency])
      for (const value of VALUES) {
        expect(formatFiat(value, currency)).toBe(currencyFormat(locale, currency).format(value))
      }
    }
    setLocalCurrency([])
  })

  // Away from a dollar country, a language whose CLDR symbol for USD is the bare $ takes CLDR
  // root's US$ in its place, on the same side and with the same spacing.
  it.each(locales)('%s: USD on a device whose own currency is not USD', locale => {
    setNumberLanguage(locale)
    setLocalCurrency(['AUD'])
    for (const value of VALUES) {
      const expected = currencyFormat(locale, 'USD')
        .formatToParts(value)
        .map(part => (part.type === 'currency' && part.value === '$' ? 'US$' : part.value))
        .join('')
      expect(formatFiat(value, 'USD')).toBe(expected)
    }
    setLocalCurrency([])
  })

  // A feed currency takes its symbol from the feed, and its side and spacing from the language.
  // Given the symbol CLDR uses, it must read exactly as CLDR does, letters (CHF, SEK) and signs
  // (€, ¥) alike.
  it.each(locales)('%s: currencies from the feed', locale => {
    for (const currency of ['EUR', 'CHF', 'JPY', 'SEK', 'INR', 'ILS', 'THB']) {
      const format = currencyFormat(locale, currency)
      const symbol = format.formatToParts(1).find(part => part.type === 'currency')!.value
      const fractionSize = format.resolvedOptions().maximumFractionDigits ?? 2
      configureFiatFormats([{ id: currency, symbol, fractionSize }], locale)
      for (const value of VALUES) {
        expect(formatFiat(value, currency)).toBe(format.format(value))
      }
    }
  })
})

describe('the dollar, by language, on a US device', () => {
  beforeEach(() => setLocalCurrency(['USD']))
  afterEach(() => {
    setNumberLanguage('en-US')
    setLocalCurrency([])
  })

  it('English shows $3.15 and Portuguese US$ 3,15', () => {
    expect(formatFiat(3.15, 'USD')).toBe('$3.15')
    setNumberLanguage('pt-BR')
    expect(formatFiat(3.15, 'USD')).toBe(`US$${NBSP}3,15`)
  })

  it('right-to-left languages put the symbol where CLDR does, with Latin digits', () => {
    setNumberLanguage('ar')
    expect(formatFiat(3.15, 'USD')).toBe(`${RLM}3.15${NBSP}US$`)
    setNumberLanguage('he')
    expect(formatFiat(3.15, 'USD')).toBe(`${RLM}3.15${NBSP}${RLM}$`)
    setNumberLanguage('ur')
    expect(formatFiat(3.15, 'USD')).toBe('$3.15')
  })

  it('a dollar the feed gives only a bare $ is named by its code, never read as US dollars', () => {
    configureFiatFormats([{ id: 'MXN', symbol: '$', fractionSize: 2 }], 'en-US')
    expect(fiatSymbol('MXN')).toBe('MXN')
    expect(formatFiat(1234.5, 'MXN')).toBe(`MXN${NBSP}1,234.50`)
    configureFiatFormats([{ id: 'AUD', symbol: 'AU$', fractionSize: 2 }], 'en-US')
    expect(formatFiat(1234.5, 'AUD')).toBe('AU$1,234.50')
  })

  it('the affixes a caller draws around its own digits match formatFiat', () => {
    for (const language of ['en-US', 'pt-BR', 'de', 'ar', 'he', 'es-MX', 'fr-CA']) {
      setNumberLanguage(language)
      const { before, after } = fiatAffixes('USD')
      expect(`${before}${localizeAmount('1234.50')}${after}`).toBe(formatFiat(1234.5, 'USD'))
    }
  })

  it('follows a change of language with no other call', () => {
    expect(fiatSymbol('USD')).toBe('$')
    setNumberLanguage('es-MX')
    expect(fiatSymbol('USD')).toBe('USD')
    expect(formatFiat(3.15, 'USD')).toBe(`USD${NBSP}3.15`)
    setNumberLanguage('fr')
    expect(formatFiat(3.15, 'USD')).toBe(`3,15${NBSP}$US`)
  })
})

// A bare $ is the reader's own dollar, so it is written only for the device's own currency, in every
// shipped language and on every path that draws a symbol beside a number.
describe("a bare $ is written only for the device's own currency", () => {
  const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales')
  const locales = fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => name.replace('.json', ''))
  // The feed gives these dollars and pesos only a bare $, and Australia's its own AU$.
  const FEED = [
    { id: 'MXN', symbol: '$', fractionSize: 2 },
    { id: 'ARS', symbol: '$', fractionSize: 2 },
    { id: 'CLP', symbol: '$', fractionSize: 0 },
    { id: 'AUD', symbol: 'AU$', fractionSize: 2 },
    { id: 'EUR', symbol: '€', fractionSize: 2 },
  ]
  const CURRENCIES = ['USD', 'BRL', ...FEED.map(c => c.id)]
  const fraction = (currency: string): number => (currency === 'USD' || currency === 'BRL' ? 2 : fiatFractionSize(currency))
  const bare = (value: number, currency: string): string => formatFiatGeneric(value, '$', fraction(currency))
  afterEach(() => {
    setNumberLanguage('en-US')
    setLocalCurrency([])
  })

  it('English on a US device writes $3.15', () => {
    setNumberLanguage('en-US')
    setLocalCurrency(['USD', 'EUR'])
    expect(formatFiat(3.15, 'USD')).toBe('$3.15')
  })

  it('English on an Australian device writes US$3.15, as CLDR en-001 does', () => {
    setNumberLanguage('en-US')
    setLocalCurrency(['AUD'])
    expect(formatFiat(3.15, 'USD')).toBe('US$3.15')
    expect(formatFiat(3.15, 'USD')).toBe(new Intl.NumberFormat('en-001', { style: 'currency', currency: 'USD' }).format(3.15))
  })

  it('Mexican Spanish on a Mexican device writes the peso with $ and the dollar as CLDR does', () => {
    configureFiatFormats(FEED, 'es-MX')
    setLocalCurrency(['MXN'])
    expect(formatFiat(1234.5, 'MXN')).toBe('$1,234.50')
    expect(formatFiat(3.15, 'USD')).toBe(`USD${NBSP}3.15`)
  })

  it('Portuguese on a Brazilian device keeps US$ 3,15', () => {
    setNumberLanguage('pt-BR')
    setLocalCurrency(['BRL'])
    expect(formatFiat(3.15, 'USD')).toBe(`US$${NBSP}3,15`)
  })

  it('English on a Mexican device writes the peso with $ and the dollar with US$', () => {
    configureFiatFormats(FEED, 'en-US')
    setLocalCurrency(['MXN'])
    expect(formatFiat(1234.5, 'MXN')).toBe('$1,234.50')
    expect(formatFiat(3.15, 'USD')).toBe('US$3.15')
  })

  it('a device that names no currency writes no bare $ at all', () => {
    configureFiatFormats(FEED, 'en-US')
    setLocalCurrency([])
    for (const currency of CURRENCIES) {
      expect(fiatSymbol(currency)).not.toBe('$')
    }
  })

  it.each(locales)('%s', locale => {
    configureFiatFormats(FEED, locale)
    // Guards the sweep itself: it must meet the bare $ where it is allowed, or it proves nothing.
    let allowed = 0
    for (const local of ['USD', 'MXN', 'AUD', 'EUR', 'BRL']) {
      setLocalCurrency([local])
      for (const currency of CURRENCIES) {
        const isBare = fiatSymbol(currency) === '$'
        if (currency !== local) {
          expect([local, currency, isBare]).toEqual([local, currency, false])
        }
        allowed += isBare ? 1 : 0
        for (const value of [3.15, 1234.5, -5]) {
          expect(formatFiat(value, currency) === bare(value, currency)).toBe(isBare)
        }
        const { before, after } = fiatAffixes(currency)
        expect(`${before}${localizeAmount('1234.50')}${after}` === bare(1234.5, currency)).toBe(isBare)
      }
    }
    // The peso always keeps its $ at home, in every language.
    expect(allowed).toBeGreaterThanOrEqual(1)
    setLocalCurrency(['MXN'])
    expect(fiatSymbol('MXN')).toBe('$')
  })

  // USD at home keeps the bare $ in exactly the languages whose CLDR symbol for it is $.
  it('USD at home is a bare $ in the languages CLDR writes it so, and only those', () => {
    setLocalCurrency(['USD'])
    const cldrBare = locales.filter(locale =>
      new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' })
        .formatToParts(1)
        .some(part => part.type === 'currency' && part.value === '$'),
    )
    const ours = locales.filter(locale => {
      setNumberLanguage(locale)
      return fiatSymbol('USD') === '$'
    })
    expect(ours).toEqual(cldrBare)
    expect(ours.length).toBeGreaterThanOrEqual(5)
  })
})

describe('formatFiat', () => {
  afterEach(() => {
    setNumberLanguage('en-US')
    setLocalCurrency([])
  })

  it('BRL reads in the app language, Brazilian in Portuguese', () => {
    setNumberLanguage('pt-BR')
    expect(formatFiat(1234.56, 'BRL')).toBe(`R$${NBSP}1.234,56`)
  })

  it('USD reads in the app language, American in English on a US device', () => {
    setLocalCurrency(['USD'])
    expect(formatFiat(1234.56, 'USD')).toBe('$1,234.56')
  })

  it('an unconfigured currency falls back to "CODE 1,234.56" without throwing', () => {
    expect(formatFiat(10, 'GBP')).toBe(`GBP${NBSP}10.00`)
  })

  it('a configured currency uses its own symbol + decimals', () => {
    configureFiatFormats([{ id: 'EUR', symbol: '€', fractionSize: 2 }], 'en')
    expect(formatFiat(1234.5, 'EUR')).toBe('€1,234.50')
  })

  it('the locale drives the separators: pt renders the same currency the Brazilian way', () => {
    configureFiatFormats([{ id: 'EUR', symbol: '€', fractionSize: 2 }], 'pt-BR')
    expect(formatFiat(1234.5, 'EUR')).toBe(`€${NBSP}1.234,50`)
  })

  it('the language, not the feed, puts the symbol after the amount', () => {
    configureFiatFormats([{ id: 'SEK', symbol: 'kr', fractionSize: 2 }], 'en')
    expect(formatFiat(1234.5, 'SEK')).toBe(`kr${NBSP}1,234.50`)
    configureFiatFormats([{ id: 'SEK', symbol: 'kr', fractionSize: 2 }], 'de')
    expect(formatFiat(1234.5, 'SEK')).toBe(`1.234,50${NBSP}kr`)
  })
})

describe('defaultFiatForLocale (single source of truth for the no-choice default)', () => {
  it('Portuguese defaults to BRL', () => {
    expect(defaultFiatForLocale('pt-BR')).toBe('BRL')
    expect(defaultFiatForLocale('pt')).toBe('BRL')
  })

  it('every other locale defaults to USD', () => {
    expect(defaultFiatForLocale('en-US')).toBe('USD')
    expect(defaultFiatForLocale('es')).toBe('USD')
    expect(defaultFiatForLocale('fr')).toBe('USD')
  })
})

describe('pickDefaultFiat (device region currency, language fallback)', () => {
  it('uses the device region currency when the device reports one', () => {
    expect(pickDefaultFiat(['BRL', 'USD'], 'en-US')).toBe('BRL') // Brazilian device, English app
    expect(pickDefaultFiat(['MXN'], 'en-US')).toBe('MXN')
    expect(pickDefaultFiat(['EUR'], 'pt-PT')).toBe('EUR') // pt-PT (Portugal) is EUR, not BRL
  })

  it('falls back to the app language when the device reports no currency', () => {
    expect(pickDefaultFiat([], 'pt-BR')).toBe('BRL')
    expect(pickDefaultFiat([], 'en-US')).toBe('USD')
  })

  it('ignores a malformed device currency and falls back to the language', () => {
    expect(pickDefaultFiat([''], 'en-US')).toBe('USD')
    expect(pickDefaultFiat(['US'], 'pt-BR')).toBe('BRL') // not a 3-letter code
  })
})

describe('fiatFractionSize (decimals per currency)', () => {
  it('standard currencies (incl. BRL/USD) use 2', () => {
    expect(fiatFractionSize('BRL')).toBe(2)
    expect(fiatFractionSize('USD')).toBe(2)
    expect(fiatFractionSize('GBP')).toBe(2)
  })

  it('zero-decimal currencies use 0 (JPY/KRW/VND have no cents)', () => {
    expect(fiatFractionSize('JPY')).toBe(0)
    expect(fiatFractionSize('KRW')).toBe(0)
    expect(fiatFractionSize('VND')).toBe(0)
  })

  it('the Gulf dinars use 3', () => {
    expect(fiatFractionSize('KWD')).toBe(3)
    expect(fiatFractionSize('BHD')).toBe(3)
  })

  it('a configured feed value wins over the ISO table', () => {
    configureFiatFormats([{ id: 'QQQ', symbol: 'Q', fractionSize: 4 }], 'en-US')
    expect(fiatFractionSize('QQQ')).toBe(4) // registry, not the default 2
  })
})

describe('formatFiat fallback keeps the right decimals for an unconfigured currency', () => {
  it('a zero-decimal currency (KRW) shows no cents even before the registry loads', () => {
    configureFiatFormats([], 'en-US') // an empty registry leaves KRW unconfigured
    expect(formatFiat(1000, 'KRW')).toBe(`KRW${NBSP}1,000`)
  })

  it('a three-decimal currency (KWD) shows three', () => {
    configureFiatFormats([], 'en-US')
    expect(formatFiat(1234.5, 'KWD')).toBe(`KWD${NBSP}1,234.500`)
  })
})

describe('currencyCountry (ISO 4217 code -> ISO 3166 country)', () => {
  it('derives the country from the first two letters of the code', () => {
    expect(currencyCountry('USD')).toBe('US')
    expect(currencyCountry('BRL')).toBe('BR')
    expect(currencyCountry('JPY')).toBe('JP')
    expect(currencyCountry('GBP')).toBe('GB')
  })

  it('EUR maps to EU (an economic aggregate that has a flag)', () => {
    expect(currencyCountry('EUR')).toBe('EU')
  })

  it('supranational X-codes with no flag at all (metals, SDR) -> null (globe)', () => {
    expect(currencyCountry('XAU')).toBeNull() // gold
    expect(currencyCountry('XDR')).toBeNull() // IMF SDR
  })

  it('maps the CFA francs to their issuing central bank seat', () => {
    expect(currencyCountry('XOF')).toBe('SN') // BCEAO, Dakar
    expect(currencyCountry('XAF')).toBe('CM') // BEAC, Yaoundé
  })

  it('overrides ANG to Curaçao, whose retired AN code has no flag', () => {
    expect(currencyCountry('ANG')).toBe('CW')
  })

  it('is case-insensitive', () => {
    expect(currencyCountry('brl')).toBe('BR')
  })
})

describe('fiatSymbol', () => {
  afterEach(() => {
    setNumberLanguage('en-US')
    setLocalCurrency([])
  })

  it('BRL/USD take the symbol the app language gives them, on a US device', () => {
    setLocalCurrency(['USD'])
    expect(fiatSymbol('BRL')).toBe('R$')
    expect(fiatSymbol('USD')).toBe('$')
    setNumberLanguage('pt-BR')
    expect(fiatSymbol('USD')).toBe('US$')
    setNumberLanguage('it')
    expect(fiatSymbol('BRL')).toBe('BRL')
  })

  it('a configured currency reports its symbol; an unknown one falls back to its code', () => {
    configureFiatFormats([{ id: 'JPY', symbol: '¥', fractionSize: 0 }], 'en')
    expect(fiatSymbol('JPY')).toBe('¥')
    expect(fiatSymbol('ZZZ')).toBe('ZZZ')
  })
})

describe('assetFiatValue', () => {
  it('a peg shown in its own currency is the amount itself', () => {
    expect(assetFiatValue(25, 'USD', 'USD', RATES)).toBe(25)
  })

  it('crosses a USD peg into BRL through the two BTC rates', () => {
    // One USD-pegged unit crosses at 550k/100k, so R$ 5.50.
    expect(assetFiatValue(1, 'USD', 'BRL', RATES)).toBeCloseTo(5.5, 6)
  })

  it('crosses a BRL peg into USD', () => {
    expect(assetFiatValue(10, 'BRL', 'USD', RATES)).toBeCloseTo(1.81818, 4)
  })

  it('is zero for an unpegged asset (memecoin) so it never corrupts the total', () => {
    expect(assetFiatValue(1_000_000, undefined, 'USD', RATES)).toBe(0)
  })

  it('is zero when the peg has no rate we fetched', () => {
    expect(assetFiatValue(5, 'EUR', 'USD', RATES)).toBe(0)
  })

  it('is zero for a non-positive amount', () => {
    expect(assetFiatValue(0, 'USD', 'USD', RATES)).toBe(0)
  })
})

describe('walletFiatTotal', () => {
  it('sums bitcoin and every pegged holding when each has a value in the currency', () => {
    const total = walletFiatTotal(
      100_000,
      [
        { amount: 1, pegFiat: 'USD' },
        { amount: 10, pegFiat: 'BRL' },
      ],
      'USD',
      RATES,
    )
    expect(total).toBeCloseTo(102.81818, 4)
  })

  it('is null when bitcoin has no rate in the currency', () => {
    expect(walletFiatTotal(100_000, [], 'BRL', { USD: 100_000 })).toBeNull()
    expect(walletFiatTotal(100_000, [{ amount: 1, pegFiat: 'USD' }], 'USD', {})).toBeNull()
  })

  it('is null when a pegged holding cannot be crossed into the currency', () => {
    // Offline after a restart: no rates at all, so USDB has no value in reais.
    expect(walletFiatTotal(0, [{ amount: 22.68, pegFiat: 'USD' }], 'BRL', {})).toBeNull()
    // A feed without the peg's own currency.
    expect(walletFiatTotal(3_062, [{ amount: 22.68, pegFiat: 'USD' }], 'BRL', { BRL: 550_000 })).toBeNull()
  })

  it('is null for a nonzero token with no peg, whatever the rates', () => {
    expect(walletFiatTotal(100_000, [{ amount: 999, pegFiat: undefined }], 'USD', RATES)).toBeNull()
  })

  it('needs no rate for a holding pegged to the currency itself, nor for empty holdings', () => {
    expect(walletFiatTotal(0, [{ amount: 22.68, pegFiat: 'USD' }], 'USD', {})).toBeCloseTo(22.68, 6)
    expect(
      walletFiatTotal(0, [{ amount: 0, pegFiat: 'BRL' }, { amount: 0, pegFiat: undefined }], 'USD', {}),
    ).toBe(0)
  })
})

describe('localizeAmount (the decimal mark follows the app language)', () => {
  afterEach(() => setNumberLanguage('en-US'))

  test('Portuguese reads a comma', () => {
    setNumberLanguage('pt-BR')
    expect(localizeAmount('0.00052')).toBe('0,00052')
    expect(decimalMark()).toBe(',')
  })

  test('any other language keeps the dot', () => {
    setNumberLanguage('en-GB')
    expect(localizeAmount('0.00052')).toBe('0.00052')
    expect(decimalMark()).toBe('.')
  })

  test('a whole amount has no mark to change', () => {
    setNumberLanguage('pt-BR')
    expect(localizeAmount('12')).toBe('12')
  })
})
