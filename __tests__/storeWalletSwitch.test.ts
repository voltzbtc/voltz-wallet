import type * as StorePurchaseModule from '../src/wallet/storePurchase'
import type { StorePurchase } from '../src/wallet/store'

type Double = typeof import('../specs/__mocks__/NativeVoltzStore')

// The store flow checks which wallet the book names, then builds what signs. A reconnect in between
// makes the identity another wallet's, and the step stops before any request, as without a connection,
// with the book left as it was.

const mockSpark: { connected: string | null } = { connected: null }
jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: () => mockSpark.connected,
  onSparkConnected: () => () => undefined,
}))

const DOMAIN = 'usevoltz.app'
const REF = 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f'
const BOOK = '/mock/Documents/store-orders.json'

let sp: typeof StorePurchaseModule
let double: Double
let requests: string[]
let warn: jest.SpyInstance
const originalOs = require('react-native').Platform.OS

// What signs is built for the wallet connected when it is read, and `during` runs while it is built,
// which is where a reconnect lands.
function context(during: () => void = () => undefined): StorePurchaseModule.StoreContext {
  return {
    walletId: () => mockSpark.connected,
    wallets: async () => ['w_a', 'w_b'],
    gateway: async () => {
      during()
      return {
        gatewayUrl: `https://${DOMAIN}`,
        domain: DOMAIN,
        pubkey: `02${mockSpark.connected === 'w_a' ? 'a' : 'b'}`,
        sign: async () => 'sig',
        sleep: async () => undefined,
        request: (async (url: string) => {
          requests.push(new URL(url).pathname)
          return { status: 409, ok: false, text: async () => JSON.stringify({ error: 'unknown_order' }) } as unknown as Response
        }) as unknown as typeof fetch,
      }
    },
  }
}

const reconnect = () => {
  mockSpark.connected = 'w_b'
}

const paid: StorePurchase = {
  store: 'google',
  productId: 'name_standard',
  state: 'purchased',
  reference: REF,
  key: 'token-1',
  purchasedAt: 0,
  verified: true,
  revoked: false,
}

async function bookOnDisk(): Promise<string | null> {
  const RNFS = require('react-native-fs').default
  return (await RNFS.exists(BOOK)) ? RNFS.readFile(BOOK, 'utf8') : null
}

beforeEach(async () => {
  jest.resetModules()
  Object.defineProperty(require('react-native').Platform, 'OS', { value: 'android', configurable: true })
  const RNFS = require('react-native-fs').default
  if (await RNFS.exists(BOOK)) {
    await RNFS.unlink(BOOK)
  }
  double = jest.requireMock('../specs/NativeVoltzStore')
  double.control.reset()
  sp = require('../src/wallet/storePurchase')
  mockSpark.connected = 'w_a'
  requests = []
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warn.mockRestore()
  Object.defineProperty(require('react-native').Platform, 'OS', { value: originalOs, configurable: true })
})

describe('a purchase settled across a reconnect', () => {
  const opened = JSON.stringify({ orders: { [REF]: 'w_a' }, bought: { [REF]: 'purchased' } })

  beforeEach(async () => {
    const RNFS = require('react-native-fs').default
    await RNFS.writeFile(BOOK, opened, 'utf8')
  })

  test('stops before the confirmation and leaves the book as it was', async () => {
    const before = await bookOnDisk()
    expect(await sp.settleStorePurchase(paid, context(reconnect))).toEqual({ kind: 'retry' })
    expect(requests).toEqual([])
    expect(await bookOnDisk()).toBe(before)
  })

  test('without a reconnect the confirmation goes out as today', async () => {
    expect(await sp.settleStorePurchase(paid, context())).toEqual({ kind: 'unknownOrder' })
    expect(requests).toEqual(['/api/store/confirm'])
  })
})

describe('a purchase pressed across a reconnect', () => {
  test('stops before the order and writes nothing to the book', async () => {
    expect(await sp.buyInStore('name', 'alice', context(reconnect))).toEqual({ kind: 'orderRetry' })
    expect(requests).toEqual([])
    expect(await bookOnDisk()).toBeNull()
  })

  test('without a reconnect the order goes out as today', async () => {
    expect(await sp.buyInStore('name', 'alice', context())).toEqual({ kind: 'orderRefused', status: 409, code: 'unknown_order' })
    expect(requests).toEqual(['/api/store/order'])
  })
})
