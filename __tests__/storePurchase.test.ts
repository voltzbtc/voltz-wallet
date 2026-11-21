import type * as StorePurchaseModule from '../src/wallet/storePurchase'
import type { NativeBuyResult, NativePurchase } from '../specs/NativeVoltzStore'

type Double = typeof import('../specs/__mocks__/NativeVoltzStore')
type Spark = { connected: string | null; listeners: Set<() => void> }

// The SDK's connection, as far as the store flow sees it, which is the wallet that signs and who is
// told when one connects.
const mockSpark: Spark = { connected: null, listeners: new Set() }
jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: () => mockSpark.connected,
  onSparkConnected: (cb: () => void) => {
    mockSpark.listeners.add(cb)
    if (mockSpark.connected !== null) {
      cb()
    }
    return () => mockSpark.listeners.delete(cb)
  },
}))
const spark = mockSpark

const DOMAIN = 'usevoltz.app'
const PUBKEY = `02${'b'.repeat(64)}`
const REF = 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f'
const REF_B = '7d444840-9dc0-11d1-b245-5ffdce74fad2'
const HMAC = 'c'.repeat(64)
const BOOK = '/mock/Documents/store-orders.json'
const HTML = '<!DOCTYPE html><html><title>Attention Required! | Cloudflare</title></html>'

type Answer = { status: number; text: string } | 'network' | Promise<{ status: number; text: string }>
type Call = { path: string; body: Record<string, unknown> }

const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) })
const deliveredFor = (reference: string) =>
  json(200, { state: 'delivered', reference, kind: 'name', credit: { domain: DOMAIN, tier: 'standard' } })

let sp: typeof StorePurchaseModule
let double: Double
let clock = 1_800_000_000_000
let log: string[]
let answers: Record<string, Answer[]>
let calls: Call[]
let warn: jest.SpyInstance
const originalOs = require('react-native').Platform.OS

function context(wallets = ['w_a', 'w_b']): StorePurchaseModule.StoreContext {
  return {
    walletId: () => spark.connected,
    wallets: async () => wallets,
    now: () => clock,
    gateway: async () => ({
      gatewayUrl: `https://${DOMAIN}`,
      domain: DOMAIN,
      pubkey: PUBKEY,
      sign: async () => 'sig',
      now: () => clock,
      sleep: async ms => {
        log.push(`sleep ${ms}`)
      },
      request: (async (url: string, init: { body: string }) => {
        const path = new URL(url).pathname
        const body = JSON.parse(init.body)
        calls.push({ path, body })
        log.push(`${path} ${body.reference ?? body.subject ?? ''}`)
        const next = (answers[path] ?? []).shift()
        if (!next) {
          throw new Error(`no answer left for ${path}`)
        }
        if (next === 'network') {
          throw new TypeError('Network request failed')
        }
        const { status, text } = await next
        return { status, ok: status < 300, text: async () => text } as unknown as Response
      }) as unknown as typeof fetch,
    }),
  }
}

// Starts a JS context with fresh modules and a fresh double, keeping what was on disk, as after the
// app is killed and opened again.
async function boot(os: 'ios' | 'android', files: Record<string, string> = {}): Promise<void> {
  jest.resetModules()
  Object.defineProperty(require('react-native').Platform, 'OS', { value: os, configurable: true })
  const RNFS = require('react-native-fs').default
  for (const [path, content] of Object.entries(files)) {
    await RNFS.writeFile(path, content, 'utf8')
  }
  double = jest.requireMock('../specs/NativeVoltzStore')
  double.control.reset()
  const finishOf = double.default.finish
  jest.spyOn(double.default, 'finish').mockImplementation(async id => {
    log.push(`finish ${id}`)
    return finishOf(id)
  })
  sp = require('../src/wallet/storePurchase')
}

async function disk(): Promise<Record<string, string>> {
  const RNFS = require('react-native-fs').default
  return (await RNFS.exists(BOOK)) ? { [BOOK]: await RNFS.readFile(BOOK, 'utf8') } : {}
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

function applePurchase(over: Partial<NativePurchase> = {}): NativePurchase {
  return { productIds: ['name_standard'], key: 'tx-1', reference: REF.toUpperCase(), state: 'purchased', purchasedAt: clock, verified: true, revoked: false, ...over }
}

function googlePurchase(over: Partial<NativePurchase> = {}): NativePurchase {
  return { productIds: ['name_standard'], key: 'token-1', reference: REF, state: '1', purchasedAt: clock, verified: true, revoked: false, ...over }
}

const appleOrder = (reference = REF) =>
  json(200, { reference, productId: 'name_standard', state: 'held', kind: 'name', subject: 'alice', appAccountToken: reference })
const googleOrder = (reference = REF) =>
  json(200, {
    reference,
    productId: 'name_standard',
    state: 'held',
    kind: 'name',
    subject: 'alice',
    obfuscatedProfileId: reference,
    obfuscatedAccountId: HMAC,
  })

const bought = (purchase: NativePurchase): NativeBuyResult => ({ status: 'purchased', code: null, subCode: null, message: null, purchase })
const launched: NativeBuyResult = { status: 'launched', code: null, subCode: null, message: null, purchase: null }

const confirms = () => calls.filter(c => c.path === '/api/store/confirm')
const finished = () => log.filter(line => line.startsWith('finish'))

beforeEach(() => {
  spark.connected = 'w_a'
  spark.listeners.clear()
  clock = 1_800_000_000_000
  log = []
  answers = {}
  calls = []
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warn.mockRestore()
  Object.defineProperty(require('react-native').Platform, 'OS', { value: originalOs, configurable: true })
})

describe('buying', () => {
  test('a cancelled sheet confirms nothing and finishes nothing', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    double.control.scriptBuy(() => ({ status: 'cancelled', code: null, subCode: null, message: null, purchase: null }))
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'failed', code: 'cancelled' })
    expect(confirms()).toEqual([])
    expect(finished()).toEqual([])
  })

  // A store age signal under 18 stops the purchase before any order holds the name or a sheet opens.
  test('a minor by the store age signal opens no order and no sheet', async () => {
    await boot('ios')
    jest.requireMock('../specs/NativeVoltzAge').ageStore.shares(13, 15)
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'adultsOnly' })
    expect(calls).toEqual([])
    expect(double.control.state.calls.buy).toEqual([])
  })

  test('an adult by the store age signal buys as anyone else does', async () => {
    await boot('ios')
    jest.requireMock('../specs/NativeVoltzAge').ageStore.shares(18, -1)
    answers['/api/store/order'] = [appleOrder()]
    double.control.scriptBuy(() => ({ status: 'cancelled', code: null, subCode: null, message: null, purchase: null }))
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'failed', code: 'cancelled' })
    expect(calls.map(c => c.path)).toEqual(['/api/store/order'])
  })

  test('a paid Apple purchase is confirmed with the reference from the transaction and finished', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    double.control.scriptBuy(() => bought(applePurchase()))
    const outcome = await sp.buyInStore('name', 'alice', context())
    expect(outcome).toMatchObject({ kind: 'settled', result: { kind: 'delivered' } })
    // StoreKit writes the UUID in capitals; the confirmation carries the form the gateway issued.
    expect(confirms()[0]!.body).toMatchObject({ store: 'apple', reference: REF, transactionId: 'tx-1' })
    expect(double.control.state.calls.buy).toEqual([{ productId: 'name_standard', reference: REF, accountId: null }])
    expect(finished()).toEqual(['finish tx-1'])
  })

  test("Google is handed the order's own identifiers and nothing is finished on the device", async () => {
    await boot('android')
    answers['/api/store/order'] = [googleOrder()]
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    double.control.scriptBuy(() => launched)
    const outcome = sp.buyInStore('name', 'alice', context())
    await flush()
    double.control.emit(double.update([googlePurchase()], '0'))
    expect(await outcome).toMatchObject({ kind: 'settled', result: { kind: 'delivered' } })
    expect(double.control.state.calls.buy).toEqual([{ productId: 'name_standard', reference: REF, accountId: HMAC }])
    expect(confirms()[0]!.body).toMatchObject({ store: 'google', reference: REF, purchaseToken: 'token-1' })
    expect(finished()).toEqual([])
  })

  test('an order the gateway refuses never opens the store', async () => {
    await boot('ios')
    answers['/api/store/order'] = [json(409, { error: 'name_pending' })]
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'orderRefused', status: 409, code: 'name_pending' })
    expect(double.control.state.calls.buy).toEqual([])
  })

  test('an order the store was already paid for is looked for among open purchases, not bought again', async () => {
    await boot('ios')
    answers['/api/store/order'] = [
      json(200, { reference: REF, productId: 'name_standard', state: 'paid', kind: 'name', subject: 'alice', appAccountToken: REF }),
    ]
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    double.control.state.open = [applePurchase()]
    expect(await sp.buyInStore('name', 'alice', context())).toMatchObject({ kind: 'settled', result: { kind: 'delivered' } })
    expect(double.control.state.calls.buy).toEqual([])
    expect(finished()).toEqual(['finish tx-1'])
  })

  test('a paid order with nothing open here buys nothing', async () => {
    await boot('ios')
    answers['/api/store/order'] = [
      json(200, { reference: REF, productId: 'name_standard', state: 'paid', kind: 'name', subject: 'alice', appAccountToken: REF }),
    ]
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'paidElsewhere', reference: REF })
    expect(double.control.state.calls.buy).toEqual([])
  })
})

// Within its ten minute hold the gateway hands back the order it already opened, still held when no
// confirmation reached it, and the store is never opened twice for one reference.
describe('an order handed back', () => {
  test('with its purchase open here confirms that purchase and opens no store', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder(), appleOrder()]
    answers['/api/store/confirm'] = ['network', 'network', 'network', 'network', deliveredFor(REF)]
    let made = 0
    double.control.scriptBuy(() => {
      made += 1
      const purchase = applePurchase({ key: `tx-${made}` })
      // A paid Apple transaction stays among the unfinished ones until it is finished.
      double.control.state.open.push(purchase)
      return bought(purchase)
    })
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'settled', reference: REF, result: { kind: 'retry' } })
    expect(await sp.buyInStore('name', 'alice', context())).toMatchObject({ kind: 'settled', result: { kind: 'delivered' } })
    expect(double.control.state.calls.buy).toHaveLength(1)
    expect(finished()).toEqual(['finish tx-1'])
  })

  test('while Ask to Buy waits shows the wait again, after a restart too', async () => {
    await boot('ios')
    const pending = () => ({ status: 'pending', code: null, subCode: null, message: null, purchase: null }) as NativeBuyResult
    answers['/api/store/order'] = [appleOrder(), appleOrder(), appleOrder()]
    double.control.scriptBuy(pending)
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'pending', reference: REF })
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'pending', reference: REF })
    expect(double.control.state.calls.buy).toHaveLength(1)
    await boot('ios', await disk())
    double.control.scriptBuy(pending)
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'pending', reference: REF })
    expect(double.control.state.calls.buy).toEqual([])
    expect(confirms()).toEqual([])
  })

  test('an Ask to Buy note whose read the platform refuses opens no store and answers a retry', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder(), appleOrder()]
    double.control.scriptBuy(() => ({ status: 'pending', code: null, subCode: null, message: null, purchase: null }))
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'pending', reference: REF })
    expect(JSON.parse((await disk())[BOOK]).bought).toEqual({ [REF]: 'pending' })
    const RNFS = require('react-native-fs').default
    const read = RNFS.readFile.bind(RNFS)
    const refused = jest.spyOn(RNFS, 'readFile').mockImplementation((async (path: string, ...rest: unknown[]) => {
      if (path === BOOK) {
        throw new Error('EACCES: permission denied')
      }
      return read(path, ...rest)
    }) as never)
    let outcome: StorePurchaseModule.StoreBuyOutcome
    try {
      outcome = await sp.buyInStore('name', 'alice', context())
    } finally {
      refused.mockRestore()
    }
    expect(outcome).toEqual({ kind: 'orderRetry' })
    expect(double.control.state.calls.buy).toHaveLength(1)
    expect(JSON.parse((await disk())[BOOK]).bought).toEqual({ [REF]: 'pending' })
  })

  test('after a purchase seen paid that is no longer open here opens no store', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder(), appleOrder()]
    answers['/api/store/confirm'] = ['network', 'network', 'network', 'network']
    double.control.scriptBuy(() => bought(applePurchase()))
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'settled', reference: REF, result: { kind: 'retry' } })
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'paidElsewhere', reference: REF })
    expect(double.control.state.calls.buy).toHaveLength(1)
  })

  test('after a cancelled sheet opens the store again', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder(), appleOrder()]
    double.control.scriptBuy(() => ({ status: 'cancelled', code: null, subCode: null, message: null, purchase: null }))
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'failed', code: 'cancelled' })
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'failed', code: 'cancelled' })
    expect(double.control.state.calls.buy).toHaveLength(2)
  })

  // The root's sync can settle the order the gateway has just handed back, after which the store no
  // longer lists its purchase and would take a second payment for an order already delivered.
  test('settled by the sync while the gateway hands it back opens no store', async () => {
    await boot('ios')
    let answer!: () => void
    answers['/api/store/order'] = [new Promise(resolve => (answer = () => resolve(appleOrder())))]
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    double.control.state.open = [applePurchase()]
    const buying = sp.buyInStore('name', 'alice', context())
    await flush()
    await sp.syncStorePurchases(context())
    expect(finished()).toEqual(['finish tx-1'])
    answer()
    expect(await buying).toEqual({ kind: 'settledMeanwhile', reference: REF })
    expect(double.control.state.calls.buy).toEqual([])
  })

  test('opens no store when the open purchases cannot be read', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    double.control.scriptBuy(() => bought(applePurchase()))
    double.control.failNext('openPurchases', 'systemError')
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'failed', code: 'storeUnavailable' })
    expect(double.control.state.calls.buy).toEqual([])
  })
})

describe('pending purchases', () => {
  test('Ask to Buy waits, and the approval arriving later is confirmed and finished', async () => {
    await boot('ios')
    const stop = sp.startStoreSync(context())
    answers['/api/store/order'] = [appleOrder()]
    double.control.scriptBuy(() => ({ status: 'pending', code: null, subCode: null, message: null, purchase: null }))
    // The sync that runs on start finds nothing open.
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'pending', reference: REF })
    expect(confirms()).toEqual([])
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    double.control.emit(double.update([applePurchase()]))
    await flush()
    expect(confirms()).toHaveLength(1)
    expect(finished()).toEqual(['finish tx-1'])
    stop()
  })

  test('a slow Play payment approved later is confirmed when the store reports it', async () => {
    await boot('android')
    const stop = sp.startStoreSync(context())
    answers['/api/store/order'] = [googleOrder()]
    double.control.scriptBuy(() => launched)
    const outcome = sp.buyInStore('name', 'alice', context())
    await flush()
    double.control.emit(double.update([googlePurchase({ state: '2' })], '0'))
    expect(await outcome).toEqual({ kind: 'pending', reference: REF })
    expect(confirms()).toEqual([])
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    double.control.emit(double.update([googlePurchase({ state: '1' })], '0'))
    await flush()
    expect(confirms()).toHaveLength(1)
    stop()
  })

  test('a pending Play purchase that is declined is gone from the list on the next open', async () => {
    await boot('android')
    double.control.state.open = [googlePurchase({ state: '2' })]
    expect(await sp.syncStorePurchases(context())).toEqual([{ kind: 'pending' }])
    double.control.state.open = []
    expect(await sp.syncStorePurchases(context())).toEqual([])
    expect(confirms()).toEqual([])
  })
})

describe('recovery', () => {
  test('a product Google says is owned has its unconsumed purchase confirmed', async () => {
    await boot('android', { [BOOK]: JSON.stringify({ orders: { [REF_B]: 'w_a' }, waits: {}, unknown: {} }) })
    answers['/api/store/order'] = [googleOrder()]
    answers['/api/store/confirm'] = [deliveredFor(REF_B)]
    double.control.state.open = [googlePurchase({ reference: REF_B, key: 'old-token' })]
    double.control.scriptBuy(() => ({ status: 'failed', code: '7', subCode: null, message: null, purchase: null }))
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'failed', code: 'alreadyOwned' })
    expect(confirms().map(c => c.body.purchaseToken)).toEqual(['old-token'])
    expect(finished()).toEqual([])
  })

  test('a network that drops mid purchase finishes nothing, and the recovery confirms what went through', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    double.control.scriptBuy(() => ({ status: 'failed', code: 'networkError', subCode: null, message: null, purchase: null }))
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'failed', code: 'network' })
    expect(finished()).toEqual([])
    double.control.state.open = [applePurchase()]
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    await sp.syncStorePurchases(context())
    expect(finished()).toEqual(['finish tx-1'])
  })

  test('a purchase paid before the app was killed is confirmed when it opens again', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    answers['/api/store/confirm'] = ['network', 'network', 'network', 'network']
    double.control.scriptBuy(() => bought(applePurchase()))
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'settled', reference: REF, result: { kind: 'retry' } })
    expect(finished()).toEqual([])
    const kept = await disk()
    // After the kill nothing in memory survives, the file does, and the store still holds the
    // transaction.
    await boot('ios', kept)
    double.control.state.open = [applePurchase()]
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    const stop = sp.startStoreSync(context())
    await flush()
    expect(finished()).toEqual(['finish tx-1'])
    stop()
  })

  test('returning to the foreground confirms what is open', async () => {
    await boot('ios')
    spark.connected = null
    const stop = sp.startStoreSync(context())
    spark.connected = 'w_a'
    double.control.state.open = [applePurchase()]
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    const { AppState } = require('react-native')
    const handler = jest.mocked(AppState.addEventListener).mock.calls.at(-1)![1] as (state: string) => void
    handler('active')
    await flush()
    expect(finished()).toEqual(['finish tx-1'])
    stop()
  })
})

describe('the gateway answers', () => {
  test('a 503 three times then a 200 finishes once, after the 200', async () => {
    await boot('ios')
    const busy = json(503, { error: 'store_unavailable' })
    answers['/api/store/confirm'] = [busy, busy, busy, deliveredFor(REF)]
    double.control.state.open = [applePurchase()]
    await sp.syncStorePurchases(context())
    expect(log).toEqual([
      `/api/store/confirm ${REF}`,
      'sleep 2000',
      `/api/store/confirm ${REF}`,
      'sleep 4000',
      `/api/store/confirm ${REF}`,
      'sleep 8000',
      `/api/store/confirm ${REF}`,
      'finish tx-1',
    ])
  })

  test.each([
    [409, 'refunded'],
    [409, 'order_already_delivered'],
    [409, 'domain_held_by_another_wallet'],
    [409, 'product_mismatch'],
    [409, 'refused'],
    [403, 'environment_not_allowed'],
    [403, 'xcode_environment'],
  ])('a final %p %p finishes on Apple', async (status, code) => {
    await boot('ios')
    answers['/api/store/confirm'] = [json(status, { error: code })]
    double.control.state.open = [applePurchase()]
    expect(await sp.syncStorePurchases(context())).toEqual([{ kind: 'refused', status, code }])
    expect(finished()).toEqual(['finish tx-1'])
  })

  test('a final refusal on Google is left for Google to refund', async () => {
    await boot('android')
    answers['/api/store/confirm'] = [json(409, { error: 'domain_held_by_another_wallet' })]
    double.control.state.open = [googlePurchase()]
    expect(await sp.syncStorePurchases(context())).toMatchObject([{ kind: 'refused' }])
    expect(double.control.state.calls.finish).toEqual([])
  })

  test.each<[string, { status: number; text: string }]>([
    ['an edge 403 page', { status: 403, text: HTML }],
    ['a 429', json(429, { error: 'too many requests' })],
    ['an edge 502 page', { status: 502, text: HTML }],
    ['a 409 code this build does not know', json(409, { error: 'purchase_on_fire' })],
    ['a defect refusal', json(409, { error: 'wrong_app_account_token' })],
    ['another defect refusal', json(409, { error: 'purchase_of_another_order' })],
    ['a purchase the store has not confirmed', json(402, { error: 'not_paid' })],
    ['a pending answer', json(402, { error: 'purchase_pending' })],
    ['a 200 for another reference', deliveredFor(REF_B)],
  ])('%s never finishes on Apple', async (_label, answer) => {
    await boot('ios')
    answers['/api/store/confirm'] = [answer]
    double.control.state.open = [applePurchase()]
    await sp.syncStorePurchases(context())
    expect(confirms()).toHaveLength(1)
    expect(finished()).toEqual([])
  })

  test('an answer that decided nothing waits a minute, then two, before asking again', async () => {
    await boot('ios')
    const busy = json(429, { error: 'too many requests' })
    answers['/api/store/confirm'] = [busy, busy, deliveredFor(REF)]
    double.control.state.open = [applePurchase()]
    await sp.syncStorePurchases(context())
    clock += 59_000
    expect(await sp.syncStorePurchases(context())).toEqual([{ kind: 'waiting', why: 'backoff' }])
    clock += 1_000
    await sp.syncStorePurchases(context())
    clock += 119_000
    expect(await sp.syncStorePurchases(context())).toEqual([{ kind: 'waiting', why: 'backoff' }])
    clock += 1_000
    await sp.syncStorePurchases(context())
    expect(confirms()).toHaveLength(3)
    expect(finished()).toEqual(['finish tx-1'])
  })

  test.each([
    [1, 60_000],
    [2, 120_000],
    [3, 240_000],
    [9, 256 * 60_000],
    [10, 6 * 60 * 60_000],
    [40, 6 * 60 * 60_000],
  ])('after %p undecided answers the wait is %p ms', (attempts, ms) => {
    expect(sp.laterWait(attempts)).toBe(ms)
  })
})

describe('whose purchase', () => {
  test('a purchase with no reference is never confirmed', async () => {
    await boot('ios')
    double.control.state.open = [applePurchase({ reference: null })]
    expect(await sp.syncStorePurchases(context())).toEqual([{ kind: 'noReference' }])
    expect(confirms()).toEqual([])
    expect(finished()).toEqual([])
  })

  test("another wallet's purchase waits until that wallet connects", async () => {
    await boot('ios', { [BOOK]: JSON.stringify({ orders: { [REF]: 'w_b' }, waits: {}, unknown: {} }) })
    const stop = sp.startStoreSync(context())
    double.control.state.open = [applePurchase()]
    expect(await sp.syncStorePurchases(context())).toEqual([{ kind: 'waiting', why: 'otherWallet' }])
    expect(confirms()).toEqual([])
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    spark.connected = 'w_b'
    spark.listeners.forEach(cb => cb())
    await flush()
    expect(confirms()).toHaveLength(1)
    expect(finished()).toEqual(['finish tx-1'])
    stop()
  })

  test('a purchase whose wallet was removed from this device is asked about by the connected wallet', async () => {
    // Adding the same words back gives the wallet a new id, and the removed id never connects again.
    await boot('ios', { [BOOK]: JSON.stringify({ orders: { [REF]: 'w_gone' }, waits: {}, unknown: {} }) })
    spark.connected = 'w_new'
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    double.control.state.open = [applePurchase()]
    expect(await sp.syncStorePurchases(context(['w_new']))).toMatchObject([{ kind: 'delivered' }])
    expect(finished()).toEqual(['finish tx-1'])
  })

  test('a purchase opened by one wallet is not confirmed by the wallet the app switches to', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    answers['/api/store/confirm'] = ['network', 'network', 'network', 'network']
    double.control.scriptBuy(() => bought(applePurchase()))
    await sp.buyInStore('name', 'alice', context())
    spark.connected = 'w_b'
    double.control.state.open = [applePurchase()]
    expect(await sp.syncStorePurchases(context())).toEqual([{ kind: 'waiting', why: 'otherWallet' }])
    expect(confirms()).toHaveLength(4)
  })

  test('a purchase from another device is tried with the connected wallet and not finished', async () => {
    await boot('ios')
    answers['/api/store/confirm'] = [json(409, { error: 'unknown_order' })]
    double.control.state.open = [applePurchase()]
    expect(await sp.syncStorePurchases(context())).toEqual([{ kind: 'unknownOrder' }])
    expect(finished()).toEqual([])
    expect(await sp.syncStorePurchases(context())).toEqual([{ kind: 'waiting', why: 'backoff' }])
  })

  test('no store notice delivers yet, so an unknown order is never finished', async () => {
    // Opened here, and every wallet on the device told the gateway does not know it.
    await boot('ios', { [BOOK]: JSON.stringify({ orders: { [REF]: 'w_a' }, waits: {}, unknown: { [REF]: ['w_a'] } }) })
    expect(sp.STORE_NOTICE_DELIVERY).toBe(false)
    spark.connected = 'w_b'
    answers['/api/store/confirm'] = [json(409, { error: 'unknown_order' })]
    double.control.state.open = [applePurchase()]
    expect(await sp.syncStorePurchases(context())).toEqual([{ kind: 'unknownOrder' }])
    expect(confirms()).toHaveLength(1)
    expect(finished()).toEqual([])
  })

  test.each<[boolean, boolean, string[], string[], boolean]>([
    [true, true, ['w_a', 'w_b'], ['w_a', 'w_b'], true],
    [false, true, ['w_a', 'w_b'], ['w_a', 'w_b'], false],
    [true, false, ['w_a', 'w_b'], ['w_a', 'w_b'], false],
    [true, true, ['w_a'], ['w_a', 'w_b'], false],
    [true, true, [], [], false],
  ])('with notices %p, opened here %p, refused by %p of %p, an unknown order finishes: %p', (notices, here, by, all, finishes) => {
    jest.isolateModules(() => {
      const { unknownOrderFinishes } = require('../src/wallet/storePurchase')
      expect(unknownOrderFinishes(notices, here, by, all)).toBe(finishes)
    })
  })
})

describe('the same purchase more than once', () => {
  test('an update that arrived before the app listened is confirmed once', async () => {
    await boot('ios')
    double.control.emit(double.update([applePurchase()]))
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    const stop = sp.startStoreSync(context())
    await flush()
    expect(confirms()).toHaveLength(1)
    expect(finished()).toEqual(['finish tx-1'])
    stop()
  })

  test('the purchase, its update and the open list together send one confirmation', async () => {
    await boot('ios')
    let answer: (reply: { status: number; text: string }) => void = () => undefined
    answers['/api/store/order'] = [appleOrder()]
    answers['/api/store/confirm'] = [new Promise(resolve => (answer = resolve))]
    double.control.scriptBuy(() => {
      double.control.state.open = [applePurchase()]
      return bought(applePurchase())
    })
    const stop = sp.startStoreSync(context())
    const outcome = sp.buyInStore('name', 'alice', context())
    await flush()
    double.control.emit(double.update([applePurchase()]))
    await sp.syncStorePurchases(context())
    await flush()
    answer(deliveredFor(REF))
    await outcome
    await flush()
    expect(double.control.state.calls.buy).toHaveLength(1)
    expect(confirms()).toHaveLength(1)
    expect(finished()).toEqual(['finish tx-1'])
    stop()
  })

  test('another purchase during a Play purchase in flight is confirmed with its own reference', async () => {
    await boot('android', { [BOOK]: JSON.stringify({ orders: { [REF_B]: 'w_a' }, waits: {}, unknown: {} }) })
    const stop = sp.startStoreSync(context())
    answers['/api/store/order'] = [googleOrder()]
    answers['/api/store/confirm'] = [deliveredFor(REF_B), deliveredFor(REF)]
    double.control.scriptBuy(() => launched)
    const outcome = sp.buyInStore('name', 'alice', context())
    await flush()
    double.control.emit(double.update([googlePurchase({ reference: REF_B, key: 'other-token' })], '0'))
    await flush()
    double.control.emit(double.update([googlePurchase()], '0'))
    expect(await outcome).toMatchObject({ kind: 'settled', result: { kind: 'delivered' } })
    expect(confirms().map(c => [c.body.reference, c.body.purchaseToken])).toEqual([
      [REF_B, 'other-token'],
      [REF, 'token-1'],
    ])
    stop()
  })
})

// A screen opened again, or after a restart, finds the purchase it was waiting on in the book and
// shows the wait, so the store is never opened for a second charge while the first one is out.
describe('a purchase a screen waits on', () => {
  const askToBuy = () => ({ status: 'pending', code: null, subCode: null, message: null, purchase: null }) as NativeBuyResult
  const waitingOn = (subject: string) => ({ reference: REF, subject, renewal: false, outcome: { kind: 'waiting' } })

  test('an Ask to Buy on Apple is held for its domain, after a restart too', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    double.control.scriptBuy(askToBuy)
    await sp.buyInStore('name', 'alice', context())
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([waitingOn('alice')])
    await boot('ios', await disk())
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([waitingOn('alice')])
    expect(await sp.storeOrderViews('name', null, context())).toEqual([waitingOn('alice')])
  })

  test('is nothing for another domain, another kind or another wallet', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    double.control.scriptBuy(askToBuy)
    await sp.buyInStore('name', 'alice', context())
    expect(await sp.storeOrderViews('name', 'pay.bakery.com', context())).toEqual([])
    expect(await sp.storeOrderViews('tier', null, context())).toEqual([])
    spark.connected = 'w_b'
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([])
  })

  test('leaving the wait lets the store open again for the order', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder(), appleOrder()]
    double.control.scriptBuy(askToBuy)
    await sp.buyInStore('name', 'alice', context())
    await sp.dropStoreWait(REF)
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([])
    await sp.buyInStore('name', 'alice', context())
    expect(double.control.state.calls.buy).toHaveLength(2)
  })

  test('a slow Play payment is held while Google lists it and not once it is gone', async () => {
    await boot('android')
    answers['/api/store/order'] = [googleOrder()]
    double.control.scriptBuy(() => launched)
    const outcome = sp.buyInStore('name', 'alice', context())
    await flush()
    double.control.emit(double.update([googlePurchase({ state: '2' })], '0'))
    await outcome
    double.control.state.open = [googlePurchase({ state: '2' })]
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([waitingOn('alice')])
    // Declined or lapsed, Google drops the purchase from its list.
    double.control.state.open = []
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([])
  })

  test('a paid purchase the gateway has not confirmed is held while the store keeps it open', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    answers['/api/store/confirm'] = ['network', 'network', 'network', 'network']
    double.control.scriptBuy(() => {
      double.control.state.open.push(applePurchase())
      return bought(applePurchase())
    })
    await sp.buyInStore('name', 'alice', context())
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([waitingOn('alice')])
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    await sp.syncStorePurchases(context())
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([])
  })

  test('an open list that cannot be read keeps the wait', async () => {
    await boot('android')
    answers['/api/store/order'] = [googleOrder()]
    double.control.scriptBuy(() => launched)
    const outcome = sp.buyInStore('name', 'alice', context())
    await flush()
    double.control.emit(double.update([googlePurchase({ state: '2' })], '0'))
    await outcome
    double.control.failNext('openPurchases', '2')
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([waitingOn('alice')])
  })

  test('a final refusal on Google is the refusal, never a wait', async () => {
    await boot('android')
    answers['/api/store/order'] = [googleOrder()]
    answers['/api/store/confirm'] = [json(409, { error: 'refunded' })]
    double.control.scriptBuy(() => launched)
    const outcome = sp.buyInStore('name', 'alice', context())
    await flush()
    double.control.emit(double.update([googlePurchase()], '0'))
    expect(await outcome).toMatchObject({ kind: 'settled', result: { kind: 'refused' } })
    double.control.state.open = [googlePurchase()]
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([
      { reference: REF, subject: 'alice', renewal: false, outcome: { kind: 'refused', refusal: '409 refunded' } },
    ])
  })

  test('a year is held for its host', async () => {
    await boot('ios')
    answers['/api/store/order'] = [
      json(200, { reference: REF, productId: 'domain_year', state: 'held', kind: 'tier', subject: 'pay.bakery.com', appAccountToken: REF }),
    ]
    double.control.scriptBuy(askToBuy)
    await sp.buyInStore('tier', 'pay.bakery.com', context())
    expect(await sp.storeOrderViews('tier', 'pay.bakery.com', context())).toEqual([waitingOn('pay.bakery.com')])
    expect(await sp.storeOrderViews('tier', 'shop.example', context())).toEqual([])
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([])
  })

  // The gateway keys a year by its host, so the first-year form can be handed the renewal's order.
  test('an order handed back keeps what the book holds for it', async () => {
    await boot('ios')
    const year = json(200, { reference: REF, productId: 'domain_year', state: 'held', kind: 'tier', subject: 'pay.bakery.com', appAccountToken: REF })
    answers['/api/store/order'] = [year, year]
    double.control.scriptBuy(askToBuy)
    await sp.buyInStore('tier', 'pay.bakery.com', context(), true)
    expect(await sp.buyInStore('tier', 'pay.bakery.com', context(), false)).toEqual({ kind: 'pending', reference: REF })
    expect(double.control.state.calls.buy).toHaveLength(1)
    expect(await sp.storeOrderViews('tier', 'pay.bakery.com', context())).toEqual([{ ...waitingOn('pay.bakery.com'), renewal: true }])
  })

  // The book is on the device, and a screen shows what it keeps before the store's list answers.
  test('the book alone holds every purchase the store list would decide, and never asks the list', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    answers['/api/store/confirm'] = ['network', 'network', 'network', 'network']
    double.control.scriptBuy(() => bought(applePurchase()))
    await sp.buyInStore('name', 'alice', context())
    const asked = double.control.state.calls.openPurchases
    expect(await sp.keptOrderViews('name', DOMAIN, context())).toEqual([waitingOn('alice')])
    expect(double.control.state.calls.openPurchases).toBe(asked)
    // The store no longer lists it, which only its list says.
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([])
  })

  test('a screen hears the answer the sync settles, by its reference', async () => {
    await boot('ios')
    const heard: Array<[string, string]> = []
    const off = sp.onStoreSettled((reference, result) => heard.push([reference, result.kind]))
    double.control.state.open = [applePurchase()]
    answers['/api/store/confirm'] = [deliveredFor(REF)]
    await sp.syncStorePurchases(context())
    off()
    double.control.state.open = [applePurchase({ key: 'tx-2', reference: REF_B.toUpperCase() })]
    answers['/api/store/confirm'] = [deliveredFor(REF_B)]
    await sp.syncStorePurchases(context())
    expect(heard).toEqual([[REF, 'delivered']])
  })
})

// What a screen showed when an order's answer arrived is kept beside the order (docs/store-bridge.md).
describe('what an order showed, kept for its screen', () => {
  const yearOrder = (reference = REF) =>
    json(200, { reference, productId: 'domain_year', state: 'held', kind: 'tier', subject: 'pay.bakery.com', appAccountToken: reference })
  const yearDelivered = (expiresAt: unknown) =>
    json(200, { state: 'delivered', reference: REF, kind: 'tier', host: 'pay.bakery.com', days: 365, expiresAt, frozen: false })
  const paidOnApple = (over: Partial<NativePurchase> = {}) => () => {
    double.control.state.open.push(applePurchase(over))
    return bought(applePurchase(over))
  }

  test('a refusal that needs support is kept while the store lists the purchase, and not once it is gone', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    answers['/api/store/confirm'] = [json(409, { error: 'wrong_bundle' })]
    double.control.scriptBuy(paidOnApple())
    await sp.buyInStore('name', 'alice', context())
    const support = { reference: REF, subject: 'alice', renewal: false, outcome: { kind: 'support', code: 'wrong_bundle' } }
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([support])
    await boot('ios', await disk())
    double.control.state.open = [applePurchase()]
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([support])
    // Once it is delivered from another device or refunded, the store stops listing it, and the case
    // and the note of the purchase leave the book, while what the order sells stays for a hand back.
    double.control.state.open = []
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([])
    const book = JSON.parse((await disk())[BOOK]!) as { orders: object; about: object; bought: object; outcomes: object }
    expect([book.outcomes, book.bought]).toEqual([{}, {}])
    expect(Object.keys(book.about)).toEqual([REF])
  })

  // A list that cannot be read is no list, and says nothing about the purchase being gone.
  test('a support case stays in the book while the store list cannot be read', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    answers['/api/store/confirm'] = [json(409, { error: 'wrong_bundle' })]
    double.control.scriptBuy(paidOnApple())
    await sp.buyInStore('name', 'alice', context())
    double.control.failNext('openPurchases', 'systemError')
    const support = { reference: REF, subject: 'alice', renewal: false, outcome: { kind: 'support', code: 'wrong_bundle' } }
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([support])
    double.control.state.open = [applePurchase()]
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([support])
  })

  test('a purchase that needs support comes before a wait', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder(REF_B), appleOrder()]
    answers['/api/store/confirm'] = [json(409, { error: 'wrong_bundle' })]
    double.control.scriptBuy(() => ({ status: 'pending', code: null, subCode: null, message: null, purchase: null }))
    await sp.buyInStore('name', 'alice', context())
    double.control.scriptBuy(paidOnApple())
    await sp.buyInStore('name', 'alice', context())
    expect((await sp.storeOrderViews('name', DOMAIN, context())).map(v => [v.reference, v.outcome.kind])).toEqual([
      [REF, 'support'],
      [REF_B, 'waiting'],
    ])
  })

  // Only told, a refusal and a delivered year come after the wait, and the refusal, which may still
  // mean money to get back, comes before the year.
  test('a wait comes before a refusal, and a refusal before a delivered year', async () => {
    const REF_C = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'
    await boot('ios')
    answers['/api/store/order'] = [yearOrder(REF), yearOrder(REF_B), yearOrder(REF_C)]
    answers['/api/store/confirm'] = [yearDelivered(1_900_000_000), json(409, { error: 'refused' })]
    double.control.scriptBuy(paidOnApple({ productIds: ['domain_year'] }))
    await sp.buyInStore('tier', 'pay.bakery.com', context(), true)
    double.control.scriptBuy(paidOnApple({ productIds: ['domain_year'], reference: REF_B.toUpperCase(), key: 'tx-2' }))
    await sp.buyInStore('tier', 'pay.bakery.com', context(), true)
    double.control.scriptBuy(() => ({ status: 'pending', code: null, subCode: null, message: null, purchase: null }))
    await sp.buyInStore('tier', 'pay.bakery.com', context(), true)
    expect((await sp.storeOrderViews('tier', 'pay.bakery.com', context())).map(v => [v.reference, v.outcome.kind])).toEqual([
      [REF_C, 'waiting'],
      [REF_B, 'refused'],
      [REF, 'delivered'],
    ])
  })

  test('a purchase with no reference is kept under its order by the store id', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    double.control.scriptBuy(paidOnApple({ reference: null, key: 'tx-9' }))
    expect(await sp.buyInStore('name', 'alice', context())).toMatchObject({ result: { kind: 'noReference' } })
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([
      { reference: REF, subject: 'alice', renewal: false, outcome: { kind: 'support', code: 'no_reference', key: 'tx-9' } },
    ])
  })

  test('an unknown order is kept as one that needs support', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    answers['/api/store/confirm'] = [json(409, { error: 'unknown_order' })]
    double.control.scriptBuy(paidOnApple())
    await sp.buyInStore('name', 'alice', context())
    expect((await sp.storeOrderViews('name', DOMAIN, context()))[0]?.outcome).toEqual({ kind: 'support', code: 'unknown_order' })
  })

  test('an Apple refusal is kept after the purchase is finished, until it is closed', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    answers['/api/store/confirm'] = [json(403, { error: 'environment_not_allowed' })]
    double.control.scriptBuy(paidOnApple())
    await sp.buyInStore('name', 'alice', context())
    expect(finished()).toEqual(['finish tx-1'])
    double.control.state.open = []
    await boot('ios', await disk())
    const [kept] = await sp.storeOrderViews('name', DOMAIN, context())
    expect(kept?.outcome).toEqual({ kind: 'refused', refusal: '403 environment_not_allowed' })
    await sp.dismissStoreOutcome(REF)
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([])
  })

  // Google lists a purchase refused for good until it refunds it, and the sync keeps asking about it.
  test('a Play refusal closed by the person is not written back when Google is asked again', async () => {
    await boot('android')
    answers['/api/store/order'] = [googleOrder()]
    answers['/api/store/confirm'] = [json(409, { error: 'refused' })]
    double.control.scriptBuy(() => launched)
    const outcome = sp.buyInStore('name', 'alice', context())
    await flush()
    double.control.emit(double.update([googlePurchase()], '0'))
    await outcome
    await sp.dismissStoreOutcome(REF)
    clock += 24 * 60 * 60_000
    double.control.state.open = [googlePurchase()]
    answers['/api/store/confirm'] = [json(409, { error: 'refused' })]
    await sp.syncStorePurchases(context())
    expect(confirms()).toHaveLength(2)
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([])
    // Nothing is written for an order no screen shows, so the book does not grow with it.
    expect(JSON.parse((await disk())[BOOK]!).outcomes).toEqual({})
  })

  test('a delivered year is kept with its end date, and a delivered name is not', async () => {
    await boot('ios')
    answers['/api/store/order'] = [yearOrder()]
    answers['/api/store/confirm'] = [yearDelivered(1_900_000_000)]
    double.control.scriptBuy(paidOnApple({ productIds: ['domain_year'] }))
    await sp.buyInStore('tier', 'pay.bakery.com', context(), true)
    expect(await sp.storeOrderViews('tier', 'pay.bakery.com', context())).toEqual([
      {
        reference: REF,
        subject: 'pay.bakery.com',
        renewal: true,
        outcome: { kind: 'delivered', host: 'pay.bakery.com', expiresAt: 1_900_000_000, frozen: false },
      },
    ])
    answers['/api/store/order'] = [appleOrder(REF_B)]
    answers['/api/store/confirm'] = [deliveredFor(REF_B)]
    double.control.scriptBuy(paidOnApple({ reference: REF_B.toUpperCase(), key: 'tx-2' }))
    await sp.buyInStore('name', 'alice', context())
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([])
  })

  test('a year delivered without an end date is not kept', async () => {
    await boot('ios')
    answers['/api/store/order'] = [yearOrder()]
    answers['/api/store/confirm'] = [yearDelivered(null)]
    double.control.scriptBuy(paidOnApple({ productIds: ['domain_year'] }))
    await sp.buyInStore('tier', 'pay.bakery.com', context())
    expect(await sp.storeOrderViews('tier', 'pay.bakery.com', context())).toEqual([])
  })

  test('Stop waiting leaves a paid purchase the gateway has not confirmed out of the wait', async () => {
    await boot('ios')
    answers['/api/store/order'] = [appleOrder()]
    answers['/api/store/confirm'] = [json(429, { error: 'too many requests' })]
    double.control.scriptBuy(paidOnApple())
    await sp.buyInStore('name', 'alice', context())
    expect((await sp.storeOrderViews('name', DOMAIN, context()))[0]?.outcome).toEqual({ kind: 'waiting' })
    await sp.dropStoreWait(REF)
    expect(await sp.storeOrderViews('name', DOMAIN, context())).toEqual([])
  })
})

// A name whose fate a failed read left open is kept beside the orders, so its sheet shows the check
// again after a reopen or a restart (docs/store-bridge.md).
describe('a name kept as a check', () => {
  const check = (over: Partial<StorePurchaseModule.NameCheck> = {}): StorePurchaseModule.NameCheck => ({
    domain: DOMAIN,
    name: 'alice1',
    after: 'register',
    attempt: ['c1'],
    ...over,
  })

  test('is kept per wallet and domain, after a restart too, and a later one replaces it', async () => {
    await boot('ios')
    await sp.keepNameCheck(check(), context())
    await sp.keepNameCheck(check({ name: 'ALICE1', after: 'delivered', attempt: [] }), context())
    await boot('ios', await disk())
    expect(await sp.nameChecks('UseVoltz.app', context())).toEqual([check({ name: 'ALICE1', after: 'delivered', attempt: [] })])
    expect(await sp.nameChecks('pay.bakery.com', context())).toEqual([])
    spark.connected = 'w_b'
    expect(await sp.nameChecks(DOMAIN, context())).toEqual([])
  })

  test('ends for its domain only, and an end with nothing to end writes nothing', async () => {
    await boot('ios')
    await sp.endNameChecks(DOMAIN, context())
    expect(await disk()).toEqual({})
    await sp.keepNameCheck(check(), context())
    await sp.keepNameCheck(check({ domain: 'pay.bakery.com', name: 'bob123' }), context())
    await sp.endNameChecks(DOMAIN, context())
    expect(await sp.nameChecks(DOMAIN, context())).toEqual([])
    expect(await sp.nameChecks('pay.bakery.com', context())).toEqual([check({ domain: 'pay.bakery.com', name: 'bob123' })])
  })

  // A record without a domain, which no build writes, does not stop the others of the domain ending.
  test('ends beside a record this build cannot read', async () => {
    const book = {
      checks: {
        a: { wallet: 'w_a', name: 'alice1', after: 'register', attempt: [] },
        b: { wallet: 'w_a', domain: DOMAIN, name: 'bob123', after: 'pending', attempt: [] },
      },
    }
    await boot('ios', { [BOOK]: JSON.stringify(book) })
    await sp.endNameChecks(DOMAIN, context())
    expect(Object.keys((JSON.parse((await disk())[BOOK]!) as { checks: object }).checks)).toEqual(['a'])
  })

  test('a record this build cannot read is left out', async () => {
    const book = {
      checks: {
        a: { wallet: 'w_a', domain: DOMAIN, name: 'alice1', after: 'register', attempt: 'x' },
        b: { wallet: 'w_a', domain: DOMAIN, name: 'bob123', after: 'later', attempt: [] },
        c: { wallet: 'w_a', domain: DOMAIN, name: 7, after: 'register', attempt: [] },
        d: { wallet: 'w_a', domain: DOMAIN, name: 'carol1', after: 'pending', attempt: [] },
      },
    }
    await boot('ios', { [BOOK]: JSON.stringify(book) })
    expect(await sp.nameChecks(DOMAIN, context())).toEqual([check({ name: 'carol1', after: 'pending', attempt: [] })])
  })
})

// The gateway's verdict is what the screens hear. A book the platform refuses to read once the
// gateway answered loses only the note of that answer, and Apple's purchase is already finished on it,
// so a retry in its place would leave a delivered purchase waiting on a confirmation nothing lists.
test('a verdict whose note the book cannot take still reaches the screens', async () => {
  await boot('ios')
  const RNFS = require('react-native-fs').default
  answers['/api/store/order'] = [appleOrder()]
  answers['/api/store/confirm'] = [deliveredFor(REF)]
  const read = RNFS.readFile.bind(RNFS)
  let refusing = false
  jest.spyOn(RNFS, 'readFile').mockImplementation(async (...args: unknown[]) => {
    if (refusing && args[0] === BOOK) {
      throw new Error('EACCES: permission denied')
    }
    return read(...args)
  })
  double.control.scriptBuy(() => {
    refusing = true
    return bought(applePurchase())
  })
  const heard: string[] = []
  const off = sp.onStoreSettled((_reference, result) => heard.push(result.kind))
  try {
    expect(await sp.buyInStore('name', 'alice', context())).toMatchObject({
      kind: 'settled',
      reference: REF,
      result: { kind: 'delivered' },
    })
  } finally {
    off()
    jest.mocked(RNFS.readFile).mockRestore()
  }
  expect(heard).toEqual(['delivered'])
  expect(finished()).toEqual(['finish tx-1'])
})

// Every other verdict the gateway gives is noted the same way, so a book refused once the gateway
// answered loses the note and never turns the answer into a retry. The unknown order that finishes is
// not reachable while STORE_NOTICE_DELIVERY is false.
test.each<[string, 'ios' | 'android', { status: number; text: string }, Record<string, unknown>, string[]]>([
  ['an unknown order', 'ios', json(409, { error: 'unknown_order' }), { kind: 'unknownOrder' }, []],
  ['a final refusal on Apple', 'ios', json(409, { error: 'refunded' }), { kind: 'refused', status: 409, code: 'refunded' }, ['finish tx-1']],
  ['a refusal that needs support', 'ios', json(409, { error: 'wrong_bundle' }), { kind: 'support', code: 'wrong_bundle' }, []],
  ['a final refusal on Google', 'android', json(409, { error: 'refunded' }), { kind: 'refused', status: 409, code: 'refunded' }, []],
])('%s whose note the book cannot take still reaches the screens', async (_label, os, answer, verdict, finishes) => {
  // The book is on disk, as the opener note leaves it, so the note after the answer has a file to read.
  await boot(os, { [BOOK]: JSON.stringify({ orders: { [REF]: 'w_a' }, waits: {}, unknown: {} }) })
  const RNFS = require('react-native-fs').default
  answers['/api/store/confirm'] = [answer]
  double.control.state.open = [os === 'ios' ? applePurchase() : googlePurchase()]
  const read = RNFS.readFile.bind(RNFS)
  let refusing = false
  jest.spyOn(RNFS, 'readFile').mockImplementation(async (...args: unknown[]) => {
    if (refusing && args[0] === BOOK) {
      throw new Error('EACCES: permission denied')
    }
    return read(...args)
  })
  const ctx = context()
  const gateway = ctx.gateway
  ctx.gateway = async () => {
    const deps = await gateway()
    return {
      ...deps,
      request: (async (...args: Parameters<typeof fetch>) => {
        const response = await deps.request!(...args)
        refusing = true
        return response
      }) as typeof fetch,
    }
  }
  const heard: string[] = []
  const off = sp.onStoreSettled((_reference, result) => heard.push(result.kind))
  try {
    expect(await sp.syncStorePurchases(ctx)).toEqual([verdict])
  } finally {
    off()
    jest.mocked(RNFS.readFile).mockRestore()
  }
  expect(heard).toEqual([verdict.kind])
  expect(finished()).toEqual(finishes)
})

// A book a later build wrote reads field by field, and one this build cannot read at all is set aside
// by the opener note, so neither keeps a press on "try again".
test.each([
  ['fields of another shape', JSON.stringify({ version: 2, orders: [REF], bought: 'purchased', about: null })],
  ['a top level that is not a map', JSON.stringify([{ orders: {} }])],
])('a book with %s does not hold the press on a retry', async (_label, book) => {
  await boot('ios', { [BOOK]: book })
  answers['/api/store/order'] = [appleOrder()]
  answers['/api/store/confirm'] = [deliveredFor(REF)]
  double.control.scriptBuy(() => bought(applePurchase()))
  expect(await sp.buyInStore('name', 'alice', context())).toMatchObject({
    kind: 'settled',
    reference: REF,
    result: { kind: 'delivered' },
  })
  expect(double.control.state.calls.buy).toHaveLength(1)
})
