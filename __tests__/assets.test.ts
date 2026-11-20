import { dollarsOfSats, cutToTwoPlaces, formatSmallFiat, formatAssetAmount, formatTokenBalance, buildSparkAssetList, inShownOrder, orderForDollarMode, formatRowAmount, BITCOIN_ASSET_ID, type AssetRow } from '../src/wallet/assets'
import { fiatSymbol, formatFiat, formatFiatGeneric, setNumberLanguage } from '../src/wallet/fiat'

const formatFiatAt = (value: number, places: number, currency: string): string =>
  formatFiatGeneric(value, fiatSymbol(currency), places)

describe('formatAssetAmount', () => {
  it('formats a whole unit', () => {
    expect(formatAssetAmount(100_000_000, 8)).toBe('1')
  })

  it('formats with fraction and trims trailing zeros', () => {
    expect(formatAssetAmount(1_050_000_000, 8)).toBe('10.5')
  })

  it('formats value less than 1 (keeps leading zeros in the fraction)', () => {
    expect(formatAssetAmount(1401, 8)).toBe('0.00001401')
  })

  it('formats zero', () => {
    expect(formatAssetAmount(0, 8)).toBe('0')
  })

  it('precision 0 returns the raw integer', () => {
    expect(formatAssetAmount(1234, 0)).toBe('1234')
  })

  it('respects precision different from 8', () => {
    expect(formatAssetAmount(150, 2)).toBe('1.5')
  })
})

describe('buildSparkAssetList', () => {
  it('leads with non-removable Bitcoin from the sat balance', () => {
    expect(buildSparkAssetList(4200, [])).toEqual([
      // Raw digits, like every amount in the model; the screen groups them in the app language.
      { assetId: BITCOIN_ASSET_ID, name: 'Bitcoin', ticker: 'sats', amount: '4200', removable: false },
    ])
  })

  it('appends held Spark tokens after Bitcoin, formatted by their decimals', () => {
    const rows = buildSparkAssetList(1000, [
      { identifier: 'tkn1', name: 'Spark USD', ticker: 'USDs', decimals: 6, balanceBaseUnits: 1_500_000 },
    ])
    expect(rows.map(r => r.name)).toEqual(['Bitcoin', 'Spark USD'])
    expect(rows[1]).toEqual({ assetId: 'tkn1', name: 'Spark USD', ticker: 'USDs', amount: '1.5', removable: false })
  })

  it('appends a catalog token the wallet does not hold as a removable zero-balance row', () => {
    const rows = buildSparkAssetList(
      1000,
      [],
      [{ identifier: 'usdb1', name: 'Bitcoin USD', ticker: 'USDB', decimals: 6 }],
    )
    expect(rows.map(r => r.name)).toEqual(['Bitcoin', 'Bitcoin USD'])
    expect(rows[1]).toEqual({ assetId: 'usdb1', name: 'Bitcoin USD', ticker: 'USDB', amount: '0', removable: true })
  })

  it('does not duplicate a catalog token the wallet already holds; the held row wins and stays locked', () => {
    const rows = buildSparkAssetList(
      1000,
      [{ identifier: 'usdb1', name: 'Bitcoin USD', ticker: 'USDB', decimals: 6, balanceBaseUnits: 2_000_000 }],
      [{ identifier: 'usdb1', name: 'Bitcoin USD', ticker: 'USDB', decimals: 6 }],
    )
    expect(rows.filter(r => r.assetId === 'usdb1')).toHaveLength(1)
    expect(rows[1]).toEqual({ assetId: 'usdb1', name: 'Bitcoin USD', ticker: 'USDB', amount: '2', removable: false })
  })

  it('suppresses a hidden catalog token', () => {
    const rows = buildSparkAssetList(
      1000,
      [],
      [{ identifier: 'usdb1', name: 'Bitcoin USD', ticker: 'USDB', decimals: 6 }],
      ['usdb1'],
    )
    expect(rows.map(r => r.assetId)).toEqual([BITCOIN_ASSET_ID])
  })

  it('never hides a held token, even when its id is in the hidden set', () => {
    const rows = buildSparkAssetList(
      1000,
      [{ identifier: 'tkn1', name: 'Held', ticker: 'HLD', decimals: 6, balanceBaseUnits: 1_000_000 }],
      [],
      ['tkn1'],
    )
    expect(rows.map(r => r.assetId)).toEqual([BITCOIN_ASSET_ID, 'tkn1'])
  })
})

describe('orderForDollarMode', () => {
  const btc = { assetId: BITCOIN_ASSET_ID, name: 'Bitcoin', ticker: 'sats', amount: '12', removable: false }
  const usdb = { assetId: 'usdb1', name: 'Bitcoin USD', ticker: 'USDB', amount: '47.4', removable: false }

  test('the token leads, since the dollar wallet holds its value there', () => {
    expect(orderForDollarMode([btc, usdb], 12).map(r => r.assetId)).toEqual(['usdb1', BITCOIN_ASSET_ID])
  })

  test('a residual sat balance stays on screen, because held funds are never hidden', () => {
    expect(orderForDollarMode([btc, usdb], 12)).toHaveLength(2)
  })

  test('with no bitcoin left the empty row drops out', () => {
    expect(orderForDollarMode([{ ...btc, amount: '0' }, usdb], 0).map(r => r.assetId)).toEqual(['usdb1'])
  })

  test('the order among the other assets is untouched', () => {
    const other = { ...usdb, assetId: 'tkn2', name: 'Other' }
    expect(orderForDollarMode([btc, usdb, other], 0).map(r => r.assetId)).toEqual(['usdb1', 'tkn2'])
  })
})

describe('cutToTwoPlaces', () => {
  test('cuts, and never rounds up', () => {
    expect(cutToTwoPlaces('25.337999')).toBe('25.33')
    expect(cutToTwoPlaces('25.999999')).toBe('25.99')
    expect(cutToTwoPlaces('0.019999')).toBe('0.01')
  })

  test('fills the places a shorter figure lacks', () => {
    expect(cutToTwoPlaces('25')).toBe('25.00')
    expect(cutToTwoPlaces('25.3')).toBe('25.30')
    expect(cutToTwoPlaces('0')).toBe('0.00')
  })

  test('keeps a figure the cut would turn into zero', () => {
    expect(cutToTwoPlaces('0.004321')).toBe('0.004321')
    expect(cutToTwoPlaces('0.000001')).toBe('0.000001')
  })

  test('does not touch digits past a float', () => {
    expect(cutToTwoPlaces('12345678901234567890.129')).toBe('12345678901234567890.12')
  })
})

describe('formatSmallFiat', () => {
  it('keeps the first two significant digits under the smallest step, cut and never rounded up', () => {
    expect(formatSmallFiat(0.0042169, 'BRL')).toBe(formatFiatAt(0.0042, 4, 'BRL'))
    expect(formatSmallFiat(0.00429, 'USD')).toBe(formatFiatAt(0.0042, 4, 'USD'))
    expect(formatSmallFiat(0.005, 'BRL')).toBe(formatFiatAt(0.005, 3, 'BRL'))
  })

  it('leaves a figure the currency can write, and a zero, as the currency writes them', () => {
    expect(formatSmallFiat(0.01, 'BRL')).toBe(formatFiat(0.01, 'BRL'))
    expect(formatSmallFiat(16_902.54, 'BRL')).toBe(formatFiat(16_902.54, 'BRL'))
    expect(formatSmallFiat(0, 'BRL')).toBe(formatFiat(0, 'BRL'))
  })

  it('goes by the places of the currency, so a yen under one is the small figure', () => {
    expect(formatSmallFiat(0.15, 'JPY')).toBe(formatFiatAt(0.15, 2, 'JPY'))
    expect(formatSmallFiat(0.15, 'BRL')).toBe(formatFiat(0.15, 'BRL'))
  })

  // A balance or a maximum typed back as drawn has to pass, so it never reads above the real one.
  describe('as a balance or a maximum', () => {
    it('cuts at the currency places at or above the step, where rounding would go up', () => {
      expect(formatSmallFiat(1.236, 'BRL')).toBe(formatFiat(1.23, 'BRL'))
      expect(formatSmallFiat(16_902.549, 'USD')).toBe(formatFiat(16_902.54, 'USD'))
      expect(formatSmallFiat(1.9, 'JPY')).toBe(formatFiatAt(1, 0, 'JPY'))
      expect(formatSmallFiat(0.0199, 'BRL')).toBe(formatFiat(0.01, 'BRL'))
    })

    it('keeps a figure that is already exact at its places', () => {
      expect(formatSmallFiat(1.23, 'BRL')).toBe(formatFiat(1.23, 'BRL'))
      expect(formatSmallFiat(16_902.54, 'USD')).toBe(formatFiat(16_902.54, 'USD'))
    })

    it('never reads above the value, over a sweep of balances on both sides of the step', () => {
      for (let sats = 1; sats <= 50_000; sats += 7) {
        const value = (sats / 1e8) * 612_345.67
        const shown = formatSmallFiat(value, 'USD')
        const digits = Number(shown.replace(/[^0-9.]/g, ''))
        expect(digits).toBeLessThanOrEqual(value)
      }
    })
  })

  // A minimum typed back as drawn has to pass, so it never reads below the real one.
  describe('as a minimum', () => {
    const atLeast = { atLeast: true }

    it('raises the second significant digit under the smallest step', () => {
      expect(formatSmallFiat(0.0042169, 'BRL', atLeast)).toBe(formatFiatAt(0.0043, 4, 'BRL'))
      expect(formatSmallFiat(0.00421, 'USD', atLeast)).toBe(formatFiatAt(0.0043, 4, 'USD'))
      expect(formatSmallFiat(0.0049001, 'BRL', atLeast)).toBe(formatFiatAt(0.005, 3, 'BRL'))
    })

    it('leaves a figure that is already exact at its places', () => {
      expect(formatSmallFiat(0.0042, 'BRL', atLeast)).toBe(formatFiatAt(0.0042, 4, 'BRL'))
      expect(formatSmallFiat(0.005, 'BRL', atLeast)).toBe(formatFiatAt(0.005, 3, 'BRL'))
      expect(formatSmallFiat(1.23, 'BRL', atLeast)).toBe(formatFiat(1.23, 'BRL'))
    })

    it('raises at the currency places at or above the step, where rounding would go down', () => {
      expect(formatSmallFiat(1.231, 'BRL', atLeast)).toBe(formatFiat(1.24, 'BRL'))
      expect(formatSmallFiat(16_902.541, 'USD', atLeast)).toBe(formatFiat(16_902.55, 'USD'))
      expect(formatSmallFiat(1.2, 'JPY', atLeast)).toBe(formatFiatAt(2, 0, 'JPY'))
    })

    it('a raise that reaches the step is written as the currency writes it', () => {
      expect(formatSmallFiat(0.00991, 'BRL', atLeast)).toBe(formatFiat(0.01, 'BRL'))
    })

    it('never reads below the value, over a sweep of minimums', () => {
      for (let sats = 1; sats <= 5000; sats += 7) {
        const value = (sats / 1e8) * 612_345.67
        const shown = formatSmallFiat(value, 'USD', atLeast)
        const digits = Number(shown.replace(/[^0-9.]/g, ''))
        expect(digits).toBeGreaterThanOrEqual(value)
      }
    })

    it('leaves zero and the default reading as they were', () => {
      expect(formatSmallFiat(0, 'BRL', atLeast)).toBe(formatFiat(0, 'BRL'))
      expect(formatSmallFiat(0.0042169, 'BRL')).toBe(formatFiatAt(0.0042, 4, 'BRL'))
    })
  })
})

describe('formatTokenBalance', () => {
  test('a dollar token reads in dollars, not in protocol precision', () => {
    expect(formatTokenBalance(47_490_984, 6, 'USD')).toBe('47.49')
  })

  test('a whole amount still shows its cents, the way money is read', () => {
    expect(formatTokenBalance(10_000_000, 6, 'USD')).toBe('10.00')
  })

  // "0.00" would say the money is gone, and eight places of DePix crowd a Home row, so under a cent
  // the balance keeps its first two significant digits.
  test('dust never reads as zero, and keeps two significant digits', () => {
    expect(formatTokenBalance(1, 6, 'USD')).toBe('0.000001')
    expect(formatTokenBalance(4_000, 6, 'USD')).toBe('0.004')
    expect(formatTokenBalance(52_321, 8, 'BRL')).toBe('0.00052')
  })

  test('dust is cut, never rounded up past what is held', () => {
    expect(formatTokenBalance(52_991, 8, 'BRL')).toBe('0.00052')
  })

  test('just under a cent is still dust, never rounded up to 0.01', () => {
    expect(formatTokenBalance(9_999, 6, 'USD')).toBe('0.0099')
    expect(formatTokenBalance(5_000, 6, 'USD')).toBe('0.005')
  })

  test('a zero among the kept digits is not printed at the end', () => {
    expect(formatTokenBalance(100_200, 8, 'BRL')).toBe('0.001')
  })

  test('a cent is a cent, not dust', () => {
    expect(formatTokenBalance(10_000, 6, 'USD')).toBe('0.01')
  })

  test('zero stays zero rather than 0.00 padding', () => {
    expect(formatTokenBalance(0, 6, 'USD')).toBe('0')
  })

  test('a token with no peg keeps full precision, as nothing says how to read it', () => {
    expect(formatTokenBalance(47_490_984, 6)).toBe('47.490984')
  })
})

describe('formatRowAmount', () => {
  afterEach(() => setNumberLanguage('en-US'))

  test('sats keep the no-break space while a token takes the language', () => {
    setNumberLanguage('pt-BR')
    expect(formatRowAmount({ ticker: 'sats', amount: '47112' })).toBe('47\u00a0112')
    expect(formatRowAmount({ ticker: 'USDB', amount: '1234.5' })).toBe('1.234,5')
  })
})

describe('dollarsOfSats', () => {
  test('reads sats at the rate', () => {
    expect(dollarsOfSats(12_300, 100_000)).toBeCloseTo(12.3, 8)
  })

  test('a cent is a figure, and under it there is none', () => {
    expect(dollarsOfSats(10, 100_000)).toBeCloseTo(0.01, 8)
    expect(dollarsOfSats(9, 100_000)).toBeNull()
  })

  test('no rate and no sats give no figure', () => {
    expect(dollarsOfSats(12_300, undefined)).toBeNull()
    expect(dollarsOfSats(12_300, null)).toBeNull()
    expect(dollarsOfSats(12_300, 0)).toBeNull()
    expect(dollarsOfSats(0, 100_000)).toBeNull()
  })
})

describe('inShownOrder', () => {
  const row = (assetId: string) => ({ assetId }) as AssetRow

  it('keeps the rows where they are on screen', () => {
    const shown = [row('b'), row('a')]
    expect(inShownOrder(shown, [row('a'), row('b')]).map(r => r.assetId)).toEqual(['b', 'a'])
  })

  it('puts a row that is new last, and drops one that left', () => {
    const shown = [row('b'), row('gone'), row('a')]
    expect(inShownOrder(shown, [row('new'), row('a'), row('b')]).map(r => r.assetId)).toEqual(['b', 'a', 'new'])
  })

  it('takes the figures of the read, not of the screen', () => {
    const fresh = { ...row('a'), amount: '2' }
    expect(inShownOrder([{ ...row('a'), amount: '1' }], [fresh])).toEqual([fresh])
  })
})
