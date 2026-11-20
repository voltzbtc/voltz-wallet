import RNFS from 'react-native-fs'
import {
  domainStateMessage,
  phaseOf,
  readDomainState,
  type DomainStateDeps,
} from '../src/wallet/domainTier'
import { setDomainFor } from '../src/wallet/lnurlDomainPref'

// The build domain the app ships with. Everything hangs off the difference between it and a domain
// the customer bought.
jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app' }))

const BUILD = 'usevoltz.app'
const HOST = 'pay.bakery.com.br'
const PUBKEY = `02${'a'.repeat(64)}`
const CACHE = `${RNFS.DocumentDirectoryPath}/domain-tier.json`
const NOW_MS = 1_700_000_000_000
const NOW = 1_700_000_000
const DAY = 86_400

const LIVE = {
  host: HOST,
  role: 'owner',
  kind: 'customer',
  expiresAt: NOW + 10 * DAY,
  frozenAt: null,
  transferSeq: 3,
  serverNow: NOW,
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function refused(status: number): Response {
  return { ok: false, status, json: async () => ({ error: 'nope' }) } as unknown as Response
}

type Call = { url: string; body: Record<string, unknown> }

function harness(
  answer: () => Promise<Response>,
  over: Partial<DomainStateDeps> = {},
): { deps: DomainStateDeps; calls: Call[]; signed: string[] } {
  const calls: Call[] = []
  const signed: string[] = []
  const deps: DomainStateDeps = {
    walletId: 'primary',
    pubkey: PUBKEY,
    sign: async message => {
      signed.push(message)
      return 'deadbeef'
    },
    now: () => NOW_MS,
    request: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return answer()
    }) as unknown as typeof fetch,
    ...over,
  }
  return { deps, calls, signed }
}

const answering = (response: Response) => async () => response
const failing = () => async () => {
  throw new Error('Network request failed')
}

async function cacheFile(): Promise<string | null> {
  return (await RNFS.exists(CACHE)) ? RNFS.readFile(CACHE, 'utf8') : null
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

describe('the signed statement', () => {
  // Byte-identical to the gateway's domain state message. Written against a literal rather than
  // against the function, because a test that rebuilds it agrees with any order.
  it('pins the version, the action, the host and the key, in that order', () => {
    expect(domainStateMessage(HOST, PUBKEY, 1700)).toBe(
      `voltz-domain:v1\nstate\n${HOST}\n${PUBKEY}\n1700`,
    )
  })

  it('signs the seconds it sends, so the gateway validity window matches', async () => {
    await setDomainFor('primary', HOST)
    const { deps, calls, signed } = harness(answering(ok(LIVE)))
    await readDomainState(deps)
    expect(signed).toEqual([domainStateMessage(HOST, PUBKEY, NOW)])
    expect(calls[0]!.body.timestamp).toBe(NOW)
  })
})

describe('a wallet on the shared domain', () => {
  // A wallet with no domain of its own still asks once, because a wallet restored from a seed has no
  // preference either and would otherwise never find what it paid for. What must not happen is a
  // request on every screen open, since almost every wallet owns nothing and is told exactly that
  // forever.
  it('asks what its key holds, once, and then costs nothing for a day', async () => {
    const first = harness(answering(ok({ domains: [], serverNow: NOW })))
    expect(await readDomainState(first.deps)).toBeNull()
    expect(first.calls).toHaveLength(1)
    expect(first.signed[0]).toContain('state-mine')

    const second = harness(answering(ok({ domains: [], serverNow: NOW })))
    expect(await readDomainState(second.deps)).toBeNull()
    expect(second.calls).toEqual([])
    expect(second.signed).toEqual([])
  })

  // Returning to the shared domain has to silence the card immediately, not on the next answer.
  it('stays silent after the wallet is pointed back at the build domain', async () => {
    await setDomainFor('primary', HOST)
    const first = harness(answering(ok(LIVE)))
    await readDomainState(first.deps)
    await setDomainFor('primary', BUILD)
    const second = harness(answering(ok(LIVE)))
    expect(await readDomainState(second.deps)).toBeNull()
    expect(second.calls).toEqual([])
  })
})

describe('a successful read', () => {
  it('is addressed at the build domain and carries the customer host in the body', async () => {
    await setDomainFor('primary', HOST)
    const { deps, calls } = harness(answering(ok(LIVE)))
    expect(await readDomainState(deps)).toEqual(LIVE)
    // A frozen host is off the edge, so a request addressed there never arrives.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://${BUILD}/api/domain/state`)
    expect(calls[0]!.url).not.toContain(HOST)
    expect(calls[0]!.body).toMatchObject({ host: HOST, pubkey: PUBKEY, signature: 'deadbeef' })
  })

  it('serves a frozen domain, which is the state the address cannot describe', async () => {
    await setDomainFor('primary', HOST)
    const frozen = { ...LIVE, expiresAt: NOW - 40 * DAY, frozenAt: NOW - 39 * DAY }
    const { deps } = harness(answering(ok(frozen)))
    const state = await readDomainState(deps)
    expect(state).not.toBeNull()
    expect(phaseOf(state!, state!.serverNow)).toBe('frozen')
  })
})

describe('a refusal', () => {
  it('reads as nothing to say rather than an error, on 404', async () => {
    await setDomainFor('primary', HOST)
    const { deps } = harness(answering(refused(404)))
    await expect(readDomainState(deps)).resolves.toBeNull()
  })

  it('reads as nothing to say rather than an error, on 403', async () => {
    await setDomainFor('primary', HOST)
    const { deps } = harness(answering(refused(403)))
    await expect(readDomainState(deps)).resolves.toBeNull()
  })

  // A handover leaves the outgoing wallet pointed at a domain that is no longer its own. Keeping the
  // old answer would keep offering it a renewal it cannot make.
  it('drops the cached answer, unlike a network that merely failed', async () => {
    await setDomainFor('primary', HOST)
    await readDomainState(harness(answering(ok(LIVE))).deps)
    await readDomainState(harness(answering(refused(403))).deps)
    expect(await readDomainState(harness(failing()).deps)).toBeNull()
  })
})

describe('a read that did not arrive', () => {
  it('serves the last answer and leaves it untouched', async () => {
    await setDomainFor('primary', HOST)
    await readDomainState(harness(answering(ok(LIVE))).deps)
    const written = await cacheFile()
    const state = await readDomainState(harness(failing()).deps)
    expect(state).toMatchObject({ role: 'owner', expiresAt: LIVE.expiresAt, transferSeq: 3 })
    expect(await cacheFile()).toBe(written)
  })

  // A gateway that answered 500 knows nothing about who owns what, so it is read as an absent
  // network rather than as a refusal, and the last answer stands.
  it('treats a server error as an absent network, keeping the last answer', async () => {
    await setDomainFor('primary', HOST)
    await readDomainState(harness(answering(ok(LIVE))).deps)
    const written = await cacheFile()
    const state = await readDomainState(harness(answering(refused(500))).deps)
    expect(state).toMatchObject({ role: 'owner', expiresAt: LIVE.expiresAt })
    expect(await cacheFile()).toBe(written)
  })

  it('says nothing when there is no last answer', async () => {
    await setDomainFor('primary', HOST)
    expect(await readDomainState(harness(failing()).deps)).toBeNull()
    expect(await cacheFile()).toBeNull()
  })

  it('says nothing when a signature cannot be made', async () => {
    await setDomainFor('primary', HOST)
    const { deps } = harness(answering(ok(LIVE)), {
      sign: async () => {
        throw new Error('not connected')
      },
    })
    expect(await readDomainState(deps)).toBeNull()
  })

  // The stored clock is the clock of that read. Served back untouched it would stop time, and a
  // domain that lapsed while the phone was offline would keep reading as ending.
  it('ages the answer, so a stale one is never presented as fresh', async () => {
    await setDomainFor('primary', HOST)
    await readDomainState(harness(answering(ok(LIVE))).deps)
    const later = NOW_MS + 40 * DAY * 1000
    const state = await readDomainState(harness(failing(), { now: () => later }).deps)
    expect(state!.serverNow).toBe(NOW + 40 * DAY)
    expect(phaseOf(state!, state!.serverNow)).toBe('expired')
  })

  it('never rewinds when the device clock moves backwards', async () => {
    await setDomainFor('primary', HOST)
    await readDomainState(harness(answering(ok(LIVE))).deps)
    const earlier = NOW_MS - 90 * DAY * 1000
    const state = await readDomainState(harness(failing(), { now: () => earlier }).deps)
    expect(state!.serverNow).toBe(NOW)
  })

  it('never serves another wallet its neighbour answer', async () => {
    await setDomainFor('primary', HOST)
    await readDomainState(harness(answering(ok(LIVE))).deps)
    await setDomainFor('segunda', HOST)
    const { deps } = harness(failing(), { walletId: 'segunda' })
    expect(await readDomainState(deps)).toBeNull()
  })

  it('never serves an answer read for a domain this wallet has left', async () => {
    await setDomainFor('primary', HOST)
    await readDomainState(harness(answering(ok(LIVE))).deps)
    await setDomainFor('primary', 'pay.other.com.br')
    expect(await readDomainState(harness(failing()).deps)).toBeNull()
  })
})

describe('a reply that is not whole', () => {
  const without = (field: string) => {
    const body: Record<string, unknown> = { ...LIVE }
    delete body[field]
    return body
  }

  it.each(['serverNow', 'role', 'kind'])('is refused when %s is missing', async field => {
    await setDomainFor('primary', HOST)
    const { deps } = harness(answering(ok(without(field))))
    expect(await readDomainState(deps)).toBeNull()
    expect(await cacheFile()).toBeNull()
  })

  it('is refused when the role is a word nobody defined', async () => {
    await setDomainFor('primary', HOST)
    const { deps } = harness(answering(ok({ ...LIVE, role: 'admin' })))
    expect(await readDomainState(deps)).toBeNull()
  })

  it('leaves the last whole answer in place', async () => {
    await setDomainFor('primary', HOST)
    await readDomainState(harness(answering(ok(LIVE))).deps)
    const written = await cacheFile()
    const state = await readDomainState(harness(answering(ok(without('serverNow')))).deps)
    expect(state).toMatchObject({ role: 'owner', expiresAt: LIVE.expiresAt })
    expect(await cacheFile()).toBe(written)
  })

  // Dates are the lenient half on purpose: a missing one reads as working, and alarming an owner
  // whose domain is fine costs more than a card that arrives one read later.
  it('accepts a body with no dates and reads it as working', async () => {
    await setDomainFor('primary', HOST)
    const { deps } = harness(answering(ok({ host: HOST, role: 'owner', kind: 'customer', serverNow: NOW })))
    const state = await readDomainState(deps)
    expect(state).toEqual({
      host: HOST,
      role: 'owner',
      kind: 'customer',
      expiresAt: null,
      frozenAt: null,
      transferSeq: 0,
      serverNow: NOW,
    })
    expect(phaseOf(state!, NOW)).toBe('fine')
  })
})
