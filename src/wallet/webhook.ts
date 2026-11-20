import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Buffer } from 'buffer'

// The payment webhook a wallet registers with the Spark provider, which POSTs the wallet's payment
// events to the gateway so it can push while the app is closed (guide/webhooks.html). This module
// decides what the provider should hold; `paymentWebhook.ts` does it on the connection.

// The four events the provider sends, the only ones its schema has. LightningReceiveFinished covers
// invoices the wallet itself made; lightning address receives reach the gateway from the LNURL server.
export const PAYMENT_WEBHOOK_EVENTS = [
  'LightningReceiveFinished',
  'LightningSendFinished',
  'CoopExitFinished',
  'StaticDepositFinished',
] as const

// What the gateway answers a v5 registration with: random and URL safe, at least 128 bits, which is 22
// characters of base64url. Checked before it goes into a path, so an answer can never add a segment,
// a query or a host to the URL the provider posts to.
const WEBHOOK_ID = /^[A-Za-z0-9_-]{22,128}$/

export function isWebhookId(value: unknown): value is string {
  return typeof value === 'string' && WEBHOOK_ID.test(value)
}

// 32 bytes as lowercase hex, the form the gateway accepts and the form drawWebhookSecret produces.
const WEBHOOK_SECRET = /^[0-9a-f]{64}$/

export function isWebhookSecret(value: unknown): value is string {
  return typeof value === 'string' && WEBHOOK_SECRET.test(value)
}

const PAYMENT_PATH = '/api/push/spark/'

// The provider posts the wallet's payments here. The path carries the gateway's id and nothing else:
// the provider is a third party, and a push token in its records would let it address this device.
export function paymentWebhookUrl(gatewayBase: string, webhookId: string): string {
  const base = gatewayBase.trim().replace(/\/+$/, '')
  if (!base) {
    throw new Error('gateway base url is required')
  }
  if (!isWebhookId(webhookId)) {
    throw new Error('invalid webhook id')
  }
  return `${base}${PAYMENT_PATH}${webhookId}`
}

// The statement a forget proves (POST /api/device/forget), rebuilt byte for byte by the gateway with the
// Host it was reached on. It names no time: a proof removes only registrations made with the secret it
// was made with, and a secret a forget named is never registered again (the app never sends it again,
// and the gateway refuses it while it keeps the mark, 410 `forgotten`), so a replay removes nothing
// that is not already removed or refused (as a revocation, RFC 7009 section 2.2).
const FORGET_VERSION = 'voltz-push-forget:v1'

export function forgetStatement(domain: string, pubkey: string): string {
  return [FORGET_VERSION, domain, pubkey.trim().toLowerCase()].join('\n')
}

// Lowercase hex HMAC-SHA256 of the statement keyed with the secret's UTF-8 bytes, the primitive the
// provider signs its deliveries with (X-Spark-Signature, guide/webhooks.html). Only a holder of the
// secret this device registered can make it, and it says nothing of the secret.
export function forgetProof(domain: string, pubkey: string, secret: string): string {
  const mac = hmac(sha256, Buffer.from(secret, 'utf8'), Buffer.from(forgetStatement(domain, pubkey), 'utf8'))
  return Buffer.from(mac).toString('hex')
}

// The breez/notify route, `<base>/api/v1/notify?platform=..&token=..`, carries the push token in the
// query. A webhook at it that is this device's is matched so the pass removes it, since a push token in
// the provider's records would let the provider address this device. It is this device's when it is on
// the gateway's own host or carries this device's token, which no other app knows.
const NOTIFY_ROUTE = '/api/v1/notify?'

function isOwnNotifyUrl(url: string, gatewayBase: string, token: string | undefined): boolean {
  const at = url.indexOf(NOTIFY_ROUTE)
  if (at < 0) {
    return false
  }
  if (url.slice(0, at) === gatewayBase) {
    return true
  }
  if (!token) {
    return false
  }
  const params = url.slice(at + NOTIFY_ROUTE.length).split('&')
  return params.includes(`token=${encodeURIComponent(token)}`) || params.includes(`token=${token}`)
}

export type ListedWebhook = { id: string; url: string; events: string[] }

export type WebhookPlan = {
  // The webhook left in place, when the one this device registered is already right.
  keep: string | null
  remove: string[]
  register: boolean
}

export type WebhookContext = {
  gatewayBase: string
  // The SDK webhook this device registered with the secret it holds now.
  marker?: { id: string; url: string }
  token?: string
  // What this device retired for the wallet and the provider has not confirmed removing
  // (webhookSecret.ts). Each goes, whatever else the plan keeps.
  retiring?: { webhookIds: string[]; sdkIds: string[]; urls: string[] }
}

// A retired webhook is known by its SDK id, by the URL noted with it, or by a URL ending in a gateway id
// this device was given, on whatever host it was registered for.
function isRetired(hook: ListedWebhook, retiring: WebhookContext['retiring']): boolean {
  if (!retiring) {
    return false
  }
  return (
    retiring.sdkIds.includes(hook.id) ||
    retiring.urls.includes(hook.url) ||
    retiring.webhookIds.some(id => hook.url.endsWith(`${PAYMENT_PATH}${id}`))
  )
}

function hasExactlyTheEvents(events: string[]): boolean {
  return (
    events.length === PAYMENT_WEBHOOK_EVENTS.length &&
    PAYMENT_WEBHOOK_EVENTS.every(event => events.includes(event))
  )
}

/**
 * What to change so the provider holds one webhook of this device for the wallet, at `want`, or none
 * when `want` is null.
 *
 * The provider's list is the wallet's, and a wallet open on two devices has a webhook of each, both on
 * the gateway's host. So a webhook counts as this device's only by proof: its URL is `want` (the id in
 * it is this device's), it is the one the marker names or sits at the marker's URL (an id the gateway
 * has since replaced), or it is the old notify route of this device. Anything else, another device's
 * included, is left alone.
 *
 * A webhook is kept only when the marker names it at `want` with exactly the four events. Without that
 * proof the secret it was made with is unknown, so it is replaced, never trusted. A retired one is
 * never kept.
 */
export function planWebhooks(listed: ListedWebhook[], want: string | null, context: WebhookContext): WebhookPlan {
  const base = context.gatewayBase.trim().replace(/\/+$/, '')
  const { marker, token, retiring } = context
  const mine = listed.filter(
    hook =>
      (want !== null && hook.url === want) ||
      (marker !== undefined && (hook.id === marker.id || hook.url === marker.url)) ||
      isOwnNotifyUrl(hook.url, base, token) ||
      isRetired(hook, retiring),
  )
  const keeper =
    want !== null && marker?.url === want
      ? mine.find(
          hook =>
            hook.id === marker.id &&
            hook.url === want &&
            hasExactlyTheEvents(hook.events) &&
            !isRetired(hook, retiring),
        )
      : undefined
  return {
    keep: keeper?.id ?? null,
    remove: mine.filter(hook => hook !== keeper).map(hook => hook.id),
    register: want !== null && keeper === undefined,
  }
}
