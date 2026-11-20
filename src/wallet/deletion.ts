import { getBreezLnurlDomain } from '../config'
import { identitySigner } from './identitySigner'
import {
  connectActiveSpark,
  connectedLnurlDomain,
  sparkConnectedWalletId,
  sparkEnsureLnAddress,
  sparkGetIdentityPubkey,
  sparkInAddressTurn,
  type SparkLnAddress,
} from './spark'
import { gatewayRefusal } from './lnRefusal'
import { getActiveWalletId } from './walletRegistry'
import { reconnectActiveWallet } from './wallet'
import { forgetLnAddress } from './lnAddressMemory'
import { clearDomainFor, domainFor, storedDomainFor } from './lnurlDomainPref'
import { forgetRegistrationOf } from './push'
import { retireWebhookState } from './webhookSecret'
import { sendDeviceForgets } from './deviceForget'
import { retirePaymentWebhook } from './paymentWebhook'
import { forgetWalletPurchases } from './purchase'
import { forgetWalletLines } from './releasedLines'
import { forgetPurchaseAsk } from './recover'
import { cachedDomainRoles, forgetDomainAsk, forgetDomainCache } from './domainTier'
import { forgetWalletDomainPurchase } from './domainOnboard'
import { forgetLabels } from './domainAccess'
import { forgetWalletOrders } from './storePurchase'
import {
  answerDeletionMark,
  clearDeletionMark,
  clearImportCheck,
  findDeletionMark,
  importCheckDue,
  lastStatusReadAt,
  noteStatusReadAt,
  onGatewayDeleted,
  writeDeletionMark,
  type DeletionMark,
  type FoundMark,
} from './deletionMark'

/**
 * Deleting a wallet's data at Voltz, from the device: the signed calls to the gateway's
 * POST /api/wallet/delete, the mark that holds every automatic step meanwhile, and the local cleanup
 * that runs only once the gateway says `done`.
 *
 * The seed, the bitcoin and the history are not touched. They live on this device and on Spark, and
 * removing the wallet stays its own flow.
 */

// The statement, byte-identical to the gateway's, which rebuilds it to verify the signature. The
// golden vector in __tests__/deletion.test.ts pins the bytes. Its own namespace, since the SDK
// refuses to sign `breez-lnurl:`, and the action word inside it keeps a signature that reads the
// preview from standing in for one that asks to delete.
export const DELETE_VERSION = 'voltz-delete:v1'

export type DeletionAction = 'preview' | 'request' | 'status' | 'return'

export function deletionMessage(action: DeletionAction, pubkey: string, timestamp: number): string {
  return [DELETE_VERSION, action, pubkey, String(timestamp)].join('\n')
}

export type DeletionDeps = {
  walletId: string
  pubkey: string
  sign: (message: string) => Promise<string>
  /** Defaults to the build's domain. Never a customer's own domain, which may be off the edge. */
  gatewayUrl?: string
  now?: () => number
  request?: typeof fetch
  /** Runs work in the address turn, so no automatic register interleaves with a request. */
  turn?: <T>(work: () => Promise<T>) => Promise<T>
}

// The whole call, signing included, ends by then. A gateway that hangs leaves the screen on what it
// can say without an answer, never on a skeleton.
export const DELETION_TIMEOUT_MS = 15_000

type Reply =
  | { kind: 'answer'; status: number; body: Record<string, unknown> }
  // A network failure, a timeout, a refused signature or a 5xx. The gateway may or may not have
  // recorded anything, so it is never read as a refusal.
  | { kind: 'none' }

function gatewayOf(deps: DeletionDeps): string | null {
  if (deps.gatewayUrl) {
    return deps.gatewayUrl.replace(/\/+$/, '')
  }
  const build = getBreezLnurlDomain()
  return build ? `https://${build}` : null
}

function nowSecs(deps: DeletionDeps): number {
  return Math.floor((deps.now ?? Date.now)() / 1000)
}

async function send(deps: DeletionDeps, action: DeletionAction): Promise<Reply> {
  const gateway = gatewayOf(deps)
  if (!gateway) {
    return { kind: 'none' }
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<Reply>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ kind: 'none' })
    }, DELETION_TIMEOUT_MS)
  })
  const asked = (async (): Promise<Reply> => {
    const timestamp = nowSecs(deps)
    const signature = await deps.sign(deletionMessage(action, deps.pubkey, timestamp))
    const response = await (deps.request ?? fetch)(`${gateway}/api/wallet/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, pubkey: deps.pubkey, signature, timestamp }),
      signal: controller.signal,
    })
    if (response.status >= 500) {
      return { kind: 'none' }
    }
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = await response.json()
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // A body that is not JSON is read as an empty one, so only the status speaks.
    }
    return { kind: 'answer', status: response.status, body }
  })().catch((): Reply => ({ kind: 'none' }))
  try {
    return await Promise.race([asked, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

const isText = (value: unknown, max = 255): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

// --- preview ---------------------------------------------------------------------------------

export type PaidWith = 'apple' | 'google' | 'sats'

export type PreviewPurchase = {
  /** `tier` is a year of a domain. */
  kind: 'name' | 'tier'
  /** The name or the host bought. */
  subject: string
  /** What the store or the support desk knows the purchase by. */
  reference: string
  paidWith: PaidWith
  /** Gateway clock, unix seconds. */
  at: number
}

/**
 * What a charge in sats the gateway lists as owed is known to be. `refused` and `not_granted` were
 * paid and turned into nothing, so Voltz may owe the sats; `unchecked` is a charge past its expiry with
 * no settlement, refusal or lapse recorded, which the treasury has not yet said was paid.
 */
export type OwedState = 'refused' | 'not_granted' | 'unchecked'

export type OwedCharge = {
  reference: string
  kind: 'name' | 'tier'
  domain: string
  /** The name or the host the charge was for. */
  subject: string
  sats: number
  state: OwedState
  /** Gateway clock, unix seconds. */
  at: number
}

export type DeletionPreview = {
  /** Every name the wallet holds or held, live or kept, as the gateway recorded them. */
  names: { domain: string; name: string }[]
  /** Purchases of the last 14 days, the window to ask the store for a refund. */
  purchases: PreviewPurchase[]
  /** The domains this wallet owns, each with how many other wallets have an address on it. */
  ownDomains: { host: string; guests: number }[]
  /** Codes of what keeps the deletion from being asked right now. Empty means it can be asked. */
  blockers: string[]
  /** Codes of what stays, read from the gateway's deletion map. */
  stays: string[]
  /** Charges in sats Voltz may owe the wallet (listed as owed), or has not yet checked, with no time window. */
  owed: OwedCharge[]
}

const CODE = /^[a-z0-9_]{1,64}$/

function codesOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(code => typeof code === 'string' && CODE.test(code))
    ? (value as string[])
    : null
}

function purchaseOf(value: unknown): PreviewPurchase | null {
  const row = value as Record<string, unknown>
  if (typeof row !== 'object' || row === null) {
    return null
  }
  const { kind, subject, reference, rail, at } = row
  if (kind !== 'name' && kind !== 'tier') {
    return null
  }
  if (rail !== 'apple' && rail !== 'google' && rail !== 'sats') {
    return null
  }
  return isText(subject) && isText(reference) && isTime(at)
    ? { kind, subject, reference, paidWith: rail, at }
    : null
}

const OWED_STATES: readonly OwedState[] = ['refused', 'not_granted', 'unchecked']

function owedOf(value: unknown): OwedCharge | null {
  const row = value as Record<string, unknown>
  if (typeof row !== 'object' || row === null) {
    return null
  }
  const { reference, kind, domain, subject, sats, state, at } = row
  if (kind !== 'name' && kind !== 'tier') {
    return null
  }
  if (!OWED_STATES.includes(state as OwedState)) {
    return null
  }
  if (typeof sats !== 'number' || !Number.isSafeInteger(sats) || sats <= 0) {
    return null
  }
  return isText(reference) && isText(domain) && isText(subject) && isTime(at)
    ? { reference, kind, domain, subject, sats, state: state as OwedState, at }
    : null
}

// Strict, because the screen shows it as what is deleted and what stays: a field missing or of
// another type makes the whole reply no preview, and no preview keeps the button off. The gateway
// also merges the request's status into this body, which is read separately.
export function parseDeletionPreview(body: unknown): DeletionPreview | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const reply = body as Record<string, unknown>
  if (!Array.isArray(reply.names) || !Array.isArray(reply.recentPurchases) || !Array.isArray(reply.ownDomains)) {
    return null
  }
  const names: DeletionPreview['names'] = []
  for (const entry of reply.names) {
    const { domain, name } = (entry ?? {}) as Record<string, unknown>
    if (!isText(domain) || !isText(name, 64)) {
      return null
    }
    names.push({ domain, name })
  }
  const purchases: PreviewPurchase[] = []
  for (const row of reply.recentPurchases) {
    const purchase = purchaseOf(row)
    if (!purchase) {
      return null
    }
    purchases.push(purchase)
  }
  const ownDomains: DeletionPreview['ownDomains'] = []
  for (const entry of reply.ownDomains) {
    const { host, guests } = (entry ?? {}) as Record<string, unknown>
    if (!isText(host) || typeof guests !== 'number' || !Number.isInteger(guests) || guests < 0) {
      return null
    }
    ownDomains.push({ host, guests })
  }
  // Absent from a gateway older than the field, which is read as nothing owed. Present, it is read
  // as strictly as the other lists.
  const owedRows = reply.owed === undefined ? [] : reply.owed
  if (!Array.isArray(owedRows)) {
    return null
  }
  const owed: OwedCharge[] = []
  for (const row of owedRows) {
    const charge = owedOf(row)
    if (!charge) {
      return null
    }
    owed.push(charge)
  }
  const blockers = codesOf(reply.blockers)
  const stays = codesOf(reply.stays)
  if (!blockers || !stays) {
    return null
  }
  return { names, purchases, ownDomains, blockers, stays, owed }
}

export type PreviewResult =
  // `status` is the request's status the gateway merges into the preview's body.
  | { kind: 'preview'; preview: DeletionPreview; status: StatusReply }
  // The gateway answered and the answer is not a preview.
  | { kind: 'failed' }
  // No answer at all.
  | { kind: 'offline' }

/** Only reads. Never writes the mark and never deletes anything, on any answer. */
export async function previewDeletion(deps: DeletionDeps): Promise<PreviewResult> {
  const reply = await send(deps, 'preview')
  if (reply.kind === 'none') {
    return { kind: 'offline' }
  }
  const preview = reply.status === 200 ? parseDeletionPreview(reply.body) : null
  return preview ? { kind: 'preview', preview, status: statusOf(reply.body) } : { kind: 'failed' }
}

// --- request ---------------------------------------------------------------------------------

export type RequestResult =
  | { kind: 'pending'; requestedAt: number; deadline: number }
  // Nothing was recorded, and the codes say why.
  | { kind: 'blocked'; blockers: string[] }
  // The gateway refused for another reason. Nothing was recorded.
  | { kind: 'failed' }
  // No answer, or one that does not say what was recorded. The mark stays as asked, and the next
  // status read decides.
  | { kind: 'noAnswer' }

// What a mark goes back to once the gateway holds no request for it: the address given up before the
// request, which stays given up, or no mark at all. Never null for a wallet that had removed its
// address, or the next open would mint a generated name over that choice. Applied only while the mark
// is still the one the answer was asked from (answerDeletionMark), so a stale `none` never drops a
// request made meanwhile; false then.
function letGo(walletId: string, pubkey: string, mark: DeletionMark): Promise<boolean> {
  const back: DeletionMark | null =
    typeof mark.removedAt === 'number' ? { pubkey: mark.pubkey || pubkey, state: 'removed', askedAt: mark.removedAt } : null
  return answerDeletionMark(walletId, pubkey, back, mark)
}

/**
 * Asks the gateway to delete the wallet's data.
 *
 * The mark is written as asked before the request is signed, so a process killed at any point after
 * it holds the address, push and purchases until a status read settles it. A mark that cannot be
 * written stops the request before anything is sent. Nothing on the device is deleted here: the
 * local cleanup waits for `done` (settleDeletion).
 */
export async function requestDeletion(deps: DeletionDeps, ownedHosts: string[] = []): Promise<RequestResult> {
  const turn = deps.turn ?? (<T>(work: () => Promise<T>) => work())
  return turn(async (): Promise<RequestResult> => {
    const found = await findDeletionMark({ walletId: deps.walletId, pubkey: deps.pubkey })
    // A wallet whose mark this device lost is read back first (settleDeletion); asking over it would
    // write a mark that hides what the gateway holds.
    if (found?.unknown) {
      return { kind: 'failed' }
    }
    const before = found?.mark ?? null
    // A wallet that gave its address up keeps that fact through the request, so a request that never
    // arrives leaves it removed (letGo).
    const removedAt = before?.state === 'removed' ? before.askedAt : before?.removedAt
    const asked: DeletionMark = {
      pubkey: deps.pubkey,
      state: 'asked',
      askedAt: nowSecs(deps),
      ...(ownedHosts.length > 0 ? { ownedHosts } : {}),
      ...(typeof removedAt === 'number' ? { removedAt } : {}),
    }
    await writeDeletionMark(deps.walletId, asked)
    // The provider stops posting this wallet's payments before the gateway is asked to forget it. A
    // removal it does not confirm in time is the next connect's to finish, and a marker that cannot be
    // written leaves the state for the held pass to remove from, so neither stops the request.
    await retirePaymentWebhook(deps.walletId, deps.pubkey).catch((err: unknown) => {
      console.warn(`payment webhook not retired before the deletion request: ${(err as Error)?.message ?? String(err)}`)
    })
    const reply = await send(deps, 'request')
    if (reply.kind === 'none') {
      return { kind: 'noAnswer' }
    }
    const { status, body } = reply
    // 202 for a request recorded now or already pending; the gateway's own field for the deadline is
    // `finishBy`.
    if (status === 202) {
      if (body.status !== 'pending' || !isTime(body.requestedAt) || !isTime(body.finishBy)) {
        return { kind: 'noAnswer' }
      }
      // Written whatever the mark became meanwhile: a status read sent before this request was
      // recorded can have answered none and let the asked mark go.
      await answerDeletionMark(
        deps.walletId,
        deps.pubkey,
        { ...asked, state: 'pending', requestedAt: body.requestedAt, deadline: body.finishBy },
        'any',
      )
      return { kind: 'pending', requestedAt: body.requestedAt, deadline: body.finishBy }
    }
    // 200 is a request this key already finished, from this device or another with the same seed.
    // The mark stays as asked, and the status read runs the cleanup before anything says deleted.
    if (status === 200) {
      return { kind: 'noAnswer' }
    }
    // The gateway already holds a request for this key, from this device or another one with the
    // same seed. The mark stays as asked and the status read says how far it went.
    if (status === 409 && body.error === 'deleted') {
      return { kind: 'noAnswer' }
    }
    const blockers = status === 409 ? codesOf(body.blockers) : null
    await letGo(deps.walletId, deps.pubkey, asked)
    return blockers && blockers.length > 0 ? { kind: 'blocked', blockers } : { kind: 'failed' }
  })
}

// --- status ----------------------------------------------------------------------------------

export type StatusReply =
  | { kind: 'none' }
  | { kind: 'pending'; requestedAt?: number; deadline?: number }
  | { kind: 'done'; doneAt: number }
  | { kind: 'returned' }
  | { kind: 'noAnswer' }

export async function readDeletionStatus(deps: DeletionDeps): Promise<StatusReply> {
  const reply = await send(deps, 'status')
  if (reply.kind === 'none' || reply.status !== 200) {
    return { kind: 'noAnswer' }
  }
  return statusOf(reply.body)
}

// The status fields of a 200 body, the status action's and the ones merged into the preview's.
function statusOf(body: Record<string, unknown>): StatusReply {
  switch (body.status) {
    case 'none':
      return { kind: 'none' }
    case 'returned':
      return { kind: 'returned' }
    case 'pending':
      return {
        kind: 'pending',
        ...(isTime(body.requestedAt) ? { requestedAt: body.requestedAt } : {}),
        ...(isTime(body.finishBy) ? { deadline: body.finishBy } : {}),
      }
    case 'done':
      // `done` without its date is not an answer the screen can show, so it is no answer.
      return isTime(body.doneAt) ? { kind: 'done', doneAt: body.doneAt } : { kind: 'noAnswer' }
    default:
      return { kind: 'noAnswer' }
  }
}

// --- local cleanup -----------------------------------------------------------------------------

/**
 * Drops this device's own copies of one wallet's records at Voltz. Runs only after the gateway said
 * `done`. Every step is keyed by this wallet's id, or by its key for the one file the device shares
 * between wallets, so another wallet's records are written back as they were. Each step is
 * idempotent and the first failure stops the run, which the next status read repeats.
 */
export async function dropLocalRecords(walletId: string, pubkey: string, ownedHosts: string[] = []): Promise<void> {
  await forgetLnAddress(walletId)
  await forgetRegistrationOf(pubkey)
  // The gateway dropped the webhook id and its secret with the rest, so this device's copy goes too,
  // into the removal marker first: the provider can still hold the webhook, and the marker keeps what
  // the next pass on this key needs to take it off. The forget it queues finds nothing left and is
  // answered as any other.
  await retireWebhookState(walletId, pubkey)
  sendDeviceForgets().catch(() => undefined)
  await forgetWalletOrders(walletId)
  await forgetWalletPurchases(walletId)
  await forgetWalletLines(walletId)
  await forgetPurchaseAsk(walletId)
  const roles = await cachedDomainRoles()
  const owned = new Set(ownedHosts.map(host => host.toLowerCase()))
  if (roles[walletId]?.role === 'owner') {
    owned.add(roles[walletId].host.toLowerCase())
  }
  const stored = await storedDomainFor(walletId)
  if (stored !== undefined && owned.has(stored)) {
    await clearDomainFor(walletId)
  }
  // Labels are names an owner gave the wallets on its domain, and the file does not say which owner.
  // They go only when no other wallet here owns a domain, so another owner's labels are never lost.
  const otherOwner = Object.entries(roles).some(([id, entry]) => id !== walletId && entry.role === 'owner')
  if (owned.size > 0 && !otherOwner) {
    await forgetLabels()
  }
  await forgetDomainCache(walletId)
  await forgetDomainAsk(walletId)
  await forgetWalletDomainPurchase(walletId)
}

// The SDK reads its lnurl domain once, at connect. After the cleanup pointed an owner back at the
// build's domain, the live session still serves the deleted one, and an address made on it would
// land on a host that is gone, so the session is rebuilt first.
//
// Never under a send or a prepare in flight: it then rejects with SparkReconnectBusy and drops
// nothing. The status read lets that go, since the done mark holds every register and the way back
// reconnects again; the way back fails the press, which the person repeats.
export async function reconnectIfDomainMoved(walletId: string): Promise<void> {
  if (sparkConnectedWalletId() !== walletId) {
    return
  }
  if (connectedLnurlDomain() === (await domainFor(walletId))) {
    return
  }
  await reconnectActiveWallet({ whenIdle: true })
}

// --- what the screen shows -------------------------------------------------------------------

export type DeletionView =
  | { kind: 'none' }
  // The address was given up from the address screen; nothing was asked of the gateway.
  | { kind: 'removed' }
  // Asked, with no answer read yet that says it was recorded.
  | { kind: 'asked' }
  | { kind: 'pending'; requestedAt?: number; deadline?: number }
  | { kind: 'done'; doneAt?: number }
  // A status read said the gateway never recorded the request. The mark is gone, or back to removed
  // for a wallet that had given its address up before asking (`removed`).
  | { kind: 'notArrived'; removed?: boolean }
  // This device lost what it recorded for the wallet (deletionMark.ts) and no status read has answered
  // for it yet. Held, and nothing about the deletion is said either way.
  | { kind: 'checking' }

export function viewOf(mark: DeletionMark | null): DeletionView {
  if (!mark) {
    return { kind: 'none' }
  }
  switch (mark.state) {
    case 'removed':
      return { kind: 'removed' }
    case 'asked':
      return { kind: 'asked' }
    case 'pending':
      return { kind: 'pending', requestedAt: mark.requestedAt, deadline: mark.deadline }
    case 'done':
      return { kind: 'done', doneAt: mark.doneAt }
  }
}

function viewOfFound(found: FoundMark | null): DeletionView {
  return found?.unknown ? { kind: 'checking' } : viewOf(found?.mark ?? null)
}

// What the screen shows once an answer could not be written because the mark changed meanwhile: the
// mark as it is now, which the change that beat it wrote.
async function viewNow(deps: DeletionDeps): Promise<DeletionView> {
  return viewOfFound(await findDeletionMark({ walletId: deps.walletId, pubkey: deps.pubkey }))
}

export type SettleDeps = DeletionDeps & {
  /** Injected for tests; the app drops the real records. */
  cleanup?: (walletId: string, pubkey: string, ownedHosts?: string[]) => Promise<void>
}

/**
 * What the screen shows for this wallet, after a status read when one is due.
 *
 * Only an asked or pending mark reads the gateway, and a mark this device lost, which is read back as
 * an import is (adoptDeletionStatus). `done` is shown only once the local cleanup ran, and the cleanup
 * runs only on `done`. No answer leaves the mark as it is, and the screen as the mark says. Every write
 * is applied only while the mark is still the one the read started from.
 */
export async function settleDeletion(deps: SettleDeps): Promise<DeletionView> {
  const found = await findDeletionMark({ walletId: deps.walletId, pubkey: deps.pubkey })
  if (found?.unknown) {
    let adopted = null as DeletionView | 'noAnswer' | null
    await adoptOnce(deps.walletId, async () => {
      adopted = await adoptDeletionStatus(deps)
    })
    // Null when another starter's read was in flight and this one waited for it: what it wrote, if
    // anything, is in the mark.
    if (adopted === null) {
      return viewNow(deps)
    }
    return adopted === 'noAnswer' ? { kind: 'checking' } : adopted
  }
  if (!found || (found.mark.state !== 'asked' && found.mark.state !== 'pending')) {
    return viewOf(found?.mark ?? null)
  }
  // Written where the mark is stored, which is another id only for the same seed added twice here.
  const { walletId: at, mark } = found
  const status = await readDeletionStatus(deps)
  switch (status.kind) {
    case 'noAnswer':
      return viewOf(mark)
    case 'none':
      if (!(await letGo(at, deps.pubkey, mark))) {
        return viewNow(deps)
      }
      return typeof mark.removedAt === 'number' ? { kind: 'notArrived', removed: true } : { kind: 'notArrived' }
    case 'returned':
      if (!(await letGo(at, deps.pubkey, mark))) {
        return viewNow(deps)
      }
      return typeof mark.removedAt === 'number' ? { kind: 'removed' } : { kind: 'none' }
    case 'pending': {
      const next: DeletionMark = {
        ...mark,
        pubkey: mark.pubkey || deps.pubkey,
        state: 'pending',
        requestedAt: status.requestedAt ?? mark.requestedAt,
        deadline: status.deadline ?? mark.deadline,
      }
      // The same pending answer again changes nothing, so the file is not written for it; the view
      // is read back, in case another change replaced the mark meanwhile.
      if (sameMark(next, mark)) {
        return viewNow(deps)
      }
      if (!(await answerDeletionMark(at, deps.pubkey, next, mark))) {
        return viewNow(deps)
      }
      return viewOf(next)
    }
    case 'done':
      return finishDone(deps, at, mark, status.doneAt)
  }
}

function sameMark(a: DeletionMark, b: DeletionMark): boolean {
  return (
    a.pubkey === b.pubkey &&
    a.state === b.state &&
    a.requestedAt === b.requestedAt &&
    a.deadline === b.deadline
  )
}

// Home's read on focus and the deletion screen's can both hear `done` at once. One cleanup runs per
// stored mark, and a second `done` meanwhile waits for it and answers what it answered, so no two
// cleanups write the same files at the same time.
const finishing = new Map<string, Promise<DeletionView>>()

function finishDone(deps: SettleDeps, at: string, mark: DeletionMark, doneAt: number): Promise<DeletionView> {
  const running = finishing.get(at)
  if (running) {
    return running
  }
  const run = finishDoneOnce(deps, at, mark, doneAt).finally(() => finishing.delete(at))
  finishing.set(at, run)
  return run
}

// `done` from the gateway: the local cleanup first, and only then the mark that says deleted.
async function finishDoneOnce(deps: SettleDeps, at: string, mark: DeletionMark, doneAt: number): Promise<DeletionView> {
  const cleanup = deps.cleanup ?? dropLocalRecords
  const pubkey = mark.pubkey || deps.pubkey
  try {
    await cleanup(deps.walletId, pubkey, mark.ownedHosts)
    if (at !== deps.walletId) {
      await cleanup(at, pubkey, mark.ownedHosts)
    }
  } catch {
    // The records stay and so does the mark, as pending: the next read runs the cleanup again,
    // and the screen never says deleted while a copy is still here.
    return viewOf({ ...mark, state: 'pending' })
  }
  const done: DeletionMark = { ...mark, pubkey, state: 'done', doneAt }
  if (!(await answerDeletionMark(at, pubkey, done, mark))) {
    return viewNow(deps)
  }
  // The done mark holds every register, and the way back reconnects again before it makes an
  // address (returnActiveWallet). A reconnect that fails here can leave no live session at all, since
  // it disconnects first; the next connect is Home's next focus or the next open of the deletion screen
  // (connectActiveSpark, which connects whenever no session is live).
  await reconnectIfDomainMoved(deps.walletId).catch(() => undefined)
  return viewOf(done)
}

// --- a seed deleted from another device, or a mark this device lost ------------------------------

/**
 * Reads the gateway's status once for a wallet that holds no mark here, or whose mark this device lost
 * with a file it could not read, and writes the mark the answer says, so a seed whose data was
 * deleted from another device ends on this one where it ends on that one: in progress, or deleted with
 * the way back. None and returned write no mark, since the gateway holds nothing against the key, and
 * no answer writes nothing and says so, for the caller to ask again later.
 */
export async function adoptDeletionStatus(deps: SettleDeps): Promise<DeletionView | 'noAnswer'> {
  const found = await findDeletionMark({ walletId: deps.walletId, pubkey: deps.pubkey })
  if (found && !found.unknown) {
    return viewOf(found.mark)
  }
  return adoptStatus(deps, await readDeletionStatus(deps))
}

// The mark an answer says, written only while the wallet still holds none here (an unknown one is
// stored as none).
async function adoptStatus(deps: SettleDeps, status: StatusReply): Promise<DeletionView | 'noAnswer'> {
  switch (status.kind) {
    case 'noAnswer':
      return 'noAnswer'
    case 'none':
    case 'returned':
      return (await answerDeletionMark(deps.walletId, deps.pubkey, null, null)) ? { kind: 'none' } : viewNow(deps)
    case 'pending': {
      const mark: DeletionMark = {
        pubkey: deps.pubkey,
        state: 'pending',
        askedAt: nowSecs(deps),
        ...(status.requestedAt ? { requestedAt: status.requestedAt } : {}),
        ...(status.deadline ? { deadline: status.deadline } : {}),
      }
      return (await answerDeletionMark(deps.walletId, deps.pubkey, mark, null)) ? viewOf(mark) : viewNow(deps)
    }
    case 'done': {
      // Held as pending before the cleanup, so a cleanup that fails leaves the wallet held and the
      // next status read runs it again.
      const mark: DeletionMark = { pubkey: deps.pubkey, state: 'pending', askedAt: nowSecs(deps) }
      if (!(await answerDeletionMark(deps.walletId, deps.pubkey, mark, null))) {
        return viewNow(deps)
      }
      return finishDone(deps, deps.walletId, mark, status.doneAt)
    }
  }
}

/**
 * The status read after an import (deletionMark.ts, noteImportCheck), and after a mark file this
 * device could not read: asked once the wallet can sign, and asked again on a later open only while no
 * answer came.
 */
export async function checkImportedDeletion(deps: SettleDeps): Promise<void> {
  const lost = (await findDeletionMark({ walletId: deps.walletId, pubkey: deps.pubkey }))?.unknown === true
  if (!lost && !(await importCheckDue(deps.walletId))) {
    return
  }
  // A read another starter had in flight is waited for, and leaves the check due. The next open clears
  // it without a request when that read wrote a mark, and asks again when it did not.
  let answered = false
  await adoptOnce(deps.walletId, async () => {
    answered = (await adoptDeletionStatus(deps)) !== 'noAnswer'
  })
  if (answered) {
    await clearImportCheck(deps.walletId)
  }
}

// A pending request runs for days, so after Home's read of it answered pending, the next focus
// within this floor reads nothing. The status call shares the gateway's costly per-caller budget
// with quotes and store orders, and a focus is often just a tab switch. Asked marks still read on
// every focus: the first answer is what says whether the request was recorded. The deletion screen
// reads on every open, so a person who looks gets a fresh answer.
export const PENDING_FOCUS_FLOOR_SECS = 300
const pendingReadAt = new Map<string, number>()

// How long the daily read of a wallet on a domain of its own waits after an answer.
export const DOMAIN_READ_EVERY_SECS = 24 * 60 * 60

// A wallet whose address may live on a domain of its own. Its data can be deleted from another device
// that also takes the domain down, and then no automatic call of this device may ever meet the 409 that
// would say so, since every register goes to a host that no longer answers. The stored domain is the
// main sign; the cached owner role also covers an owner whose stored domain was lost. A member of
// someone else's domain counts too, at the cost of one read a day.
async function onOwnDomain(walletId: string): Promise<boolean> {
  const shared = getBreezLnurlDomain()?.trim().toLowerCase()
  const stored = (await storedDomainFor(walletId))?.trim().toLowerCase()
  if (stored && stored !== shared) {
    return true
  }
  return (await cachedDomainRoles())[walletId]?.role === 'owner'
}

const dailyUnansweredAt = new Map<string, number>()

// At most one answered read a day for such a wallet with no mark here. No answer may repeat after
// PENDING_FOCUS_FLOOR_SECS; a time file that cannot be read makes the read due, never blocks it.
async function readOwnDomainDaily(deps: SettleDeps): Promise<void> {
  if (!(await onOwnDomain(deps.walletId))) {
    return
  }
  const now = nowSecs(deps)
  const last = await lastStatusReadAt(deps.walletId)
  if (last !== null && now - last < DOMAIN_READ_EVERY_SECS) {
    return
  }
  const tried = dailyUnansweredAt.get(deps.walletId)
  // A read another starter began is already asking for this wallet.
  if ((tried !== undefined && now - tried < PENDING_FOCUS_FLOOR_SECS) || adopting.has(deps.walletId)) {
    return
  }
  // The outcome is noted before the turn is let go. A focus that read the time while this read was in
  // flight finds the turn still held when it looks, where noting it after the turn would let that
  // focus ask a second time. A time that cannot be written fails this focus once the turn is let go,
  // so a starter waiting on the read is not failed by it.
  let noted: Promise<void> = Promise.resolve()
  await adoptOnce(deps.walletId, async () => {
    if ((await adoptDeletionStatus(deps)) === 'noAnswer') {
      dailyUnansweredAt.set(deps.walletId, now)
      return
    }
    dailyUnansweredAt.delete(deps.walletId)
    noted = noteStatusReadAt(deps.walletId, now)
    await noted.catch(() => undefined)
  })
  await noted
}

/**
 * The status reads Home makes on focus, the app's first open included, for the wallet it is on: a
 * request still asked or pending, so a deletion that finished elsewhere ends in done with its local
 * cleanup without a visit to the deletion screen, then the read after an import or a lost mark, and
 * for a wallet with no mark and nothing due on a domain of its own, one read a day.
 */
export async function readDeletionOnFocus(deps: SettleDeps): Promise<void> {
  const found = await findDeletionMark({ walletId: deps.walletId, pubkey: deps.pubkey })
  if (found && !found.unknown && (found.mark.state === 'asked' || found.mark.state === 'pending')) {
    const last = pendingReadAt.get(deps.walletId)
    const now = nowSecs(deps)
    if (!(found.mark.state === 'pending' && last !== undefined && now - last < PENDING_FOCUS_FLOOR_SECS)) {
      const view = await settleDeletion(deps)
      if (view.kind === 'pending') {
        pendingReadAt.set(deps.walletId, now)
      } else {
        pendingReadAt.delete(deps.walletId)
      }
    }
  }
  const importDue = !found && (await importCheckDue(deps.walletId))
  await checkImportedDeletion(deps)
  if (!found && !importDue) {
    await readOwnDomainDaily(deps)
  }
}

/**
 * The preview, for a wallet that holds no mark here. The gateway merges the request's status into it,
 * and a seed whose deletion was asked from another device is pending or done there: the mark is
 * written from that status, as an import's read writes it, rather than leaving every automatic step
 * to run into the gateway's refusal.
 */
export async function previewOrAdopt(deps: SettleDeps): Promise<PreviewResult | { kind: 'adopted'; view: DeletionView }> {
  const read = await previewDeletion(deps)
  if (read.kind !== 'preview' || (read.status.kind !== 'pending' && read.status.kind !== 'done')) {
    return read
  }
  if (await findDeletionMark({ walletId: deps.walletId, pubkey: deps.pubkey })) {
    return read
  }
  const view = await adoptStatus(deps, read.status)
  return view === 'noAnswer' ? read : { kind: 'adopted', view }
}

// --- return ----------------------------------------------------------------------------------

export type ReturnResult = { kind: 'returned' } | { kind: 'failed' }

/**
 * "Create the address again". A wallet that only gave its address up asks nobody: the gateway holds
 * nothing for it, and the mark goes. A wallet that asked for its data to be deleted asks the gateway
 * to stop refusing its key, and the mark goes only on a 200, so the address is never minted while
 * the gateway would still refuse it.
 */
export async function returnFromDeletion(deps: DeletionDeps): Promise<ReturnResult> {
  const found = await findDeletionMark({ walletId: deps.walletId, pubkey: deps.pubkey })
  if (!found) {
    return { kind: 'returned' }
  }
  // Not offered for a mark this device lost: the status read decides first what there is to undo.
  if (found.unknown) {
    return { kind: 'failed' }
  }
  if (found.mark.state === 'removed') {
    await clearDeletionMark(found.walletId)
    return { kind: 'returned' }
  }
  const reply = await send(deps, 'return')
  if (reply.kind === 'none' || reply.status !== 200) {
    return { kind: 'failed' }
  }
  // The gateway no longer refuses the key, which is an answer for it like a status of none.
  await answerDeletionMark(found.walletId, deps.pubkey, null, 'any')
  return { kind: 'returned' }
}

// --- the live wallet ---------------------------------------------------------------------------

/**
 * "Create the address again" for the wallet the app is on. The session is rebuilt first when the
 * cleanup moved the wallet's domain, so the address made right after lands on the domain in use.
 */
export async function returnActiveWallet(): Promise<ReturnResult> {
  const walletId = await getActiveWalletId()
  if (walletId) {
    await reconnectIfDomainMoved(walletId)
  }
  return returnFromDeletion(await liveDeletionDeps())
}

/**
 * Deps for the wallet the app is on: the registry's active id, signed by the connected identity
 * (which refuses to sign as another wallet), and the address turn of spark.ts.
 */
export async function liveDeletionDeps(): Promise<DeletionDeps> {
  const walletId = await getActiveWalletId()
  if (!walletId) {
    throw new Error('no active wallet')
  }
  // A wallet switch repoints the registry without reconnecting the SDK, so the connected identity can
  // still be the previous wallet's. Signing with it would ask the gateway to delete that wallet's data
  // while the mark lands on this one, so the active wallet is connected first and checked after.
  await connectActiveSpark()
  if (sparkConnectedWalletId() !== walletId) {
    throw new Error('spark connected as another wallet')
  }
  return connectedDeps(walletId)
}

async function connectedDeps(walletId: string): Promise<DeletionDeps> {
  const signer = await identitySigner()
  return { walletId, pubkey: signer.pubkey, sign: signer.sign, turn: sparkInAddressTurn }
}

/**
 * What the mark alone says for the active wallet, without asking the gateway or connecting. Looked
 * up by its key too when the session is on it, as every stop looks it up (findDeletionMark).
 */
export async function activeDeletionView(): Promise<DeletionView> {
  const walletId = await getActiveWalletId()
  if (!walletId) {
    throw new Error('no active wallet')
  }
  const pubkey = sparkConnectedWalletId() === walletId ? await sparkGetIdentityPubkey().catch(() => null) : null
  return viewOfFound(await findDeletionMark({ walletId, pubkey }))
}

/**
 * The address ensure of spark.ts, for a screen. The gateway refusing the key with `deleted` while
 * this device holds no mark is a seed whose data was deleted from another device, so the status is
 * read once and the wallet held as the answer says, rather than left with no address and no reason.
 * The refusal's own notice has usually started that read already, and this waits for it; a screen
 * reads even inside REFUSAL_READ_FLOOR_SECS, since someone is looking at it.
 */
export async function ensureLnAddressOrAdopt(): Promise<SparkLnAddress | null> {
  try {
    return await sparkEnsureLnAddress()
  } catch (err) {
    if (gatewayRefusal(err) !== 'deleted') {
      throw err
    }
    const running = adopting.get(sparkConnectedWalletId() ?? '')
    if (running) {
      await running
      return null
    }
    const deps = await liveDeletionDeps()
    await adoptOnce(deps.walletId, () => adoptAfterRefusal(deps))
    return null
  }
}

// --- a `deleted` refusal from any gateway call ---------------------------------------------------

// After a status read on a refusal that got no answer, the next refusal within this window reads
// nothing: every automatic call of a deleted wallet is refused, and each read spends the gateway's
// per-caller budget that quotes and store orders share.
export const REFUSAL_READ_FLOOR_SECS = PENDING_FOCUS_FLOOR_SECS

// One status read at a time per wallet with no mark here, or a lost one, whichever refusal, import
// check, daily read or screen started it; a second starter waits for the read in flight. The read of
// an asked or pending mark (settleDeletion) is not counted here, and finishDone keeps two of its
// `done` answers from cleaning up twice.
const adopting = new Map<string, Promise<void>>()
const unansweredAt = new Map<string, number>()

function adoptOnce(walletId: string, work: () => Promise<void>): Promise<void> {
  const running = adopting.get(walletId)
  if (running) {
    return running
  }
  const run = work().finally(() => adopting.delete(walletId))
  adopting.set(walletId, run)
  return run
}

const sameKey = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

// The status read for a wallet the gateway refused as deleted, and the mark its answer says, written
// only while the session is still on that wallet once the answer is in, and only while the wallet
// holds no mark here (adoptStatus).
async function adoptAfterRefusal(deps: DeletionDeps): Promise<void> {
  const found = await findDeletionMark({ walletId: deps.walletId, pubkey: deps.pubkey })
  if (found && !found.unknown) {
    return
  }
  const status = await readDeletionStatus(deps)
  if (status.kind === 'noAnswer') {
    unansweredAt.set(deps.walletId, nowSecs(deps))
    return
  }
  unansweredAt.delete(deps.walletId)
  if (sparkConnectedWalletId() !== deps.walletId || !sameKey(await sparkGetIdentityPubkey().catch(() => null), deps.pubkey)) {
    return
  }
  await adoptStatus(deps, status)
}

// The listener of deletionMark.ts's notice. Only the connected wallet, signing as the refused key,
// and the active one, so nothing is reconnected for it; never while a read for it runs, nor within
// the floor after one that got no answer. The refused call never waits for it, so a failure is
// logged and dropped.
function hearDeleted(pubkey: string): void {
  const walletId = sparkConnectedWalletId()
  if (!walletId || adopting.has(walletId)) {
    return
  }
  const last = unansweredAt.get(walletId)
  if (last !== undefined && Math.floor(Date.now() / 1000) - last < REFUSAL_READ_FLOOR_SECS) {
    return
  }
  adoptOnce(walletId, async () => {
    if ((await getActiveWalletId()) !== walletId) {
      return
    }
    const deps = await connectedDeps(walletId)
    if (!sameKey(deps.pubkey, pubkey) || sparkConnectedWalletId() !== walletId) {
      return
    }
    await adoptAfterRefusal(deps)
  }).catch((err: unknown) => {
    console.warn('deletion status after a refusal:', (err as Error)?.message ?? err)
  })
}

onGatewayDeleted(hearDeleted)
