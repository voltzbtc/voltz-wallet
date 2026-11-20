import type * as StoreModule from '../src/wallet/store'
import type { NativeBuyResult } from '../specs/NativeVoltzStore'

type Double = typeof import('../specs/__mocks__/NativeVoltzStore')

// Google answers a purchase flow through the same listener that reports every other purchase of the
// app. An OK call answers the tap when it is this flow's answer: the tap's purchase, the tap's
// product with no reference to read, or no purchase at all, since an OK ends the flow. A call with
// only other purchases is not, whether of other products or of this product for another order, and
// the tap waits for the next call, so an error after it still answers the tap. No timer decides any
// of this.

const REF = 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f'
const OTHER = '7d444840-9dc0-11d1-b245-5ffdce74fad2'
const ACCOUNT = 'a'.repeat(64)

let store: typeof StoreModule
let double: Double
let warn: jest.SpyInstance
const originalOs = require('react-native').Platform.OS

const launched: NativeBuyResult = { status: 'launched', code: null, subCode: null, message: null, purchase: null }

const flush = () => new Promise(resolve => setImmediate(resolve))

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
  jest.resetModules()
  Object.defineProperty(require('react-native').Platform, 'OS', { value: 'android', configurable: true })
  double = jest.requireMock('../specs/NativeVoltzStore')
  double.control.reset()
  double.control.scriptBuy(() => launched)
  store = require('../src/wallet/store')
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warn.mockRestore()
  jest.useRealTimers()
  Object.defineProperty(require('react-native').Platform, 'OS', { value: originalOs, configurable: true })
})

// Resolves to the tap's result, or to 'open' when it has not answered yet.
function settledOf(result: Promise<StoreModule.BuyResult>): () => Promise<StoreModule.BuyResult | 'open'> {
  let answer: StoreModule.BuyResult | 'open' = 'open'
  result.then(r => {
    answer = r
  })
  return async () => {
    await flush()
    return answer
  }
}

function listen(): string[] {
  const seen: string[] = []
  store.onPurchaseUpdate(p => seen.push(p.key))
  return seen
}

async function tap(): Promise<() => Promise<StoreModule.BuyResult | 'open'>> {
  const answer = settledOf(store.buy('name_standard', { reference: REF, accountId: ACCOUNT }))
  await flush()
  return answer
}

describe('an OK that is this flow answer', () => {
  test("with the tap's product and reference answers as before, and hands nothing on", async () => {
    const seen = listen()
    const answer = await tap()
    double.control.emit(double.update([double.purchase({ reference: REF, state: '1', key: 'mine' })], '0'))
    expect(await answer()).toMatchObject({ kind: 'purchased', purchase: { key: 'mine', reference: REF } })
    expect(seen).toEqual([])
  })

  test("with the tap's product and no reference answers pending at once and hands the purchase on once", async () => {
    const seen = listen()
    const answer = await tap()
    double.control.emit(double.update([double.purchase({ reference: null, state: '1', key: 'bare' })], '0'))
    expect(await answer()).toEqual({ kind: 'pending', purchase: null })
    expect(seen).toEqual(['bare'])
    expect(jest.getTimerCount()).toBe(0)
  })

  test('with no purchase at all answers pending at once', async () => {
    const answer = await tap()
    double.control.emit(double.update([], '0'))
    expect(await answer()).toEqual({ kind: 'pending', purchase: null })
    expect(jest.getTimerCount()).toBe(0)
  })

  test("after it the tap's own purchase reaches the listeners once, and the next purchase may start", async () => {
    const seen = listen()
    const answer = await tap()
    double.control.emit(double.update([], '0'))
    expect(await answer()).toEqual({ kind: 'pending', purchase: null })
    double.control.emit(double.update([double.purchase({ reference: REF, state: '1', key: 'mine' })], '0'))
    expect(seen).toEqual(['mine'])
    const next = store.buy('name_standard', { reference: OTHER, accountId: ACCOUNT })
    await flush()
    double.control.emit(double.update([], '1'))
    expect(await next).toEqual({ kind: 'failed', code: 'cancelled' })
    expect(double.control.state.calls.buy).toHaveLength(2)
  })
})

describe('an OK with only other purchases', () => {
  test('of other products hands each on once and leaves the tap open, at any delay', async () => {
    const seen = listen()
    const answer = await tap()
    double.control.emit(
      double.update(
        [
          double.purchase({ reference: REF, state: '1', key: 'short', productIds: ['name_short'] }),
          double.purchase({ reference: OTHER, state: '1', key: 'domain', productIds: ['domain_year'] }),
        ],
        '0',
      ),
    )
    expect(seen).toEqual(['short', 'domain'])
    jest.advanceTimersByTime(60 * 60_000)
    expect(await answer()).toBe('open')
    expect(jest.getTimerCount()).toBe(0)
  })

  test('of this product for another order hands it on once and leaves the tap open', async () => {
    const seen = listen()
    const answer = await tap()
    double.control.emit(double.update([double.purchase({ reference: OTHER, state: '1', key: 'other-order' })], '0'))
    expect(seen).toEqual(['other-order'])
    expect(await answer()).toBe('open')
    jest.advanceTimersByTime(11_000)
    double.control.emit(double.update([], '1'))
    expect(await answer()).toEqual({ kind: 'failed', code: 'cancelled' })
  })

  test("is followed by the tap's purchase, which answers it as before", async () => {
    const seen = listen()
    const answer = await tap()
    double.control.emit(double.update([double.purchase({ reference: OTHER, state: '1', key: 'domain', productIds: ['domain_year'] })], '0'))
    jest.advanceTimersByTime(11_000)
    double.control.emit(double.update([double.purchase({ reference: REF, state: '1', key: 'mine' })], '0'))
    expect(await answer()).toMatchObject({ kind: 'purchased', purchase: { key: 'mine' } })
    expect(seen).toEqual(['domain'])
  })

  test.each([0, 11_000, 10 * 60_000])('is followed by a cancel %i ms later, which answers cancelled', async delay => {
    const seen = listen()
    const answer = await tap()
    double.control.emit(double.update([double.purchase({ reference: OTHER, state: '1', key: 'domain', productIds: ['domain_year'] })], '0'))
    jest.advanceTimersByTime(delay)
    double.control.emit(double.update([], '1'))
    expect(await answer()).toEqual({ kind: 'failed', code: 'cancelled' })
    expect(seen).toEqual(['domain'])
  })

  test('is followed by any other Google error, which answers the tap as before', async () => {
    const answer = await tap()
    double.control.emit(double.update([double.purchase({ reference: OTHER, state: '1', key: 'domain', productIds: ['domain_year'] })], '0'))
    jest.advanceTimersByTime(11_000)
    double.control.emit(double.update([], '7'))
    expect(await answer()).toEqual({ kind: 'failed', code: 'alreadyOwned' })
  })
})
