import { liveStoreContext, openStoreOrder, recordSpendIntent, confirmStorePurchase } from '../src/wallet/storePurchase'
import { walletPurchases } from '../src/wallet/withdrawal'
import { connectedLnurlDomain } from '../src/wallet/spark'

// A wallet on a domain of its own keeps addressing every store, credits and withdrawal request to the
// build's domain, with the domain the request is about in the signed body. The customer's hostname is
// the customer's to keep, and whoever answers it after a lapse or a DNS change would receive the
// wallet's signed statements and could answer a store confirm with a delivery that never happened. A
// frozen domain is off the edge, so a renewal sent to it reached nobody and could never land.

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app', getDistribution: () => 'store' }))
jest.mock('../src/wallet/spark', () => ({
  connectedLnurlDomain: jest.fn(),
  sparkGetIdentityPubkey: async () => `02${'a'.repeat(64)}`,
  sparkSignMessage: async () => 'sig',
  sparkConnectedWalletId: () => 'w1',
  onSparkConnected: () => () => undefined,
}))

const OWN = 'pay.bakery.com.br'
type Call = { url: string; body: Record<string, unknown> }

async function deps(answer: Record<string, unknown>) {
  const calls: Call[] = []
  const gateway = await liveStoreContext().gateway()
  return {
    calls,
    deps: {
      ...gateway,
      sleep: async () => undefined,
      request: (async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) })
        return { status: 200, ok: true, text: async () => JSON.stringify(answer), json: async () => answer } as unknown as Response
      }) as unknown as typeof fetch,
    },
  }
}

beforeEach(() => {
  jest.mocked(connectedLnurlDomain).mockReturnValue(OWN)
})

test('a renewal of a frozen own domain is ordered at the build domain, with the host signed in the body', async () => {
  const { deps: d, calls } = await deps({ reference: 'r', productId: 'domain_year', state: 'held', kind: 'tier', subject: OWN })
  await openStoreOrder(d, 'apple', 'tier', OWN)
  expect(calls.map(c => c.url)).toEqual(['https://usevoltz.app/api/store/order'])
  expect(calls[0]!.body).toMatchObject({ host: OWN, kind: 'tier', subject: OWN })
})

test('the store confirm and a spend go to the build domain and name the domain in the body', async () => {
  const { deps: d, calls } = await deps({ state: 'delivered', reference: 'r' })
  await confirmStorePurchase(d, { store: 'apple', reference: 'r', key: '2000000000000001' } as never)
  await recordSpendIntent(d, 'padaria')
  expect(calls.map(c => c.url)).toEqual(['https://usevoltz.app/api/store/confirm', 'https://usevoltz.app/api/store/spend'])
  expect(calls.map(c => c.body.host)).toEqual([OWN, OWN])
})

// Their statements name no host, so they never go anywhere but the build domain.
test('the credits read and the purchases read go to the build domain', async () => {
  const { deps: d, calls } = await deps({ credits: [], purchases: [] })
  await walletPurchases(d)
  expect(calls.map(c => c.url)).toEqual(['https://usevoltz.app/api/store/credits'])
})
