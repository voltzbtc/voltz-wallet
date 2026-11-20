import type * as StoreModule from '../src/wallet/store'
import type { NativeBuyResult } from '../specs/NativeVoltzStore'

type Double = typeof import('../specs/__mocks__/NativeVoltzStore')

const UPPER = 'E621E1F8-C36C-495A-93FC-0C247A3E6E5F'
const LOWER = 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f'
const OTHER = '7d444840-9dc0-11d1-b245-5ffdce74fad2'
const ACCOUNT = 'a'.repeat(64)

let store: typeof StoreModule
let double: Double
let warn: jest.SpyInstance
const originalOs = require('react-native').Platform.OS

// A fresh store module per test, since it keeps the native subscription and its backlog for the
// life of the JS context, and a fresh double behind it.
function load(os: 'ios' | 'android'): void {
  jest.resetModules()
  Object.defineProperty(require('react-native').Platform, 'OS', { value: os, configurable: true })
  double = jest.requireMock('../specs/NativeVoltzStore')
  double.control.reset()
  store = require('../src/wallet/store')
}

const flush = () => new Promise(resolve => setImmediate(resolve))

const launched: NativeBuyResult = { status: 'launched', code: null, subCode: null, message: null, purchase: null }

beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warn.mockRestore()
  Object.defineProperty(require('react-native').Platform, 'OS', { value: originalOs, configurable: true })
})

test('a build with the bridge has a store', () => {
  load('ios')
  expect(store.storeAvailable()).toBe(true)
})

describe('store codes', () => {
  beforeEach(() => load('ios'))

  test.each([
    ['userCancelled', 'cancelled'],
    ['networkError', 'network'],
    ['purchaseNotAllowed', 'notAllowed'],
    ['productUnavailable', 'storeUnavailable'],
    ['notAvailableInStorefront', 'storeUnavailable'],
    ['systemError', 'storeUnavailable'],
    ['unsupported', 'storeUnavailable'],
    ['invalidQuantity', 'unknown'],
    ['notEntitled', 'unknown'],
    ['invalidReference', 'unknown'],
    ['1', 'unknown'],
    [null, 'unknown'],
  ])('Apple %p is %p', (code, stable) => {
    expect(store.storeErrorCode('apple', code)).toBe(stable)
  })

  test.each([
    ['1', null, 'cancelled'],
    ['7', null, 'alreadyOwned'],
    ['12', null, 'network'],
    ['2', null, 'network'],
    ['-1', null, 'network'],
    ['3', null, 'storeUnavailable'],
    ['4', null, 'storeUnavailable'],
    ['-2', null, 'storeUnavailable'],
    ['6', null, 'storeUnavailable'],
    ['6', '1', 'declined'],
    ['3', '1', 'declined'],
    ['6', '2', 'storeUnavailable'],
    ['5', null, 'unknown'],
    ['8', null, 'unknown'],
    ['-3', null, 'unknown'],
    ['userCancelled', null, 'unknown'],
    [null, null, 'unknown'],
  ])('Google %p with sub code %p is %p', (code, subCode, stable) => {
    expect(store.storeErrorCode('google', code, subCode)).toBe(stable)
  })

  test("a code nothing maps leaves the store's message in the log", () => {
    store.storeErrorCode('google', '5', null, 'Invalid product id')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid product id'))
  })
})

describe('purchases as the app reads them', () => {
  test('an Apple reference comes back lowercase, the form the gateway issued', async () => {
    load('ios')
    double.control.state.open = [double.purchase({ reference: UPPER })]
    const [purchase] = await store.openPurchases()
    expect(purchase).toMatchObject({ store: 'apple', reference: LOWER, state: 'purchased', productId: 'name_standard' })
  })

  test('a Google reference is read as the store holds it', async () => {
    load('android')
    double.control.state.open = [double.purchase({ reference: LOWER, state: '1', key: 'token-1' })]
    const [purchase] = await store.openPurchases()
    expect(purchase).toMatchObject({ store: 'google', reference: LOWER, state: 'purchased', key: 'token-1' })
  })

  test.each([
    ['1', 'purchased'],
    ['2', 'pending'],
    ['0', 'pending'],
    ['purchased', 'pending'],
  ])('a Play purchase in state %p reads as %p', async (state, read) => {
    load('android')
    double.control.state.open = [double.purchase({ state, reference: LOWER })]
    expect((await store.openPurchases())[0]!.state).toBe(read)
  })

  test('a purchase that carries no reference reads as none', async () => {
    load('ios')
    double.control.state.open = [double.purchase({ reference: '' }), double.purchase({ reference: null, key: '2' })]
    expect((await store.openPurchases()).map(p => p.reference)).toEqual([null, null])
  })

  test('a store that cannot list its purchases says why with a stable code', async () => {
    load('android')
    double.control.failNext('openPurchases', '-1')
    await expect(store.openPurchases()).rejects.toMatchObject({ code: 'network' })
  })

  // Play answers BILLING_UNAVAILABLE on a device with no Google account, and FEATURE_NOT_SUPPORTED
  // where billing is not offered at all: the device has no billing, which is not one call failing.
  test.each([
    ['android', '3', true],
    ['android', '-2', true],
    ['android', '6', false],
    ['android', '2', false],
    ['android', '-1', false],
    ['android', '12', false],
    ['android', '4', false],
    ['ios', 'unsupported', false],
    ['ios', 'systemError', false],
  ] as const)('on %s, a list refused with %p says the device has no billing: %p', async (os, code, none) => {
    load(os)
    double.control.failNext('openPurchases', code)
    const refusal = await store.openPurchases().then(
      () => null,
      (err: unknown) => err,
    )
    expect(refusal).toBeInstanceOf(store.StoreError)
    expect((refusal as StoreModule.StoreError).noBilling).toBe(none)
  })
})

describe('products', () => {
  test('a product the store did not find is left out', async () => {
    load('ios')
    double.control.state.products = [
      { id: 'name_standard', displayPrice: 'R$ 54,90' },
      { id: 'name_short', displayPrice: 'R$ 549,90' },
    ]
    expect(await store.loadProducts(['name_standard', 'domain_year'])).toEqual([
      { id: 'name_standard', displayPrice: 'R$ 54,90' },
    ])
  })

  test('a store error while loading becomes a stable code', async () => {
    load('ios')
    double.control.failNext('loadProducts', 'networkError')
    await expect(store.loadProducts(['name_standard'])).rejects.toMatchObject({ code: 'network' })
  })
})

describe('buying on Apple', () => {
  beforeEach(() => load('ios'))

  test('a purchase comes back with its reference lowercase, and no account id is sent', async () => {
    double.control.scriptBuy(() => ({
      status: 'purchased',
      code: null,
      subCode: null,
      message: null,
      purchase: double.purchase({ reference: UPPER }),
    }))
    const result = await store.buy('name_standard', { reference: LOWER, accountId: ACCOUNT })
    expect(result).toMatchObject({ kind: 'purchased', purchase: { reference: LOWER } })
    expect(double.control.state.calls.buy).toEqual([{ productId: 'name_standard', reference: LOWER, accountId: null }])
  })

  test('Ask to Buy is pending with no purchase yet', async () => {
    double.control.scriptBuy(() => ({ status: 'pending', code: null, subCode: null, message: null, purchase: null }))
    expect(await store.buy('name_standard', { reference: LOWER })).toEqual({ kind: 'pending', purchase: null })
  })

  test('a cancelled sheet is a failure coded cancelled', async () => {
    double.control.scriptBuy(() => ({ status: 'cancelled', code: null, subCode: null, message: null, purchase: null }))
    expect(await store.buy('name_standard', { reference: LOWER })).toEqual({ kind: 'failed', code: 'cancelled' })
  })

  test('a network that drops mid purchase is coded network', async () => {
    double.control.scriptBuy(() => ({ status: 'failed', code: 'networkError', subCode: null, message: null, purchase: null }))
    expect(await store.buy('name_standard', { reference: LOWER })).toEqual({ kind: 'failed', code: 'network' })
  })

  test('a bridge that rejects is a failure with the code it carried', async () => {
    double.control.failNext('buy', 'systemError')
    expect(await store.buy('name_standard', { reference: LOWER })).toEqual({ kind: 'failed', code: 'storeUnavailable' })
  })

  test('a second purchase while one is in flight is refused without reaching the store', async () => {
    let answer: (result: NativeBuyResult) => void = () => undefined
    double.control.scriptBuy(() => new Promise(resolve => (answer = resolve)))
    const first = store.buy('name_standard', { reference: LOWER })
    await flush()
    expect(await store.buy('name_short', { reference: OTHER })).toEqual({ kind: 'failed', code: 'unknown' })
    answer({ status: 'cancelled', code: null, subCode: null, message: null, purchase: null })
    await first
    double.control.scriptBuy(() => ({ status: 'cancelled', code: null, subCode: null, message: null, purchase: null }))
    await store.buy('name_short', { reference: OTHER })
    expect(double.control.state.calls.buy.map(c => c.productId)).toEqual(['name_standard', 'name_short'])
  })
})

describe('buying on Google', () => {
  beforeEach(() => {
    load('android')
    double.control.scriptBuy(() => launched)
  })

  test('the purchase that answers the tap carries its product and the order reference', async () => {
    const result = store.buy('name_standard', { reference: LOWER, accountId: ACCOUNT })
    await flush()
    double.control.emit(double.update([double.purchase({ reference: LOWER, state: '1', key: 'token-1' })], '0'))
    expect(await result).toMatchObject({ kind: 'purchased', purchase: { key: 'token-1', reference: LOWER } })
    expect(double.control.state.calls.buy).toEqual([
      { productId: 'name_standard', reference: LOWER, accountId: ACCOUNT },
    ])
  })

  test('another purchase arriving during the tap goes to its own destination', async () => {
    const seen: string[] = []
    store.onPurchaseUpdate(p => seen.push(p.key))
    const result = store.buy('name_standard', { reference: LOWER, accountId: ACCOUNT })
    await flush()
    // A pending purchase approved elsewhere, of another order, and one of this product for another
    // order, and one of another product carrying this order's reference.
    double.control.emit(
      double.update(
        [
          double.purchase({ reference: OTHER, state: '1', key: 'other-order' }),
          double.purchase({ reference: LOWER, state: '1', key: 'other-product', productIds: ['name_short'] }),
        ],
        '0',
      ),
    )
    await flush()
    expect(seen).toEqual(['other-order', 'other-product'])
    double.control.emit(double.update([double.purchase({ reference: LOWER, state: '1', key: 'mine' })], '0'))
    expect(await result).toMatchObject({ kind: 'purchased', purchase: { key: 'mine' } })
    expect(seen).toEqual(['other-order', 'other-product'])
  })

  test('a launch the store refuses answers at once and frees the next purchase', async () => {
    double.control.scriptBuy(() => ({ status: 'failed', code: '7', subCode: null, message: null, purchase: null }))
    expect(await store.buy('name_standard', { reference: LOWER })).toEqual({ kind: 'failed', code: 'alreadyOwned' })
    double.control.scriptBuy(() => launched)
    const next = store.buy('name_standard', { reference: OTHER })
    await flush()
    double.control.emit(double.update([], '1'))
    expect(await next).toEqual({ kind: 'failed', code: 'cancelled' })
    expect(double.control.state.calls.buy).toHaveLength(2)
  })

  test('a declined payment is told apart from a store error', async () => {
    const result = store.buy('name_standard', { reference: LOWER })
    await flush()
    double.control.emit(double.update([], '6', '1'))
    expect(await result).toEqual({ kind: 'failed', code: 'declined' })
  })

  test('a slow payment is pending and carries the purchase', async () => {
    const result = store.buy('name_standard', { reference: LOWER })
    await flush()
    double.control.emit(double.update([double.purchase({ reference: LOWER, state: '2', key: 'slow' })], '0'))
    expect(await result).toMatchObject({ kind: 'pending', purchase: { key: 'slow', state: 'pending' } })
  })

  test('finishing a Play purchase never reaches the store', async () => {
    await store.finish({
      store: 'google',
      productId: 'name_standard',
      state: 'purchased',
      purchasedAt: 0,
      reference: LOWER,
      key: 'token-1',
      verified: true,
      revoked: false,
    })
    expect(double.control.state.calls.finish).toEqual([])
  })
})

describe('finishing on Apple', () => {
  test('finishes the transaction by its id', async () => {
    load('ios')
    double.control.state.open = [double.purchase({ reference: UPPER, key: '2000000999' })]
    const [purchase] = await store.openPurchases()
    await store.finish(purchase!)
    expect(double.control.state.calls.finish).toEqual(['2000000999'])
    expect(await store.openPurchases()).toEqual([])
  })
})

describe('the queue of store updates', () => {
  test('an update that arrived before anyone listened comes out once', async () => {
    load('ios')
    double.control.emit(double.update([double.purchase({ reference: UPPER, key: 'early' })]))
    const seen: string[] = []
    store.onPurchaseUpdate(p => seen.push(p.key))
    await flush()
    double.control.emit(double.update([double.purchase({ reference: UPPER, key: 'late' })]))
    await flush()
    expect(seen).toEqual(['early', 'late'])
  })

  test('an update that lands between subscribing and draining comes out once', async () => {
    load('ios')
    double.control.state.holdDrain = true
    const seen: string[] = []
    store.onPurchaseUpdate(p => seen.push(p.key))
    await flush()
    double.control.emit(double.update([double.purchase({ reference: UPPER, key: 'between' })]))
    double.control.releaseDrain()
    await flush()
    expect(seen).toEqual(['between'])
  })

  test('what the store hands over before the app listens waits for the first listener', async () => {
    load('android')
    double.control.scriptBuy(() => launched)
    const result = store.buy('name_standard', { reference: LOWER })
    await flush()
    double.control.emit(
      double.update(
        [double.purchase({ reference: OTHER, state: '1', key: 'stray' }), double.purchase({ reference: LOWER, state: '1', key: 'mine' })],
        '0',
      ),
    )
    await result
    const seen: string[] = []
    store.onPurchaseUpdate(p => seen.push(p.key))
    store.onPurchaseUpdate(() => undefined)
    expect(seen).toEqual(['stray'])
  })

  test('the backlog keeps the newest hundred', async () => {
    load('android')
    double.control.scriptBuy(() => launched)
    const result = store.buy('name_standard', { reference: LOWER })
    await flush()
    const stray = Array.from({ length: 101 }, (_, i) => double.purchase({ reference: OTHER, state: '1', key: `k${i}` }))
    double.control.emit(double.update(stray, '0'))
    double.control.emit(double.update([double.purchase({ reference: LOWER, state: '1', key: 'mine' })], '0'))
    await result
    const seen: string[] = []
    store.onPurchaseUpdate(p => seen.push(p.key))
    expect(seen).toHaveLength(100)
    expect(seen[0]).toBe('k1')
    expect(seen[99]).toBe('k100')
  })

  test('a drain that fails is tried again by the next listener', async () => {
    load('ios')
    double.control.emit(double.update([double.purchase({ reference: UPPER, key: 'kept' })]))
    double.control.failNext('takeQueued', 'systemError')
    const seen: string[] = []
    store.onPurchaseUpdate(p => seen.push(p.key))
    await flush()
    expect(seen).toEqual([])
    store.onPurchaseUpdate(p => seen.push(p.key))
    await flush()
    expect(seen).toEqual(['kept', 'kept'])
    expect(double.control.state.calls.takeQueued).toBe(2)
  })
})

// Apple's refund sheet answers what became of the sheet, and only Apple has one.
describe('the refund sheet', () => {
  test.each([
    [{ status: 'success', code: null, message: null }, 'sent'],
    [{ status: 'userCancelled', code: null, message: null }, 'closed'],
    [{ status: 'failed', code: 'duplicateRequest', message: 'already asked' }, 'duplicate'],
    [{ status: 'failed', code: 'failed', message: 'nope' }, 'failed'],
    [{ status: 'failed', code: 'noScene', message: 'no scene' }, 'failed'],
    [{ status: 'failed', code: 'networkError', message: 'offline' }, 'failed'],
    [{ status: 'something new', code: null, message: null }, 'failed'],
  ])('Apple answering %j reads as %s, for the id asked', async (answer, expected) => {
    load('ios')
    double.control.scriptRefund(() => answer)
    await expect(store.requestStoreRefund('2000000123456789')).resolves.toBe(expected)
    expect(double.control.state.calls.beginRefundRequest).toEqual(['2000000123456789'])
  })

  test('a bridge that rejects reads as failed', async () => {
    load('ios')
    double.control.failNext('beginRefundRequest', 'systemError')
    await expect(store.requestStoreRefund('1')).resolves.toBe('failed')
  })

  test('Google opens nothing', async () => {
    load('android')
    double.control.scriptRefund(() => ({ status: 'success', code: null, message: null }))
    await expect(store.requestStoreRefund('1')).resolves.toBe('failed')
    expect(double.control.state.calls.beginRefundRequest).toEqual([])
  })

  test('the sheet can open on an iPhone with the bridge and never on Android', () => {
    load('ios')
    expect(store.storeRefundSheetAvailable()).toBe(true)
    load('android')
    expect(store.storeRefundSheetAvailable()).toBe(false)
  })
})
