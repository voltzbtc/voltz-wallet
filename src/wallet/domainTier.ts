import RNFS from 'react-native-fs'
import { getBreezLnurlDomain } from '../config'
import { serialQueue } from './durableFile'
import { setDomainFor, storedDomainFor } from './lnurlDomainPref'

// What the owner of a custom domain is told about its lifecycle. The gateway's POST
// /api/domain/state sends facts and never a state word, so the vocabulary of "ending" and "gone"
// exists once, here, and the two halves cannot drift apart on what it means.

export type DomainKind = 'public' | 'customer'

/** The lifecycle half of the /api/domain/state body. */
export type DomainLifecycle = {
  kind: DomainKind
  /** Unix seconds the paid year ends. Null on the shared domain, which has no tier to run out. */
  expiresAt: number | null
  /** Unix seconds the hostname was taken off the edge. Null while it is up. */
  frozenAt: number | null
}

export type DomainPhase = 'fine' | 'ending' | 'lastDay' | 'expired' | 'frozen'

const DAY_SECS = 86_400

// Both windows close on their far edge, and the reason is the reminder ladder: the gateway claims
// its first rung 30 days out and the last-day rung 24 hours out. A card that waited for the next
// second would let a push announce a deadline the screen still denies.
const ENDING_SECS = 30 * DAY_SECS

// `serverNow` arrives in the same body as `expiresAt` and is the only clock read here. A device
// clock is user-settable and drifts, so trusting it would freeze the banner onto a paid customer
// whose phone runs fast, and hide the last day from one whose phone runs slow.
export function phaseOf(state: DomainLifecycle, serverNow: number): DomainPhase {
  // Nothing on the shared build domain can lapse, so it is answered before any date is read.
  if (state.kind === 'public') {
    return 'fine'
  }
  // Removal of the hostname already happened; expiry is only derived. So it outranks expiry, and a
  // renewal keeps reading frozen until the thaw actually puts the hostname back, which is the truth
  // for the payer either way.
  if (typeof state.frozenAt === 'number') {
    return 'frozen'
  }
  // A field that failed to arrive has to read as working. Alarming an owner whose domain is fine
  // costs more than a card that shows up one read later.
  if (typeof state.expiresAt !== 'number') {
    return 'fine'
  }
  const remaining = state.expiresAt - serverNow
  // At the instant of expiry the paid year is over, so this is no longer the last day. It stays
  // this way however long ago it lapsed, since only the reminders fall silent after 30 days.
  if (remaining <= 0) {
    return 'expired'
  }
  if (remaining <= DAY_SECS) {
    return 'lastDay'
  }
  if (remaining <= ENDING_SECS) {
    return 'ending'
  }
  return 'fine'
}

// The signed statement, byte-identical to the gateway's domain state message, which it rebuilds to
// verify the signature. Its own action word, so a signature made to read a domain can never stand
// in for one that grants access or hands the domain over.
const STATE_VERSION = 'voltz-domain:v1'

export function domainStateMessage(host: string, pubkey: string, timestamp: number): string {
  return [STATE_VERSION, 'state', host, pubkey, String(timestamp)].join('\n')
}

// The statement for the read that names no host, byte-identical to the message the gateway
// rebuilds for that read. Its own action word again, because this one answers what a key holds
// rather than whether it holds a named host, and a signature made to confirm one domain must never
// be replayable to enumerate them all.
export function domainsMineMessage(pubkey: string, timestamp: number): string {
  return [STATE_VERSION, 'state-mine', pubkey, String(timestamp)].join('\n')
}

export type DomainRole = 'owner' | 'member' | 'public'

/** The whole /api/domain/state body. */
export type DomainState = DomainLifecycle & {
  host: string
  role: DomainRole
  transferSeq: number
  /** The gateway's clock, and the only one `phaseOf` may be given. */
  serverNow: number
}

// The last answer, kept so a domain that is ending still says so on a train with no signal. Written
// only after a reply that parsed, because a card that goes quiet the moment the network does is a
// card the owner never sees on the day it matters.
const CACHE = `${RNFS.DocumentDirectoryPath}/domain-tier.json`

type CacheEntry = { host: string; readAt: number; state: DomainState }

type Cache = Record<string, CacheEntry>

// Every change to these two files reads the whole file and writes it back, so two at once would put
// back what the other just took out.
const serial = serialQueue()

async function readCache(): Promise<Cache> {
  try {
    if (!(await RNFS.exists(CACHE))) {
      return {}
    }
    const parsed: unknown = JSON.parse(await RNFS.readFile(CACHE, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Cache) : {}
  } catch {
    return {}
  }
}

function remember(walletId: string, entry: CacheEntry): Promise<void> {
  return serial(async () => {
    const cache = await readCache()
    cache[walletId] = entry
    await RNFS.writeFile(CACHE, JSON.stringify(cache), 'utf8')
  })
}

// A refusal from the gateway is authoritative, unlike a network that simply failed, so it drops the
// entry: after a handover the outgoing wallet must stop being offered a renewal for a domain that
// is no longer its own.
async function forget(walletId: string): Promise<void> {
  try {
    await forgetDomainCache(walletId)
  } catch {
    // An entry that could not be dropped is refused again on the next focus.
  }
}

// The last answer's host and role for every wallet on this device, read without asking anybody.
export async function cachedDomainRoles(): Promise<Record<string, { host: string; role: DomainRole }>> {
  const cache = await readCache()
  return Object.fromEntries(
    Object.entries(cache)
      .filter(([, entry]) => typeof entry?.host === 'string' && typeof entry?.state?.role === 'string')
      .map(([walletId, entry]) => [walletId, { host: entry.host, role: entry.state.role }]),
  )
}

// Drops one wallet's cached answer and throws when that cannot be written, unlike `forget` above,
// because the deletion cleanup that calls it retries on the next read rather than leaving a copy of
// a deleted domain on the device.
export function forgetDomainCache(walletId: string): Promise<void> {
  return serial(async () => {
    const cache = await readCache()
    if (!(walletId in cache)) {
      return
    }
    delete cache[walletId]
    await RNFS.writeFile(CACHE, JSON.stringify(cache), 'utf8')
  })
}

// When this wallet last asked what its key holds, per wallet. Kept apart from the answer cache
// above, because the question has an answer even when there is no domain, and "nothing, asked an
// hour ago" has to survive a restart or the ask happens on every screen open.
const ASKED = `${RNFS.DocumentDirectoryPath}/domain-mine.json`

// Almost every wallet owns nothing and is told exactly that forever, and this read runs on the focus
// of the screen that shows an address, so asking every time would be a request per screen open for
// every install of the app. A day is short enough to find a restored wallet on its first open, and to
// notice a domain bought on another handset holding the same seed, or one whose preference failed to
// be written after a purchase.
const ASK_EVERY_SECS = DAY_SECS

async function readAsked(): Promise<Record<string, number>> {
  try {
    if (!(await RNFS.exists(ASKED))) {
      return {}
    }
    const parsed: unknown = JSON.parse(await RNFS.readFile(ASKED, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function rememberAsk(walletId: string, atSecs: number): Promise<void> {
  return serial(async () => {
    const asked = await readAsked()
    asked[walletId] = atSecs
    await RNFS.writeFile(ASKED, JSON.stringify(asked), 'utf8')
  })
}

// Drops the throttle for one wallet, so the next read asks again instead of waiting the window out.
// A handover is the case that needs it: the wallet receiving a domain was told minutes ago that it
// held none, and that answer is now wrong on this device's own evidence.
export async function forgetDomainAsk(walletId: string): Promise<void> {
  try {
    await serial(async () => {
      const asked = await readAsked()
      if (walletId in asked) {
        delete asked[walletId]
        await RNFS.writeFile(ASKED, JSON.stringify(asked), 'utf8')
      }
    })
  } catch {
    // Never rejects. It runs beside a move that has already happened, and what it unblocks is a
    // read arriving sooner, never the move itself.
  }
}

// The stored `serverNow` is the clock at the moment of that read, so handing it back untouched would
// stop time: a domain that lapsed while the phone was offline would keep reading as ending. Elapsed
// device time is added instead, which ages the answer without letting the device name the hour. A
// clock moved backwards adds nothing rather than rewinding the phase.
function aged(entry: CacheEntry, nowSecs: number): DomainState {
  return {
    ...entry.state,
    serverNow: entry.state.serverNow + Math.max(0, nowSecs - entry.readAt),
  }
}

function parseState(body: unknown, host: string): DomainState | null {
  const reply = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const role = reply.role
  const kind = reply.kind
  const serverNow = reply.serverNow
  // The clock, the role and the kind are what every branch downstream reads, so a body missing one
  // of them yields a guess, and a guess is worth less than the last answer that was whole.
  if (role !== 'owner' && role !== 'member' && role !== 'public') {
    return null
  }
  if (kind !== 'public' && kind !== 'customer') {
    return null
  }
  if (typeof serverNow !== 'number') {
    return null
  }
  return {
    host: typeof reply.host === 'string' ? reply.host : host,
    role,
    kind,
    // A date that failed to arrive reads as absent, which `phaseOf` answers as working.
    expiresAt: typeof reply.expiresAt === 'number' ? reply.expiresAt : null,
    frozenAt: typeof reply.frozenAt === 'number' ? reply.frozenAt : null,
    transferSeq: typeof reply.transferSeq === 'number' ? reply.transferSeq : 0,
    serverNow,
  }
}

// The host-less reply carries the same fields per item, and the clock once at the top. Parsed
// through the same function as the named read so the two shapes cannot drift on what a whole answer
// is, and one item that is not whole refuses the lot, because a list silently short of a domain reads
// as a wallet that owns less than it does.
function parseMine(body: unknown): DomainState[] | null {
  const reply = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const domains = reply.domains
  const serverNow = reply.serverNow
  if (typeof serverNow !== 'number' || !Array.isArray(domains)) {
    return null
  }
  const parsed: DomainState[] = []
  for (const item of domains) {
    const host = (item as { host?: unknown })?.host
    if (typeof host !== 'string' || host === '') {
      return null
    }
    const state = parseState({ ...(item as object), serverNow }, host)
    if (!state) {
      return null
    }
    parsed.push(state)
  }
  return parsed
}

// Which of them this wallet is, for the purposes of this screen.
//
// Owned only. Being a member is somebody else's domain: adopting one would move this wallet's
// addresses onto a company name nobody asked to move them onto, and it would offer a renewal only
// the owner is allowed to make. A member keeps the screen it always had.
//
// Among owned domains it picks the one that most needs its owner, first a domain that has already
// stopped, then the year that ends soonest, and the host name only as the last resort, so two reads
// of the same pair never disagree about which one is being shown.
function pickOwn(domains: DomainState[]): DomainState | null {
  const owned = domains.filter(domain => domain.role === 'owner')
  owned.sort((a, b) => {
    const stopped = Number(b.frozenAt !== null) - Number(a.frozenAt !== null)
    if (stopped !== 0) {
      return stopped
    }
    // A domain with no date has nothing running out, so it waits behind every domain that has.
    const ends =
      (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER)
    if (ends !== 0) {
      return ends
    }
    if (a.host === b.host) {
      return 0
    }
    return a.host < b.host ? -1 : 1
  })
  return owned[0] ?? null
}

export type DomainStateDeps = {
  walletId: string
  pubkey: string
  sign: (message: string) => Promise<string>
  now?: () => number
  request?: typeof fetch
}

// What the gateway says this wallet's key holds, for a wallet that cannot name a domain.
//
// Restoring from the seed is the only recovery a self-custody wallet has, and the file that named
// the domain lived on the handset that is gone. Without this the domain the customer pays for is
// invisible on the new one: never seen, never renewed, and one day frozen with no warning, because
// the warning lives on the screen that needed the name.
async function readOwnDomains(
  deps: DomainStateDeps,
  build: string,
  nowSecs: number,
): Promise<DomainState | null> {
  const stored = (await readCache())[deps.walletId]
  const last = (await readAsked())[deps.walletId]
  // A device clock moved in either direction asks again rather than falling silent: an extra ask
  // costs one request, a missing one costs somebody the domain they are paying for.
  if (typeof last === 'number' && nowSecs >= last && nowSecs - last < ASK_EVERY_SECS) {
    return stored ? aged(stored, nowSecs) : null
  }
  try {
    const signature = await deps.sign(domainsMineMessage(deps.pubkey, nowSecs))
    // No host in the body at all, which is what makes this the question about the key rather than
    // about a name, and the reason it is addressed at the shared build domain is the same one the
    // named read has: a frozen hostname is off the edge and answers nobody.
    const response = await (deps.request ?? fetch)(`https://${build}/api/domain/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey: deps.pubkey, signature, timestamp: nowSecs }),
    })
    if (!response.ok) {
      return stored ? aged(stored, nowSecs) : null
    }
    const mine = parseMine(await response.json())
    if (!mine) {
      return stored ? aged(stored, nowSecs) : null
    }
    // Only a reply that arrived whole closes the question. A refusal or a body that did not parse
    // leaves it open, and a wallet that owns something must not wait out a day on a reply that
    // said nothing about it.
    await rememberAsk(deps.walletId, nowSecs)
    const own = pickOwn(mine)
    if (!own) {
      // An empty list is an answer and not a failure: this key holds nothing. Anything remembered
      // describes a domain it no longer holds, so that goes with it.
      await forget(deps.walletId)
      return null
    }
    await remember(deps.walletId, { host: own.host, readAt: nowSecs, state: own })
    if (own.frozenAt === null) {
      // Adopted only while the hostname is up. Pointing a wallet at a frozen host makes every
      // address claim fail against a name that is not on the edge, and leaves that wallet with no
      // address at all, which is worse than the one it has. The renewal writes the preference once
      // the domain is back (`UseMyDomainScreen`), so this is not the last chance to adopt it.
      //
      // This is best effort and deliberately without a reconnect, because the SDK takes the domain
      // at connect, so the addresses follow at the next one instead of a read that runs on a
      // screen's focus tearing down a live session.
      await setDomainFor(deps.walletId, own.host).catch(() => undefined)
    }
    return own
  } catch {
    return stored ? aged(stored, nowSecs) : null
  }
}

// What the gateway says about this wallet's domain, or null when there is nothing to say.
//
// Never rejects. It runs on the focus of a screen whose job is to show an address, and a lifecycle
// notice that can break that screen is worse than no notice at all.
export async function readDomainState(deps: DomainStateDeps): Promise<DomainState | null> {
  const build = getBreezLnurlDomain()
  if (!build) {
    return null
  }
  const nowSecs = Math.floor((deps.now ?? Date.now)() / 1000)
  // What was stored, never what the wallet connects with, and never the tail of the lightning
  // address. Once the hostname is off the edge the SDK can return no address at all, and the one
  // moment the owner most needs the explanation is the moment a design keyed off the address has
  // nothing to key off. Stored and connected differ in exactly the case below.
  const host = await storedDomainFor(deps.walletId)
  // Nothing stored is a wallet that cannot name a domain, which is what a restore leaves behind, so
  // the gateway is asked what the key holds instead of being told there is nothing to ask about.
  if (host === undefined) {
    return readOwnDomains(deps, build, nowSecs)
  }
  // A wallet that chose the shared domain said so itself, and no year can run out there, so it
  // costs nothing on every focus and the round trip never happens.
  if (!host || host === build) {
    return null
  }
  const stored = (await readCache())[deps.walletId]
  // An entry belongs to the wallet and the host it was read for. Another wallet's domain, or this
  // wallet's previous one, describes something the owner is not looking at.
  const cached = stored?.host === host ? stored : undefined
  try {
    const signature = await deps.sign(domainStateMessage(host, deps.pubkey, nowSecs))
    // Addressed at the shared build domain with the host in the body, never at the customer's own
    // hostname. The freeze works by removing that hostname from the edge, so a request addressed
    // there cannot arrive, and the owner would be locked out of the screen that renews the thing
    // they are being asked to pay for. The signed statement carries the host, so the body is bound.
    const response = await (deps.request ?? fetch)(`https://${build}/api/domain/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host, pubkey: deps.pubkey, signature, timestamp: nowSecs }),
    })
    if (response.status === 403 || response.status === 404) {
      await forget(deps.walletId)
      return null
    }
    if (!response.ok) {
      return cached ? aged(cached, nowSecs) : null
    }
    const state = parseState(await response.json(), host)
    if (!state) {
      return cached ? aged(cached, nowSecs) : null
    }
    await remember(deps.walletId, { host, readAt: nowSecs, state })
    return state
  } catch {
    return cached ? aged(cached, nowSecs) : null
  }
}
