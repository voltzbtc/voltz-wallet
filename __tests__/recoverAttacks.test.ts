import RNFS from 'react-native-fs'
import { recoverPurchases, type RecoverDeps } from '../src/wallet/recover'
import { scopeOn } from '../src/wallet/releasedLines'
import { savePending } from '../src/wallet/purchase'
import { sparkGetLnAddress, sparkRegisterLnAddress } from '../src/wallet/spark'

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app', getDistribution: () => 'direct' }))
jest.mock('../src/wallet/spark', () => ({
  sparkGetLnAddress: jest.fn(async () => null),
  sparkRegisterLnAddress: jest.fn(async (username: string) => ({
    username,
    address: `${username}@usevoltz.app`,
    lnurl: 'lnurl1',
  })),
  sparkTakeLnAddress: jest.fn((username: string, walletId?: string) =>
    (require('./support/takeLnAddress') as typeof import('./support/takeLnAddress')).takeLnAddress(username, walletId),
  ),
  sparkConnectedWalletId: jest.fn(() => 'w_a'),
}))
jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn(async () => 'w_a') }))

const BUILD = 'usevoltz.app'
const SOLD_ON = 'bakery.com.br'
const PUBKEY = `02${'a'.repeat(64)}`
const NOW_MS = 1_700_000_000_000
const ASKED = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`

const NAME_CHARGE = {
  reference: 'ref-name',
  kind: 'name' as const,
  domain: SOLD_ON,
  subject: 'bakery',
  amountSats: 12821,
}

type Reply = { status: number; body: unknown }
const ok = (body: unknown): Reply => ({ status: 200, body })
function response({ status, body }: Reply): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

function harness(
  replies: { pending?: Reply | (() => Reply) | (() => never); name?: Reply },
  over: Partial<RecoverDeps> = {},
) {
  const calls: string[] = []
  const deps: RecoverDeps = {
    walletId: 'w_a',
    lines: scopeOn('w_a'),
    pubkey: PUBKEY,
    sign: async () => 'deadbeef',
    now: () => NOW_MS,
    request: (async (url: string) => {
      calls.push(url)
      if (url.includes('/api/charges/pending')) {
        const p = replies.pending ?? ok({ charges: [] })
        return response(typeof p === 'function' ? (p() as Reply) : p)
      }
      if (url.includes('/api/quote/confirm')) {
        return response(replies.name ?? ok({ paid: true, entitled: true }))
      }
      throw new Error(`unrouted ${url}`)
    }) as unknown as typeof fetch,
    ...over,
  }
  return { deps, calls }
}

async function asked(): Promise<Record<string, { at: number; open: boolean }>> {
  return (await RNFS.exists(ASKED)) ? JSON.parse(await RNFS.readFile(ASKED, 'utf8')) : {}
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(sparkGetLnAddress).mockResolvedValue(null)
  jest.mocked(sparkRegisterLnAddress).mockImplementation(async (username: string) => ({
    username,
    address: `${username}@${BUILD}`,
    lnurl: 'lnurl1',
  }))
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

// Every way the truth can be unknown must leave the question OPEN, never recorded as answered,
// because a closed question is a day of silence over money that left.
describe('ATTACK: producing the silence', () => {
  const unknowable: [string, Partial<Parameters<typeof harness>[0]>, Partial<RecoverDeps>][] = [
    ['503 treasury_unavailable', { pending: { status: 503, body: { error: 'treasury_unavailable' } } }, {}],
    ['charges field absent, not empty', { pending: ok({}) }, {}],
    ['charges is null', { pending: ok({ charges: null }) }, {}],
    ['charges is an object', { pending: ok({ charges: { 0: NAME_CHARGE } }) }, {}],
    ['200 with a body that is not JSON', { pending: () => { throw new Error('x') } }, {}],
  ]
  for (const [what, replies, over] of unknowable) {
    test(`${what} leaves the question open`, async () => {
      const { deps } = harness(replies as never, over)
      await expect(recoverPurchases(deps)).resolves.toBeNull()
      expect((await asked()).w_a).toEqual({ at: NOW_MS / 1000, open: true })
    })
  }

  test('200 whose body is not JSON at all leaves the question open', async () => {
    const deps: RecoverDeps = {
      walletId: 'w_a',
      lines: scopeOn('w_a'),
      pubkey: PUBKEY,
      sign: async () => 'deadbeef',
      now: () => NOW_MS,
      request: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON')
          },
        }) as unknown as Response) as unknown as typeof fetch,
    }
    await expect(recoverPurchases(deps)).resolves.toBeNull()
    expect((await asked()).w_a).toEqual({ at: NOW_MS / 1000, open: true })
  })

  test('a network that never answers leaves the question open', async () => {
    const deps: RecoverDeps = {
      walletId: 'w_a',
      lines: scopeOn('w_a'),
      pubkey: PUBKEY,
      sign: async () => 'deadbeef',
      now: () => NOW_MS,
      request: (async () => {
        throw new TypeError('Network request failed')
      }) as unknown as typeof fetch,
    }
    await expect(recoverPurchases(deps)).resolves.toBeNull()
    expect((await asked()).w_a).toEqual({ at: NOW_MS / 1000, open: true })
  })

  test('a signature that cannot be made leaves the question open', async () => {
    const { deps } = harness({}, {
      sign: async () => {
        throw new Error('keychain locked')
      },
    })
    await expect(recoverPurchases(deps)).resolves.toBeNull()
    expect((await asked()).w_a).toEqual({ at: NOW_MS / 1000, open: true })
  })

  test('an open question is re-asked on the next focus past the floor, not tomorrow', async () => {
    const { deps: down } = harness({ pending: { status: 503, body: {} } })
    await recoverPurchases(down)
    const { deps, calls } = harness({ pending: ok({ charges: [NAME_CHARGE] }) }, {
      now: () => NOW_MS + 301_000,
    })
    const found = await recoverPurchases(deps)
    expect(calls.some(c => c.includes('/charges/pending'))).toBe(true)
    expect(found?.status).toBe('ready')
  })

  test('an ask inside the open floor does not spend a request', async () => {
    const { deps: down } = harness({ pending: { status: 503, body: {} } })
    await recoverPurchases(down)
    const { deps, calls } = harness({ pending: ok({ charges: [NAME_CHARGE] }) }, {
      now: () => NOW_MS + 299_000,
    })
    expect(await recoverPurchases(deps)).toBeNull()
    expect(calls).toEqual([])
  })
})

// A well-formed charge for a product this build does not know must not bury the ones it does.
// Silence over a recoverable name is the defect the design exists to prevent.
describe('ATTACK: a charge whose kind this build does not know', () => {
  const FUTURE = { reference: 'ref-x', kind: 'renewal', domain: SOLD_ON, subject: 'x', amountSats: 10 }

  test('does not bury a recoverable name sitting beside it', async () => {
    const { deps } = harness({ pending: ok({ charges: [FUTURE, NAME_CHARGE] }) })
    const found = await recoverPurchases(deps)
    expect(found?.subject).toBe(`bakery@${SOLD_ON}`)
    expect(found?.status).toBe('ready')
  })

  test('and the row it could not read keeps the question open', async () => {
    const { deps } = harness({ pending: ok({ charges: [FUTURE, NAME_CHARGE] }) })
    await recoverPurchases(deps)
    expect((await asked()).w_a.open).toBe(true)
  })
})

// The opposite failure is inventing a payment. Nobody may be told they have an unfinished payment
// on the strength of the list alone.
describe('ATTACK: inventing a payment', () => {
  test('a charge the confirm refuses as unpaid is never called granted', async () => {
    const { deps } = harness({
      pending: ok({ charges: [NAME_CHARGE] }),
      name: { status: 402, body: { paid: false } },
    })
    const found = await recoverPurchases(deps)
    expect(found?.status).not.toBe('ready')
    expect(jest.mocked(sparkRegisterLnAddress)).not.toHaveBeenCalled()
  })

  test('nothing is registered before the confirm has answered', async () => {
    const order: string[] = []
    jest.mocked(sparkRegisterLnAddress).mockImplementation(async (u: string) => {
      order.push('register')
      return { username: u, address: `${u}@${BUILD}`, lnurl: 'l' }
    })
    const deps: RecoverDeps = {
      walletId: 'w_a',
      lines: scopeOn('w_a'),
      pubkey: PUBKEY,
      sign: async () => 'deadbeef',
      now: () => NOW_MS,
      request: (async (url: string) => {
        if (url.includes('/charges/pending')) return response(ok({ charges: [NAME_CHARGE] }))
        order.push('confirm')
        return response(ok({ paid: true, entitled: true }))
      }) as unknown as typeof fetch,
    }
    await recoverPurchases(deps)
    expect(order).toEqual(['confirm', 'register'])
  })
})

// The attacks that fit none of the groups above.
describe('ATTACK: the rest', () => {
  test('a name this wallet already holds is reported ready without a second register', async () => {
    jest.mocked(sparkGetLnAddress).mockResolvedValue({
      username: 'Bakery',
      address: `bakery@${SOLD_ON}`,
      lnurl: 'l',
    } as never)
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    const found = await recoverPurchases(deps)
    expect(found?.status).toBe('ready')
    expect(jest.mocked(sparkRegisterLnAddress)).not.toHaveBeenCalled()
  })

  test('a purchase already in flight on this device keeps its own slot', async () => {
    await savePending({ kind: 'name', subject: 'other', reference: 'ref-inflight', amountSats: 5 })
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    const found = await recoverPurchases(deps)
    expect(found?.status).toBe('ready')
    const { loadPending } = jest.requireActual('../src/wallet/purchase')
    expect((await loadPending('name'))?.reference).toBe('ref-inflight')
  })

  test('a name that cannot be put on the wallet still keeps the proof of payment', async () => {
    jest.mocked(sparkRegisterLnAddress).mockRejectedValue(new Error('taken'))
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    const found = await recoverPurchases(deps)
    expect(found?.status).toBe('blocked')
    const { loadPending } = jest.requireActual('../src/wallet/purchase')
    expect((await loadPending('name'))?.reference).toBe('ref-name')
  })
})

// A purchase made before the address the customer is currently reachable at must not replace it.
//
// The sweep runs unattended on Home focus. A wallet restored from its seed already answers on
// whatever address it held, because the LNURL server keys registrations on (domain, pubkey), and an
// older paid-but-unconfirmed charge for a different name is exactly what this file goes looking for.
describe('ATTACK: a wallet that already answers on another address', () => {
  test('does not have that address swapped out from under it', async () => {
    jest.mocked(sparkGetLnAddress).mockResolvedValue({
      username: 'othername',
      address: `othername@${BUILD}`,
      lnurl: 'l',
    } as never)
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    await recoverPurchases(deps)
    expect(jest.mocked(sparkRegisterLnAddress)).not.toHaveBeenCalled()
  })

  test('is told the name is waiting, never that an address it does not answer on is ready', async () => {
    jest.mocked(sparkGetLnAddress).mockResolvedValue({
      username: 'othername',
      address: `othername@${BUILD}`,
      lnurl: 'l',
    } as never)
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    expect((await recoverPurchases(deps))?.status).toBe('waiting')
  })

  test('keeps the proof, so the address screen can finish it for free', async () => {
    jest.mocked(sparkGetLnAddress).mockResolvedValue({
      username: 'othername',
      address: `othername@${BUILD}`,
      lnurl: 'l',
    } as never)
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    await recoverPurchases(deps)
    const { loadPending } = jest.requireActual('../src/wallet/purchase')
    expect((await loadPending('name'))?.reference).toBe('ref-name')
  })

  // An address that could not be read is not an address that is absent, and the difference is
  // somebody's live address.
  test('an address that cannot be read is never registered over', async () => {
    jest.mocked(sparkGetLnAddress).mockRejectedValue(new Error('offline'))
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    expect((await recoverPurchases(deps))?.status).toBe('waiting')
    expect(jest.mocked(sparkRegisterLnAddress)).not.toHaveBeenCalled()
  })

  // The entitlement is what puts the money beyond risk, and it must still be taken.
  test('the payment is still confirmed, so the money is not left at risk', async () => {
    jest.mocked(sparkGetLnAddress).mockResolvedValue({
      username: 'othername',
      address: `othername@${BUILD}`,
      lnurl: 'l',
    } as never)
    const { deps, calls } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    await recoverPurchases(deps)
    // Confirmed at the build domain, naming the domain it was sold on in the body.
    expect(calls).toContain(`https://${BUILD}/api/quote/confirm`)
  })
})
