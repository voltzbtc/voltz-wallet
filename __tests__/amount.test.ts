import { crossChainBoundsSat, formatSats, parseAmountSat, parseConvertAmount } from '../src/wallet/amount'
import { setNumberLanguage } from '../src/wallet/fiat'

describe('parseAmountSat', () => {
  it('accepts a positive integer', () => {
    expect(parseAmountSat('1000')).toBe(1000)
  })

  it('accepts 1 sat', () => {
    expect(parseAmountSat('1')).toBe(1)
  })

  it('ignores surrounding whitespace', () => {
    expect(parseAmountSat('  1000  ')).toBe(1000)
  })

  it('accepts the whole bitcoin supply in sats', () => {
    expect(parseAmountSat('2100000000000000')).toBe(2_100_000_000_000_000)
  })

  it('rejects more than the whole supply', () => {
    expect(parseAmountSat('2100000000000001')).toBeNull()
  })

  it('rejects zero', () => {
    expect(parseAmountSat('0')).toBeNull()
  })

  it('rejects leading zeros that add up to zero', () => {
    expect(parseAmountSat('000')).toBeNull()
  })

  it('rejects a negative', () => {
    expect(parseAmountSat('-5')).toBeNull()
  })

  it('rejects a decimal, since a sat does not divide', () => {
    expect(parseAmountSat('10.5')).toBeNull()
  })

  it('rejects a decimal written with a comma', () => {
    expect(parseAmountSat('10,5')).toBeNull()
  })

  it('rejects text', () => {
    expect(parseAmountSat('abc')).toBeNull()
  })

  it('rejects an empty string', () => {
    expect(parseAmountSat('')).toBeNull()
  })

  it('rejects whitespace alone', () => {
    expect(parseAmountSat('   ')).toBeNull()
  })

  it('rejects scientific notation', () => {
    expect(parseAmountSat('1e3')).toBeNull()
  })

  it('rejects a number followed by text', () => {
    expect(parseAmountSat('100abc')).toBeNull()
  })

  it('rejects a leading plus', () => {
    expect(parseAmountSat('+100')).toBeNull()
  })

  it('rejects a thousands separator', () => {
    expect(parseAmountSat('1.000')).toBeNull()
    expect(parseAmountSat('1 000')).toBeNull()
  })

  it('rejects hexadecimal', () => {
    expect(parseAmountSat('0x10')).toBeNull()
  })

  it('rejects Infinity and NaN written as text', () => {
    expect(parseAmountSat('Infinity')).toBeNull()
    expect(parseAmountSat('NaN')).toBeNull()
  })
})

describe('parseConvertAmount', () => {
  it('accepts an integer', () => {
    expect(parseConvertAmount('10')).toBe(10)
  })

  it('accepts a decimal with a dot', () => {
    expect(parseConvertAmount('1.5')).toBe(1.5)
  })

  it('accepts a decimal with a comma, normalising it to a dot', () => {
    expect(parseConvertAmount('1,5')).toBe(1.5)
  })

  it('accepts a fraction that starts with a dot', () => {
    expect(parseConvertAmount('.5')).toBe(0.5)
  })

  it('ignores surrounding whitespace', () => {
    expect(parseConvertAmount('  2.5  ')).toBe(2.5)
  })

  it('rejects zero', () => {
    expect(parseConvertAmount('0')).toBeNull()
  })

  it('rejects a negative', () => {
    expect(parseConvertAmount('-1')).toBeNull()
  })

  it('rejects text', () => {
    expect(parseConvertAmount('abc')).toBeNull()
  })

  it('rejects an empty string', () => {
    expect(parseConvertAmount('')).toBeNull()
  })

  it('rejects scientific notation', () => {
    expect(parseConvertAmount('1e3')).toBeNull()
  })
})

// A route bounds a send both in sats and in dollars, and the tighter of the two binds.
describe('crossChainBoundsSat', () => {
  // Shaped after a live Orchestra entry for BTC to USDT on Tron.
  const tron = { minSat: 1200, minUsdCents: 80, maxUsdCents: 8_980_000 }

  it('takes the dollar floor when it is above the sats floor', () => {
    // 0.80 USD at 60,000 USD/BTC is 1,333.3 sats, rounded up so the floor is never under-quoted.
    expect(crossChainBoundsSat(tron, 60_000)).toEqual({ min: 1334, max: 149_666_666 })
  })

  it('takes the sats floor when bitcoin is dear enough', () => {
    expect(crossChainBoundsSat(tron, 100_000).min).toBe(1200)
  })

  it('keeps the tighter ceiling of the two', () => {
    expect(crossChainBoundsSat({ ...tron, maxSat: 1_000_000 }, 60_000).max).toBe(1_000_000)
  })

  it('ignores the dollar band without a usable rate', () => {
    for (const rate of [undefined, 0, NaN]) {
      expect(crossChainBoundsSat(tron, rate)).toEqual({ min: 1200, max: undefined })
    }
  })

  it('is unbounded when the route publishes nothing', () => {
    expect(crossChainBoundsSat({}, 60_000)).toEqual({ min: undefined, max: undefined })
  })
})

// Sats keep the Bitcoin convention in every language, a no-break space between groups, so a figure in
// sats never reads like a decimal and never wraps inside a group.
describe('formatSats', () => {
  afterEach(() => setNumberLanguage('en-US'))

  test.each(['pt-BR', 'en-US', 'fr', 'es', 'hi'])('groups with a no-break space in %s', language => {
    setNumberLanguage(language)
    expect(formatSats(1234)).toBe('1\u00a0234')
    expect(formatSats(47112)).toBe('47\u00a0112')
    expect(formatSats(123456789)).toBe('123\u00a0456\u00a0789')
    expect(formatSats(800)).toBe('800')
  })

  // The success overlays count up through fractions of a sat and pass each frame here. A frame left
  // unrounded reads as "822.80 126 953 125 sats".
  test('a fraction of a sat rounds to a whole one', () => {
    expect(formatSats(822.80126953125)).toBe('823')
    expect(formatSats(1234.4)).toBe('1\u00a0234')
  })
})
