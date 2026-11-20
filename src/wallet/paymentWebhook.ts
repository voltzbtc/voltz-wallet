import { getBreezLnurlDomain } from '../config'
import { answerWithin } from './answerWithin'
import { deletionHolds } from './deletionMark'
import { sendDeviceForgets } from './deviceForget'
import { sparkConnectedIdentity, sparkWebhookSession } from './spark'
import { paymentWebhookUrl, planWebhooks } from './webhook'
import { loadRetiring, loadWebhookState, noteSdkWebhook, retireWebhookState, settleRetiring } from './webhookSecret'

export type PaymentWebhookTarget = {
  walletId: string
  pubkey: string
  // The gateway on the wallet's domain, `https://<domain>`.
  gatewayBase: string
  // This device's push token, which only identifies the old notify route to remove.
  token?: string
}

// One pass at a time. Two passes over one list would both find no webhook and both register one.
let turn: Promise<void> = Promise.resolve()

// How long a pass holds the queue. The SDK documents no timeout for these calls, and a pass whose
// call never answers would otherwise hold every later one, so no connect after it could repair
// anything. One released late can still finish on its own, and the pass after it removes any extra
// webhook it left, since only the marker's survives a plan.
export const PASS_WAIT_MS = 30_000

// Resolves once every pass queued so far has ended, whatever it ended with.
export function paymentWebhookSettled(): Promise<void> {
  return turn
}

/**
 * Brings the provider's webhooks for the connected wallet in line with what this device holds: one
 * webhook of this device at the gateway's URL for its id, with the four events and the secret the
 * gateway has, and no older one of this device. A wallet held by a deletion keeps none, and whatever
 * the removal marker names goes, the marker losing each entry only once the provider removed it.
 *
 * Runs after every push registration, so a pass that failed is the next connect's to repeat. Nothing
 * waits on it: a connect, a send and the registration itself go on whatever it answers. A removal
 * that fails stops the pass before anything is registered, so the marker never forgets a webhook the
 * provider still holds.
 */
export function syncPaymentWebhook(target: PaymentWebhookTarget): Promise<void> {
  const previous = turn
  const run = previous.then(() => pass(target))
  // The wait starts with the pass, so time spent behind the pass before it is not charged to this one.
  turn = previous
    .then(() =>
      answerWithin(
        run.then(
          () => null,
          () => null,
        ),
        PASS_WAIT_MS,
      ),
    )
    .then(() => undefined)
  return run
}

async function pass({ walletId, pubkey, gatewayBase, token }: PaymentWebhookTarget): Promise<void> {
  const retiring = await loadRetiring(pubkey)
  const state = await loadWebhookState(walletId)
  // A wallet that asked for its data to be deleted, or gave its address up, has no device to notify,
  // and the provider would go on posting its payments to a gateway that keeps nothing of it.
  const held = await deletionHolds({ pubkey })
  const want = !held && state?.webhookId ? paymentWebhookUrl(gatewayBase, state.webhookId) : null
  if (want === null && !held && retiring === null) {
    // Never registered as v5 and nothing retired, so there is nothing of this device's to fix, and no
    // list is spent.
    return
  }
  // Bound to the target's key as well as its id, so a pass queued for one key never lists another's
  // webhooks and settles this key's marker against them.
  const session = sparkWebhookSession(walletId, pubkey)
  const plan = planWebhooks(await session.list(), want, {
    gatewayBase,
    marker: state?.sdk,
    token,
    ...(retiring ? { retiring } : {}),
  })
  for (const id of plan.remove) {
    await session.unregister(id)
  }
  if (retiring) {
    // Every retired webhook the provider listed is removed by now, and one it did not list is already
    // gone, so the provider has confirmed each.
    await settleRetiring(pubkey, retiring)
  }
  if (plan.register && want !== null && state) {
    const id = await session.register(want, state.secret)
    await noteSdkWebhook(walletId, state.secret, { id, url: want })
  }
}

// How long a removal waits on the provider before going on. A deletion request and the removal of a
// wallet are the person's to make, and a provider that does not answer must not hold them; the marker
// stays, so the next connect of that wallet finishes the removal.
export const RETIRE_WAIT_MS = 10_000

/**
 * Takes the wallet's webhook off the provider and queues the gateway forget of its secret: before a data
 * deletion request is filed, and when the wallet is removed from this device.
 *
 * The removal marker and the forget are written first (retireWebhookState) and outlive everything else
 * of the wallet here. The forget is sent at once and never waited on, since it carries its own proof and
 * goes again on every start, connect and return to the foreground until the gateway answers it. The
 * provider's removal is what waits, at most `wait`, and runs now only when the connection is this
 * wallet's; a wallet removed while another one is connected keeps its marker until its key connects
 * again. Rejects only when the marker or the forget could not be written, and then nothing was dropped.
 */
export async function retirePaymentWebhook(walletId: string, pubkey?: string, wait = RETIRE_WAIT_MS): Promise<void> {
  await retireWebhookState(walletId, pubkey)
  sendDeviceForgets().catch(() => undefined)
  await answerWithin(
    removeFromProvider(walletId, pubkey).then(
      () => null,
      () => null,
    ),
    wait,
  )
}

async function removeFromProvider(walletId: string, pubkey?: string): Promise<void> {
  let connected: { walletId: string; pubkey: string } | null = null
  try {
    connected = await sparkConnectedIdentity()
  } catch {
    // With no connection the marker waits for the next connect of this key.
    return
  }
  if (connected.walletId !== walletId || (pubkey !== undefined && connected.pubkey !== pubkey)) {
    return
  }
  const domain = getBreezLnurlDomain()
  const gatewayBase = domain ? `https://${domain}` : ''
  await syncPaymentWebhook({ walletId, pubkey: connected.pubkey, gatewayBase })
}
