import RNFS from 'react-native-fs'
import { recoverPurchases, type RecoverDeps } from '../src/wallet/recover'
import { scopeOn } from '../src/wallet/releasedLines'
import { getDistribution } from '../src/config'
import { STORE_CREDITS_VERSION } from '../src/wallet/storePurchase'
import { SparkReconnectBusy, sparkRefreshTakenBackAddress } from '../src/wallet/spark'

// The sweep in a build that sells through the store, which also asks the gateway for credits bought
// there and never spent: neither store shows a reinstalled app a consumable it already finished.

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app', getDistribution: jest.fn(() => 'store') }))

jest.mock('../src/wallet/spark', () => ({
  sparkGetLnAddress: jest.fn(async () => null),
  sparkRegisterLnAddress: jest.fn(async (username: string) => ({ username, address: `${username}@usevoltz.app`, lnurl: 'lnurl1' })),
  sparkTakeLnAddress: jest.fn((username: string, walletId?: string) =>
    (require('./support/takeLnAddress') as typeof import('./support/takeLnAddress')).takeLnAddress(username, walletId),
  ),
  sparkConnectedWalletId: jest.fn(() => 'w_a'),
  sparkRefreshTakenBackAddress: jest.fn(async () => false),
  SparkReconnectBusy: class extends Error {},
}))

jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn(async () => 'w_a') }))

const PUBKEY = `02${'a'.repeat(64)}`
const NOW_MS = 1_700_000_000_000
const ASKED = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`

type Reply = { status: number; body: unknown }
type Call = { url: string; body: Record<string, unknown> }

// The gateway's id shape, the SHA-256 of a payment reference in hex.
const credit = (over: Record<string, unknown> = {}) => ({
  id: 'c1d2'.repeat(16),
  domain: 'usevoltz.app',
  tier: 'standard',
  state: 'available',
  name: null,
  grantedAt: 1_699_000_000,
  ...over,
})

function harness(replies: { pending?: Reply; credits?: Reply }): { deps: RecoverDeps; calls: Call[]; signed: string[] } {
  const calls: Call[] = []
  const signed: string[] = []
  const answer = ({ status, body }: Reply) =>
    ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response
  const deps: RecoverDeps = {
    walletId: 'w_a',
    lines: scopeOn('w_a'),
    pubkey: PUBKEY,
    sign: async message => {
      signed.push(message)
      return 'deadbeef'
    },
    now: () => NOW_MS,
    sleep: async () => undefined,
    request: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      if (url.endsWith('/api/charges/pending')) {
        return answer(replies.pending ?? { status: 200, body: { charges: [] } })
      }
      if (url.endsWith('/api/store/credits')) {
        return answer(replies.credits ?? { status: 200, body: { credits: [] } })
      }
      if (url.endsWith('/api/quote/confirm')) {
        return answer({ status: 200, body: { paid: true, entitled: true } })
      }
      throw new Error(`unrouted ${url}`)
    }) as unknown as typeof fetch,
  }
  return { deps, calls, signed }
}

async function asked(): Promise<Record<string, { at: number; open: boolean }>> {
  return (await RNFS.exists(ASKED)) ? JSON.parse(await RNFS.readFile(ASKED, 'utf8')) : {}
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(getDistribution).mockReturnValue('store')
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

test('an unspent credit is found with the key that bought it, at the build domain', async () => {
  const h = harness({ credits: { status: 200, body: { credits: [credit({ domain: 'bakery.com.br' })] } } })
  expect(await recoverPurchases(h.deps)).toEqual({
    status: 'credit',
    kind: 'name',
    subject: 'bakery.com.br',
    reference: '',
    pubkey: PUBKEY,
  })
  const ask = h.calls.find(c => c.url.endsWith('/api/store/credits'))!
  expect(ask.url).toBe('https://usevoltz.app/api/store/credits')
  expect(h.signed).toContain([STORE_CREDITS_VERSION, 'credits', PUBKEY, String(NOW_MS / 1000)].join('\n'))
})

test('a credit already spent, reserved, annulled or held by a withdrawal is nothing to pick up', async () => {
  const h = harness({
    credits: {
      status: 200,
      body: {
        credits: [
          credit({ state: 'spent', name: 'alice1' }),
          credit({ state: 'reserved', name: 'bob123' }),
          credit({ state: 'annulled' }),
          // Spent on nothing while a withdrawal of its purchase is open.
          credit({ id: 'e5f6'.repeat(16), held: 'withdrawal' }),
        ],
      },
    },
  })
  expect(await recoverPurchases(h.deps)).toBeNull()
  expect((await asked()).w_a?.open).toBe(false)
})

// A refund annuls the credit and the name it bought is frozen, while the SDK's cache can still show
// that name; the list names no name for an annulled credit, so its id and domain are what is passed on.
test('each annulled credit is handed to the address refresh by its id and domain, for the wallet swept', async () => {
  const h = harness({
    credits: {
      status: 200,
      body: {
        credits: [
          credit({ state: 'spent', name: 'alice1' }),
          credit({ state: 'annulled', id: 'a1'.repeat(32) }),
          credit({ state: 'annulled', id: 'b2'.repeat(32), domain: 'bakery.com.br' }),
          credit({ state: 'annulled', id: 'c3'.repeat(32) }),
        ],
      },
    },
  })
  expect(await recoverPurchases(h.deps)).toBeNull()
  expect(sparkRefreshTakenBackAddress).toHaveBeenCalledTimes(1)
  expect(sparkRefreshTakenBackAddress).toHaveBeenCalledWith('w_a', [
    { id: 'a1'.repeat(32), domain: 'usevoltz.app' },
    { id: 'b2'.repeat(32), domain: 'bakery.com.br' },
    { id: 'c3'.repeat(32), domain: 'usevoltz.app' },
  ])
})

test('no annulled credit refreshes nothing', async () => {
  const h = harness({ credits: { status: 200, body: { credits: [credit(), credit({ state: 'spent', name: 'alice1' })] } } })
  await recoverPurchases(h.deps)
  expect(sparkRefreshTakenBackAddress).not.toHaveBeenCalled()
})

test('a refresh that fails is logged, and the sweep answers as it would without it', async () => {
  jest.mocked(sparkRefreshTakenBackAddress).mockRejectedValueOnce(new Error('connect failed'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const h = harness({ credits: { status: 200, body: { credits: [credit({ state: 'annulled' }), credit()] } } })
  expect(await recoverPurchases(h.deps)).toMatchObject({ status: 'credit' })
  expect(warn).toHaveBeenCalledWith('address not refreshed after a refund: connect failed')
  expect((await asked()).w_a?.open).toBe(false)
  warn.mockRestore()
})

// Skipped for a send or an address change in flight, the refresh leaves the dead name in the SDK's
// cache, and a focus keeps the live connection, so only a sweep retries it: the next one minutes away
// rather than a day, until it runs.
test('a refresh skipped for something in flight keeps the question open until it runs', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  jest.mocked(sparkRefreshTakenBackAddress).mockRejectedValueOnce(new SparkReconnectBusy())
  let now = NOW_MS
  const h = harness({ credits: { status: 200, body: { credits: [credit({ state: 'annulled' })] } } })
  const deps = { ...h.deps, now: () => now }

  expect(await recoverPurchases(deps)).toBeNull()
  expect((await asked()).w_a).toEqual({ at: NOW_MS / 1000, open: true })
  expect(warn).not.toHaveBeenCalled()

  now += 300_000
  await recoverPurchases(deps)
  expect(sparkRefreshTakenBackAddress).toHaveBeenCalledTimes(2)
  expect((await asked()).w_a?.open).toBe(false)

  // Run, the refresh owes nothing, and the sweep waits its settled day again.
  now += 300_000
  await recoverPurchases(deps)
  expect(sparkRefreshTakenBackAddress).toHaveBeenCalledTimes(2)
  warn.mockRestore()
})

test('a list that cannot be read keeps the question open', async () => {
  const h = harness({ credits: { status: 500, body: { error: 'boom' } } })
  expect(await recoverPurchases(h.deps)).toBeNull()
  expect((await asked()).w_a?.open).toBe(true)
})

// The sats sweep is the same as before, and a credit only joins what it found.
test('a name paid in sats is still put on the wallet beside the credit', async () => {
  const h = harness({
    pending: {
      status: 200,
      body: { charges: [{ reference: 'ref-name', kind: 'name', domain: 'usevoltz.app', subject: 'bakery', amountSats: 12821 }] },
    },
    credits: { status: 200, body: { credits: [credit()] } },
  })
  const found = await recoverPurchases(h.deps)
  expect(h.calls.map(c => new URL(c.url).pathname)).toEqual(['/api/charges/pending', '/api/quote/confirm', '/api/store/credits'])
  // A credit needs the buyer to choose a name, which outranks good news that needs nothing.
  expect(found?.status).toBe('credit')
})

test('a direct build never asks for credits', async () => {
  jest.mocked(getDistribution).mockReturnValue('direct')
  const h = harness({ credits: { status: 200, body: { credits: [credit()] } } })
  expect(await recoverPurchases(h.deps)).toBeNull()
  expect(h.calls.some(c => c.url.endsWith('/api/store/credits'))).toBe(false)
})
