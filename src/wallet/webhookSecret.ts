import * as Keychain from 'react-native-keychain'
import { getBreezLnurlDomain } from '../config'
import { secureBytes, toHex } from './secureRandom'
import { forgetProof, isWebhookSecret } from './webhook'

// What this device holds for one wallet's payment webhook. Kept in the Keychain, never in a file,
// because the secret is the key the Spark provider signs the wallet's payment events with, and
// whoever reads it can forge a payment notice to the gateway.
//
// The webhook id and the SDK marker sit beside the secret on purpose. The provider lists a webhook's
// URL but never its secret, so the marker is the only proof that the webhook at that URL was made
// with this secret: a secret drawn again (after a removal or a deletion) comes with no marker, and the
// next pass replaces the webhook rather than keep one the gateway would refuse as unsigned.
export type WebhookState = {
  secret: string
  // The gateway's id for this wallet, device and secret, from the last v5 registration it accepted. The
  // gateway keeps one record per secret, so a secret drawn again is answered a new id.
  webhookId?: string
  // The SDK webhook this device registered with this secret, and the URL it was registered for.
  sdk?: { id: string; url: string }
  // The identity key the secret was drawn for, which is the key every registration with it names. It
  // keys the removal marker and the gateway forget once this state is retired (retireWebhookState).
  pubkey?: string
}

const SERVICE = 'com.voltz.wallet.pushwebhook'

const serviceFor = (walletId: string): string => `${SERVICE}.${walletId}`

const SECRET_BYTES = 32

// react-native-get-random-values decodes the native answer with no length check, so a truncated one
// leaves the tail at 0x00; a healthy draw ends in four zero bytes with probability 2^-32 (seed.ts).
const ZERO_TAIL_LIMIT = 4

// 32 bytes from the platform's CSPRNG, as 64 lowercase hex characters. Refuses rather than fall back,
// missing source and Math.random included (secureBytes), since a guessable secret lets anyone sign a
// payment notice for this wallet.
export function drawWebhookSecret(): string {
  const bytes = secureBytes(SECRET_BYTES, 'a webhook secret')
  let zeroTail = 0
  while (zeroTail < bytes.length && bytes[bytes.length - 1 - zeroTail] === 0) {
    zeroTail += 1
  }
  if (zeroTail >= ZERO_TAIL_LIMIT) {
    throw new Error('refusing to draw a webhook secret: the draw ended in a run of zero bytes')
  }
  return toHex(bytes)
}

function parse(raw: string): WebhookState | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { secret, webhookId, sdk, pubkey } = value as Record<string, unknown>
  if (!isWebhookSecret(secret)) {
    return null
  }
  const state: WebhookState = { secret }
  if (typeof webhookId === 'string') {
    state.webhookId = webhookId
  }
  if (typeof pubkey === 'string') {
    state.pubkey = pubkey
  }
  const marker = sdk as { id?: unknown; url?: unknown } | undefined
  if (typeof marker?.id === 'string' && typeof marker.url === 'string') {
    state.sdk = { id: marker.id, url: marker.url }
  }
  return state
}

// Null when nothing usable is stored. An entry that does not parse counts as none, and drawing again
// costs a webhook the next pass replaces, plus the old secret's record at the gateway, which keeps one
// record per secret and drops one only on a forget proved with that secret, with the device row or
// with the wallet's data. A Keychain read that throws propagates, so nothing is drawn over an entry
// that could not be read.
export async function loadWebhookState(walletId: string): Promise<WebhookState | null> {
  const creds = await Keychain.getGenericPassword({ service: serviceFor(walletId) })
  return creds ? parse(creds.password) : null
}

async function write(walletId: string, state: WebhookState): Promise<void> {
  await Keychain.setGenericPassword('webhook', JSON.stringify(state), {
    service: serviceFor(walletId),
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

// Every change is a read, a merge and a write of one entry, and two of them running together would
// write back what the other replaced (a webhook id lost under a marker, or two secrets drawn at once,
// one of them sent to the gateway and the other kept). One queue for all of them keeps each whole.
let queue: Promise<unknown> = Promise.resolve()

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

/**
 * The wallet's state for a registration under `pubkey`, drawing and storing a secret first when none is
 * held, with the key it is drawn for written beside it before anything is sent with it.
 *
 * A held secret is never registered under a key other than its own, and never once a queued forget
 * names it: that forget would remove the registration made with it. Both cases retire the held state,
 * which queues its forget and keeps what the provider may hold, and draw a new secret. The second is a
 * retirement cut between queueing the forget and dropping the secret.
 */
export function webhookStateFor(walletId: string, pubkey: string): Promise<WebhookState> {
  return inTurn(async () => {
    const held = await loadWebhookState(walletId)
    if (held && (held.pubkey ?? pubkey) === pubkey && !(await forgetNames(held))) {
      if (held.pubkey === undefined) {
        const stamped = { ...held, pubkey }
        await write(walletId, stamped)
        return stamped
      }
      return held
    }
    if (held) {
      await retireHeld(walletId, held, held.pubkey ?? pubkey)
    }
    const fresh: WebhookState = { secret: drawWebhookSecret(), pubkey }
    await write(walletId, fresh)
    return fresh
  })
}

// Changes the stored state only while it still holds `secret`. A secret forgotten or drawn again
// meanwhile belongs to another registration, and an answer about the old one must not land on it.
function update(walletId: string, secret: string, change: (state: WebhookState) => WebhookState): Promise<void> {
  return inTurn(async () => {
    const held = await loadWebhookState(walletId)
    if (held?.secret !== secret) {
      return
    }
    await write(walletId, change(held))
  })
}

export function noteGatewayWebhookId(walletId: string, secret: string, webhookId: string, pubkey: string): Promise<void> {
  return update(walletId, secret, state => ({ ...state, webhookId, pubkey }))
}

export function noteSdkWebhook(walletId: string, secret: string, sdk: { id: string; url: string }): Promise<void> {
  return update(walletId, secret, state => ({ ...state, sdk }))
}

// What the provider may still hold from this device for one wallet, kept until a pass on that wallet's
// connection removed it: the gateway ids its webhook URL can end in, and the SDK webhooks noted with
// their URLs. Keyed by the identity key rather than the wallet id, since a removed wallet's id can
// pass to other words, and only a connection with this key can list or remove these webhooks.
export type RetiringWebhook = { webhookIds: string[]; sdkIds: string[]; urls: string[] }

const RETIRING_SERVICE = 'com.voltz.wallet.pushwebhook.retiring'

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every(item => typeof item === 'string') ? (value as string[]) : null

// Every wallet's marker in one entry. Null when the entry does not parse, which every reader takes as
// a refusal rather than as no marker: writing over it would forget webhooks the provider still holds.
async function readRetiring(): Promise<Record<string, RetiringWebhook> | null> {
  const creds = await Keychain.getGenericPassword({ service: RETIRING_SERVICE })
  if (!creds) {
    return {}
  }
  let value: unknown
  try {
    value = JSON.parse(creds.password)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const all: Record<string, RetiringWebhook> = {}
  for (const [pubkey, entry] of Object.entries(value as Record<string, unknown>)) {
    const e = (entry ?? {}) as Record<string, unknown>
    const webhookIds = strings(e.webhookIds)
    const sdkIds = strings(e.sdkIds)
    const urls = strings(e.urls)
    if (!webhookIds || !sdkIds || !urls) {
      return null
    }
    all[pubkey] = { webhookIds, sdkIds, urls }
  }
  return all
}

async function readRetiringOrThrow(): Promise<Record<string, RetiringWebhook>> {
  const all = await readRetiring()
  if (all === null) {
    throw new Error('the payment webhook removal marker does not parse')
  }
  return all
}

async function writeRetiring(all: Record<string, RetiringWebhook>): Promise<void> {
  if (Object.keys(all).length === 0) {
    await Keychain.resetGenericPassword({ service: RETIRING_SERVICE })
    return
  }
  await Keychain.setGenericPassword('webhook', JSON.stringify(all), {
    service: RETIRING_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

const isEmpty = (entry: RetiringWebhook): boolean =>
  entry.webhookIds.length === 0 && entry.sdkIds.length === 0 && entry.urls.length === 0

const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])]

// The marker for the wallet with this identity key, or null when nothing is waiting to be removed.
export function loadRetiring(pubkey: string): Promise<RetiringWebhook | null> {
  return inTurn(async () => (await readRetiringOrThrow())[pubkey] ?? null)
}

/**
 * Moves what this device registered for the wallet into the removal marker, queues the gateway forget
 * for the secret, then drops the secret, the webhook id and the SDK marker. For a deletion request, a
 * wallet removed from this device and notifications turned off. Every drop of a secret goes through the
 * retirement this runs (retireHeld).
 *
 * The marker is written before anything is dropped and dropped only by settleRetiring, so the webhook is
 * never forgotten before the provider confirmed its removal. The forget is queued before the secret is
 * dropped and carries everything its sending needs, the key and the proof (forgetProof), whether or not
 * a gateway id ever came back: a registration whose answer was lost is still the gateway's to delete.
 *
 * `pubkey` is the wallet's identity key when the caller knows it, and the one written with the secret
 * otherwise. A state that names something the provider may hold with no key to file it under is left as
 * it is, since dropping it would lose the only record of that webhook.
 */
export function retireWebhookState(walletId: string, pubkey?: string): Promise<void> {
  return inTurn(async () => {
    const state = await loadWebhookState(walletId)
    if (state) {
      await retireHeld(walletId, state, pubkey)
    }
  })
}

/**
 * Retires the wallet's state only while it still holds `secret`, for a registration the gateway refused
 * because a forget had named that secret (410 `forgotten`). The gateway keeps a mark of every forget and
 * refuses a marked secret while it keeps the mark, and the app never sends a retired secret again, so
 * retiring it is what makes the next connect draw a fresh one. A state retired or drawn again meanwhile
 * is another registration's and stays. The forget this queues finds the secret already marked and
 * changes nothing there.
 */
export function retireForgottenSecret(walletId: string, secret: string, pubkey: string): Promise<void> {
  return inTurn(async () => {
    const state = await loadWebhookState(walletId)
    if (state?.secret === secret) {
      await retireHeld(walletId, state, pubkey)
    }
  })
}

async function retireHeld(walletId: string, state: WebhookState, pubkey?: string): Promise<void> {
  const entry: RetiringWebhook = {
    webhookIds: state.webhookId ? [state.webhookId] : [],
    sdkIds: state.sdk ? [state.sdk.id] : [],
    urls: state.sdk ? [state.sdk.url] : [],
  }
  const key = pubkey ?? state.pubkey
  if (!isEmpty(entry)) {
    if (!key) {
      return
    }
    const all = await readRetiringOrThrow()
    const held = all[key]
    all[key] = held
      ? {
          webhookIds: union(held.webhookIds, entry.webhookIds),
          sdkIds: union(held.sdkIds, entry.sdkIds),
          urls: union(held.urls, entry.urls),
        }
      : entry
    await writeRetiring(all)
  }
  // Every key a registration with this secret can have named. Without a domain this build never
  // registered, so the gateway holds nothing of it.
  const domain = getBreezLnurlDomain()
  const keys = [...new Set([state.pubkey, pubkey].filter((k): k is string => typeof k === 'string'))]
  if (domain && keys.length > 0) {
    await addForgets(keys.map(k => ({ pubkey: k.trim().toLowerCase(), proof: forgetProof(domain, k, state.secret) })))
  }
  await Keychain.resetGenericPassword({ service: serviceFor(walletId) })
}

// Takes off the marker what a pass removed, after the provider confirmed each removal. Anything retired
// after the pass read the marker stays for the next one.
export function settleRetiring(pubkey: string, removed: RetiringWebhook): Promise<void> {
  return inTurn(async () => {
    const all = await readRetiringOrThrow()
    const held = all[pubkey]
    if (!held) {
      return
    }
    const left: RetiringWebhook = {
      webhookIds: held.webhookIds.filter(id => !removed.webhookIds.includes(id)),
      sdkIds: held.sdkIds.filter(id => !removed.sdkIds.includes(id)),
      urls: held.urls.filter(url => !removed.urls.includes(url)),
    }
    if (isEmpty(left)) {
      delete all[pubkey]
    } else {
      all[pubkey] = left
    }
    await writeRetiring(all)
  })
}

// A forget the gateway is still owed (POST /api/device/forget, deviceForget.ts): the wallet's key and the
// proof that the sender held the secret of the registrations to remove. Neither the secret nor the words
// are needed to send it, so it outlives both, the Forgot PIN erase included, and nothing about it
// expires. Dropped only once the gateway answered it with a 200.
export type DeviceForget = { pubkey: string; proof: string }

const FORGET_SERVICE = 'com.voltz.wallet.pushwebhook.forget'

const PUBKEY = /^0[23][0-9a-f]{64}$/
const PROOF = /^[0-9a-f]{64}$/

const sameForget = (a: DeviceForget, b: DeviceForget): boolean => a.pubkey === b.pubkey && a.proof === b.proof

function forgetOf(value: unknown): DeviceForget | null {
  const e = (value ?? {}) as Record<string, unknown>
  if (typeof e.pubkey !== 'string' || typeof e.proof !== 'string') {
    return null
  }
  return { pubkey: e.pubkey, proof: e.proof }
}

// Throws when the entry does not parse, as the removal marker does: writing over it would drop forgets
// the gateway is still owed.
async function readForgets(): Promise<DeviceForget[]> {
  const creds = await Keychain.getGenericPassword({ service: FORGET_SERVICE })
  if (!creds) {
    return []
  }
  let value: unknown
  try {
    value = JSON.parse(creds.password)
  } catch {
    throw new Error('the gateway forget list does not parse')
  }
  const entries = Array.isArray(value) ? value.map(forgetOf) : [null]
  if (entries.some(entry => entry === null)) {
    throw new Error('the gateway forget list does not parse')
  }
  return entries as DeviceForget[]
}

async function writeForgets(entries: DeviceForget[]): Promise<void> {
  if (entries.length === 0) {
    await Keychain.resetGenericPassword({ service: FORGET_SERVICE })
    return
  }
  await Keychain.setGenericPassword('webhook', JSON.stringify(entries), {
    service: FORGET_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

// A key the gateway would refuse as malformed is never queued, since its forget could never be answered.
async function addForgets(entries: DeviceForget[]): Promise<void> {
  const fresh = entries.filter(entry => PUBKEY.test(entry.pubkey) && PROOF.test(entry.proof))
  if (fresh.length === 0) {
    return
  }
  const held = await readForgets()
  await writeForgets([...held.filter(other => !fresh.some(entry => sameForget(other, entry))), ...fresh])
}

// Whether a queued forget was made with this state's secret, under any key.
async function forgetNames(state: WebhookState): Promise<boolean> {
  const domain = getBreezLnurlDomain()
  if (!domain) {
    return false
  }
  return (await readForgets()).some(entry => forgetProof(domain, entry.pubkey, state.secret) === entry.proof)
}

export function loadDeviceForgets(): Promise<DeviceForget[]> {
  return inTurn(readForgets)
}

// Drops one forget once the gateway answered it.
export function settleDeviceForget(entry: DeviceForget): Promise<void> {
  return inTurn(async () => {
    const held = await readForgets()
    if (!held.some(other => sameForget(other, entry))) {
      return
    }
    await writeForgets(held.filter(other => !sameForget(other, entry)))
  })
}
