// The SDK reports Rate.value as fiat per 1 BTC, so sats to fiat is sats/1e8 * rate.
const SATS_PER_BTC = 100_000_000

export function satsToFiat(sats: number, btcFiatRate: number): number {
  return (sats / SATS_PER_BTC) * btcFiatRate
}

export function fiatToSats(fiatValue: number, btcFiatRate: number): number {
  if (!(btcFiatRate > 0)) {
    return 0
  }
  return Math.round((fiatValue / btcFiatRate) * SATS_PER_BTC)
}

export function formatBrl(value: number): string {
  return formatFiatGeneric(value, fiatSymbol('BRL'), 2)
}

export function formatUsd(value: number): string {
  return formatFiatGeneric(value, fiatSymbol('USD'), 2)
}

// An unpegged asset or a peg with no known rate returns 0 rather than corrupting the total.
export function assetFiatValue(
  amount: number,
  pegFiat: string | undefined,
  currency: FiatCurrency,
  rates: Record<string, number>,
): number {
  if (!pegFiat || !(amount > 0)) {
    return 0
  }
  if (pegFiat === currency) {
    return amount
  }
  const pegRate = rates[pegFiat]
  const displayRate = rates[currency]
  if (!(pegRate > 0) || !(displayRate > 0)) {
    return 0
  }
  return amount * (displayRate / pegRate)
}

// The whole wallet in `currency`, or null when a nonzero holding has no value there: bitcoin without
// the currency's rate, a pegged token without the rates that cross its peg into it, or a token with
// no peg at all. A sum that skipped such a holding would read as the total while leaving it out.
export function walletFiatTotal(
  btcSat: number,
  assets: { amount: number; pegFiat?: string }[],
  currency: FiatCurrency,
  rates: Record<string, number>,
): number | null {
  let total = 0
  if (btcSat > 0) {
    const rate = rates[currency]
    if (!(rate > 0)) {
      return null
    }
    total += satsToFiat(btcSat, rate)
  }
  for (const a of assets) {
    if (!(a.amount > 0)) {
      continue
    }
    const value = assetFiatValue(a.amount, a.pegFiat, currency, rates)
    if (!(value > 0)) {
      return null
    }
    total += value
  }
  return total
}

// Any code the SDK's fiat feed knows, not a closed union, because the app is international.
export type FiatCurrency = string

// How the app language writes a number, as CLDR does with Latin digits. `minGroup` is the fewest
// integer digits that take a separator at all (Spanish writes 1234 but 12.345), and `secondary` is
// the size of every group after the first (Hindi writes 12,34,567). A table rather than Intl, so a
// device writes exactly what the test measures whatever Intl its JavaScript engine ships.
type Separators = { decimal: string; group: string; minGroup?: number; secondary?: number }

const DOT_DECIMAL: Separators = { decimal: '.', group: ',' }
const COMMA_DECIMAL: Separators = { decimal: ',', group: '.' }
const NBSP = '\u00a0'
const NARROW_NBSP = '\u202f'

// Keyed by the tag the app ships, falling back to its base language and then to English.
const SEPARATORS: Record<string, Separators> = {
  en: DOT_DECIMAL,
  ar: DOT_DECIMAL,
  he: DOT_DECIMAL,
  ja: DOT_DECIMAL,
  ko: DOT_DECIMAL,
  th: DOT_DECIMAL,
  ur: DOT_DECIMAL,
  zh: DOT_DECIMAL,
  'es-MX': DOT_DECIMAL,
  hi: { ...DOT_DECIMAL, secondary: 2 },
  de: COMMA_DECIMAL,
  id: COMMA_DECIMAL,
  pt: COMMA_DECIMAL,
  tr: COMMA_DECIMAL,
  vi: COMMA_DECIMAL,
  es: { ...COMMA_DECIMAL, minGroup: 5 },
  it: { ...COMMA_DECIMAL, minGroup: 5 },
  fr: { decimal: ',', group: NARROW_NBSP },
  'fr-CA': { decimal: ',', group: NBSP },
  ru: { decimal: ',', group: NBSP },
  pl: { decimal: ',', group: NBSP, minGroup: 5 },
  'pt-PT': { decimal: ',', group: NBSP, minGroup: 5 },
}

// How the app language writes an amount of money, from CLDR's standard currency pattern with Latin
// digits. `pattern` is where the symbol (¤) sits around the number (#), with the no-break space and
// the bidi marks the pattern itself carries, `minus` is the language's minus sign, and USD and BRL
// take the symbol the language gives them, except that a bare $ is kept for the device's own
// currency (fiatSymbol). Placement belongs to the language, not to the currency, as in CLDR, so
// German writes 3,15 $ and 3,15 €, and English $3.15 and €3.15.
type MoneyFormat = { pattern: string; USD: string; BRL: string; minus?: string }

const RLM = '\u200f'
// Arabic, Hebrew and Urdu keep the minus on the left of the digits with a left-to-right mark.
const LRM_MINUS = '\u200e-'
const TIGHT_PREFIX = '¤#'
const SPACED_PREFIX = `¤${NBSP}#`
const SPACED_SUFFIX = `#${NBSP}¤`

// Keyed as SEPARATORS is. Spanish, Italian and Mexican Spanish name a currency by its code where
// the language has no symbol for it, and Mexican Spanish keeps the bare $ for the peso.
const MONEY: Record<string, MoneyFormat> = {
  en: { pattern: TIGHT_PREFIX, USD: '$', BRL: 'R$' },
  'en-GB': { pattern: TIGHT_PREFIX, USD: 'US$', BRL: 'R$' },
  hi: { pattern: TIGHT_PREFIX, USD: '$', BRL: 'R$' },
  ja: { pattern: TIGHT_PREFIX, USD: '$', BRL: 'R$' },
  tr: { pattern: TIGHT_PREFIX, USD: '$', BRL: 'R$' },
  ur: { pattern: TIGHT_PREFIX, USD: '$', BRL: 'R$', minus: LRM_MINUS },
  id: { pattern: TIGHT_PREFIX, USD: 'US$', BRL: 'R$' },
  ko: { pattern: TIGHT_PREFIX, USD: 'US$', BRL: 'R$' },
  th: { pattern: TIGHT_PREFIX, USD: 'US$', BRL: 'R$' },
  zh: { pattern: TIGHT_PREFIX, USD: 'US$', BRL: 'R$' },
  'es-MX': { pattern: TIGHT_PREFIX, USD: 'USD', BRL: 'BRL' },
  pt: { pattern: SPACED_PREFIX, USD: 'US$', BRL: 'R$' },
  'pt-PT': { pattern: SPACED_SUFFIX, USD: 'US$', BRL: 'R$' },
  de: { pattern: SPACED_SUFFIX, USD: '$', BRL: 'R$' },
  ru: { pattern: SPACED_SUFFIX, USD: '$', BRL: 'R$' },
  es: { pattern: SPACED_SUFFIX, USD: 'US$', BRL: 'BRL' },
  vi: { pattern: SPACED_SUFFIX, USD: 'US$', BRL: 'R$' },
  fr: { pattern: SPACED_SUFFIX, USD: '$US', BRL: 'R$' },
  'fr-CA': { pattern: SPACED_SUFFIX, USD: `$${NBSP}US`, BRL: 'R$' },
  it: { pattern: SPACED_SUFFIX, USD: 'USD', BRL: 'BRL' },
  pl: { pattern: SPACED_SUFFIX, USD: 'USD', BRL: 'R$' },
  ar: { pattern: `${RLM}#${NBSP}¤`, USD: 'US$', BRL: 'R$', minus: LRM_MINUS },
  he: { pattern: `${RLM}#${NBSP}${RLM}¤`, USD: '$', BRL: 'R$', minus: LRM_MINUS },
}

const fiatRegistry = new Map<string, { symbol: string; fractionSize: number }>()
let separators: Separators = DOT_DECIMAL
let money: MoneyFormat = MONEY.en
// The device's own currency, null until src/i18n reads it and when the device names none.
let localCurrency: FiatCurrency | null = null

function forLanguage<T>(table: Record<string, T>, language: string): T | undefined {
  return table[language] ?? table[language.split('-')[0]]
}

// Set from the app language at boot and on every change, by a listener in src/i18n.
export function setNumberLanguage(language: string): void {
  separators = forLanguage(SEPARATORS, language) ?? DOT_DECIMAL
  money = forLanguage(MONEY, language) ?? MONEY.en
}

// The first currency the device reports for its region, when it is an ISO 4217 code. Both the
// default display currency and the bare $ go by it.
function deviceRegionCurrency(deviceCurrencies: string[]): FiatCurrency | null {
  const first = deviceCurrencies[0]?.toUpperCase()
  return first && /^[A-Z]{3}$/.test(first) ? first : null
}

// Set from react-native-localize's getCurrencies() at boot and on every return to the foreground, by
// src/i18n.
export function setLocalCurrency(deviceCurrencies: string[]): void {
  localCurrency = deviceRegionCurrency(deviceCurrencies)
}

export function decimalMark(): string {
  return separators.decimal
}

// Separates the thousands of a run of integer digits the way the app language does.
export function groupDigits(digits: string): string {
  const { group, minGroup = 4, secondary = 3 } = separators
  if (digits.length < minGroup) {
    return digits
  }
  const groups = [digits.slice(-3)]
  let rest = digits.slice(0, -3)
  while (rest.length > secondary) {
    groups.unshift(rest.slice(-secondary))
    rest = rest.slice(0, -secondary)
  }
  if (rest) {
    groups.unshift(rest)
  }
  return groups.join(group)
}

// An amount as the user reads it. Amounts are built with a dot and no grouping, which parsing and
// payment URIs expect, so only the text bound for the screen takes the language's separators. It
// takes one amount, not a sentence, whose own full stop is not a decimal mark.
export function localizeAmount(amount: string): string {
  const negative = amount.startsWith('-')
  const [whole, fraction] = (negative ? amount.slice(1) : amount).split('.')
  const body =
    fraction === undefined
      ? groupDigits(whole)
      : `${groupDigits(whole)}${separators.decimal}${fraction}`
  return negative ? `-${body}` : body
}

// Covers formatting done before the SDK registry loads. The feed's value wins once present.
const NON_STANDARD_FRACTIONS: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, PYG: 0, XAF: 0, XOF: 0, XPF: 0, RWF: 0, UGX: 0, GNF: 0,
  BIF: 0, DJF: 0, KMF: 0, VUV: 0,
  KWD: 3, BHD: 3, OMR: 3, TND: 3, JOD: 3, LYD: 3, IQD: 3,
}

export function fiatFractionSize(currency: FiatCurrency): number {
  return fiatRegistry.get(currency)?.fractionSize ?? NON_STANDARD_FRACTIONS[currency.toUpperCase()] ?? 2
}

// The feed's placement of a symbol is its home country's habit and is not kept, since the app
// language places every currency, as CLDR does.
export function configureFiatFormats(
  currencies: { id: string; symbol: string; fractionSize: number }[],
  locale: string,
): void {
  setNumberLanguage(locale)
  for (const c of currencies) {
    fiatRegistry.set(c.id, { symbol: c.symbol, fractionSize: c.fractionSize })
  }
}

// CLDR's currency spacing: where the pattern sets the symbol against the digits, a symbol whose
// touching character is not itself a symbol or a space takes a no-break space, so CHF 3.15 but
// $3.15.
// The React Native Babel preset expands the property escapes into plain ranges at build time.
const SYMBOL_OR_SPACE = /[\p{S}\p{Z}]/u

function spacing(edge: string | undefined): string {
  return edge !== undefined && !SYMBOL_OR_SPACE.test(edge) ? NBSP : ''
}

// What the app language writes before and after the digits of an amount in `symbol`. Replacements
// go through a function so a $ in the symbol is never read as a replacement pattern.
function moneyAffixes(symbol: string, negative: boolean): { before: string; after: string } {
  const [head, tail] = money.pattern.split('#')
  const sign = negative ? money.minus ?? '-' : ''
  const glyphs = Array.from(symbol)
  const lead = head.endsWith('¤') ? spacing(glyphs[glyphs.length - 1]) : ''
  const trail = tail.startsWith('¤') ? spacing(glyphs[0]) : ''
  const before = head.includes('¤')
    ? head.replace('¤', () => `${sign}${symbol}${lead}`)
    : `${head}${sign}`
  const after = tail.replace('¤', () => `${trail}${symbol}`)
  return { before, after }
}

export function formatFiatGeneric(value: number, symbol: string, fractionSize: number): string {
  const fixed = value.toFixed(fractionSize)
  const negative = fixed.startsWith('-')
  const { before, after } = moneyAffixes(symbol, negative)
  return `${before}${localizeAmount(negative ? fixed.slice(1) : fixed)}${after}`
}

const BARE_DOLLAR = '$'
// CLDR root's symbol for USD, the one en-001 writes.
const US_DOLLAR = 'US$'

// A reader takes a bare $ for the dollar of their own country, whatever language the app speaks, so
// only the device's own currency is written that way. USD elsewhere takes US$, and any other
// currency the feed gives only that glyph (MXN, ARS, CLP) is named by its code.
export function fiatSymbol(currency: FiatCurrency): string {
  const symbol =
    currency === 'BRL' || currency === 'USD'
      ? money[currency]
      : fiatRegistry.get(currency)?.symbol ?? currency
  if (symbol !== BARE_DOLLAR || currency === localCurrency) {
    return symbol
  }
  return currency === 'USD' ? US_DOLLAR : currency
}

// The text on each side of a non-negative amount in `currency`, for a caller that draws the digits
// itself, such as the amount being typed.
export function fiatAffixes(currency: FiatCurrency): { before: string; after: string } {
  return moneyAffixes(fiatSymbol(currency), false)
}

// BRL and USD keep two decimals whatever the feed says, as they always have.
export function formatFiat(value: number, currency: FiatCurrency): string {
  if (currency === 'BRL') {
    return formatBrl(value)
  }
  if (currency === 'USD') {
    return formatUsd(value)
  }
  return formatFiatGeneric(value, fiatSymbol(currency), fiatFractionSize(currency))
}

export function defaultFiatForLocale(language: string): FiatCurrency {
  return language.toLowerCase().startsWith('pt') ? 'BRL' : 'USD'
}

// The device's region currency wins over the app language, so a Mexican device starts in MXN.
export function pickDefaultFiat(deviceCurrencies: string[], language: string): FiatCurrency {
  return deviceRegionCurrency(deviceCurrencies) ?? defaultFiatForLocale(language)
}

// ISO 4217 prefixes that are not a usable ISO 3166 country (AN retired, CFA francs shared).
const COUNTRY_OVERRIDES: Record<string, string> = { ANG: 'CW', XOF: 'SN', XAF: 'CM' }

// Supranational X codes (XAU, XDR) have no flag at all and return null, which <Flag/> draws as a globe.
export function currencyCountry(currencyCode: string): string | null {
  const code = currencyCode.toUpperCase()
  if (COUNTRY_OVERRIDES[code]) {
    return COUNTRY_OVERRIDES[code]
  }
  const country = code.slice(0, 2)
  if (code.startsWith('X') || !/^[A-Z]{2}$/.test(country)) {
    return null
  }
  return country
}
