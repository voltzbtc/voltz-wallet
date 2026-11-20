import RNFS from 'react-native-fs'
import {
  helpMailUrl,
  paymentEvidence,
  pendingChargesMessage,
  putBackCard,
  recoverPurchases,
  type RecoverDeps,
} from '../src/wallet/recover'
import { loadPending, recordRefusal, savePending } from '../src/wallet/purchase'
import { loadPendingPurchase, recordPurchaseRefusal, savePendingPurchase } from '../src/wallet/domainOnboard'
import {
  activeScope,
  claimLine,
  forgetWalletLines,
  listLines,
  noteLine,
  scopeOn,
  takeLine,
  type ReleasedLine,
} from '../src/wallet/releasedLines'
import { sparkConnectedWalletId, sparkGetLnAddress, sparkRegisterLnAddress } from '../src/wallet/spark'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { StoreError, openPurchases, storeAvailable, type StorePurchase } from '../src/wallet/store'

// The domain the build ships with. Everything here turns on the difference between it and the domain
// a charge was actually raised on.
jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app', getDistribution: () => 'direct' }))

jest.mock('../src/wallet/spark', () => ({
  connectedLnurlDomain: jest.fn(() => undefined),
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

// A build with no store bridge unless a case says otherwise.
jest.mock('../src/wallet/store', () => ({
  ...jest.requireActual('../src/wallet/store'),
  storeAvailable: jest.fn(() => false),
  openPurchases: jest.fn(async () => []),
}))

const BUILD = 'usevoltz.app'
const SOLD_ON = 'bakery.com.br'
const PUBKEY = `02${'a'.repeat(64)}`
const NOW_MS = 1_700_000_000_000
const NOW = 1_700_000_000
const ASKED = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`

const NAME_CHARGE = {
  reference: 'ref-name',
  kind: 'name' as const,
  domain: SOLD_ON,
  subject: 'bakery',
  amountSats: 12821,
}
const TIER_CHARGE = {
  reference: 'ref-tier',
  kind: 'tier' as const,
  domain: SOLD_ON,
  subject: SOLD_ON,
  amountSats: 99000,
}

type Reply = { status: number; body: unknown }

const ok = (body: unknown): Reply => ({ status: 200, body })

function response({ status, body }: Reply): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

type Call = { url: string; body: Record<string, unknown> }

// One double for every request the sweep makes, routed by path, because the confirmation rides the
// same injected fetch and which host each one is addressed at is the thing under test.
function harness(
  replies: { pending?: Reply | (() => Reply); name?: Reply; tier?: Reply },
  over: Partial<RecoverDeps> = {},
): { deps: RecoverDeps; calls: Call[]; signed: string[] } {
  const calls: Call[] = []
  const signed: string[] = []
  const deps: RecoverDeps = {
    walletId: 'w_a',
    lines: scopeOn('w_a'),
    pubkey: PUBKEY,
    sign: async message => {
      signed.push(message)
      return 'deadbeef'
    },
    now: () => NOW_MS,
    request: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      if (url.includes('/api/charges/pending')) {
        const pending = replies.pending ?? ok({ charges: [] })
        return response(typeof pending === 'function' ? pending() : pending)
      }
      if (url.includes('/api/quote/confirm')) {
        return response(replies.name ?? ok({ paid: true, entitled: true }))
      }
      if (url.includes('/api/domain/quote/confirm')) {
        return response(replies.tier ?? ok({ expiresAt: NOW + 365 * 86400, frozen: false }))
      }
      throw new Error(`unrouted ${url}`)
    }) as unknown as typeof fetch,
    ...over,
  }
  return { deps, calls, signed }
}

const pendingCalls = (calls: Call[]): Call[] => calls.filter(c => c.url.includes('/charges/pending'))

async function asked(): Promise<Record<string, { at: number; open: boolean }>> {
  return (await RNFS.exists(ASKED))
    ? JSON.parse(await RNFS.readFile(ASKED, 'utf8'))
    : {}
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(sparkGetLnAddress).mockResolvedValue(null)
  jest
    .mocked(sparkRegisterLnAddress)
    .mockImplementation(async (username: string) => ({
      username,
      address: `${username}@${BUILD}`,
      lnurl: 'lnurl1',
    }))
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(getActiveWalletId).mockResolvedValue('w_a')
  jest.mocked(sparkConnectedWalletId).mockReturnValue('w_a')
  jest.mocked(storeAvailable).mockReturnValue(false)
  jest.mocked(openPurchases).mockResolvedValue([])
})

describe('the signed statement', () => {
  // Byte-identical to the gateway's pending charges message, which it rebuilds to verify the
  // signature. Written against a literal rather than rebuilt from the same parts, because a copy
  // assembled the same way agrees with the wrong field order too.
  test('is the gateway wording, in the gateway order', () => {
    expect(pendingChargesMessage(PUBKEY, 1700)).toBe(
      `voltz-domain:v1\npending-charges\n${PUBKEY}\n1700`,
    )
  })

  test('is what the sweep actually signs, and the ask carries it unchanged', async () => {
    const { deps, calls, signed } = harness({})
    await recoverPurchases(deps)
    expect(signed).toEqual([pendingChargesMessage(PUBKEY, NOW)])
    expect(pendingCalls(calls)[0].url).toBe(`https://${BUILD}/api/charges/pending`)
    expect(pendingCalls(calls)[0].body).toEqual({
      pubkey: PUBKEY,
      signature: 'deadbeef',
      timestamp: NOW,
    })
  })
})

describe('a treasury that cannot answer', () => {
  // The load-bearing line of the whole contract. 503 and an empty list are the same pixels and
  // opposite facts, so the difference has to live in whether the question was recorded as answered.
  test('leaves the question open, and the next open asks again', async () => {
    const first = harness({ pending: { status: 503, body: { error: 'treasury_unavailable' } } })
    expect(await recoverPurchases(first.deps)).toBeNull()
    expect((await asked()).w_a).toEqual({ at: NOW, open: true })

    const later = harness({}, { now: () => NOW_MS + 6 * 60_000 })
    await recoverPurchases(later.deps)
    expect(pendingCalls(later.calls)).toHaveLength(1)
  })

  test('is not confused with being owed nothing, which does close the question', async () => {
    const first = harness({ pending: ok({ charges: [] }) })
    expect(await recoverPurchases(first.deps)).toBeNull()
    expect((await asked()).w_a).toEqual({ at: NOW, open: false })

    const later = harness({}, { now: () => NOW_MS + 6 * 60_000 })
    await recoverPurchases(later.deps)
    expect(pendingCalls(later.calls)).toHaveLength(0)
  })

  // A row this build cannot read never closes the question, and never buries the rows it can. The
  // first half stops a list short of a charge being recorded as the final answer; the second stops
  // one unreadable row hiding a paid name, which the gateway would keep returning, making the
  // silence permanent for somebody who is owed something recoverable.
  test('drops a record for a charge that can never receive money', async () => {
    // A send the wallet cannot afford can still leave a proof behind, and that record blocks every
    // later purchase while the screen says the money is on its way. The gateway lists only charges
    // where money arrived, so one where none did is invisible to the sweep and the record would sit
    // there forever.
    await savePendingPurchase({ host: 'bakery.com.br', reference: 'dead-ref', amountSats: 199800 })
    const { deps } = harness({ pending: ok({ charges: [], expired: ['dead-ref'] }) })

    await recoverPurchases(deps)

    expect(await loadPendingPurchase()).toBeNull()
  })

  test('drops nothing when the gateway names nothing, and nothing is inferred from silence', async () => {
    // A gateway older than the field answers no list at all, and absent is not empty: it says
    // nothing about what is dead. Reading it as "none of these are owed" would drop a record that
    // stands for real money and charge somebody twice.
    await savePendingPurchase({ host: 'bakery.com.br', reference: 'alive-ref', amountSats: 199800 })
    const { deps } = harness({ pending: ok({ charges: [] }) })

    await recoverPurchases(deps)

    expect(await loadPendingPurchase()).toMatchObject({ reference: 'alive-ref' })
  })

  test('drops only what was named, never a neighbour', async () => {
    await savePendingPurchase({ host: 'bakery.com.br', reference: 'mine', amountSats: 199800 })
    const { deps } = harness({ pending: ok({ charges: [], expired: ['somebody-elses'] }) })

    await recoverPurchases(deps)

    expect(await loadPendingPurchase()).toMatchObject({ reference: 'mine' })
  })

  test('a body short of a whole charge leaves the question open', async () => {
    const { deps } = harness({
      pending: ok({ charges: [NAME_CHARGE, { ...TIER_CHARGE, subject: '' }] }),
    })
    await recoverPurchases(deps)
    expect((await asked()).w_a.open).toBe(true)
  })

  test('and still recovers the charge it could read', async () => {
    const { deps } = harness({
      pending: ok({ charges: [{ ...TIER_CHARGE, subject: '' }, NAME_CHARGE] }),
    })
    const found = await recoverPurchases(deps)
    expect(found).toMatchObject({ status: 'ready', subject: `bakery@${SOLD_ON}` })
  })
})

describe('nothing pending', () => {
  test('draws nothing and writes no proof', async () => {
    const { deps } = harness({ pending: ok({ charges: [] }) })
    expect(await recoverPurchases(deps)).toBeNull()
    expect(await loadPending('name')).toBeNull()
    expect(await loadPendingPurchase()).toBeNull()
  })

  test('the day window holds without a request, and a clock moved backwards asks again', async () => {
    const first = harness({ pending: ok({ charges: [] }) })
    await recoverPurchases(first.deps)

    const sameDay = harness({}, { now: () => NOW_MS + 23 * 3_600_000 })
    await recoverPurchases(sameDay.deps)
    expect(pendingCalls(sameDay.calls)).toHaveLength(0)

    const backwards = harness({}, { now: () => NOW_MS - 3_600_000 })
    await recoverPurchases(backwards.deps)
    expect(pendingCalls(backwards.calls)).toHaveLength(1)
  })
})

describe('a name that was paid for and never received', () => {
  test('is confirmed on the domain it was sold on, not the one the build ships with', async () => {
    const { deps, calls } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    const found = await recoverPurchases(deps)
    const confirm = calls.find(c => c.url.includes('/api/quote/confirm'))
    expect(confirm?.url).toBe(`https://${SOLD_ON}/api/quote/confirm`)
    expect(confirm?.body).toEqual({
      username: 'bakery',
      pubkey: PUBKEY,
      reference: 'ref-name',
    })
    expect(found).toEqual({
      status: 'ready',
      kind: 'name',
      subject: `bakery@${SOLD_ON}`,
      reference: 'ref-name',
      pubkey: PUBKEY,
    })
  })

  test('is put on the wallet with no tap, and the proof is retired once it exists', async () => {
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    await recoverPurchases(deps)
    expect(sparkRegisterLnAddress).toHaveBeenCalledWith('bakery')
    expect(await loadPending('name')).toBeNull()
  })

  test('a wallet that already answers on the name is not registered a second time', async () => {
    jest
      .mocked(sparkGetLnAddress)
      .mockResolvedValue({ username: 'bakery', address: 'x', lnurl: 'y' })
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    expect((await recoverPurchases(deps))?.status).toBe('ready')
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
  })

  // Read at the moment the confirmation goes out, not after it comes back, because an app killed
  // while that request is in flight has to leave the address sheet something to resume from, and a
  // check made after the reply cannot tell whether the proof existed before it.
  test('the proof is on disk before the gateway is asked, so a crash mid-confirm leaves a trail', async () => {
    let held: string | null = null
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
    deps.request = (async (url: string, init: RequestInit) => {
      if (url.includes('/api/quote/confirm')) {
        held = (await loadPending('name'))?.reference ?? null
      }
      return request(url, init)
    }) as unknown as typeof fetch
    await recoverPurchases(deps)
    expect(held).toBe('ref-name')
  })
})

describe('a payment the gateway has not seen settle', () => {
  test('says it is landing rather than that it failed', async () => {
    const { deps } = harness({
      pending: ok({ charges: [NAME_CHARGE] }),
      name: { status: 402, body: { paid: false } },
    })
    expect((await recoverPurchases(deps))?.status).toBe('settling')
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
  })

  test('keeps the question open, so the next open picks it up without a tap', async () => {
    const { deps } = harness({
      pending: ok({ charges: [NAME_CHARGE] }),
      name: { status: 402, body: { paid: false } },
    })
    await recoverPurchases(deps)
    expect((await asked()).w_a.open).toBe(true)

    const later = harness({}, { now: () => NOW_MS + 6 * 60_000 })
    await recoverPurchases(later.deps)
    expect(pendingCalls(later.calls)).toHaveLength(1)
  })

  test('leaves the proof on disk, since it is the only way back to the payment', async () => {
    const { deps } = harness({
      pending: ok({ charges: [NAME_CHARGE] }),
      name: { status: 402, body: { paid: false } },
    })
    await recoverPurchases(deps)
    expect((await loadPending('name'))?.reference).toBe('ref-name')
  })
})

describe('telling a refusal from a dead network', () => {
  test('a grant that did not happen asks for a person', async () => {
    const { deps } = harness({
      pending: ok({ charges: [NAME_CHARGE] }),
      name: { status: 409, body: { paid: true, entitled: false, error: 'paid_but_not_granted' } },
    })
    expect((await recoverPurchases(deps))?.status).toBe('stuck')
  })

  // `final: true` is the gateway saying no later confirmation grants it, and a person gives the sats
  // back. The proof stays, since it is the reference support looks the payment up by.
  test('a grant refused for good asks for a person and keeps the proof', async () => {
    const { deps } = harness({
      pending: ok({ charges: [NAME_CHARGE] }),
      name: { status: 409, body: { paid: true, entitled: false, error: 'paid_but_not_granted', final: true } },
    })
    expect((await recoverPurchases(deps))?.status).toBe('stuck')
    expect((await loadPending('name'))?.reference).toBe('ref-name')
  })

  // `final: false` is another wallet's reservation in the way, which a later confirmation may still
  // get past. It is still landing: nobody is sent to support for it, and the question stays open so
  // the next focus after a few minutes asks again.
  test('a grant another reservation holds up is still landing, and asked again soon', async () => {
    const { deps } = harness({
      pending: ok({ charges: [NAME_CHARGE] }),
      name: { status: 409, body: { paid: true, entitled: false, error: 'paid_but_not_granted', final: false } },
    })
    expect((await recoverPurchases(deps))?.status).toBe('settling')
    expect((await asked()).w_a.open).toBe(true)
    expect((await loadPending('name'))?.reference).toBe('ref-name')

    // And when that window ends in a refusal for good, the next ask says so.
    const later = harness(
      {
        pending: ok({ charges: [NAME_CHARGE] }),
        name: { status: 409, body: { paid: true, entitled: false, error: 'paid_but_not_granted', final: true } },
      },
      { now: () => NOW_MS + 6 * 60_000 },
    )
    expect((await recoverPurchases(later.deps))?.status).toBe('stuck')
    expect((await loadPending('name'))?.reference).toBe('ref-name')
  })

  // A year's refusal carries no `final`, so it is never told it is coming.
  test('a year whose grant did not happen asks for a person, and one held up is landing', async () => {
    const refused = { paid: true, entitled: false, days: 365, error: 'paid_but_not_granted' }
    const plain = harness({ pending: ok({ charges: [TIER_CHARGE] }), tier: { status: 409, body: refused } })
    expect((await recoverPurchases(plain.deps))?.status).toBe('stuck')

    await RNFS.unlink(ASKED).catch(() => undefined)
    const held = harness({ pending: ok({ charges: [TIER_CHARGE] }), tier: { status: 409, body: { ...refused, final: false } } })
    expect((await recoverPurchases(held.deps))?.status).toBe('settling')
  })

  test('a network that died says it is landing, and never sends anybody to support', async () => {
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) }, {})
    const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
    deps.request = (async (url: string, init: RequestInit) => {
      if (url.includes('/api/quote/confirm')) {
        throw new Error('Network request failed')
      }
      return request(url, init)
    }) as unknown as typeof fetch
    expect((await recoverPurchases(deps))?.status).toBe('settling')
  })
})

// A confirmation that never reaches the gateway says nothing new about the payment, and the last
// paid refusal kept with its proof still stands. A card that reads as landing over a payment
// refused for good sends nobody to the person who gives the sats back.
describe('a refusal for good with no fresh answer', () => {
  const FOR_GOOD: Reply = {
    status: 409,
    body: { paid: true, entitled: false, error: 'paid_but_not_granted', final: true },
  }
  const MAY_CLEAR: Reply = {
    status: 409,
    body: { paid: true, entitled: false, error: 'paid_but_not_granted', final: false },
  }
  const YEAR_REFUSED: Reply = {
    status: 409,
    body: { paid: true, entitled: false, days: 365, error: 'paid_but_not_granted' },
  }
  // Past the day a settled ask is trusted for, so the sweep asks again.
  const DAYS_LATER = NOW_MS + 2 * 86_400_000

  // Every request answers as the harness does, except a confirmation, which cannot reach the
  // gateway.
  function unreachable(at: number, charges: unknown[] = [NAME_CHARGE]): RecoverDeps {
    const { deps } = harness({ pending: ok({ charges }) }, { now: () => at })
    const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
    deps.request = (async (url: string, init: RequestInit) => {
      if (url.includes('/quote/confirm')) {
        throw new Error('Network request failed')
      }
      return request(url, init)
    }) as unknown as typeof fetch
    return deps
  }

  test('a name refused for good on an earlier ask still asks for a person', async () => {
    const first = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: FOR_GOOD })
    expect((await recoverPurchases(first.deps))?.status).toBe('stuck')

    expect((await recoverPurchases(unreachable(DAYS_LATER)))?.status).toBe('stuck')
    const held = await loadPending('name')
    expect(held).toMatchObject({ subject: 'bakery', reference: 'ref-name', amountSats: 12821 })
    expect(held).not.toHaveProperty('unpaid')
  })

  test('a year refused on an earlier ask still asks for a person', async () => {
    const first = harness({ pending: ok({ charges: [TIER_CHARGE] }), tier: YEAR_REFUSED })
    expect((await recoverPurchases(first.deps))?.status).toBe('stuck')

    expect((await recoverPurchases(unreachable(DAYS_LATER, [TIER_CHARGE])))?.status).toBe('stuck')
    const held = await loadPendingPurchase()
    expect(held).toMatchObject({ host: SOLD_ON, reference: 'ref-tier', amountSats: 99000 })
    expect(held).not.toHaveProperty('unpaid')
  })

  // The address sheet keeps what it heard on the same proof the sweep files the charge into.
  test('a refusal for good the address sheet heard asks for a person', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-name', amountSats: 12821 })
    await recordRefusal('name', 'ref-name', true)
    expect((await recoverPurchases(unreachable(NOW_MS)))?.status).toBe('stuck')
    expect(await loadPending('name')).toMatchObject({ reference: 'ref-name', refusedForGood: true })
  })

  // A proof that cannot be read says nothing verified about the charge landing, so the card sends the
  // buyer to a person rather than promising it.
  test.each<[string, string, unknown[]]>([
    ['name', 'purchases.json', [NAME_CHARGE]],
    ['year', 'domain-purchase.json', [TIER_CHARGE]],
  ])('a %s whose proof cannot be read and whose confirmation goes unanswered asks for a person', async (_kind, file, charges) => {
    await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/${file}`, '{"w_a": {"ref', 'utf8')
    expect((await recoverPurchases(unreachable(NOW_MS, charges)))?.status).toBe('stuck')
    expect(await RNFS.readFile(`${RNFS.DocumentDirectoryPath}/${file}`, 'utf8')).toBe('{"w_a": {"ref')
  })

  // Nothing was answered, so the question stays open and the next focus after a few minutes asks
  // again.
  test('an ask that could not reach the gateway is asked again soon', async () => {
    const first = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: FOR_GOOD })
    await recoverPurchases(first.deps)
    expect((await asked()).w_a.open).toBe(false)

    expect((await recoverPurchases(unreachable(DAYS_LATER)))?.status).toBe('stuck')
    expect((await asked()).w_a.open).toBe(true)
  })

  test('a wait heard after a refusal for good takes it back', async () => {
    const first = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: FOR_GOOD })
    expect((await recoverPurchases(first.deps))?.status).toBe('stuck')
    const second = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: MAY_CLEAR }, { now: () => DAYS_LATER })
    expect((await recoverPurchases(second.deps))?.status).toBe('settling')

    expect((await recoverPurchases(unreachable(DAYS_LATER + 6 * 60_000)))?.status).toBe('settling')
    expect(await loadPending('name')).toMatchObject({ reference: 'ref-name' })
  })

  test("another payment's refusal says nothing about this one", async () => {
    await savePending({ kind: 'name', subject: 'other', reference: 'ref-9', amountSats: 1 })
    await recordRefusal('name', 'ref-9', true)
    expect((await recoverPurchases(unreachable(NOW_MS)))?.status).toBe('settling')
    expect(await loadPending('name')).toMatchObject({ reference: 'ref-9', refusedForGood: true })
  })

  // Granted, the name only waits on the address screen, where a refusal still on the proof would
  // send the buyer to a person for a name that is theirs.
  test('a grant takes back the refusal while the name waits for the buyer', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-name', amountSats: 12821 })
    await recordRefusal('name', 'ref-name', true)
    jest.mocked(sparkGetLnAddress).mockResolvedValue({ username: 'cafe', address: `cafe@${BUILD}`, lnurl: 'lnurl1' })
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    expect((await recoverPurchases(deps))?.status).toBe('waiting')
    const held = await loadPending('name')
    expect(held).toMatchObject({ reference: 'ref-name', amountSats: 12821 })
    expect(held).not.toHaveProperty('refusedForGood')
  })
})

describe('a name that could not be taken', () => {
  test('is not reported as ready, and the proof stays for the address screen to retry', async () => {
    jest.mocked(sparkRegisterLnAddress).mockRejectedValue(new Error('name is reserved'))
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    expect((await recoverPurchases(deps))?.status).toBe('blocked')
    expect((await loadPending('name'))?.reference).toBe('ref-name')
  })
})

describe('a year on a domain', () => {
  test('is confirmed at the build domain, because the customer host may be off the edge', async () => {
    const { deps, calls } = harness({ pending: ok({ charges: [TIER_CHARGE] }) })
    const found = await recoverPurchases(deps)
    const confirm = calls.find(c => c.url.includes('/api/domain/quote/confirm'))
    expect(confirm?.url).toBe(`https://${BUILD}/api/domain/quote/confirm`)
    // The confirm is signed, so the body carries more than the charge. It is matched on the fields
    // that identify the charge rather than on the whole object, because pinning the shape would
    // fail every time the wire gains a field, and would say nothing about what this test is for.
    expect(confirm?.body).toMatchObject({ host: SOLD_ON, pubkey: PUBKEY, reference: 'ref-tier' })
    expect(typeof (confirm?.body as { signature?: unknown }).signature).toBe('string')
    expect(found?.status).toBe('ready')
    expect(found?.subject).toBe(SOLD_ON)
    expect(await loadPendingPurchase()).toBeNull()
  })

  test('drops the domain throttle, so the next read adopts it instead of waiting a day', async () => {
    await RNFS.writeFile(
      `${RNFS.DocumentDirectoryPath}/domain-mine.json`,
      JSON.stringify({ w_a: NOW }),
      'utf8',
    )
    const { deps } = harness({ pending: ok({ charges: [TIER_CHARGE] }) })
    await recoverPurchases(deps)
    const mine = JSON.parse(
      await RNFS.readFile(`${RNFS.DocumentDirectoryPath}/domain-mine.json`, 'utf8'),
    )
    expect(mine.w_a).toBeUndefined()
  })
})

describe('a slot another purchase already holds', () => {
  // savePending refuses to displace a different reference, and a slot this charge never held must
  // never be cleared on its behalf. Getting that wrong throws away the proof of somebody's payment.
  test('is confirmed anyway, and the proof already there survives untouched', async () => {
    await savePending({
      kind: 'name',
      subject: 'otherbakery',
      reference: 'ref-mine',
      amountSats: 500,
    })
    const { deps, calls } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    expect((await recoverPurchases(deps))?.status).toBe('ready')
    expect(calls.some(c => c.url.includes('/api/quote/confirm'))).toBe(true)
    expect((await loadPending('name'))?.reference).toBe('ref-mine')
  })

  test('the same holds for a domain purchase', async () => {
    await savePendingPurchase({ host: 'other.com.br', reference: 'ref-mine', amountSats: 500 })
    const { deps } = harness({ pending: ok({ charges: [TIER_CHARGE] }) })
    expect((await recoverPurchases(deps))?.status).toBe('ready')
    expect((await loadPendingPurchase())?.reference).toBe('ref-mine')
  })
})

describe('more than one thing owed', () => {
  test('shows the one a person has to act on, not the one that finished', async () => {
    const stuck = { ...NAME_CHARGE, reference: 'ref-stuck', subject: 'stalled' }
    const { deps } = harness({ pending: ok({ charges: [TIER_CHARGE, stuck] }) })
    const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
    deps.request = (async (url: string, init: RequestInit) => {
      if (url.includes('/api/quote/confirm')) {
        return response({
          status: 409,
          body: { paid: true, entitled: false, error: 'paid_but_not_granted' },
        })
      }
      return request(url, init)
    }) as unknown as typeof fetch
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'stuck', reference: 'ref-stuck' })
  })

  test('only the first name changes the address the wallet answers on', async () => {
    const second = { ...NAME_CHARGE, reference: 'ref-two', subject: 'secondbakery' }
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE, second] }) })
    await recoverPurchases(deps)
    expect(jest.mocked(sparkRegisterLnAddress).mock.calls).toEqual([['bakery']])
  })
})

describe('somewhere to go when nothing was found', () => {
  test('carries the key and every reference still on the device', async () => {
    await savePending({ kind: 'name', subject: 'alice', reference: 'ref-name', amountSats: 1 })
    await savePendingPurchase({ host: SOLD_ON, reference: 'ref-tier', amountSats: 2 })
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({
      pubkey: PUBKEY,
      references: ['ref-name', 'ref-tier'],
      unread: false,
    })
  })

  test('still answers when the key cannot be read, since that case is a failure too', async () => {
    expect(
      await paymentEvidence(async () => {
        throw new Error('not connected')
      }),
    ).toEqual({ pubkey: '', references: [], unread: false })
  })

  // "none on this device" is only true when every proof read answered, so a file that is there and
  // cannot be read is reported as unread rather than as no payment.
  const DOCS = RNFS.DocumentDirectoryPath
  test.each<[string, string, string]>([
    ['a torn record file', 'purchases.json', '{"w_a": {"name": {"reference": "ref'],
    ['a record file that is not a map', 'purchases.json', '[1, 2]'],
    ['a wallet entry that is not a map', 'purchases.json', '{"w_a": "ref-name"}'],
    ['a name record with no reference', 'purchases.json', '{"w_a": {"name": {"subject": "alice"}}}'],
    ['a torn older record', 'purchase-name.json', '{"reference": "ref'],
    ['an older record with no reference', 'purchase-name.json', '{"subject": "alice"}'],
    ['a torn domain record', 'domain-purchase.json', '{"w_a": {"reference'],
    ['a domain record that is not a map', 'domain-purchase.json', '17'],
    ['a domain record with no reference', 'domain-purchase.json', '{"w_a": {"host": "bakery.com.br"}}'],
    // Nothing in this build writes the older file first, so a torn copy of it is no cut first write.
    ['a torn copy of the older record with no file', 'purchase-name.json.tmp', '{"reference": "ref'],
  ])('reads %s as unread rather than as no reference', async (_label, file, text) => {
    await RNFS.writeFile(`${DOCS}/${file}`, text, 'utf8')
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({ pubkey: PUBKEY, references: [], unread: true })
  })

  // A torn copy with no file beside it is a first write that was cut, whose last finished state is no
  // file, on each file whose first writes lose nothing when cut.
  test.each(['purchases.json', 'domain-purchase.json', 'store-orders.json'])(
    'reads a torn copy of %s with no file as no file, beside the proofs that read',
    async file => {
      await savePendingPurchase({ host: SOLD_ON, reference: 'ref-tier', amountSats: 2 })
      if (file === 'domain-purchase.json') {
        await RNFS.unlink(`${DOCS}/${file}`)
      }
      await RNFS.writeFile(`${DOCS}/${file}.tmp`, '{"w_a": {"ref', 'utf8')
      const tier = file === 'domain-purchase.json' ? [] : ['ref-tier']
      expect(await paymentEvidence(async () => PUBKEY)).toEqual({ pubkey: PUBKEY, references: tier, unread: false })
    },
  )

  // Every wallet's proofs are read, so which wallet is active decides nothing here.
  test('carries the proof whatever the registry answers about the active wallet', async () => {
    await savePending({ kind: 'name', subject: 'alice', reference: 'ref-name', amountSats: 1 })
    jest.mocked(getActiveWalletId).mockRejectedValue(new Error('registry unreadable'))
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({
      pubkey: PUBKEY,
      references: ['ref-name'],
      unread: false,
    })
  })

  test('carries a proof filed only under another wallet', async () => {
    jest.mocked(getActiveWalletId).mockResolvedValue('w_b')
    await savePending({ kind: 'name', subject: 'alice', reference: 'ref-other', amountSats: 1 })
    await savePendingPurchase({ host: SOLD_ON, reference: 'ref-other-tier', amountSats: 2 })
    jest.mocked(getActiveWalletId).mockResolvedValue('w_a')
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({
      pubkey: PUBKEY,
      references: ['ref-other', 'ref-other-tier'],
      unread: false,
    })
  })

  const BOOK = `${DOCS}/store-orders.json`

  test('carries what the store book keeps for money the store may hold', async () => {
    await RNFS.writeFile(
      BOOK,
      JSON.stringify({
        orders: { 'ord-open': 'w_a', 'ord-paid': 'w_b' },
        bought: { 'ord-paid': 'purchased', 'ord-asked': 'pending' },
        outcomes: {
          'ord-support': { kind: 'support', code: 'no_reference', key: 'txn-9' },
          'ord-refused': { kind: 'refused', refusal: '409 refunded' },
          'ord-done': { kind: 'delivered', host: SOLD_ON, expiresAt: NOW, frozen: false },
        },
      }),
      'utf8',
    )
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({
      pubkey: PUBKEY,
      references: ['ord-paid', 'ord-asked', 'ord-support', 'txn-9', 'ord-refused'],
      unread: false,
    })
  })

  test.each<[string, string, string]>([
    ['a torn store book', BOOK, '{"orders": {"ord'],
    ['a store book that is not a map', BOOK, '[1]'],
    ['a store book set aside', `${BOOK}.unreadable`, '{"orders'],
    ['a copy of the store book set aside', `${BOOK}.tmp.unreadable`, '{"orders'],
  ])('reads %s as unread, beside the proofs that read', async (_label, path, text) => {
    await savePending({ kind: 'name', subject: 'alice', reference: 'ref-name', amountSats: 1 })
    await RNFS.writeFile(path, text, 'utf8')
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({ pubkey: PUBKEY, references: ['ref-name'], unread: true })
  })

  const listed = (reference: string | null, key: string): StorePurchase => ({
    store: 'apple',
    productId: 'domain_year',
    state: 'purchased',
    purchasedAt: NOW_MS,
    reference,
    key,
    verified: true,
    revoked: false,
  })

  test('carries every purchase the store still holds open, by its reference or else its key', async () => {
    jest.mocked(storeAvailable).mockReturnValue(true)
    jest.mocked(openPurchases).mockResolvedValue([listed('ord-1', 'txn-1'), listed(null, 'txn-2')])
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({
      pubkey: PUBKEY,
      references: ['ord-1', 'txn-2'],
      unread: false,
    })
  })

  test("reads a store list that cannot be read as unread, never as none", async () => {
    jest.mocked(storeAvailable).mockReturnValue(true)
    jest.mocked(openPurchases).mockRejectedValue(new Error('storeUnavailable'))
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({ pubkey: PUBKEY, references: [], unread: true })
  })

  // A call that fails, on the network or in the store's service, says nothing about what the list holds.
  test.each([
    ['network', false],
    ['storeUnavailable', false],
    ['unknown', false],
  ] as const)('a list refused with %p, on a device that has billing, stays unread', async (code, noBilling) => {
    jest.mocked(storeAvailable).mockReturnValue(true)
    jest.mocked(openPurchases).mockRejectedValue(new StoreError(code, 'refused', noBilling))
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({ pubkey: PUBKEY, references: [], unread: true })
  })

  // Play answers BILLING_UNAVAILABLE on a device with no Google account. Such a device holds no store
  // purchase it can see, so the list is read and empty, and the other sources decide.
  test('a device the store says has no billing reads as an empty list, not an unread one', async () => {
    jest.mocked(storeAvailable).mockReturnValue(true)
    jest.mocked(openPurchases).mockRejectedValue(new StoreError('storeUnavailable', 'Billing service unavailable on device.', true))
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({ pubkey: PUBKEY, references: [], unread: false })
    await savePending({ kind: 'name', subject: 'alice', reference: 'ref-name', amountSats: 1 })
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({ pubkey: PUBKEY, references: ['ref-name'], unread: false })
    await RNFS.writeFile(`${DOCS}/domain-purchase.json`, '{"w_a": {"reference', 'utf8')
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({ pubkey: PUBKEY, references: ['ref-name'], unread: true })
  })

  test('names a reference once when two sources hold it', async () => {
    jest.mocked(storeAvailable).mockReturnValue(true)
    jest.mocked(openPurchases).mockResolvedValue([listed('ord-1', 'txn-1')])
    await RNFS.writeFile(BOOK, JSON.stringify({ bought: { 'ord-1': 'purchased' } }), 'utf8')
    expect((await paymentEvidence(async () => PUBKEY)).references).toEqual(['ord-1'])
  })

  // A torn file beside a good proof hides neither: the good one is carried and the torn one is unread.
  test('keeps a name proof that reads beside a domain record that does not', async () => {
    await savePending({ kind: 'name', subject: 'alice', reference: 'ref-name', amountSats: 1 })
    await RNFS.writeFile(`${DOCS}/domain-purchase.json`, '{"w_a": {"reference', 'utf8')
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({
      pubkey: PUBKEY,
      references: ['ref-name'],
      unread: true,
    })
  })

  test('keeps a domain proof that reads beside a name record that does not', async () => {
    await savePendingPurchase({ host: SOLD_ON, reference: 'ref-tier', amountSats: 2 })
    await RNFS.writeFile(`${DOCS}/purchases.json`, '{"w_a": {"name": {"reference": "ref', 'utf8')
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({
      pubkey: PUBKEY,
      references: ['ref-tier'],
      unread: true,
    })
  })

  test('answers no reference when no proof file is there, or the only one stands for no payment', async () => {
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({ pubkey: PUBKEY, references: [], unread: false })
    await savePending({ kind: 'name', subject: 'alice', reference: 'ref-name', amountSats: 1, unpaid: true })
    await savePendingPurchase({ host: SOLD_ON, reference: 'ref-tier', amountSats: 2, unpaid: true })
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({ pubkey: PUBKEY, references: [], unread: false })
  })

  test('still finds an older record when this wallet has none of its own', async () => {
    const older = { kind: 'name', subject: 'alice', reference: 'ref-old', amountSats: 1 }
    await RNFS.writeFile(`${DOCS}/purchase-name.json`, JSON.stringify(older), 'utf8')
    const olderTier = { host: SOLD_ON, reference: 'ref-old-tier', amountSats: 2 }
    await RNFS.writeFile(`${DOCS}/domain-purchase.json`, JSON.stringify(olderTier), 'utf8')
    expect(await paymentEvidence(async () => PUBKEY)).toEqual({
      pubkey: PUBKEY,
      references: ['ref-old', 'ref-old-tier'],
      unread: false,
    })
  })

  test('the mail reaches the address the support page already publishes, escaped', async () => {
    const url = helpMailUrl('A payment', 'Wallet: 02ab\nPayment: ref')
    expect(url.startsWith('mailto:support@usevoltz.app?')).toBe(true)
    expect(url).toContain('subject=A%20payment')
    expect(url).toContain('Wallet%3A%2002ab%0APayment%3A%20ref')
  })
})

// Final answers that name more than a person giving the sats back, read from the answer for this
// charge alone: only its `repaid: true` says the sats came back, and a paid-again name never reads as
// the payment that put the name on the wallet. One that owes nothing gives the slot up once its card is
// handed back, and one still owed keeps the proof for the next opening to ask again.
describe('a paid charge answered for good in other words', () => {
  const NAME_REFUSED = { paid: true, entitled: false, error: 'paid_but_not_granted', final: true }
  const YEAR_REFUSED = { paid: true, entitled: false, days: 365, error: 'paid_but_not_granted' }
  const DAYS_LATER = NOW_MS + 2 * 86_400_000
  const STORE = `${RNFS.DocumentDirectoryPath}/purchases.json`
  const DOMAIN_STORE = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`

  function unreachable(at: number, charges: unknown[]): RecoverDeps {
    const { deps } = harness({ pending: ok({ charges }) }, { now: () => at })
    const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
    deps.request = (async (url: string, init: RequestInit) => {
      if (url.includes('/quote/confirm')) {
        throw new Error('Network request failed')
      }
      return request(url, init)
    }) as unknown as typeof fetch
    return deps
  }

  // The record itself is gone from the file, not only marked, so no reader can offer or ask about it.
  async function onFile(file: string, reference: string): Promise<boolean> {
    return (await RNFS.exists(file)) && (await RNFS.readFile(file, 'utf8')).includes(reference)
  }

  test.each<[string, Reply, string, string | undefined, boolean]>([
    ['a name given back', { status: 409, body: { ...NAME_REFUSED, repaid: true } }, 'repaid', undefined, false],
    ['a name with repaid false', { status: 409, body: { ...NAME_REFUSED, repaid: false } }, 'stuck', 'kept', false],
    ['a name without repaid', { status: 409, body: NAME_REFUSED }, 'stuck', 'kept', false],
    // A holder's answer releases the slot: the wallet has the name, and the sats owed back are the
    // gateway's to track.
    ['a name paid again', ok({ paid: true, entitled: true, paidAgain: true }), 'paidAgain', undefined, true],
    [
      'a name paid again and given back',
      ok({ paid: true, entitled: true, paidAgain: true, repaid: true }),
      'paidAgainRepaid',
      undefined,
      true,
    ],
    [
      'a name paid again once the wallet lost it',
      { status: 409, body: { paid: true, entitled: false, error: 'paid_but_not_granted', paidAgain: true } },
      'paidAgain',
      'paidAgain',
      false,
    ],
    [
      'a name bought before',
      { status: 409, body: { paid: true, entitled: false, error: 'bought_before', final: true } },
      'boughtBefore',
      undefined,
      false,
    ],
  ])('%s', async (_, reply, status, held, registers) => {
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: reply })
    expect((await recoverPurchases(deps))?.status).toBe(status)
    expect(jest.mocked(sparkRegisterLnAddress).mock.calls).toEqual(registers ? [['bakery']] : [])
    expect((await asked()).w_a.open).toBe(false)
    if (held === undefined) {
      expect(await loadPending('name')).toBeNull()
      expect(await onFile(STORE, 'ref-name')).toBe(false)
      return
    }
    const proof = await loadPending('name')
    expect(proof).toMatchObject({ reference: 'ref-name', refusedForGood: true })
    expect(proof?.finalAnswer).toBe(held === 'kept' ? undefined : held)
    // Owed, so a later ask that cannot reach the gateway still says what this charge's answer said.
    expect((await recoverPurchases(unreachable(DAYS_LATER, [NAME_CHARGE])))?.status).toBe(status)
  })

  test.each<[string, Reply, string, string | undefined]>([
    ['a year given back', { status: 409, body: { ...YEAR_REFUSED, repaid: true } }, 'repaid', undefined],
    ['a year with repaid false', { status: 409, body: { ...YEAR_REFUSED, repaid: false } }, 'stuck', 'kept'],
    ['a year without repaid', { status: 409, body: YEAR_REFUSED }, 'stuck', 'kept'],
    [
      'a year bought before',
      { status: 409, body: { paid: true, entitled: false, days: 365, error: 'bought_before', final: true } },
      'boughtBefore',
      undefined,
    ],
  ])('%s', async (_, reply, status, held) => {
    const { deps } = harness({ pending: ok({ charges: [TIER_CHARGE] }), tier: reply })
    expect((await recoverPurchases(deps))?.status).toBe(status)
    expect((await asked()).w_a.open).toBe(false)
    if (held === undefined) {
      expect(await loadPendingPurchase()).toBeNull()
      expect(await onFile(DOMAIN_STORE, 'ref-tier')).toBe(false)
      return
    }
    const proof = await loadPendingPurchase()
    expect(proof).toMatchObject({ reference: 'ref-tier', refusedForGood: true })
    expect(proof?.finalAnswer).toBeUndefined()
    expect((await recoverPurchases(unreachable(DAYS_LATER, [TIER_CHARGE])))?.status).toBe(status)
  })

  // The name a holder's answer puts on the wallet goes there by the rule a grant follows, which never
  // swaps an address the wallet already answers on, and the slot is given up as the card says it.
  test.each([
    ['paid again', { paid: true, entitled: true, paidAgain: true }],
    ['paid again and given back', { paid: true, entitled: true, paidAgain: true, repaid: true }],
  ])('a name %s leaves an address in use as it is and gives the slot up', async (_, body) => {
    jest.mocked(sparkGetLnAddress).mockResolvedValue({ username: 'cafe', address: `cafe@${BUILD}`, lnurl: 'lnurl1' })
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: ok(body) })
    expect((await recoverPurchases(deps))?.status).toMatch(/^paidAgain/)
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    expect(await loadPending('name')).toBeNull()
    expect(await listLines()).toEqual([])
  })

  // An address that could not be read is not an address that is absent (takeName).
  test('a name paid again registers nothing when the address cannot be read', async () => {
    jest.mocked(sparkGetLnAddress).mockRejectedValue(new Error('SdkError.NetworkError'))
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: ok({ paid: true, entitled: true, paidAgain: true }) })
    expect((await recoverPurchases(deps))?.status).toBe('paidAgain')
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
  })

  // A grant from a gateway older than paidAgain reads as it always did.
  test('control: a holder answer without paidAgain puts the name on the wallet as before', async () => {
    jest.mocked(sparkRegisterLnAddress).mockResolvedValue({ username: 'bakery', address: `bakery@${SOLD_ON}`, lnurl: 'l' })
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: ok({ paid: true, entitled: true }) })
    expect((await recoverPurchases(deps))?.status).toBe('ready')
    expect(await loadPending('name')).toBeNull()
  })
})

// A released answer's line is said exactly once. The sweep keeps every one it hears in the
// list of lines before giving the slot up, whether or not the charge held the slot, and the card says
// a line only once it took it out of the list, read after the sweep's questions were answered.
describe('a line no view has shown', () => {
  const nameLine = (answer: ReleasedLine['answer'], reference = 'ref-name'): ReleasedLine => ({
    kind: 'name',
    reference,
    answer,
    subject: `bakery@${SOLD_ON}`,
  })
  const STUCK = { status: 409, body: { paid: true, entitled: false, error: 'paid_but_not_granted', final: true } }
  const AGAIN = ok({ paid: true, entitled: true, paidAgain: true })

  // Name confirmations answered by reference, for a sweep over two names with different answers.
  function byReference(deps: RecoverDeps, answers: Record<string, Reply>): RecoverDeps {
    const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
    deps.request = (async (url: string, init: RequestInit) => {
      const reference = JSON.parse(String(init.body)).reference as string
      if (url.includes('/api/quote/confirm') && !url.includes('/domain/') && answers[reference]) {
        await request(url, init)
        return response(answers[reference]!)
      }
      return request(url, init)
    }) as unknown as typeof fetch
    return deps
  }

  // The subject is the one the line was heard with, never rebuilt from the session's domain.
  test.each([
    ['repaid', 'repaid'],
    ['paidAgain', 'paidAgain'],
    ['boughtBefore', 'boughtBefore'],
  ] as const)('a kept name line of %s is the card once, also when the throttle holds the sweep back', async (answer, status) => {
    await noteLine(nameLine(answer), await activeScope())
    await RNFS.writeFile(ASKED, JSON.stringify({ w_a: { at: NOW, open: false } }), 'utf8')
    const { deps, calls } = harness({})
    expect(await recoverPurchases(deps)).toEqual({ status, kind: 'name', subject: `bakery@${SOLD_ON}`, reference: 'ref-name', pubkey: PUBKEY })
    expect(calls).toEqual([])
    expect(await recoverPurchases(deps)).toBeNull()
  })

  test('a kept year line is the card once, and a due sweep asks nothing about it', async () => {
    await noteLine({ kind: 'tier', reference: 'ref-tier', answer: 'repaid', subject: SOLD_ON }, await activeScope())
    const { deps, calls } = harness({ pending: ok({ charges: [] }) })
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'repaid', kind: 'tier', subject: SOLD_ON })
    expect(calls.filter(c => c.url.includes('/confirm'))).toEqual([])
    const later = harness({ pending: ok({ charges: [] }) }, { now: () => NOW_MS + 2 * 86_400_000 })
    expect(await recoverPurchases(later.deps)).toBeNull()
  })

  test('a kept line is the card also when the list of charges cannot be fetched', async () => {
    await noteLine(nameLine('repaid'), await activeScope())
    const { deps } = harness({ pending: { status: 503, body: {} } })
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'repaid', reference: 'ref-name' })
    expect(await listLines()).toEqual([])
  })

  // The line is kept before the slot is given up, so a sweep stopped between the two leaves the
  // proof, whose next confirmation hears the same answer.
  test('the sweep keeps a released line while the slot still holds its proof', async () => {
    const released = jest.requireActual('../src/wallet/releasedLines') as typeof import('../src/wallet/releasedLines')
    const realNote = released.noteLine
    const heldAtNote: (string | null)[] = []
    const note = jest.spyOn(released, 'noteLine').mockImplementation(async (kept, scope) => {
      heldAtNote.push((await loadPending('name'))?.reference ?? null)
      await realNote(kept, scope)
    })
    const { deps } = harness({
      pending: ok({ charges: [NAME_CHARGE] }),
      name: { status: 409, body: { paid: true, entitled: false, error: 'paid_but_not_granted', final: true, repaid: true } },
    })
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'repaid', reference: NAME_CHARGE.reference })
    note.mockRestore()
    expect(heldAtNote).toEqual([NAME_CHARGE.reference])
    expect(await loadPending('name')).toBeNull()
  })

  // A sweep that asks nothing keeps a card on screen that asks for a person over a line it outranks,
  // and the line waits in the list for the next sweep with nothing more urgent on screen.
  test.each([
    ['the throttle holds the sweep back', {}],
    ['the list of charges cannot be fetched', { pending: { status: 503, body: {} } }],
  ] as const)('a card asking for a person stays on screen when %s, and the line waits', async (_, replies) => {
    await noteLine(nameLine('repaid'), await activeScope())
    if (!('pending' in replies)) {
      await RNFS.writeFile(ASKED, JSON.stringify({ w_a: { at: NOW, open: false } }), 'utf8')
    }
    const stuck = { status: 'stuck' as const, kind: 'name' as const, subject: `cafe@${SOLD_ON}`, reference: 'ref-stuck', pubkey: PUBKEY }
    const first = harness(replies)
    first.deps.showing = stuck
    expect(await recoverPurchases(first.deps)).toBeNull()
    expect(await listLines()).toEqual([nameLine('repaid')])
    const next = harness(replies)
    next.deps.showing = null
    expect(await recoverPurchases(next.deps)).toMatchObject({ status: 'repaid', reference: 'ref-name' })
    expect(await listLines()).toEqual([])
  })

  // A line that outranks the card on screen takes its place, and one as urgent leaves it.
  test('a line more urgent than the card on screen is the card, and one as urgent is not', async () => {
    await RNFS.writeFile(ASKED, JSON.stringify({ w_a: { at: NOW, open: false } }), 'utf8')
    await noteLine(nameLine('paidAgain', 'ref-again'), await activeScope())
    const settled = { status: 'boughtBefore' as const, kind: 'tier' as const, subject: SOLD_ON, reference: 'ref-tier', pubkey: PUBKEY }
    const first = harness({})
    first.deps.showing = settled
    expect(await recoverPurchases(first.deps)).toMatchObject({ status: 'paidAgain', reference: 'ref-again' })
    await noteLine(nameLine('paidAgain', 'ref-later'), await activeScope())
    const second = harness({})
    second.deps.showing = { ...settled, status: 'paidAgain', reference: 'ref-again' }
    expect(await recoverPurchases(second.deps)).toBeNull()
    expect((await listLines()).map(line => line.reference)).toEqual(['ref-later'])
  })

  // A card painted while the app is away is seen by nobody, so no line is claimed then, and one claimed
  // as the app leaves goes back to the list for the next reader.
  test('a kept line is claimed only while a card would be seen, and goes back when the app leaves meanwhile', async () => {
    await RNFS.writeFile(ASKED, JSON.stringify({ w_a: { at: NOW, open: false } }), 'utf8')
    await noteLine(nameLine('repaid'), await activeScope())
    const away = harness({})
    away.deps.onScreen = () => false
    expect(await recoverPurchases(away.deps)).toBeNull()
    expect(await listLines()).toEqual([nameLine('repaid')])
    const leaving = harness({})
    let looks = 0
    leaving.deps.onScreen = () => (looks += 1) === 1
    expect(await recoverPurchases(leaving.deps)).toBeNull()
    expect(looks).toBe(2)
    expect(await listLines()).toEqual([nameLine('repaid')])
    const back = harness({})
    back.deps.onScreen = () => true
    expect(await recoverPurchases(back.deps)).toMatchObject({ status: 'repaid', reference: 'ref-name' })
    expect(await listLines()).toEqual([])
  })

  // A line belongs to the wallet whose charge it answers, so a switch while the sweep's questions are out
  // keeps it on that wallet's list for its next reader, and no card of it goes up over the wallet
  // switched to, whose own lines the sweep leaves alone.
  test('a switch while the sweep asks keeps the line on the wallet that asked, and claims nothing', async () => {
    const registry = jest.requireMock('../src/wallet/walletRegistry') as { getActiveWalletId: jest.Mock }
    try {
      registry.getActiveWalletId.mockResolvedValue('w_b')
      await noteLine(nameLine('repaid', 'ref-b'), await activeScope())
      registry.getActiveWalletId.mockResolvedValue('w_a')
      const { deps } = harness({
        pending: ok({ charges: [NAME_CHARGE] }),
        name: { status: 409, body: { paid: true, entitled: false, error: 'paid_but_not_granted', final: true, repaid: true } },
      })
      const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
      deps.request = (async (url: string, init: RequestInit) => {
        if (url.includes('/api/quote/confirm')) {
          registry.getActiveWalletId.mockResolvedValue('w_b')
        }
        return request(url, init)
      }) as unknown as typeof fetch
      expect(await recoverPurchases(deps)).toBeNull()
      expect((await listLines()).map(kept => kept.reference)).toEqual(['ref-b'])
      registry.getActiveWalletId.mockResolvedValue('w_a')
      expect(await listLines()).toEqual([nameLine('repaid', NAME_CHARGE.reference)])
      const back = harness({}, { now: () => NOW_MS + 1000 })
      expect(await recoverPurchases(back.deps)).toMatchObject({ status: 'repaid', reference: NAME_CHARGE.reference })
    } finally {
      registry.getActiveWalletId.mockResolvedValue('w_a')
    }
  })

  // A due sweep's own answers are newer than the card on screen, so they replace it.
  test('a due sweep answers with what it found, whatever card is on screen', async () => {
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: ok({ paid: true, entitled: false }) })
    deps.showing = { status: 'stuck', kind: 'name', subject: `cafe@${SOLD_ON}`, reference: 'ref-stuck', pubkey: PUBKEY }
    expect((await recoverPurchases(deps))?.status).toBe('settling')
  })

  // The paid-again answer is heard for a charge that did not get the slot, and the stuck card outranks
  // it. The line is kept, never lost, and the next sweep that finds nothing more urgent says it, once.
  // The address in use stays as it is.
  test('a released answer heard for a charge that did not hold the slot is kept, then said once', async () => {
    jest.mocked(sparkGetLnAddress).mockResolvedValue({ username: 'bob', address: `bob@${BUILD}`, lnurl: 'l' })
    const stuck = { ...NAME_CHARGE, reference: 'ref-stuck' }
    const again = { ...NAME_CHARGE, reference: 'ref-again' }
    const first = harness({ pending: ok({ charges: [stuck, again] }) })
    byReference(first.deps, { 'ref-stuck': STUCK, 'ref-again': AGAIN })
    expect((await recoverPurchases(first.deps))?.status).toBe('stuck')
    expect((await loadPending('name'))?.reference).toBe('ref-stuck')
    expect(await listLines()).toEqual([
      { kind: 'name', reference: 'ref-again', answer: 'paidAgain', subject: `bakery@${SOLD_ON}` },
    ])
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()

    const throttled = harness({}, { now: () => NOW_MS + 1000 })
    expect(await recoverPurchases(throttled.deps)).toMatchObject({ status: 'paidAgain', reference: 'ref-again' })
    expect(throttled.calls).toEqual([])
    expect(await listLines()).toEqual([])

    // The gateway lists the stuck charge again, and never the released one (outstandingCharges).
    const later = harness({ pending: ok({ charges: [stuck] }), name: STUCK }, { now: () => NOW_MS + 2 * 86_400_000 })
    expect((await recoverPurchases(later.deps))?.status).toBe('stuck')
    const quiet = harness({}, { now: () => NOW_MS + 2 * 86_400_000 + 1000 })
    expect(await recoverPurchases(quiet.deps)).toBeNull()
    expect(later.calls.filter(c => c.body.reference === 'ref-again')).toEqual([])
  })

  // A view takes the line while the sweep's questions are out, so the card that comes back after them
  // is not that line, and the line is never said twice.
  test('a line a view takes while the sweep is out is not the card', async () => {
    for (const viewTakes of [true, false]) {
      ;(RNFS as unknown as { __reset: () => void }).__reset()
      await noteLine(nameLine('repaid', 'ref-a'), await activeScope())
      let answer!: () => void
      const gate = new Promise<void>(resolve => (answer = resolve))
      const { deps } = harness({ pending: ok({ charges: [] }) })
      const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
      deps.request = (async (url: string, init: RequestInit) => {
        await gate
        return request(url, init)
      }) as unknown as typeof fetch
      const card = recoverPurchases(deps)
      await new Promise(resolve => setTimeout(resolve, 0))
      // What the sheet's opening does with no proof held.
      const taken = viewTakes ? await takeLine('name', await activeScope()) : null
      answer()
      if (viewTakes) {
        expect(taken?.reference).toBe('ref-a')
        expect(await card).toBeNull()
      } else {
        // With no view taking it, the same sweep answers with the line, which shows the probe can fail.
        expect(await card).toMatchObject({ status: 'repaid', reference: 'ref-a' })
      }
      expect(await listLines()).toEqual([])
    }
  })

  // A view showed the answer it heard itself, and the sweep's question about the same charge was
  // already out. Its answer, arriving after, is not kept to be said again.
  test('a released answer heard after a view showed it is not kept again', async () => {
    await claimLine('ref-name', await activeScope())
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: { status: 409, body: { ...STUCK.body, repaid: true } } })
    expect(await recoverPurchases(deps)).toBeNull()
    expect(await listLines()).toEqual([])
    expect(await loadPending('name')).toBeNull()
  })

  // A crash between keeping the line and giving the slot up leaves the proof. The next sweep asks
  // again, hears the same answer, finds the line kept and says it once, then gives the slot up.
  test('a crash between keeping a line and giving the slot up says the line once', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-name', amountSats: 12821 })
    await noteLine({ kind: 'name', reference: 'ref-name', answer: 'repaid', subject: `bakery@${SOLD_ON}` }, await activeScope())
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: { status: 409, body: { ...STUCK.body, repaid: true } } })
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'repaid', reference: 'ref-name' })
    expect(await loadPending('name')).toBeNull()
    expect(await listLines()).toEqual([])
    const quiet = harness({}, { now: () => NOW_MS + 1000 })
    expect(await recoverPurchases(quiet.deps)).toBeNull()
  })

  // Showing a kept line gives up a slot its crash left behind, so nothing asks about it again.
  test('a kept line the card says gives up the slot of its reference', async () => {
    await savePendingPurchase({ host: SOLD_ON, reference: 'ref-tier', amountSats: 99000 })
    await noteLine({ kind: 'tier', reference: 'ref-tier', answer: 'boughtBefore', subject: SOLD_ON }, await activeScope())
    await RNFS.writeFile(ASKED, JSON.stringify({ w_a: { at: NOW, open: false } }), 'utf8')
    const { deps } = harness({})
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'boughtBefore', reference: 'ref-tier' })
    expect(await loadPendingPurchase()).toBeNull()
  })

  // Three charges answered in one sweep: each line is kept, the card says the most urgent, and the
  // views take the others, each once. takeLine is what the sheet's and the domain screen's
  // openings call with no proof held.
  test('three released answers in one sweep are each said once', async () => {
    jest.mocked(sparkGetLnAddress).mockResolvedValue({ username: 'bob', address: `bob@${BUILD}`, lnurl: 'l' })
    const a = { ...NAME_CHARGE, reference: 'ref-a' }
    const b = { ...NAME_CHARGE, reference: 'ref-b' }
    const { deps } = harness({
      pending: ok({ charges: [a, b, TIER_CHARGE] }),
      tier: { status: 409, body: { paid: true, entitled: false, days: 365, error: 'bought_before', final: true } },
    })
    byReference(deps, { 'ref-a': { status: 409, body: { ...STUCK.body, repaid: true } }, 'ref-b': AGAIN })
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'paidAgain', reference: 'ref-b' })
    expect((await takeLine('name', await activeScope()))?.reference).toBe('ref-a')
    expect((await takeLine('tier', await activeScope()))?.reference).toBe('ref-tier')
    expect(await takeLine('name', await activeScope())).toBeNull()
    const quiet = harness({}, { now: () => NOW_MS + 1000 })
    expect(await recoverPurchases(quiet.deps)).toBeNull()
    expect(await loadPending('name')).toBeNull()
    expect(await loadPendingPurchase()).toBeNull()
  })

  // A list file that cannot be read never keeps the slot. A torn one is set aside and the list
  // starts again from the line; a read the platform refuses keeps the file and loses the line.
  test('a torn list file is set aside, and the slot is given up all the same', async () => {
    const LINES = `${RNFS.DocumentDirectoryPath}/released-lines.json`
    await RNFS.writeFile(LINES, '{"w_a":[', 'utf8')
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: { status: 409, body: { ...STUCK.body, repaid: true } } })
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'repaid', reference: 'ref-name' })
    expect(await RNFS.readFile(`${LINES}.unreadable`, 'utf8')).toBe('{"w_a":[')
    expect(await loadPending('name')).toBeNull()
  })

  test('a list file the platform will not read keeps no slot and shows no line', async () => {
    const LINES = `${RNFS.DocumentDirectoryPath}/released-lines.json`
    await noteLine(nameLine('boughtBefore', 'ref-old'), await activeScope())
    const before = await RNFS.readFile(LINES, 'utf8')
    const readFile = RNFS.readFile
    const refuse = jest.spyOn(RNFS, 'readFile').mockImplementation(async (path: string, encoding?: string) => {
      if (path.startsWith(LINES)) {
        throw new Error('EACCES')
      }
      return readFile(path, encoding)
    })
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: { status: 409, body: { ...STUCK.body, repaid: true } } })
    expect(await recoverPurchases(deps)).toBeNull()
    expect(await loadPending('name')).toBeNull()
    refuse.mockRestore()
    expect(await RNFS.readFile(LINES, 'utf8')).toBe(before)
  })

  // One sweep at a time, so two focuses in a row never confirm the same charge twice nor take a name
  // twice.
  test('a sweep while another is out asks nothing and answers nothing new', async () => {
    const { deps, calls } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: ok({ paid: true, entitled: true, paidAgain: true }) })
    const [first, second] = await Promise.all([recoverPurchases(deps), recoverPurchases(deps)])
    expect(first?.status).toBe('paidAgain')
    expect(second).toBeNull()
    expect(calls.filter(c => c.url.includes('/api/quote/confirm'))).toHaveLength(1)
    expect(sparkRegisterLnAddress).toHaveBeenCalledTimes(1)
  })
})

// The sweep asks about one wallet's charges, the one whose key signed, and every proof it files, marks,
// clears or gives up, and every proof it reads back, is that wallet's. A switch while its questions are
// out leaves the wallet switched to with the slot and the year record it had, and no card about the
// asked wallet's charges goes up over it.
describe('a switch while the sweep asks', () => {
  const STORE = `${RNFS.DocumentDirectoryPath}/purchases.json`
  const YEARS = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`
  const OWN_B = { kind: 'name' as const, subject: 'bob', reference: 'ref-b', amountSats: 700 }
  const OWN_B_YEAR = { host: 'bob.com.br', reference: 'ref-b-year', amountSats: 700 }
  const NOT_YET: Reply = ok({ paid: true, entitled: false })
  const YEAR_NOT_YET: Reply = { status: 402, body: {} }
  const KEPT_BODY = { paid: true, entitled: false, error: 'paid_but_not_granted', final: true }
  const YEAR_KEPT_BODY = { paid: true, entitled: false, days: 365, error: 'paid_but_not_granted' }
  const KEPT: Reply = { status: 409, body: KEPT_BODY }
  const YEAR_KEPT: Reply = { status: 409, body: YEAR_KEPT_BODY }
  const REPAID: Reply = { status: 409, body: { ...KEPT_BODY, repaid: true } }
  const YEAR_REPAID: Reply = { status: 409, body: { ...YEAR_KEPT_BODY, repaid: true } }

  const registry = (): jest.Mock => jest.mocked(getActiveWalletId)

  // Moves the registry to `to` as the request whose path holds `path` goes out, after the harness
  // answered nothing yet, so every slot call after it would resolve the wallet switched to.
  function switchOn(deps: RecoverDeps, path: string, to = 'w_b', fail = false): RecoverDeps {
    const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
    deps.request = (async (url: string, init: RequestInit) => {
      if (url.includes(path)) {
        registry().mockResolvedValue(to)
        if (fail) {
          throw new Error('Network request failed')
        }
      }
      return request(url, init)
    }) as unknown as typeof fetch
    return deps
  }

  async function slots(file: string): Promise<Record<string, unknown>> {
    return (await RNFS.exists(file)) ? JSON.parse(await RNFS.readFile(file, 'utf8')) : {}
  }

  // The switched-to wallet's own proofs of both kinds, written while it was active, so a write, mark or
  // clear landing on it shows as a change of these records.
  async function walletBHolds(): Promise<void> {
    registry().mockResolvedValue('w_b')
    await savePending(OWN_B)
    await savePendingPurchase(OWN_B_YEAR)
    registry().mockResolvedValue('w_a')
  }

  async function walletBUntouched(): Promise<void> {
    expect((await slots(STORE)).w_b).toEqual({ name: OWN_B })
    expect((await slots(YEARS)).w_b).toEqual(OWN_B_YEAR)
  }

  const CONFIRM = { name: '/api/quote/confirm', tier: '/api/domain/quote/confirm' }

  test.each([
    ['name', NAME_CHARGE, { name: NOT_YET }],
    ['year', TIER_CHARGE, { tier: YEAR_NOT_YET }],
  ] as const)('a %s charge listed before the switch is filed in the asked wallet only', async (_, charge, replies) => {
    const { deps } = harness({ pending: ok({ charges: [charge] }), ...replies })
    expect(await recoverPurchases(switchOn(deps, '/api/charges/pending'))).toBeNull()
    const file = charge.kind === 'name' ? STORE : YEARS
    expect(Object.keys(await slots(file))).toEqual(['w_a'])
    const held = charge.kind === 'name' ? await loadPending('name', 'w_a') : await loadPendingPurchase('w_a')
    expect(held).toMatchObject({ reference: charge.reference, amountSats: charge.amountSats })
  })

  test.each([
    ['name', NAME_CHARGE, { name: KEPT }],
    ['year', TIER_CHARGE, { tier: YEAR_KEPT }],
  ] as const)('a %s refused for good while switched is kept on the asked wallet', async (_, charge, replies) => {
    await walletBHolds()
    const { deps } = harness({ pending: ok({ charges: [charge] }), ...replies })
    expect(await recoverPurchases(switchOn(deps, CONFIRM[charge.kind]))).toBeNull()
    const held = charge.kind === 'name' ? await loadPending('name', 'w_a') : await loadPendingPurchase('w_a')
    expect(held).toMatchObject({ reference: charge.reference, refusedForGood: true })
    await walletBUntouched()
  })

  test.each([
    ['name', NAME_CHARGE, { name: REPAID }],
    ['year', TIER_CHARGE, { tier: YEAR_REPAID }],
  ] as const)('a %s given back while switched is given up from the asked wallet, its line kept there', async (_, charge, replies) => {
    await walletBHolds()
    const { deps } = harness({ pending: ok({ charges: [charge] }), ...replies })
    expect(await recoverPurchases(switchOn(deps, CONFIRM[charge.kind]))).toBeNull()
    const file = charge.kind === 'name' ? STORE : YEARS
    expect((await slots(file)).w_a).toBeUndefined()
    expect((await listLines('w_a')).map(line => line.reference)).toEqual([charge.reference])
    await walletBUntouched()
  })

  test.each([
    ['name', NAME_CHARGE],
    ['year', TIER_CHARGE],
  ] as const)('a %s granted while switched is cleared from the asked wallet, and no card goes up', async (_, charge) => {
    await walletBHolds()
    const { deps } = harness({ pending: ok({ charges: [charge] }) })
    expect(await recoverPurchases(switchOn(deps, CONFIRM[charge.kind]))).toBeNull()
    const file = charge.kind === 'name' ? STORE : YEARS
    expect((await slots(file)).w_a).toBeUndefined()
    await walletBUntouched()
  })

  // The grant takes back a refusal for good on the asked wallet's proof, which stays while its name
  // waits on the address screen.
  test('a grant while switched takes the refusal back on the asked wallet', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-name', amountSats: 12821 })
    await recordRefusal('name', 'ref-name', true)
    await walletBHolds()
    jest.mocked(sparkGetLnAddress).mockResolvedValue({ username: 'other', address: `other@${BUILD}`, lnurl: 'lnurl1' })
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    expect(await recoverPurchases(switchOn(deps, CONFIRM.name))).toBeNull()
    const held = await loadPending('name', 'w_a')
    expect(held).toMatchObject({ reference: 'ref-name' })
    expect(held).not.toHaveProperty('refusedForGood')
    await walletBUntouched()
  })

  test('a charge the gateway calls expired is dropped from the asked wallet only', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-dead', amountSats: 1 })
    await savePendingPurchase({ host: SOLD_ON, reference: 'ref-dead-year', amountSats: 1 })
    await walletBHolds()
    const { deps } = harness({ pending: ok({ charges: [], expired: ['ref-dead', 'ref-dead-year'] }) })
    expect(await recoverPurchases(switchOn(deps, '/api/charges/pending'))).toBeNull()
    expect((await slots(STORE)).w_a).toBeUndefined()
    expect((await slots(YEARS)).w_a).toBeUndefined()
    await walletBUntouched()
  })

  // What the asked wallet's proof last heard is read from that proof, also while the registry names
  // another wallet; the switch back before the card leaves the card to show it.
  test.each([
    ['name', [NAME_CHARGE, TIER_CHARGE], CONFIRM.name, CONFIRM.tier],
    ['year', [TIER_CHARGE, NAME_CHARGE], CONFIRM.tier, CONFIRM.name],
  ] as const)('a %s refused before is read on the asked wallet while switched away', async (_, charges, away, back) => {
    const first = charges[0]!
    if (first.kind === 'name') {
      await savePending({ kind: 'name', subject: first.subject, reference: first.reference, amountSats: first.amountSats })
      await recordRefusal('name', first.reference, true)
    } else {
      await savePendingPurchase({ host: first.subject, reference: first.reference, amountSats: first.amountSats })
      await recordPurchaseRefusal(first.reference, true)
    }
    const { deps } = harness({ pending: ok({ charges }) })
    switchOn(deps, away, 'w_b', true)
    switchOn(deps, back, 'w_a')
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'stuck', reference: first.reference })
  })

  // The release marks the record given up before it clears it, so a clear that does not land still
  // leaves a record every reader answers as no proof. Each write that takes the asked wallet's record
  // out is refused here, so only the mark shows.
  test.each([
    ['name', NAME_CHARGE, { name: REPAID }, STORE],
    ['year', TIER_CHARGE, { tier: YEAR_REPAID }, YEARS],
  ] as const)('a %s given back while switched is marked given up on the asked wallet when its clear fails', async (_, charge, replies, file) => {
    await walletBHolds()
    const writeFile = RNFS.writeFile
    const refuse = jest.spyOn(RNFS, 'writeFile').mockImplementation(async (path: string, text: string, encoding?: string) => {
      if (path.startsWith(file)) {
        const next = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>
        if (next.w_a === undefined || (charge.kind === 'name' && next.w_a.name === undefined)) {
          throw new Error('ENOSPC')
        }
      }
      return writeFile(path, text, encoding)
    })
    try {
      const { deps } = harness({ pending: ok({ charges: [charge] }), ...replies })
      expect(await recoverPurchases(switchOn(deps, CONFIRM[charge.kind]))).toBeNull()
    } finally {
      refuse.mockRestore()
    }
    const kept = (await slots(file)).w_a as Record<string, unknown>
    const record = charge.kind === 'name' ? (kept.name as Record<string, unknown>) : kept
    expect(record).toMatchObject({ reference: charge.reference, refusedForGood: true, finalAnswer: 'repaid' })
    expect(charge.kind === 'name' ? await loadPending('name', 'w_a') : await loadPendingPurchase('w_a')).toBeNull()
    await walletBUntouched()
  })

  // The registry answers the asked wallet to both looks the card takes before and after its claim, and
  // the wallet switched to from then on, so a release that resolved the wallet would give up the slot
  // of the wallet switched to.
  test('a kept line the card says gives up the asked wallet slot, though the registry moves after the claim', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-name', amountSats: 12821 })
    await noteLine({ kind: 'name', reference: 'ref-name', answer: 'repaid', subject: `bakery@${SOLD_ON}` }, scopeOn('w_a'))
    await RNFS.writeFile(ASKED, JSON.stringify({ w_a: { at: NOW, open: false } }), 'utf8')
    registry().mockResolvedValueOnce('w_a').mockResolvedValueOnce('w_a').mockResolvedValue('w_b')
    const { deps } = harness({})
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'repaid', reference: 'ref-name' })
    expect((await slots(STORE)).w_a).toBeUndefined()
  })

  test('a registry that cannot be read when the card is chosen puts no card up', async () => {
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
    deps.request = (async (url: string, init: RequestInit) => {
      if (url.includes(CONFIRM.name)) {
        registry().mockRejectedValue(new Error('unreadable'))
      }
      return request(url, init)
    }) as unknown as typeof fetch
    expect(await recoverPurchases(deps)).toBeNull()
    expect(await loadPending('name', 'w_a')).toBeNull()
  })

  // The session reconnects to the wallet switched to as the request whose path holds `path` goes out,
  // so the live connection is that wallet's when the name would go on. `registryToo` false leaves the
  // registry on the asked wallet, as a switch there and back before the card would.
  function reconnectOn(deps: RecoverDeps, path: string, registryToo = true): RecoverDeps {
    if (registryToo) {
      switchOn(deps, path)
    }
    const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
    deps.request = (async (url: string, init: RequestInit) => {
      if (url.includes(path)) {
        jest.mocked(sparkConnectedWalletId).mockReturnValue('w_b')
      }
      return request(url, init)
    }) as unknown as typeof fetch
    return deps
  }

  // A register on the live connection would sign with the wallet switched to: a name the gateway gives
  // that key for free would land there, and the clear after it would drop the asked wallet's proof.
  test('a name granted after a reconnect to the wallet switched to registers nothing and keeps the asked wallet proof', async () => {
    await walletBHolds()
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    expect(await recoverPurchases(reconnectOn(deps, CONFIRM.name))).toBeNull()
    expect(sparkGetLnAddress).not.toHaveBeenCalled()
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    expect(await loadPending('name', 'w_a')).toMatchObject({ reference: 'ref-name', amountSats: 12821 })
    await walletBUntouched()
  })

  test('a name granted while the session is on another wallet is left waiting with its proof', async () => {
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    expect(await recoverPurchases(reconnectOn(deps, CONFIRM.name, false))).toMatchObject({
      status: 'waiting',
      reference: 'ref-name',
    })
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    expect(await loadPending('name', 'w_a')).toMatchObject({ reference: 'ref-name' })
  })

  // A holder's answer releases the slot whatever the take found, as an address in use does, and its
  // line is kept for the asked wallet.
  test('a name paid again after a reconnect to the wallet switched to registers nothing', async () => {
    const { deps } = harness({
      pending: ok({ charges: [NAME_CHARGE] }),
      name: ok({ paid: true, entitled: true, paidAgain: true }),
    })
    expect(await recoverPurchases(reconnectOn(deps, CONFIRM.name))).toBeNull()
    expect(sparkGetLnAddress).not.toHaveBeenCalled()
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    expect((await listLines('w_a')).map(line => line.reference)).toEqual(['ref-name'])
  })

  test('control: a name granted with no switch goes on the asked wallet and its proof is cleared', async () => {
    await walletBHolds()
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }) })
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'ready', reference: 'ref-name' })
    expect(jest.mocked(sparkRegisterLnAddress).mock.calls.map(([name]) => name)).toEqual(['bakery'])
    expect((await slots(STORE)).w_a).toBeUndefined()
    await walletBUntouched()
  })

  // Home hands back a card it dropped before painting it (HomeScreen, giveBack), and its line returns to
  // the list of the wallet the sweep asked about, once.
  test('a line card handed back returns to the asked wallet list once, whichever wallet is active', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-name', amountSats: 12821 })
    await noteLine({ kind: 'name', reference: 'ref-name', answer: 'repaid', subject: `bakery@${SOLD_ON}` }, scopeOn('w_a'))
    await RNFS.writeFile(ASKED, JSON.stringify({ w_a: { at: NOW, open: false } }), 'utf8')
    const { deps } = harness({})
    const card = await recoverPurchases(deps)
    expect(card).toMatchObject({ status: 'repaid', reference: 'ref-name' })
    expect(await listLines('w_a')).toEqual([])
    registry().mockResolvedValue('w_b')
    await putBackCard(card)
    expect((await listLines('w_a')).map(line => line.reference)).toEqual(['ref-name'])
    expect(await listLines('w_b')).toEqual([])
    // The next reader says it, and the same card handed back again brings nothing back.
    expect(await claimLine('ref-name', scopeOn('w_a'))).toMatchObject({ outcome: 'claimed' })
    await putBackCard(card)
    expect(await listLines('w_a')).toEqual([])
  })

  // The sweep's wallet removed, or its data deleted, while the card was out: Home's hand-back comes
  // after the forget and must not bring the line back under that id.
  test('a line card handed back after its wallet was forgotten brings no line back', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-name', amountSats: 12821 })
    await noteLine({ kind: 'name', reference: 'ref-name', answer: 'repaid', subject: `bakery@${SOLD_ON}` }, scopeOn('w_a'))
    await RNFS.writeFile(ASKED, JSON.stringify({ w_a: { at: NOW, open: false } }), 'utf8')
    const { deps } = harness({})
    const card = await recoverPurchases(deps)
    expect(card).toMatchObject({ status: 'repaid', reference: 'ref-name' })
    registry().mockResolvedValue('w_b')
    await forgetWalletLines('w_a')
    await putBackCard(card)
    expect(await listLines('w_a')).toEqual([])
    expect(await listLines('w_b')).toEqual([])
  })

  // A sweep still out when its wallet is removed or its data deleted writes nothing more for that
  // wallet: not the line of an answer heard after the forget, and not the shown mark of a claim made
  // after it. The released-lines file is the one place either would land.
  const LINES = `${RNFS.DocumentDirectoryPath}/released-lines.json`

  test('an answer heard after its wallet was forgotten is not kept for it', async () => {
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: REPAID })
    const request = deps.request as unknown as (url: string, init: RequestInit) => Promise<Response>
    deps.request = (async (url: string, init: RequestInit) => {
      if (url.includes(CONFIRM.name)) {
        await forgetWalletLines('w_a')
      }
      return request(url, init)
    }) as unknown as typeof fetch
    expect(await recoverPurchases(deps)).toBeNull()
    expect(await listLines('w_a')).toEqual([])
    expect(await RNFS.exists(LINES)).toBe(false)
  })

  test('a line the sweep listed and claims after its wallet was forgotten leaves no mark', async () => {
    await noteLine({ kind: 'name', reference: 'ref-name', answer: 'repaid', subject: `bakery@${SOLD_ON}` }, scopeOn('w_a'))
    await RNFS.writeFile(ASKED, JSON.stringify({ w_a: { at: NOW, open: false } }), 'utf8')
    const { deps } = harness({})
    // Queued in the list's turn ahead of the claim, after the sweep listed the line.
    let forgot: Promise<void> = Promise.resolve()
    deps.onScreen = () => {
      forgot = forgetWalletLines('w_a')
      return true
    }
    expect(await recoverPurchases(deps)).toBeNull()
    await forgot
    expect(await RNFS.exists(LINES)).toBe(false)
  })

  // The caller read the scope as it picked the wallet (HomeScreen, sweep), and the forget ran after the
  // pick and before the sweep started. The sweep keeps nothing for that wallet, and claims nothing
  // there either, a line noted after the forget included, which stays listed for the next reader.
  test('a sweep whose wallet was forgotten after its caller picked it keeps nothing', async () => {
    const { deps, calls } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: REPAID })
    await forgetWalletLines('w_a')
    expect(await recoverPurchases(deps)).toBeNull()
    expect(calls.filter(c => c.url.includes(CONFIRM.name))).toHaveLength(1)
    expect(await RNFS.exists(LINES)).toBe(false)
  })

  test('a sweep whose wallet was forgotten after its caller picked it claims no line noted since', async () => {
    const { deps } = harness({})
    await forgetWalletLines('w_a')
    const since = { kind: 'name' as const, reference: 'ref-name', answer: 'repaid' as const, subject: `bakery@${SOLD_ON}` }
    await noteLine(since, scopeOn('w_a'))
    await RNFS.writeFile(ASKED, JSON.stringify({ w_a: { at: NOW, open: false } }), 'utf8')
    expect(await recoverPurchases(deps)).toBeNull()
    expect(JSON.parse(await RNFS.readFile(LINES, 'utf8'))).toEqual({ w_a: [since] })
  })

  test('control: with no forget the sweep keeps the answer and claims it for its card', async () => {
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: REPAID })
    expect(await recoverPurchases(deps)).toMatchObject({ status: 'repaid', reference: NAME_CHARGE.reference })
    expect(JSON.parse(await RNFS.readFile(LINES, 'utf8'))).toEqual({
      w_a: [{ reference: NAME_CHARGE.reference, shown: true }],
    })
  })

  test('a card that is no kept line hands nothing back', async () => {
    const { deps } = harness({ pending: ok({ charges: [NAME_CHARGE] }), name: NOT_YET })
    const card = await recoverPurchases(deps)
    expect(card).toMatchObject({ status: 'settling', reference: 'ref-name' })
    await putBackCard(card)
    await putBackCard(null)
    expect(await listLines('w_a')).toEqual([])
  })
})
