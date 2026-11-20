import {
  domainTransferAcceptMessage,
  domainTransferMessage,
  moveDomain,
  type DomainMove,
  type DomainMoveDeps,
  type DomainMoveStep,
} from '../src/wallet/domainMove'

const HOST = 'pay.bakery.com.br'
const GATEWAY = 'https://usevoltz.app'
const NOW_MS = 1_700_000_000_000
const NOW = 1_700_000_000
const SEQ = 3

function ok(body: unknown = { moved: true, transferSeq: SEQ + 1 }): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function refused(status: number, error: string): Response {
  return { ok: false, status, json: async () => ({ error }) } as unknown as Response
}

function move(over: Partial<DomainMove> = {}): DomainMove {
  return { host: HOST, fromWalletId: 'A', toWalletId: 'B', transferSeq: SEQ, frozen: false, ...over }
}

type Call = { url: string; body: Record<string, unknown> }

// `refuse` names which switch the SDK cannot make, by wallet and by how many times that wallet has
// been asked for, since the walk asks for the target twice and only the second one is leg three.
// A refused switch leaves `connected` where it was, because nothing was reconnected.
function harness(
  answer: () => Promise<Response> = async () => ok(),
  over: Partial<DomainMoveDeps> = {},
  refuse?: (walletId: string, nth: number) => boolean,
): {
  deps: DomainMoveDeps
  trail: string[]
  steps: DomainMoveStep[]
  calls: Call[]
  adopted: string[]
  connectedTo: () => string
} {
  const trail: string[] = []
  const steps: DomainMoveStep[] = []
  const calls: Call[] = []
  const adopted: string[] = []
  const asked: Record<string, number> = {}
  let connected = 'A'
  const deps: DomainMoveDeps = {
    gatewayUrl: GATEWAY,
    identity: async () => `pub-${connected}`,
    switchTo: async id => {
      asked[id] = (asked[id] ?? 0) + 1
      if (refuse?.(id, asked[id]!)) {
        throw new Error('no connection')
      }
      connected = id
      trail.push(`switch:${id}`)
    },
    // The action word and the connected wallet are what every assertion here is about: which half of
    // the handover was signed, and by which key the gateway will check it against.
    sign: async message => {
      trail.push(`sign:${message.split('\n')[1]}@${connected}`)
      return `sig-${connected}`
    },
    adopt: async (walletId, host) => {
      adopted.push(`${walletId}@${host}`)
    },
    onStep: step => steps.push(step),
    now: () => NOW_MS,
    request: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return answer()
    }) as unknown as typeof fetch,
    ...over,
  }
  return { deps, trail, steps, calls, adopted, connectedTo: () => connected }
}

// The gateway's transfer statements are the specification. Written out as literals rather than built
// from the same helpers, because a test that calls the code it checks agrees with any wording.
test('the two statements are the ones the gateway verifies, and neither is the other', () => {
  expect(domainTransferMessage(HOST, 'pub-A', 'pub-B', SEQ, NOW)).toBe(
    `voltz-domain:v1\ntransfer\n${HOST}\npub-A\npub-B\n3\n${NOW}`,
  )
  expect(domainTransferAcceptMessage(HOST, 'pub-B', 'pub-A', SEQ, NOW)).toBe(
    `voltz-domain:v1\ntransfer-accept\n${HOST}\npub-B\npub-A\n3\n${NOW}`,
  )
  // Two forms exist because an offer replayed as an acceptance would let one signature do both
  // halves of a handover.
  expect(domainTransferMessage(HOST, 'pub-A', 'pub-B', SEQ, NOW)).not.toBe(
    domainTransferAcceptMessage(HOST, 'pub-A', 'pub-B', SEQ, NOW),
  )
})

test('the walk visits target, origin, target, and each half is signed where it will be checked', async () => {
  // The SDK signs with whatever wallet is connected. The target key can only be read on the target,
  // the offer can only be signed by the owner, and the acceptance only by the wallet receiving it,
  // so every leg reconnects. A leg that skips the reconnect signs with the previous wallet, which
  // is the failure that makes a lightning address transfer fail on every attempt.
  const h = harness()

  await expect(moveDomain(h.deps, move())).resolves.toBe(SEQ + 1)

  expect(h.trail).toEqual([
    'switch:B',
    'switch:A',
    'sign:transfer@A',
    'switch:B',
    'sign:transfer-accept@B',
  ])
  expect(h.calls[0]!.body).toMatchObject({
    fromPubkey: 'pub-A',
    toPubkey: 'pub-B',
    fromSignature: 'sig-A',
    toSignature: 'sig-B',
  })
})

test('the request carries the whole statement, addressed at the shared gateway', async () => {
  const h = harness()

  await moveDomain(h.deps, move())

  expect(h.calls).toHaveLength(1)
  // The call never goes to the customer's own hostname, because a frozen domain is off the edge and
  // a handover sent there could not arrive at all.
  expect(h.calls[0]!.url).toBe(`${GATEWAY}/api/domain/transfer`)
  expect(h.calls[0]!.body).toEqual({
    host: HOST,
    fromPubkey: 'pub-A',
    toPubkey: 'pub-B',
    transferSeq: SEQ,
    timestamp: NOW,
    fromSignature: 'sig-A',
    toSignature: 'sig-B',
  })
})

test('the sequence read with the domain state is the one signed on both sides', async () => {
  // The sequence is what kills the replay, so it has to be inside both signatures and match the one
  // sent. A signature over a different number is refused, and one sent without it is replayable.
  const signed: string[] = []
  const h = harness(undefined, {
    sign: async message => {
      signed.push(message)
      return 'sig'
    },
  })

  await moveDomain(h.deps, move({ transferSeq: 7 }))

  expect(signed).toHaveLength(2)
  expect(signed.every(message => message.split('\n')[5] === '7')).toBe(true)
  expect(h.calls[0]!.body.transferSeq).toBe(7)
})

test('moving to the wallet that already holds the domain is refused before anything happens', async () => {
  const h = harness()

  await expect(moveDomain(h.deps, move({ toWalletId: 'A' }))).rejects.toThrow('same_wallet')
  expect(h.trail).toEqual([])
  expect(h.calls).toEqual([])
})

test('a sequence the gateway calls stale is reported, and nothing is adopted', async () => {
  // Somebody moved this domain while the screen was open. Signing again with a fresher number would
  // hand over a domain in a state the owner never saw.
  const h = harness(async () => refused(409, 'stale_transfer_seq'))

  await expect(moveDomain(h.deps, move())).rejects.toThrow('stale_transfer_seq')
  expect(h.adopted).toEqual([])
  expect(h.connectedTo()).toBe('A')
})

test('a target whose key cannot be read leaves the device on the origin and sends nothing', async () => {
  const h = harness(undefined, {
    identity: async () => {
      throw new Error('operator timed out')
    },
  })

  await expect(moveDomain(h.deps, move())).rejects.toThrow('operator timed out')
  // Nothing was signed, so the domain is still the origin's, and the origin is where its renewal and
  // its unfinished purchases can be seen.
  expect(h.connectedTo()).toBe('A')
  expect(h.trail).toEqual(['switch:B', 'switch:A'])
  expect(h.calls).toEqual([])
})

test('an offer the origin refuses to sign leaves the device on the origin and sends nothing', async () => {
  const h = harness(undefined, {
    sign: async () => {
      throw new Error('refused')
    },
  })

  await expect(moveDomain(h.deps, move())).rejects.toThrow('refused')
  // The whole trail is asserted, not just which wallet is connected, because the refusal happens on
  // the origin, so the device is sitting there either way and the return leg would go unnoticed.
  expect(h.trail).toEqual(['switch:B', 'switch:A', 'switch:A'])
  expect(h.calls).toEqual([])
})

test('a target that cannot be reconnected for its half never reaches the gateway', async () => {
  // Leg three only. The first switch to the target succeeds, so this is the wallet dropping off
  // between the offer and the acceptance, which is the case that would otherwise sign the acceptance
  // with the outgoing owner's key.
  const h = harness(undefined, {}, (id, nth) => id === 'B' && nth === 2)

  await expect(moveDomain(h.deps, move())).rejects.toThrow('no connection')
  expect(h.calls).toEqual([])
  expect(h.trail).toEqual(['switch:B', 'switch:A', 'sign:transfer@A', 'switch:A'])
  expect(h.connectedTo()).toBe('A')
})

test('the reason the move failed survives a way back that fails too', async () => {
  // Reporting the return leg would replace a reason the owner can act on with one about a leg they
  // never asked for. Left on the target, which the wallet picker moves off, and nothing was signed.
  const h = harness(
    undefined,
    {
      identity: async () => {
        throw new Error('operator timed out')
      },
    },
    id => id === 'A',
  )

  await expect(moveDomain(h.deps, move())).rejects.toThrow('operator timed out')
  expect(h.connectedTo()).toBe('B')
})

test('a live domain points the new owner at it', async () => {
  const h = harness()

  await moveDomain(h.deps, move())

  expect(h.adopted).toEqual([`B@${HOST}`])
  // The wallet the domain now belongs to is the one left connected, and the one the owner is
  // looking at.
  expect(h.connectedTo()).toBe('B')
})

test('a frozen domain moves without pointing the new owner at a hostname that is off the edge', async () => {
  // The hostname has been removed, so every address claim against it fails and the new owner would
  // end with no address at all. The renewal writes the preference once the domain is back.
  const h = harness()

  await expect(moveDomain(h.deps, move({ frozen: true }))).resolves.toBe(SEQ + 1)

  expect(h.adopted).toEqual([])
  expect(h.calls).toHaveLength(1)
})

test('a domain the gateway moved stays moved when the preference cannot be written', async () => {
  // The handover already happened. Reporting it as failed would tell the owner to try again, and the
  // second attempt is refused as stale, which reads as the domain having been taken by someone else.
  const h = harness(undefined, {
    adopt: async () => {
      throw new Error('no space left on device')
    },
  })

  await expect(moveDomain(h.deps, move())).resolves.toBe(SEQ + 1)
  expect(h.connectedTo()).toBe('B')
})

test('a reply without the new sequence is still a move', async () => {
  const h = harness(async () => ok({ moved: true }))

  await expect(moveDomain(h.deps, move())).resolves.toBeNull()
  expect(h.adopted).toEqual([`B@${HOST}`])
})

test('each leg is reported, so a slow reconnect does not read as a hang', async () => {
  const h = harness()

  await moveDomain(h.deps, move())

  expect(h.steps).toEqual(['reading-target', 'signing', 'claiming'])
})
