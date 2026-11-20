import { estimateSwitchCost, SWITCH_COST_WAIT_MS } from '../src/wallet/stableCost'
import {
  sparkConversionLimits,
  sparkDiscardConvertQuote,
  sparkGetFiatRates,
  sparkGetWalletInfo,
  sparkPrepareConvertBySpend,
  type SparkToken,
} from '../src/wallet/spark'
import { USDB } from '../src/wallet/tokens'

// No confirm in the double: a call to it would throw, which is the point of a sheet that only looks.
jest.mock('../src/wallet/spark', () => ({
  sparkConversionLimits: jest.fn(),
  sparkDiscardConvertQuote: jest.fn(),
  sparkGetFiatRates: jest.fn(),
  sparkGetWalletInfo: jest.fn(),
  sparkPrepareConvertBySpend: jest.fn(),
}))

const usdbToken = (balanceBaseUnits: number): SparkToken =>
  ({ identifier: USDB.identifier, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits } as SparkToken)

// 1% under spot at 100 000 USD a bitcoin, with the field that reads a hundred times too high.
const QUOTE = { handle: 'q1', spentBaseUnits: 100_000, receivedBaseUnits: 99_000_000, feeBaseUnits: 90_000_000 }

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 100_000, tokens: [] })
  jest.mocked(sparkConversionLimits).mockResolvedValue({ minFromBaseUnits: 1000 })
  jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 100_000 })
  jest.mocked(sparkPrepareConvertBySpend).mockResolvedValue(QUOTE)
})

afterEach(() => {
  jest.useRealTimers()
})

test('the cost comes from the two amounts at spot, never from the fee the quote reports', async () => {
  const cost = await estimateSwitchCost(true)

  expect(cost.kind).toBe('cost')
  expect((cost as { pct: number }).pct).toBeCloseTo(1, 6)
})

// 0.4% under spot both ways. Selling USDB takes an exact input, whose received figure is the floor the
// SDK signs, 1% under what the pool gives.
describe('both directions of one sheet read the same cost', () => {
  const ON = { handle: 'on', spentBaseUnits: 100_000, receivedBaseUnits: 99_600_000, feeBaseUnits: 0 }
  const OFF = {
    handle: 'off',
    spentBaseUnits: 100_000_000,
    receivedBaseUnits: 98_604,
    expectedBaseUnits: 99_600,
    feeBaseUnits: 0,
  }

  test('turning on', async () => {
    jest.mocked(sparkPrepareConvertBySpend).mockResolvedValue(ON)

    expect((await estimateSwitchCost(true)) as { pct: number }).toMatchObject({ pct: expect.closeTo(0.4, 6) })
  })

  test('turning off reads what the pool gives, never the floor', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 5, tokens: [usdbToken(100_000_000)] })
    jest.mocked(sparkPrepareConvertBySpend).mockResolvedValue(OFF)

    expect((await estimateSwitchCost(false)) as { pct: number }).toMatchObject({ pct: expect.closeTo(0.4, 6) })
  })
})

test('turning on quotes the whole bitcoin balance into USDB', async () => {
  await estimateSwitchCost(true)

  expect(sparkConversionLimits).toHaveBeenCalledWith(undefined, USDB.identifier)
  expect(sparkPrepareConvertBySpend).toHaveBeenCalledWith(undefined, USDB.identifier, 100_000, 100_000_000)
})

test('turning off quotes the whole USDB balance into bitcoin, found by identifier', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat: 5,
    tokens: [{ ...usdbToken(7_000_000), identifier: 'btkn1other' }, usdbToken(50_000_000)],
  })

  await estimateSwitchCost(false)

  expect(sparkConversionLimits).toHaveBeenCalledWith(USDB.identifier, undefined)
  expect(sparkPrepareConvertBySpend).toHaveBeenCalledWith(USDB.identifier, undefined, 50_000_000, 0)
})

test('the quote is dropped once, whatever the answer', async () => {
  await estimateSwitchCost(true)

  expect(sparkDiscardConvertQuote).toHaveBeenCalledTimes(1)
  expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('q1')
})

test('a quote that lands after the wait is still dropped', async () => {
  jest.useFakeTimers()
  let land: (quote: typeof QUOTE) => void = () => undefined
  jest.mocked(sparkPrepareConvertBySpend).mockReturnValue(new Promise(resolve => (land = resolve)))

  const cost = estimateSwitchCost(true)
  await jest.advanceTimersByTimeAsync(SWITCH_COST_WAIT_MS)
  expect(await cost).toEqual({ kind: 'unknown' })
  expect(sparkDiscardConvertQuote).not.toHaveBeenCalled()

  land(QUOTE)
  await jest.advanceTimersByTimeAsync(0)

  expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('q1')
})

test('below the minimum it names the minimum and quotes nothing', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 999, tokens: [] })

  expect(await estimateSwitchCost(true)).toEqual({ kind: 'below', minBase: 1000 })
  expect(sparkPrepareConvertBySpend).not.toHaveBeenCalled()
})

test('at the minimum exactly it quotes', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 1000, tokens: [] })

  await estimateSwitchCost(true)

  expect(sparkPrepareConvertBySpend).toHaveBeenCalledTimes(1)
})

test('nothing to convert and no answer on the minimum: no figure', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 0, tokens: [] })
  jest.mocked(sparkConversionLimits).mockRejectedValue(new Error('offline'))

  expect(await estimateSwitchCost(true)).toEqual({ kind: 'below', minBase: undefined })
})

test.each(['waiting', 'stale'] as const)('a %s balance is not quoted', async sync => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync, recoverableSat: 0, balanceSat: 100_000, tokens: [] })

  expect(await estimateSwitchCost(true)).toEqual({ kind: 'unknown' })
  expect(sparkPrepareConvertBySpend).not.toHaveBeenCalled()
})

test('a quote that fails gives no figure', async () => {
  jest.mocked(sparkPrepareConvertBySpend).mockRejectedValue(new Error('pool down'))

  expect(await estimateSwitchCost(true)).toEqual({ kind: 'unknown' })
})

test('a wallet read that fails gives no figure', async () => {
  jest.mocked(sparkGetWalletInfo).mockRejectedValue(new Error('not connected'))

  expect(await estimateSwitchCost(true)).toEqual({ kind: 'unknown' })
})

test('with no dollar rate there is nothing to measure against, and nothing is quoted', async () => {
  jest.mocked(sparkGetFiatRates).mockResolvedValue({})

  expect(await estimateSwitchCost(true)).toEqual({ kind: 'unknown' })
  expect(sparkPrepareConvertBySpend).not.toHaveBeenCalled()
})
