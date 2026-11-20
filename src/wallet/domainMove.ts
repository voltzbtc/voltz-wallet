// Handing a customer domain from one wallet to another. The gateway's /api/domain/transfer handler
// rebuilds both statements to verify them, so they must stay byte-identical or every request is
// answered as an invalid signature. Its own namespace keeps a signature made here from being
// replayed against the LNURL server's `breez-lnurl:` routes.
const VERSION = 'voltz-domain:v1'

// Two statements with different action words, so neither can stand in for the other: the outgoing
// owner's offer must never verify as the incoming wallet's acceptance. The wallet keys are in
// opposite order for the same reason, so the two forms differ even before the action word is read.
//
// The sequence is inside both. Without it, the wallet that received the domain can hand it back and
// then replay the original pair inside the gateway's validity window to take it again.
export function domainTransferMessage(
  host: string,
  fromPubkey: string,
  toPubkey: string,
  transferSeq: number,
  timestamp: number,
): string {
  const seq = String(transferSeq)
  return [VERSION, 'transfer', host, fromPubkey, toPubkey, seq, String(timestamp)].join('\n')
}

export function domainTransferAcceptMessage(
  host: string,
  toPubkey: string,
  fromPubkey: string,
  transferSeq: number,
  timestamp: number,
): string {
  const seq = String(transferSeq)
  return [VERSION, 'transfer-accept', host, toPubkey, fromPubkey, seq, String(timestamp)].join('\n')
}

export type DomainMoveStep = 'reading-target' | 'signing' | 'claiming'

export type DomainMoveDeps = {
  /** Addressed at the shared build domain, never at the customer's own hostname, because a frozen
   * domain is off the edge, so a request sent there cannot arrive and the owner could not hand it
   * over. */
  gatewayUrl: string
  /** Identity key of the wallet currently connected. */
  identity: () => Promise<string>
  /** Connects the SDK to another wallet and waits for it. It is never the switch that only
   * repoints the registry, because the SDK signs with whatever is connected, and a leg run on the
   * previous wallet produces a signature the gateway refuses. */
  switchTo: (walletId: string) => Promise<void>
  /** Signs as `as`, the pubkey sent beside the signature, and refuses when the wallet connected is
   * another, so a leg that lands on the wrong wallet sends nothing rather than its signature. */
  sign: (message: string, as: string) => Promise<string>
  /** Points the wallet that now owns the domain at it and reconnects, so its addresses are served
   * there. It is best effort, since by the time it runs the domain has already moved. */
  adopt: (walletId: string, host: string) => Promise<void>
  /** Reports which leg is running, so a slow reconnect does not look like a hang. */
  onStep?: (step: DomainMoveStep) => void
  now?: () => number
  request?: typeof fetch
}

export type DomainMove = {
  host: string
  fromWalletId: string
  toWalletId: string
  /** From the domain's state read. The gateway refuses a stale one, which means the domain moved
   * while this screen was open, and no fresher value may be substituted here: the person would then
   * be signing away a domain in a state they never saw. */
  transferSeq: number
  /** The hostname has been taken off the edge. Decides whether the target adopts the domain. */
  frozen: boolean
}

async function refuse(response: Response): Promise<never> {
  // The gateway's reason is machine-readable and the screen maps it to a sentence; anything else is
  // reported by status so a failure is never silent.
  let reason = `status ${response.status}`
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') {
      reason = body.error
    }
  } catch {
    // Left as the status.
  }
  throw new Error(reason)
}

// Moves the domain and answers the sequence it now stands at, or null when the reply carried none.
// The target is left connected on success, since that is the wallet the domain now belongs to.
//
// The walk visits the target, the origin and the target again, reconnecting the SDK at every leg.
// The SDK signs with whichever wallet is connected, so a leg that runs on the wrong one produces the
// other wallet's signature: the acceptance would carry the outgoing owner's key and the gateway
// would refuse it. Switching without connecting makes this fail on every attempt.
export async function moveDomain(deps: DomainMoveDeps, move: DomainMove): Promise<number | null> {
  if (move.fromWalletId === move.toWalletId) {
    // Before any switch or request. The gateway refuses `same_wallet` as well, but a handover to
    // itself is two reconnects and a signature pair spent to be told what is known here.
    throw new Error('same_wallet')
  }

  const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
  let moved: number | null
  try {
    // The target's identity key is only readable while connected to it, so the walk starts there.
    deps.onStep?.('reading-target')
    await deps.switchTo(move.toWalletId)
    const toPubkey = await deps.identity()

    // The offer is signed by the wallet that owns the domain, and its key is read on that wallet
    // rather than carried in, so what is signed and what the gateway checks come from one place.
    deps.onStep?.('signing')
    await deps.switchTo(move.fromWalletId)
    const fromPubkey = await deps.identity()
    const fromSignature = await deps.sign(
      domainTransferMessage(move.host, fromPubkey, toPubkey, move.transferSeq, timestamp),
      fromPubkey,
    )

    // Back to the target for its half. A wallet that cannot sign is a wallet nobody is holding, and
    // a domain handed to one would be lost rather than moved.
    deps.onStep?.('claiming')
    await deps.switchTo(move.toWalletId)
    const toSignature = await deps.sign(
      domainTransferAcceptMessage(move.host, toPubkey, fromPubkey, move.transferSeq, timestamp),
      toPubkey,
    )

    const response = await (deps.request ?? fetch)(
      `${deps.gatewayUrl.replace(/\/+$/, '')}/api/domain/transfer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host: move.host,
          fromPubkey,
          toPubkey,
          transferSeq: move.transferSeq,
          timestamp,
          fromSignature,
          toSignature,
        }),
      },
    )
    if (!response.ok) {
      await refuse(response)
    }
    const body = (await response.json().catch(() => ({}))) as { transferSeq?: unknown }
    moved = typeof body.transferSeq === 'number' ? body.transferSeq : null
  } catch (err) {
    // Wherever the walk gave up, the domain is still the origin's, and two of the three legs run on
    // the target. Per wallet state is keyed to whichever wallet is active, so a device left on the
    // target hides the origin's own renewal and its unfinished purchases, and the owner is offered
    // a domain year they already paid for.
    //
    // A request that failed after the gateway committed lands here too, and reports a move that did
    // happen as one that did not. The state read on the next focus is what corrects it, from the
    // only side that knows: the owner rows follow the gateway's answer, not this one.
    //
    // The way back is a switch like any other and can fail. Its failure is dropped so the reason the
    // move failed is the one that reaches the caller, and because a device left on the target is
    // confusing rather than broken, since nothing moved and the wallet picker goes back.
    await deps.switchTo(move.fromWalletId).catch(() => undefined)
    throw err
  }

  // Only while the hostname is up. Pointing a wallet at a frozen domain makes every address claim
  // fail against a host that is not on the edge, and leaves that wallet with no address at all,
  // which is worse than the address it already has. The renewal writes the preference once the
  // domain is back, so this is not the last chance to adopt it.
  if (!move.frozen) {
    // The domain has already moved, so a preference that could not be written must not report the
    // handover as failed. It costs the new owner addresses on the shared domain until the next
    // adoption, never the domain itself.
    await deps.adopt(move.toWalletId, move.host).catch(() => undefined)
  }
  return moved
}
