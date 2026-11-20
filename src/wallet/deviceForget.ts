import { getBreezLnurlDomain } from '../config'
import { answerWithin } from './answerWithin'
import { loadDeviceForgets, settleDeviceForget, type DeviceForget } from './webhookSecret'

// How long one run holds the queue, as a pass over the provider does (paymentWebhook.ts). A request that
// never answers would otherwise hold every later run.
export const FORGET_WAIT_MS = 30_000

type Deps = { request?: typeof fetch }

// One run at a time, and a call made while one waits to start joins it, since that run reads the queue
// after the call.
let turn: Promise<void> = Promise.resolve()
let next: Promise<void> | null = null

// Resolves once every run queued so far has ended, whatever it ended with.
export function deviceForgetSettled(): Promise<void> {
  return turn
}

async function sendOne(entry: DeviceForget, domain: string, deps: Deps): Promise<void> {
  const response = await (deps.request ?? fetch)(`https://${domain}/api/device/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey: entry.pubkey, proof: entry.proof }),
  })
  // The gateway answers 200 alike whether the proof matched, matched nothing or named an unknown key
  // (RFC 7009 section 2.2), so a 200 is the only answer that ends the forget. A 404 from a gateway
  // without the route, a refusal and a server error keep it for the next run, with no time limit.
  if (response.status !== 200) {
    return
  }
  await settleDeviceForget(entry)
}

async function sendAll(deps: Deps): Promise<void> {
  const domain = getBreezLnurlDomain()
  if (!domain) {
    return
  }
  for (const entry of await loadDeviceForgets()) {
    await sendOne(entry, domain, deps).catch(() => undefined)
  }
}

/**
 * Sends every forget the gateway is still owed. Called right after one is queued (notifications off, a
 * wallet removed, a data deletion), on every start, every connect and every return to the foreground.
 * Each entry carries its own proof, so nothing on the device has to sign and a removed wallet's forget
 * goes as well as the connected one's. Nothing waits on it: a removal and a deletion go on whatever it
 * answers.
 */
export function sendDeviceForgets(deps: Deps = {}): Promise<void> {
  if (next) {
    return next
  }
  const previous = turn
  const run = previous.then(() => {
    next = null
    return sendAll(deps)
  })
  next = run
  // The wait starts with the run, so time spent behind the run before it is not charged to this one.
  turn = previous
    .then(() =>
      answerWithin(
        run.then(
          () => null,
          () => null,
        ),
        FORGET_WAIT_MS,
      ),
    )
    .then(() => undefined)
  return run
}
