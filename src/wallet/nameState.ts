import { getBreezLnurlDomain } from '../config'

// What became of the name a wallet last held, asked of the gateway when the SDK reads no address, or,
// for a wallet that remembers no name, what the gateway knows about its key alone.
//
// The SDK cannot tell a name taken back by a refund from a domain that is not answering: its lookup
// reads a cache, and its recovery reads any 404 as "no address". The gateway's POST /api/name/state
// reads the LNURL server's own tables, so it can say which. This module asks, parses and decides; the
// register itself stays in spark.ts, the one module that talks to the SDK.

// `withdrawal` is true when the buyer's own withdrawal took the name back. The name is gone as after a
// refund, so nothing reads it differently; a gateway older than the field sends none, which the parser
// reads as false.
export type TakenBack = { closedBy: 'refund' | 'sandbox_revocation'; closedAt: number; withdrawal?: boolean }
export type HeldBy = 'you' | 'another' | 'nobody'
export type GivenHeldBy = HeldBy

/** The whole /api/name/state body, for the name and host it was asked about. */
export type NameState = {
  host: string
  /** The name asked about, or null for a read about the key alone. */
  name: string | null
  /** The name live for this wallet on the host, or null. */
  live: string | null
  /** Set only when the name asked about was taken back from this wallet and nothing is live on it. */
  takenBack: TakenBack | null
  /** The wallet's first name on the host, the one that stays free for it. */
  given: string | null
  givenHeldBy: GivenHeldBy | null
  /**
   * Whose the name asked about is, or null when nothing was asked about a name or the gateway is
   * older than the field.
   */
  askedHeldBy: HeldBy | null
  serverNow: number
}

// The statement, byte-identical to the gateway's nameStateMessage, which it rebuilds to verify the
// signature. The golden vector in __tests__/nameState.test.ts is copied from the gateway's suite and
// keeps the two sides from drifting apart with both suites green. The SDK refuses to sign the
// breez-lnurl: namespace, and the action word keeps a signature made to read a name from standing
// in for one made to be quoted for it. A read about the key alone signs the name line empty, which
// no named read can sign, since the gateway refuses an empty name.
const NAME_VERSION = 'voltz-name:v1'

export function nameStateMessage(
  host: string,
  pubkey: string,
  name: string,
  timestamp: number,
): string {
  return [NAME_VERSION, 'state', host, pubkey, name, String(timestamp)].join('\n')
}

// The spelling the gateway accepts and the SDK writes. A name in any other form is not one this
// device could register as given, so a reply carrying one is not an answer.
const EXACT_USERNAME = /^[a-z0-9._-]{1,64}$/

function nameOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null
  }
  return typeof value === 'string' && EXACT_USERNAME.test(value) ? value : undefined
}

function takenBackOf(value: unknown): TakenBack | null | undefined {
  if (value === null) {
    return null
  }
  if (typeof value !== 'object') {
    return undefined
  }
  const { closedBy, closedAt, withdrawal } = value as Record<string, unknown>
  if (closedBy !== 'refund' && closedBy !== 'sandbox_revocation') {
    return undefined
  }
  return typeof closedAt === 'number' && Number.isFinite(closedAt)
    ? { closedBy, closedAt, withdrawal: withdrawal === true }
    : undefined
}

function heldByOf(value: unknown): HeldBy | undefined {
  return value === 'you' || value === 'another' || value === 'nobody' ? value : undefined
}

// Strict, because what it returns can register a name: any field missing, of another type or about
// another question makes the whole reply no answer, and no answer keeps the wallet as it is. The one
// field that may be missing is askedHeldBy, which a gateway older than it never sends; a reply about
// the key alone says nothing about a name, so it carries neither takenBack nor askedHeldBy.
export function parseNameState(body: unknown, host: string, name: string | null): NameState | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const reply = body as Record<string, unknown>
  // Bound to the question asked, so a reply about another name or host never decides this one.
  if (reply.host !== host || reply.name !== name) {
    return null
  }
  const live = nameOrNull(reply.live)
  const takenBack = takenBackOf(reply.takenBack)
  const given = nameOrNull(reply.given)
  const heldBy = reply.givenHeldBy
  const askedHeldBy =
    reply.askedHeldBy === undefined || reply.askedHeldBy === null
      ? null
      : heldByOf(reply.askedHeldBy)
  const serverNow = reply.serverNow
  if (
    live === undefined ||
    takenBack === undefined ||
    given === undefined ||
    askedHeldBy === undefined
  ) {
    return null
  }
  if (name === null && (takenBack !== null || askedHeldBy !== null)) {
    return null
  }
  if (typeof serverNow !== 'number' || !Number.isFinite(serverNow)) {
    return null
  }
  // The gateway sends givenHeldBy exactly when it sends a given name; one without the other is a
  // reply this side does not understand.
  if (
    given === null
      ? heldBy !== null
      : heldBy !== 'you' && heldBy !== 'another' && heldBy !== 'nobody'
  ) {
    return null
  }
  return {
    host,
    name,
    live,
    takenBack,
    given,
    givenHeldBy: heldBy as GivenHeldBy | null,
    askedHeldBy,
    serverNow,
  }
}

export type NameStateDeps = {
  pubkey: string
  sign: (message: string) => Promise<string>
  now?: () => number
  request?: typeof fetch
}

// The whole read, signing included, ends by then. It runs before an address can be shown, and a
// gateway that hangs must leave the wallet as it would be without this read, not on a skeleton.
export const NAME_STATE_TIMEOUT_MS = 10_000

// What the gateway says about `name` on `host` for this wallet, or null for no answer.
//
// Never rejects. Every failure (no build domain, a refused signature, a network error, a timeout,
// any status but 200, including the 404 of a gateway without the route, and a body that does not
// parse) is no answer, which the caller treats exactly as if this read did not exist.
export function readNameState(
  deps: NameStateDeps,
  host: string,
  name: string,
): Promise<NameState | null> {
  return ask(deps, host, name)
}

// What the gateway knows about this wallet's key alone on `host`: what is live for it and its first
// name. Never rejects, as readNameState. A gateway older than this read refuses a body with no name
// with 400, which is no answer too.
export function readKeyState(deps: NameStateDeps, host: string): Promise<NameState | null> {
  return ask(deps, host, null)
}

async function ask(
  deps: NameStateDeps,
  host: string,
  name: string | null,
): Promise<NameState | null> {
  // Addressed at the shared build domain with the host in the body, never at the host itself: a
  // custom domain frozen for its year is off the edge and answers nobody.
  const build = getBreezLnurlDomain()
  if (!build) {
    return null
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, NAME_STATE_TIMEOUT_MS)
  })
  const asked = (async (): Promise<NameState | null> => {
    const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
    const signature = await deps.sign(nameStateMessage(host, deps.pubkey, name ?? '', timestamp))
    const body =
      name === null
        ? { host, pubkey: deps.pubkey, signature, timestamp }
        : { host, name, pubkey: deps.pubkey, signature, timestamp }
    const response = await (deps.request ?? fetch)(`https://${build}/api/name/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    // The strict parse below would also refuse every error body the gateway sends today. This is
    // kept so that only a 200 is ever an answer, whatever an error body comes to carry.
    if (response.status !== 200) {
      return null
    }
    return parseNameState(await response.json(), host, name)
  })().catch(() => null)
  try {
    return await Promise.race([asked, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

export type NextStep =
  /** Claim the remembered name back, which answers null while it cannot be had. */
  | { kind: 'claimHeld' }
  /** Register the wallet's first name, free and its own. */
  | { kind: 'registerGiven'; username: string }
  /** No first name to go back to, so the generated-name loop runs, as for a new wallet. */
  | { kind: 'mint' }
  /** Nothing is registered, and the wallet shows no address. `warn` names why, for the log. */
  | { kind: 'stop'; warn?: string }

// What an empty SDK read does for a wallet that remembers `held`, given the gateway's answer.
//
// Read in this order on purpose: takenBack can be set while another name, the first one included,
// is live for the wallet, and a live name is never replaced by this path. A remembered name the
// gateway says is another wallet's, as after a transfer, is gone from this wallet as surely as one a
// refund took back, and moves on the same way.
export function nextStep(state: NameState | null, held: string): NextStep {
  if (state === null) {
    return { kind: 'claimHeld' }
  }
  if (state.live !== null) {
    // The first name live for this wallet is asked for again. The server refuses a name that is
    // already held, this wallet's own included, so the attempt replaces nothing. Any other live name
    // is left alone.
    return state.live === state.given
      ? { kind: 'registerGiven', username: state.live }
      : { kind: 'stop' }
  }
  if (state.takenBack === null && state.askedHeldBy !== 'another') {
    return { kind: 'claimHeld' }
  }
  if (state.given === null) {
    return { kind: 'mint' }
  }
  if (state.givenHeldBy === 'another') {
    return { kind: 'stop', warn: 'given_held_by_another' }
  }
  // The name taken back is never asked for again by this path; the payment guard would refuse it.
  if (state.given === held) {
    return { kind: 'stop', warn: 'given_was_taken_back' }
  }
  return { kind: 'registerGiven', username: state.given }
}

export type KeyStep =
  /** The address exists on the server and the read was empty for another reason; nothing registers. */
  | { kind: 'noteLive'; username: string }
  /** Register the wallet's first name, free and its own. */
  | { kind: 'registerGiven'; username: string }
  /** The generated-name loop, as for a new wallet. */
  | { kind: 'mint' }
  /** Nothing is registered, and the wallet shows no address. `warn` names why, for the log. */
  | { kind: 'stop'; warn: string }

// What an empty SDK read does for a wallet that remembers no name, given the gateway's answer about
// its key alone. Without an answer the wallet mints as it always did; the payment guard refuses a
// generated name to a wallet that has a first name, so that fails without harm. A first name held for
// this wallet, or by nobody, is the one free name it can have, so a generated one is never tried then.
export function keyStep(state: NameState | null): KeyStep {
  if (state === null) {
    return { kind: 'mint' }
  }
  if (state.live !== null) {
    return { kind: 'noteLive', username: state.live }
  }
  if (state.given === null) {
    return { kind: 'mint' }
  }
  if (state.givenHeldBy === 'another') {
    return { kind: 'stop', warn: 'given_held_by_another' }
  }
  return { kind: 'registerGiven', username: state.given }
}
