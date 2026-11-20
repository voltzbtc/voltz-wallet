import { DEPIX } from '../src/wallet/tokens'
import {
  sparkConvertAssets,
  tokenIdOf,
  toBaseUnits,
  fromBaseUnits,
  quotedFigure,
  estimateSparkConvert,
  effectiveConvertCostPct,
  SPARK_BTC,
  KNOWN_SPARK_TOKENS,
  rangeBounds,
  type SparkConvertAsset,
} from '../src/wallet/sparkConvert'

const token = (over: Partial<Parameters<typeof sparkConvertAssets>[0][number]> = {}) => ({
  identifier: 'tkn1',
  ticker: 'USDs',
  name: 'Spark USD',
  decimals: 6,
  balanceBaseUnits: 100,
  ...over,
})
const knownIds = KNOWN_SPARK_TOKENS.map(k => k.id)

describe('sparkConvertAssets', () => {
  it('leads with BTC, then the known tokens, then the held tokens', () => {
    const assets = sparkConvertAssets([token({ identifier: 'tkn1' })])
    expect(assets[0]).toEqual(SPARK_BTC)
    expect(assets.map(a => a.id)).toEqual(['btc', ...knownIds, 'tkn1'])
    expect(assets.at(-1)).toEqual({ id: 'tkn1', ticker: 'USDs', name: 'Spark USD', decimals: 6 })
  })

  it('offers the known stablecoin (USDB) even with nothing held', () => {
    expect(sparkConvertAssets([]).map(a => a.id)).toEqual(['btc', ...knownIds])
  })

  // The app is international, so a real-pegged token waits for the person to add it or to hold
  // some.
  it('offers DePix once it is on the wallet list, not by default', () => {
    expect(sparkConvertAssets([]).map(a => a.id)).not.toContain(DEPIX.identifier)
    const listed = sparkConvertAssets([], [DEPIX])
    expect(listed.map(a => a.id)).toEqual(['btc', DEPIX.identifier])
    expect(listed[1].fiatId).toBe('BRL')
  })

  // The SDK's balance carries no peg, so a held token takes its peg from the registry by identifier.
  it('a held DePix is priced in reais, and an unknown token stays unpegged', () => {
    const assets = sparkConvertAssets([
      token({ identifier: DEPIX.identifier, ticker: 'DePix', decimals: 8 }),
      token({ identifier: 'tkn9', ticker: 'MEME' }),
    ])
    expect(assets.find(a => a.id === DEPIX.identifier)?.fiatId).toBe('BRL')
    expect(assets.find(a => a.id === 'tkn9')?.fiatId).toBeUndefined()
  })

  // Held or listed, the tokens come in the app's one order, the dollars, then the real, then the rest.
  it('orders the tokens the same way every list does, after bitcoin', () => {
    const assets = sparkConvertAssets(
      [token({ identifier: 'tkn9', ticker: 'MEME' }), token({ identifier: DEPIX.identifier, ticker: 'DePix', decimals: 8 })],
      [...KNOWN_SPARK_TOKENS.map(k => ({ identifier: k.id, name: k.name, ticker: k.ticker, decimals: k.decimals }))],
    )
    expect(assets.map(a => a.id)).toEqual(['btc', ...knownIds, DEPIX.identifier, 'tkn9'])
  })

  it('dedupes a held token that is also a known one', () => {
    const known = KNOWN_SPARK_TOKENS[0]
    const assets = sparkConvertAssets([
      token({ identifier: known.id, ticker: known.ticker, decimals: known.decimals }),
    ])
    expect(assets.filter(a => a.id === known.id)).toHaveLength(1)
  })
})

describe('tokenIdOf', () => {
  it('is undefined for BTC, which carries no token identifier', () => {
    expect(tokenIdOf(SPARK_BTC)).toBeUndefined()
  })

  it('is the identifier for a token', () => {
    expect(tokenIdOf({ id: 'tkn1', ticker: 'USDs', name: 'Spark USD', decimals: 6 })).toBe('tkn1')
  })
})

describe('fromBaseUnits', () => {
  it('formats token base units with trimmed decimals', () => {
    expect(fromBaseUnits(1_500_000, 6)).toBe('1.5')
  })

  it('formats sats (0 decimals) as an integer', () => {
    expect(fromBaseUnits(4200, 0)).toBe('4200')
  })
})

describe('quotedFigure', () => {
  const exact = 1_000_000_000_000_000_001n

  it('draws the exact amount while it is still the figure', () => {
    expect(quotedFigure(Number(exact), exact, 18)).toBe('1.000000000000000001')
  })

  // A pair puts the second leg's figure over the first leg's, and the first leg's exact amount must
  // never be drawn as the second's.
  it('falls back to the figure when the exact amount is another one', () => {
    expect(quotedFigure(2_500_000, 797n, 6)).toBe('2.5')
  })

  it('draws the figure when there is no exact amount', () => {
    expect(quotedFigure(1_500_000, undefined, 6)).toBe('1.5')
  })
})

describe('estimateSparkConvert', () => {
  const USDB = KNOWN_SPARK_TOKENS[0] // fiatId USD, 6 decimals

  it('BTC -> USDB: sats valued via the USD rate', () => {
    // 100 USD of BTC lands as 100_000_000 base units, since USDB carries 6 decimals.
    expect(estimateSparkConvert(SPARK_BTC, USDB, 100_000, { USD: 100_000 })).toBe(100_000_000)
  })

  it('USDB -> BTC: the inverse (100 USDB back to 100_000 sats)', () => {
    expect(estimateSparkConvert(USDB, SPARK_BTC, 100_000_000, { USD: 100_000 })).toBe(100_000)
  })

  it('is null without a rate (BTC leg cannot be priced)', () => {
    expect(estimateSparkConvert(SPARK_BTC, USDB, 100_000, { USD: 0 })).toBeNull()
  })

  // At 400_000 BRL per bitcoin, 100_000 sats is 400 reais, which is 400 DePix at 8 decimals.
  it('BTC -> DePix: through the real, not the dollar', () => {
  const DEPIX_ASSET: SparkConvertAsset = { id: DEPIX.identifier, ticker: 'DePix', name: 'Decentralized PIX', decimals: 8, fiatId: 'BRL' }
    expect(estimateSparkConvert(SPARK_BTC, DEPIX_ASSET, 100_000, { USD: 100_000, BRL: 400_000 })).toBe(40_000_000_000)
    expect(estimateSparkConvert(DEPIX_ASSET, SPARK_BTC, 40_000_000_000, { USD: 100_000, BRL: 400_000 })).toBe(100_000)
  })

  // Priced at the dollar, DePix would read five times its value; a missing real rate prices nothing.
  it('is null for DePix with no real rate, even with the dollar rate known', () => {
  const DEPIX_ASSET: SparkConvertAsset = { id: DEPIX.identifier, ticker: 'DePix', name: 'Decentralized PIX', decimals: 8, fiatId: 'BRL' }
    expect(estimateSparkConvert(SPARK_BTC, DEPIX_ASSET, 100_000, { USD: 100_000 })).toBeNull()
  })

  it('is null for a non-USD token (a memecoin has no peg)', () => {
    const meme = { id: 'tkn', ticker: 'MEME', name: 'Meme', decimals: 8 }
    expect(estimateSparkConvert(SPARK_BTC, meme, 100_000, { USD: 100_000 })).toBeNull()
  })
})

describe('toBaseUnits', () => {
  it('scales a token display amount by its decimals', () => {
    expect(toBaseUnits('1.5', 6)).toBe(1_500_000)
  })

  it('treats a 0-decimals asset (BTC/sats) as already base units', () => {
    expect(toBaseUnits('4200', 0)).toBe(4200)
  })

  it('is 0 for empty, zero, negative or malformed input', () => {
    expect(toBaseUnits('', 6)).toBe(0)
    expect(toBaseUnits('0', 6)).toBe(0)
    expect(toBaseUnits('-5', 6)).toBe(0)
    expect(toBaseUnits('abc', 6)).toBe(0)
  })
})

describe('effectiveConvertCostPct', () => {
  const USDB: SparkConvertAsset = { id: 'usdb', ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, fiatId: 'USD' }
  const UNPEGGED: SparkConvertAsset = { id: 'x', ticker: 'X', name: 'X', decimals: 6 }
  // BTC at 100_000 USD, so 100_000 sats is worth 100 USD.

  it('computes the spread baked into the AMM price (fee is 0)', () => {
    expect(effectiveConvertCostPct(SPARK_BTC, USDB, 100_000, 99_000_000, { USD: 100_000 })).toBeCloseTo(1, 6)
  })

  it('works the other direction (token -> BTC)', () => {
    expect(effectiveConvertCostPct(USDB, SPARK_BTC, 100_000_000, 99_000, { USD: 100_000 })).toBeCloseTo(1, 6)
  })

  it('is 0 at parity (a priceable pair always yields a number, not null)', () => {
    expect(effectiveConvertCostPct(SPARK_BTC, USDB, 100_000, 100_000_000, { USD: 100_000 })).toBe(0)
  })

  it('clamps to 0 when the output is worth more than the input (never a negative cost)', () => {
    expect(effectiveConvertCostPct(SPARK_BTC, USDB, 100_000, 101_000_000, { USD: 100_000 })).toBe(0)
  })

  it('reads the cost of a DePix convert against the real', () => {
    const DEPIX_ASSET: SparkConvertAsset = { id: 'depix', ticker: 'DePix', name: 'Decentralized PIX', decimals: 8, fiatId: 'BRL' }
    // 100_000 sats is 400 reais at 400_000 BRL; 396 DePix back is a 1% cost.
    expect(effectiveConvertCostPct(SPARK_BTC, DEPIX_ASSET, 100_000, 39_600_000_000, { BRL: 400_000 })).toBeCloseTo(1, 6)
  })

  it('is null only when a side cannot be priced (unpegged token, or no rate)', () => {
    expect(effectiveConvertCostPct(SPARK_BTC, UNPEGGED, 100_000, 50_000_000, { USD: 100_000 })).toBeNull()
    expect(effectiveConvertCostPct(SPARK_BTC, USDB, 100_000, 99_000_000, { USD: 0 })).toBeNull()
  })
})

// The range line reads a token at two places, the minimum up and the maximum down, so the minimum shown
// always passes and the maximum never promises more than the balance.
describe('rangeBounds', () => {
  test('a DePix range reads at two places, the minimum up and the maximum down', () => {
    expect(rangeBounds(349_911_263, 791_144_120, 8)).toEqual({
      minBase: 350_000_000,
      maxBase: 791_000_000,
      min: '3.50',
      max: '7.91',
    })
  })

  test('a minimum a hair over a cent goes up to the next cent, and one on a cent stays', () => {
    expect(rangeBounds(349_000_001, 700_000_000, 8).min).toBe('3.50')
    expect(rangeBounds(350_000_000, 700_000_000, 8).min).toBe('3.50')
  })

  test('a maximum a hair under the next cent stays on the cent below', () => {
    expect(rangeBounds(100_000_000, 391_999_999, 8).max).toBe('3.91')
  })

  test('USDB reads at two places too', () => {
    expect(rangeBounds(640_001, 10_420_000, 6)).toMatchObject({ min: '0.65', max: '10.42' })
  })

  test('sats are whole and pass through', () => {
    expect(rangeBounds(800, 47_112, 0)).toEqual({ minBase: 800, maxBase: 47_112, min: '800', max: '47112' })
  })

  // At two places these would read 3.50 to 3.49, so a place is added until the range reads in order.
  test('bounds that would cross at two places get the places that keep them apart', () => {
    expect(rangeBounds(349_100_000, 349_900_000, 8)).toMatchObject({ min: '3.491', max: '3.499' })
  })

  test('a balance under a cent is not drawn as zero', () => {
    expect(rangeBounds(1_234, 4_000, 6)).toMatchObject({ min: '0.002', max: '0.004' })
  })

  test('a balance below the minimum is left exact, for the caller to say so', () => {
    expect(rangeBounds(500_000_001, 100_000_001, 8)).toEqual({
      minBase: 500_000_001,
      maxBase: 100_000_001,
      min: '5.00000001',
      max: '1.00000001',
    })
  })

  // A balance a hair over the minimum leaves one figure at two places, and that figure is the one to spend.
  test('bounds that meet at two places read as the same figure', () => {
    expect(rangeBounds(349_911_263, 350_000_000, 8)).toMatchObject({ min: '3.50', max: '3.50' })
  })

  test('the minimum shown is never below the real one, and the maximum never above the balance', () => {
    const cases: Array<[number, number, number]> = [
      [349_911_263, 791_144_120, 8],
      [1, 99, 8],
      [123_456, 123_457, 6],
      [999_999, 1_000_001, 6],
      [3, 7, 2],
      [10_000_001, 19_999_999, 8],
    ]
    for (const [min, max, decimals] of cases) {
      const b = rangeBounds(min, max, decimals)
      expect(b.minBase).toBeGreaterThanOrEqual(min)
      expect(b.maxBase).toBeLessThanOrEqual(max)
      expect(b.minBase).toBeLessThanOrEqual(b.maxBase)
    }
  })
})
