import {
  answersWithin,
  bestOffer,
  chainDisplayName,
  crossChainSource,
  contractNote,
  groupRoutes,
  pickReceiveLanding,
  quoteExpiryMs,
  quoteLapsed,
  quoteLapsesInMs,
  receiveBounds,
  providerDisplayName,
  routeContenders,
  sortRoutes,
} from '../src/wallet/crossChain'
import { formatBaseUnitsExact, roundBaseUnits, toBaseUnitsExact } from '../src/wallet/sparkConvert'

// The SDK reads `amount` in the source's unit, so this choice is what makes the digits mean dollars.
describe('crossChainSource', () => {
  test.each([
    [true, { btc: true, usdb: true }, 'usdb'],
    [true, { btc: false, usdb: true }, 'usdb'],
    [true, { btc: true, usdb: false }, 'sats'],
    [false, { btc: true, usdb: true }, 'sats'],
    [false, { btc: true, usdb: false }, 'sats'],
  ])('dollar mode %s on a route that takes %j pays from %s', (dollarMode, accepts, source) => {
    expect(crossChainSource({ accepts }, dollarMode)).toBe(source)
  })
})

// What lands on Spark follows the dollar wallet, so receiving USDT never asks a second question.
describe('pickReceiveLanding', () => {
  const both = { btc: true, usdb: true }

  it('lands dollars in the dollar wallet', () => {
    expect(pickReceiveLanding(both, true)).toBe('usdb')
  })

  it('lands bitcoin otherwise', () => {
    expect(pickReceiveLanding(both, false)).toBe('btc')
  })

  it('falls back to what the route can deliver', () => {
    expect(pickReceiveLanding({ btc: true, usdb: false }, true)).toBe('btc')
    // Some routes deliver only USDB, whatever the wallet prefers.
    expect(pickReceiveLanding({ btc: false, usdb: true }, false)).toBe('usdb')
  })

  it('leaves out a route that delivers neither', () => {
    expect(pickReceiveLanding({ btc: false, usdb: false }, true)).toBeNull()
  })
})

describe('chainDisplayName', () => {
  it('names the chains the SDK gives as slugs', () => {
    expect(chainDisplayName('tron')).toBe('Tron')
    expect(chainDisplayName('bsc')).toBe('BNB Chain')
    expect(chainDisplayName('hyperevm')).toBe('HyperEVM')
  })

  // The provider adds networks without notice, and a raw slug still reads.
  it('capitalises a slug it does not know', () => {
    expect(chainDisplayName('monad')).toBe('Monad')
  })
})

describe('sortRoutes', () => {
  it('puts the common networks first, USDT before USDC, and the rest by name', () => {
    const routes = [
      { chain: 'zora', asset: 'USDC' },
      { chain: 'base', asset: 'USDC' },
      { chain: 'tron', asset: 'USDT' },
      { chain: 'ethereum', asset: 'USDC' },
      { chain: 'ethereum', asset: 'USDT' },
      { chain: 'avalanche', asset: 'USDC' },
    ]
    expect(sortRoutes(routes).map(r => `${r.asset}/${r.chain}`)).toEqual([
      'USDT/tron',
      'USDT/ethereum',
      'USDC/ethereum',
      'USDC/base',
      'USDC/avalanche',
      'USDC/zora',
    ])
  })
})

// Bounds for a receive are in the asset paid in (base units) and in dollars; the tighter binds.
describe('receiveBounds', () => {
  const none = {
    minAmount: undefined,
    maxAmount: undefined,
    minUsdCents: undefined,
    maxUsdCents: undefined,
  }

  it('takes the tighter of the unit and dollar bounds, in the asset base units', () => {
    const limits = { minAmount: 500_000n, maxAmount: undefined, minUsdCents: 100n, maxUsdCents: 1_000_000n }
    expect(receiveBounds(limits, 6)).toEqual({ min: 1_000_000n, max: 10_000_000_000n })
  })

  it('takes the tighter ceiling too', () => {
    const limits = { minAmount: undefined, maxAmount: 5_000_000_000n, minUsdCents: undefined, maxUsdCents: 1_000_000n }
    expect(receiveBounds(limits, 6).max).toBe(5_000_000_000n)
  })

  it('keeps each side of a pair it does not take from overriding the other', () => {
    const limits = {
      minAmount: 2_000_000n,
      maxAmount: 9_000_000_000n,
      minUsdCents: 100n,
      maxUsdCents: 1_000_000n,
    }
    expect(receiveBounds(limits, 6)).toEqual({ min: 2_000_000n, max: 9_000_000_000n })
  })

  // Past about 15 digits a double drops the last base units, so a floor one unit past five dollars
  // came back as five dollars, a figure the provider refuses.
  it('keeps 18-decimal base units to the last one', () => {
    const min = 5_000_000_000_000_000_001n
    const max = 9_999_999_999_999_999_999n
    const limits = { ...none, minAmount: min, minUsdCents: 500n, maxAmount: max }
    expect(receiveBounds(limits, 18)).toEqual({ min, max })
  })

  it('reads cents as base units at any places', () => {
    const limits = { ...none, minUsdCents: 123n, maxUsdCents: 456n }
    expect(receiveBounds(limits, 18)).toEqual({
      min: 1_230_000_000_000_000_000n,
      max: 4_560_000_000_000_000_000n,
    })
    expect(receiveBounds(limits, 8)).toEqual({ min: 123_000_000n, max: 456_000_000n })
  })

  // An asset with fewer places than a cent cannot hold the dollar bound, so it moves inward.
  it('moves a dollar bound inward where the asset cannot hold a cent', () => {
    const limits = { ...none, minUsdCents: 123n, maxUsdCents: 456n }
    expect(receiveBounds(limits, 1)).toEqual({ min: 13n, max: 45n })
    expect(receiveBounds(limits, 0)).toEqual({ min: 2n, max: 4n })
  })

  it('is unbounded without limits', () => {
    expect(receiveBounds(undefined, 6)).toEqual({ min: undefined, max: undefined })
  })
})

// A double holds about 15 significant digits and USDC on BSC has 18 decimals, so amounts the sender
// must match exactly are carried as bigint, never through a Number.
describe('exact base units', () => {
  it('formats without float noise', () => {
    expect(formatBaseUnitsExact(49_850_000_000_000_000_000n, 18)).toBe('49.85')
    expect(formatBaseUnitsExact(1n, 18)).toBe('0.000000000000000001')
    expect(formatBaseUnitsExact(0n, 6)).toBe('0')
    expect(formatBaseUnitsExact(50_000_000n, 6)).toBe('50')
  })

  it('parses a display amount into exact base units', () => {
    expect(toBaseUnitsExact('50.12', 18)).toBe(50_120_000_000_000_000_000n)
    // A double gets 1.1 wrong at 18 places, by 128 base units.
    expect(toBaseUnitsExact('1.1', 18)).toBe(1_100_000_000_000_000_000n)
    expect(toBaseUnitsExact('50.12', 6)).toBe(50_120_000n)
    expect(toBaseUnitsExact('7', 6)).toBe(7_000_000n)
  })

  it('refuses what is not a positive amount the asset can represent', () => {
    for (const bad of ['', '0', '-1', 'abc', '1.2.3', '0.0000001']) {
      expect(toBaseUnitsExact(bad, 6)).toBeNull()
    }
  })
})

// A bound is drawn at fewer places than the asset holds, and rounding must never cross the bound.
describe('roundBaseUnits', () => {
  it('rounds a floor up and a ceiling down to the places drawn', () => {
    expect(roundBaseUnits(1_230_001n, 6, 2, 'up')).toBe(1_240_000n)
    expect(roundBaseUnits(1_229_999n, 6, 2, 'down')).toBe(1_220_000n)
  })

  it('leaves a figure already on a step where it is', () => {
    expect(roundBaseUnits(1_230_000n, 6, 2, 'up')).toBe(1_230_000n)
    expect(roundBaseUnits(1_230_000n, 6, 2, 'down')).toBe(1_230_000n)
    expect(roundBaseUnits(0n, 18, 2, 'up')).toBe(0n)
  })

  // A double carrying these lands on 5.00 both ways, the floor below itself.
  it('steps on the last of 18 places', () => {
    expect(roundBaseUnits(5_000_000_000_000_000_001n, 18, 2, 'up')).toBe(5_010_000_000_000_000_000n)
    const under = 4_999_999_999_999_999_999n
    expect(roundBaseUnits(under, 18, 2, 'down')).toBe(4_990_000_000_000_000_000n)
  })

  it('keeps an asset with no more places than drawn exact', () => {
    expect(roundBaseUnits(13n, 1, 2, 'up')).toBe(13n)
    expect(roundBaseUnits(7n, 0, 2, 'down')).toBe(7n)
  })
})

describe('when a quote lapses', () => {
  const NOON = Date.UTC(2026, 10, 4, 12, 0, 0)

  it('reads what Orchestra sends, RFC3339 in any of its spellings', () => {
    expect(quoteExpiryMs('2026-11-04T12:00:00Z')).toBe(NOON)
    expect(quoteExpiryMs('2026-11-04T09:00:00-03:00')).toBe(NOON)
    expect(quoteExpiryMs('2026-11-04t12:00:00z')).toBe(NOON)
    expect(quoteExpiryMs('2026-11-04T12:00:00.123456789Z')).toBe(NOON + 123)
  })

  // Node takes any number of digits, and a spec-minded engine owes only the three of a Date.
  it('hands the engine no more fractional digits than a Date holds', () => {
    const parse = jest.spyOn(Date, 'parse')
    quoteExpiryMs('2026-11-04T12:00:00.123456789Z')
    expect(parse).toHaveBeenCalledWith('2026-11-04T12:00:00.123Z')
    parse.mockRestore()
  })

  it('reads what Boltz sends, unix seconds as text', () => {
    expect(quoteExpiryMs(String(NOON / 1000))).toBe(NOON)
    expect(quoteExpiryMs(` ${NOON / 1000} `)).toBe(NOON)
  })

  it('has no moment for anything else', () => {
    expect(quoteExpiryMs('')).toBeNull()
    expect(quoteExpiryMs('soon')).toBeNull()
    expect(quoteExpiryMs('2026-13-45T12:00:00Z')).toBeNull()
    expect(quoteExpiryMs('Nov 4 2026')).toBeNull()
    expect(quoteExpiryMs('9'.repeat(30))).toBeNull()
  })

  it('counts as lapsed ten seconds early', () => {
    const at = '2026-11-04T12:00:00Z'
    expect(quoteLapsed(at, NOON - 10_001)).toBe(false)
    expect(quoteLapsed(at, NOON - 10_000)).toBe(true)
    expect(quoteLapsed(at, NOON + 1)).toBe(true)
    expect(quoteLapsesInMs(at, NOON - 60_000)).toBe(50_000)
    expect(quoteLapsesInMs(at, NOON)).toBe(0)
  })

  it('never lapses without a moment, so the send goes on to the SDK', () => {
    expect(quoteLapsed('soon', NOON)).toBe(false)
    expect(quoteLapsesInMs('soon', NOON)).toBeNull()
  })
})

describe('groupRoutes', () => {
  const route = (chain: string, asset: string, provider = 'orchestra') => ({ chain, asset, provider })

  test('joins the providers of one chain and asset, in the order of the routes', () => {
    const groups = groupRoutes([
      route('base', 'USDC'),
      route('base', 'USDT'),
      route('base', 'USDT', 'boltz'),
      route('tron', 'USDT'),
    ])

    expect(groups.map(g => `${g.asset}/${g.chain}:${g.routes.length}`)).toEqual([
      'USDT/tron:1',
      'USDT/base:2',
      'USDC/base:1',
    ])
  })

  test('nothing in, nothing out', () => {
    expect(groupRoutes([])).toEqual([])
  })

  test('two contracts of one asset on one chain are two tokens, as the SDK keys them', () => {
    const groups = groupRoutes([
      { ...route('base', 'USDC'), contractAddress: '0xAAA' },
      { ...route('base', 'USDC'), contractAddress: '0xBBB' },
      { ...route('base', 'USDC', 'boltz'), contractAddress: '0xBBB' },
    ])

    expect(groups.map(g => `${g.contractAddress}:${g.routes.length}`)).toEqual(['0xAAA:1', '0xBBB:2'])
  })

  test('one EVM token two providers spell in different case is one line', () => {
    const groups = groupRoutes([
      { ...route('base', 'USDC'), contractAddress: '0xA0b8' },
      { ...route('Base', 'USDC', 'boltz'), contractAddress: '0xa0B8' },
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].routes).toHaveLength(2)
  })

  test('a base58 contract keeps its case, which is part of the address', () => {
    const groups = groupRoutes([
      { ...route('solana', 'USDC'), contractAddress: 'EPjFWdd5' },
      { ...route('solana', 'USDC'), contractAddress: 'epjfwdd5' },
    ])

    expect(groups).toHaveLength(2)
  })

  test('a coin with no contract keeps a line of its own', () => {
    const groups = groupRoutes([route('base', 'USDC'), { ...route('base', 'USDC'), contractAddress: '0xAAA' }])

    expect(groups).toHaveLength(2)
  })
})

describe('contractNote', () => {
  const group = (chain: string, asset: string, contractAddress?: string) => ({
    chain,
    asset,
    contractAddress,
    routes: [],
  })
  const LONG = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

  test('names the contract of lines that would read alike, short', () => {
    const a = group('base', 'USDC', LONG)
    const b = group('base', 'USDC', '0xBBB')

    expect(contractNote(a, [a, b])).toBe('0x833589…A02913')
    expect(contractNote(b, [a, b])).toBe('0xBBB')
  })

  test('a line alone on its chain and asset says nothing', () => {
    const a = group('base', 'USDC', LONG)

    expect(contractNote(a, [a, group('tron', 'USDC', '0xT'), group('base', 'USDT', '0xU')])).toBeUndefined()
  })

  test('a coin with no contract has nothing to name', () => {
    const a = group('base', 'USDC')

    expect(contractNote(a, [a, group('base', 'USDC', LONG)])).toBeUndefined()
  })
})

describe('routeContenders', () => {
  const chosen = { id: 'o', chain: 'base', asset: 'USDT', contractAddress: '0xa', accepts: { usdb: true } }
  const boltz = { ...chosen, id: 'b', accepts: { usdb: false } }

  test('the chosen route leads, with what delivers the same behind it', () => {
    expect(routeContenders([boltz, chosen], chosen, 'sats').map(r => r.id)).toEqual(['o', 'b'])
  })

  test('a USDB amount leaves out a route that takes only sats', () => {
    expect(routeContenders([chosen, boltz], chosen, 'usdb').map(r => r.id)).toEqual(['o'])
  })

  test('another chain, asset or contract is not the same thing', () => {
    const others = [
      { ...boltz, id: 'c', chain: 'tron' },
      { ...boltz, id: 'a', asset: 'USDC' },
      { ...boltz, id: 'k', contractAddress: '0xb' },
      { ...boltz, id: 'n', contractAddress: undefined },
    ]

    expect(routeContenders([chosen, ...others], chosen, 'sats')).toEqual([chosen])
  })

  test('two routes under one id are one route', () => {
    expect(routeContenders([chosen, { ...chosen }], chosen, 'sats')).toEqual([chosen])
  })

  // Two providers can spell one EVM token apart, and a list that groups them has to compare them too.
  test('one token spelled apart by two providers still competes', () => {
    const spelled = { ...chosen, id: 's', chain: 'Base', contractAddress: '0xA' }
    expect(routeContenders([chosen, spelled], chosen, 'sats').map(r => r.id)).toEqual(['o', 's'])
  })

  test('a base58 contract keeps its case, since case changes which token it is', () => {
    const tron = { ...chosen, chain: 'tron', contractAddress: 'TAbC' }
    expect(routeContenders([tron, { ...tron, id: 's', contractAddress: 'tabc' }], tron, 'sats')).toEqual([tron])
  })
})

describe('bestOffer', () => {
  const quote = (estimatedOut: number, decimals = 6) => ({ estimatedOut, decimals })

  test('whoever delivers more, wherever it stands', () => {
    expect(bestOffer([quote(10), quote(30), quote(20)]).estimatedOut).toBe(30)
  })

  test('a tie stays with the first', () => {
    const first = quote(10)

    expect(bestOffer([first, quote(10)])).toBe(first)
  })

  test('different decimals do not compare, so the first stands', () => {
    const first = quote(10_000_000)

    expect(bestOffer([first, quote(9_000_000_000_000_000_000, 18)])).toBe(first)
  })
})

describe('answersWithin', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('keeps the order of the calls, whoever lands first', async () => {
    let slow: (value: string) => void = () => undefined
    const running = answersWithin([new Promise<string>(resolve => (slow = resolve)), Promise.resolve('fast')], 1_000, jest.fn())

    await jest.advanceTimersByTimeAsync(10)
    slow('slow')

    await expect(running).resolves.toEqual({ answers: ['slow', 'fast'], failures: [] })
  })

  test('a failure stands apart from the answers', async () => {
    const cause = new Error('no')

    await expect(answersWithin([Promise.reject(cause), Promise.resolve(1)], 1_000, jest.fn())).resolves.toEqual({
      answers: [1],
      failures: [cause],
    })
  })

  test('at the limit it answers with what landed, and later ones go to late', async () => {
    let slow: (value: number) => void = () => undefined
    const late = jest.fn()
    const running = answersWithin([Promise.resolve(1), new Promise<number>(resolve => (slow = resolve))], 1_000, late)

    await jest.advanceTimersByTimeAsync(999)
    expect(late).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await expect(running).resolves.toEqual({ answers: [1], failures: [] })

    slow(2)
    await jest.advanceTimersByTimeAsync(0)
    expect(late).toHaveBeenCalledWith(2)
  })

  test('nothing landing by the limit is no answers and no failures', async () => {
    const running = answersWithin([new Promise(() => undefined)], 1_000, jest.fn())

    await jest.advanceTimersByTimeAsync(1_000)

    await expect(running).resolves.toEqual({ answers: [], failures: [] })
  })
})

test('a provider reads by its name, never its slug', () => {
  expect(providerDisplayName('orchestra')).toBe('Orchestra')
  expect(providerDisplayName('boltz')).toBe('Boltz')
})
