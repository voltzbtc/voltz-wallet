import RNFS from 'react-native-fs'
import { deletionHolds, noteGatewayDeleted } from './deletionMark'
import { isWebhookId, isWebhookSecret } from './webhook'

export type PushPlatform = 'ios' | 'android'

// Statement the wallet's identity key signs to say where it wants to be notified. The gateway
// rebuilds it to verify the signature, so the two must stay byte-identical or every registration
// is rejected as an invalid signature. Its own namespace keeps a signature made here from being
// replayed against the LNURL server's `breez-lnurl:` routes.
const MESSAGE_VERSION = 'voltz-push:v1'
const MESSAGE_VERSION_V2 = 'voltz-push:v2'
const MESSAGE_VERSION_V3 = 'voltz-push:v3'
const MESSAGE_VERSION_V4 = 'voltz-push:v4'
const MESSAGE_VERSION_V5 = 'voltz-push:v5'

export function registerDeviceMessage(
  domain: string,
  pubkey: string,
  platform: PushPlatform,
  token: string,
  timestamp: number,
): string {
  // The token is part of the signed statement so an intercepted signature cannot be replayed with a
  // different token to redirect someone else's payment notifications.
  return [MESSAGE_VERSION, 'register-device', domain, pubkey, platform, token, String(timestamp)].join(
    '\n',
  )
}

// How this device wants a notification worded. It is sent to the gateway rather than translated
// there, because this app already carries 24 locales, and a second copy on the server is the copy
// that goes stale.
// `{amount}` and `{domain}` are filled in by the gateway, the only side that knows the value and
// the host.
export type PushText = {
  locale: string
  titleTemplate: string
  bodyTemplate: string
  expiryTitles?: string
  expiryBodies?: string
  /**
   * Wording for the one-off notice that a domain started serving, sent when a purchase reaches
   * `active` and when a frozen one thaws.
   *
   * Two fields of its own rather than a sixth expiry stage. Those five travel as one string where
   * position selects the stage, so a sixth shifts every later one and a device registered with five
   * would be told its last day when its domain just came up. It is also not a rung: the ladder is a
   * race against a date with a claimed-stage guard, and spending a rung on this would cost somebody
   * the expiry warning they needed.
   */
  readyTitle?: string
  readyBody?: string
  // Wording for the payment events the provider's webhook reports, five parts each, in
  // `PAYMENT_EVENTS` order and joined by the unit separator, as the expiry pair is.
  paymentTitles?: string
  paymentBodies?: string
}

// A `PushText` carrying the domain expiry reminders, which is what the v3 statement requires.
export type PushExpiryText = PushText & { expiryTitles: string; expiryBodies: string }
export type PushReadyText = PushExpiryText & { readyTitle: string; readyBody: string }
export type PushPaymentText = PushReadyText & { paymentTitles: string; paymentBodies: string }

// Unit separator. The five reminder templates travel joined by it and never by `\n`, which
// separates the statement's own fields: reusing `\n` would let two different field vectors render
// the same statement, so a single signature would cover both.
export const TEMPLATE_SEPARATOR = '\u001f'

// The same limit the gateway enforces on device registration, which refuses a longer part.
export const TEMPLATE_MAX = 120

// The order is fixed and shared with the gateway's reminder ladder, because position in the joined
// string is what selects the wording for a stage.
export const EXPIRY_STAGES = ['month', 'week', 'lastDay', 'stopped', 'stillOff'] as const

export type ExpiryStage = (typeof EXPIRY_STAGES)[number]

// i18n key per stage, without the Title/Body suffix.
const EXPIRY_KEYS: Record<ExpiryStage, string> = {
  month: 'push.domainMonth',
  week: 'push.domainWeek',
  lastDay: 'push.domainLastDay',
  stopped: 'push.domainStopped',
  stillOff: 'push.domainStillOff',
}

// Wording the gateway can store as one part. Either separator inside it would move a field
// boundary, and a part past the ceiling is refused there as the whole registration.
export function isValidTemplate(part: string): boolean {
  return (
    part.length > 0 &&
    part.length <= TEMPLATE_MAX &&
    !part.includes('\n') &&
    !part.includes(TEMPLATE_SEPARATOR)
  )
}

// Never drops a part, empty included, because the gateway reads the wording for a stage by
// position, so a missing element shifts every later one and a reminder for one stage arrives at
// another.
export function joinExpiryTemplates(parts: readonly string[]): string {
  if (parts.length !== EXPIRY_STAGES.length) {
    throw new Error(`expiry wording needs exactly ${EXPIRY_STAGES.length} parts`)
  }
  return parts.join(TEMPLATE_SEPARATOR)
}

// The payment events the gateway words a push for, in the order it reads them by position: a Lightning
// receive on an invoice the wallet made, a Lightning send that went through, one that did not complete,
// an on-chain send, and an on-chain deposit received. Fixed for the same reason as the stages above,
// since a part missing or moved hands one event another's words.
export const PAYMENT_EVENTS = ['lnReceived', 'lnSent', 'lnSendFailed', 'onchainSent', 'onchainReceived'] as const

export type PaymentEvent = (typeof PAYMENT_EVENTS)[number]

// The gateway puts the amount in the body, so a body that lost its placeholder would tell a payment
// happened without saying how much.
const AMOUNT = '{amount}'

// Whether each body states an amount, which only a field the provider defines as what moved may
// fill (https://sdk-doc-spark.breez.technology/guide/webhooks.html). An on-chain send has none: the
// page gives `total_amount` as "Total amount of the cooperative exit" and never as what the
// recipient got, so its title and body say only that the payment was sent, and the gateway refuses
// a registration whose wording for it carries the placeholder, which would reach the lock screen as
// written. A deposit's `credit_amount` is "Amount to be credited to the wallet", and a failed
// send's amount is the invoice's, which the body states without saying where the sats are.
const STATES_AMOUNT: Readonly<Record<PaymentEvent, boolean>> = {
  lnReceived: true,
  lnSent: true,
  lnSendFailed: true,
  onchainSent: false,
  onchainReceived: true,
}

// Never drops a part, for the same reason as joinExpiryTemplates.
export function joinPaymentTemplates(parts: readonly string[]): string {
  if (parts.length !== PAYMENT_EVENTS.length) {
    throw new Error(`payment wording needs exactly ${PAYMENT_EVENTS.length} parts`)
  }
  return parts.join(TEMPLATE_SEPARATOR)
}

// Renders one i18n key in one locale. Injected so the joining and the fallback stay testable
// without the native modules `pushToken` pulls in.
export type TemplateRenderer = (key: string, locale: string) => string

// English is what the gateway falls back to for a device that registered before v3, so a part
// replaced here lands on the same wording the server would have used anyway.
const FALLBACK_LOCALE = 'en-US'

// The five reminders in stage order, rendered now because the gateway sends them months later
// without knowing what language this owner reads. Null when even English is unusable.
export function expiryTemplates(
  locale: string,
  render: TemplateRenderer,
): { expiryTitles: string; expiryBodies: string } | null {
  const part = (key: string): string => {
    const rendered = render(key, locale)
    // A translation the gateway would refuse falls back to English instead of being cut to fit: a
    // truncated sentence stays truncated on the lock screen for the whole year, while an English
    // one is at least whole. Refusing to register is worse still, since this same statement
    // carries the payment wording and the token.
    return isValidTemplate(rendered) ? rendered : render(key, FALLBACK_LOCALE)
  }
  const titles = EXPIRY_STAGES.map(stage => part(`${EXPIRY_KEYS[stage]}Title`))
  const bodies = EXPIRY_STAGES.map(stage => part(`${EXPIRY_KEYS[stage]}Body`))
  if (![...titles, ...bodies].every(isValidTemplate)) {
    // Nothing valid left to sign, so the device registers as v2 and the gateway supplies its own
    // English defaults. That loses the translation and keeps the reminder.
    return null
  }
  return { expiryTitles: joinExpiryTemplates(titles), expiryBodies: joinExpiryTemplates(bodies) }
}

// The one-off notice that a domain started serving. Rendered here for the same reason the five above
// are: the gateway sends it whenever the thing happens and does not know what language this owner
// reads. Null when even English is unusable, which drops the device to v3 and loses only this
// notice, never a reminder.
export function readyTemplates(
  locale: string,
  render: TemplateRenderer,
): { readyTitle: string; readyBody: string } | null {
  const part = (key: string): string => {
    const rendered = render(key, locale)
    return isValidTemplate(rendered) ? rendered : render(key, FALLBACK_LOCALE)
  }
  const readyTitle = part('push.domainReadyTitle')
  const readyBody = part('push.domainReadyBody')
  return isValidTemplate(readyTitle) && isValidTemplate(readyBody) ? { readyTitle, readyBody } : null
}

// The five payment notices, rendered now because the gateway sends them while the app is closed. A
// part falls back to English as the reminders do, a body also does when its translation lost the
// amount, and a title or a body does when it asks for an amount its event has no field for. Null
// when even English is unusable, which keeps the device on v4: the lightning address notice and the
// reminders go on, and only these five are missing.
export function paymentTemplates(
  locale: string,
  render: TemplateRenderer,
): { paymentTitles: string; paymentBodies: string } | null {
  const usable = (part: string, amount: boolean | null): boolean =>
    isValidTemplate(part) && (amount === null || part.includes(AMOUNT) === amount)
  const part = (key: string, amount: boolean | null): string => {
    const rendered = render(key, locale)
    return usable(rendered, amount) ? rendered : render(key, FALLBACK_LOCALE)
  }
  // A title may state the amount, except where there is none to state.
  const titleRule = (event: PaymentEvent): boolean | null => (STATES_AMOUNT[event] ? null : false)
  const titles = PAYMENT_EVENTS.map(event => part(`push.${event}Title`, titleRule(event)))
  const bodies = PAYMENT_EVENTS.map(event => part(`push.${event}Body`, STATES_AMOUNT[event]))
  if (
    !titles.every((title, at) => usable(title, titleRule(PAYMENT_EVENTS[at]!))) ||
    !bodies.every((body, at) => usable(body, STATES_AMOUNT[PAYMENT_EVENTS[at]!]))
  ) {
    return null
  }
  return { paymentTitles: joinPaymentTemplates(titles), paymentBodies: joinPaymentTemplates(bodies) }
}

// Adds the wording to the signed statement. Without it inside the signature, whoever holds the token
// could choose what appears on the owner's lock screen.
export function registerDeviceMessageV2(
  domain: string,
  pubkey: string,
  platform: PushPlatform,
  token: string,
  text: PushText,
  timestamp: number,
): string {
  return [
    MESSAGE_VERSION_V2,
    'register-device',
    domain,
    pubkey,
    platform,
    token,
    text.locale,
    text.titleTemplate,
    text.bodyTemplate,
    String(timestamp),
  ].join('\n')
}

// The same statement with the expiry reminders appended. Each joined string is one field here,
// which is why the five parts inside it are separated by the unit separator and not by `\n`.
export function registerDeviceMessageV3(
  domain: string,
  pubkey: string,
  platform: PushPlatform,
  token: string,
  text: PushExpiryText,
  timestamp: number,
): string {
  return [
    MESSAGE_VERSION_V3,
    'register-device',
    domain,
    pubkey,
    platform,
    token,
    text.locale,
    text.titleTemplate,
    text.bodyTemplate,
    text.expiryTitles,
    text.expiryBodies,
    String(timestamp),
  ].join('\n')
}

// Appends the ready wording to what v3 already signs, in two fields at the end. The expiry pair
// keeps its position and its length, so the gateway's five-part parse is untouched and a device
// still on v3 stays registered: it goes on receiving every expiry warning and simply never gets this
// one. Silence is the right degradation here, since a missed warning costs a domain and a missed
// "it is live" costs opening the app.
export function registerDeviceMessageV4(
  domain: string,
  pubkey: string,
  platform: PushPlatform,
  token: string,
  text: PushReadyText,
  timestamp: number,
): string {
  return [
    MESSAGE_VERSION_V4,
    'register-device',
    domain,
    pubkey,
    platform,
    token,
    text.locale,
    text.titleTemplate,
    text.bodyTemplate,
    text.expiryTitles,
    text.expiryBodies,
    text.readyTitle,
    text.readyBody,
    String(timestamp),
  ].join('\n')
}

// Appends the payment webhook to what v4 signs: the five payment notices, then the secret the provider
// signs this wallet's payment events with. Every v4 field keeps its line, so the gateway's v4 parse
// reads them unchanged. The secret is inside the signature because whoever could swap it for one of
// their own could sign payment notices for this wallet, and the wording is for the same reason as
// before: a token holder must not choose what a lock screen says about money.
export function registerDeviceMessageV5(
  domain: string,
  pubkey: string,
  platform: PushPlatform,
  token: string,
  text: PushPaymentText,
  webhookSecret: string,
  timestamp: number,
): string {
  return [
    MESSAGE_VERSION_V5,
    'register-device',
    domain,
    pubkey,
    platform,
    token,
    text.locale,
    text.titleTemplate,
    text.bodyTemplate,
    text.expiryTitles,
    text.expiryBodies,
    text.readyTitle,
    text.readyBody,
    text.paymentTitles,
    text.paymentBodies,
    webhookSecret,
    String(timestamp),
  ].join('\n')
}

function hasExpiryWording(text: PushText): text is PushExpiryText {
  return typeof text.expiryTitles === 'string' && typeof text.expiryBodies === 'string'
}

function hasReadyWording(text: PushText): text is PushReadyText {
  return hasExpiryWording(text) && typeof text.readyTitle === 'string' && typeof text.readyBody === 'string'
}

function hasPaymentWording(text: PushText): text is PushPaymentText {
  return (
    hasReadyWording(text) && typeof text.paymentTitles === 'string' && typeof text.paymentBodies === 'string'
  )
}

// What was last accepted by the gateway. Registration is otherwise a network round trip on every
// launch, and FCM only issues a new token on install, restore or a server-side rotation.
export type PushRegistration = {
  pubkey: string
  platform: PushPlatform
  token: string
  domain: string
  text?: PushText
}

const FILE = `${RNFS.DocumentDirectoryPath}/push-registration.json`

export async function loadRegistration(): Promise<PushRegistration | null> {
  try {
    if (!(await RNFS.exists(FILE))) {
      return null
    }
    const parsed = JSON.parse(await RNFS.readFile(FILE, 'utf8'))
    return typeof parsed?.token === 'string' ? (parsed as PushRegistration) : null
  } catch {
    return null
  }
}

export async function saveRegistration(registration: PushRegistration): Promise<void> {
  await RNFS.writeFile(FILE, JSON.stringify(registration), 'utf8')
}

// Drops the record of what the gateway accepted, only when it was this key's. The file holds one
// registration for the whole device, and another wallet's must survive this wallet's deletion.
export async function forgetRegistrationOf(pubkey: string): Promise<void> {
  const stored = await loadRegistration()
  if (stored?.pubkey.toLowerCase() === pubkey.trim().toLowerCase()) {
    await RNFS.unlink(FILE)
  }
}

export function needsRegistration(
  stored: PushRegistration | null,
  next: PushRegistration,
): boolean {
  // The pubkey is in the comparison because switching wallets has to re-point this device, even
  // though FCM handed back the very same token.
  // The wording is compared too, so switching the app language re-points the notification instead of
  // leaving the device addressed in the language it was set up in. The reminder wording is in the
  // comparison for the same reason, and it matters more: the gateway keeps it for a year.
  return (
    stored === null ||
    stored.token !== next.token ||
    stored.pubkey !== next.pubkey ||
    stored.platform !== next.platform ||
    stored.domain !== next.domain ||
    stored.text?.locale !== next.text?.locale ||
    stored.text?.titleTemplate !== next.text?.titleTemplate ||
    stored.text?.bodyTemplate !== next.text?.bodyTemplate ||
    stored.text?.expiryTitles !== next.text?.expiryTitles ||
    stored.text?.expiryBodies !== next.text?.expiryBodies ||
    // Compared for the same reason as the rest, and the reason it must not be forgotten is the
    // version: this file decides re-registration field by field, so wording added in a new statement
    // version changes nothing here, and every device already registered would stay on the old one
    // forever with no way to notice.
    stored.text?.readyTitle !== next.text?.readyTitle ||
    stored.text?.readyBody !== next.text?.readyBody ||
    stored.text?.paymentTitles !== next.text?.paymentTitles ||
    stored.text?.paymentBodies !== next.text?.paymentBodies
  )
}

// The payment webhook's part of a registration. The secret lives in the Keychain and travels only in
// the request; it is never written to the registration file, which is why a held id stands in for it
// when deciding whether to register again.
export type PushWebhook = {
  // 64 hex characters, drawn on this device for this wallet.
  secret: string
  // Whether the gateway already answered a v5 registration with an id for this secret. Without one
  // the device registers again whatever the file says, since a secret the gateway never accepted
  // makes every payment notice fail its signature there.
  held: boolean
  // Keeps the id the gateway answered with.
  save: (webhookId: string) => Promise<void>
  // Retires the secret, for a registration the gateway refused because a forget had named it. The
  // gateway refuses a marked secret while it keeps the mark, and the app never sends a retired secret
  // again, so keeping it would only repeat the refusal.
  forgotten: () => Promise<void>
}

export type PushDeps = {
  gatewayUrl: string
  domain: string
  platform: PushPlatform
  token: string
  identity: () => Promise<string>
  sign: (message: string) => Promise<string>
  // Absent only in a test; the app always knows its own language.
  text?: PushText
  webhook?: PushWebhook
  now?: () => number
  request?: typeof fetch
}

// v5 needs both the wording and a secret, and without either the device stays on v4.
function paymentWebhookOf(deps: PushDeps): { text: PushPaymentText; webhook: PushWebhook } | null {
  const { text, webhook } = deps
  return text && webhook && hasPaymentWording(text) && isWebhookSecret(webhook.secret)
    ? { text, webhook }
    : null
}

// The version follows what this device actually has to say. An app that cannot render the reminders
// still registers on an older statement, which the gateway keeps accepting.
function statementFor(deps: PushDeps, pubkey: string, token: string, timestamp: number): string {
  const { domain, platform, text } = deps
  if (!text) {
    return registerDeviceMessage(domain, pubkey, platform, token, timestamp)
  }
  const payment = paymentWebhookOf(deps)
  if (payment) {
    return registerDeviceMessageV5(domain, pubkey, platform, token, payment.text, payment.webhook.secret, timestamp)
  }
  if (!hasExpiryWording(text)) {
    return registerDeviceMessageV2(domain, pubkey, platform, token, text, timestamp)
  }
  if (!hasReadyWording(text)) {
    return registerDeviceMessageV3(domain, pubkey, platform, token, text, timestamp)
  }
  return registerDeviceMessageV4(domain, pubkey, platform, token, text, timestamp)
}

async function webhookIdOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { webhookId?: unknown } | null
    return isWebhookId(body?.webhookId) ? body.webhookId : null
  } catch {
    return null
  }
}

async function refusalCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown } | null
    return typeof body?.error === 'string' ? body.error : undefined
  } catch {
    return undefined
  }
}

// Tells the gateway where to notify this wallet. Returns false when nothing had to be sent, so a
// caller can run this on every launch without producing a request each time, and when the gateway
// refused the secret as forgotten, which is no failure: the secret is retired and the next connect
// registers a fresh one.
export async function registerPushDevice(deps: PushDeps): Promise<boolean> {
  const token = deps.token.trim()
  if (!token) {
    throw new Error('push token is required')
  }
  const pubkey = await deps.identity()
  // A wallet that asked for its data to be deleted, or gave its address up, points no device at
  // itself until it asks for the address back. The gateway refuses such a key too; stopping here
  // keeps the request from being made at all.
  if (await deletionHolds({ pubkey })) {
    return false
  }
  const payment = paymentWebhookOf(deps)
  // The wording stored is the wording signed: payment parts that went out on v4 for want of a secret
  // are left out, so the file never claims a v5 registration the gateway did not get.
  const text = deps.text && !payment ? withoutPaymentWording(deps.text) : deps.text
  const next: PushRegistration = {
    pubkey,
    platform: deps.platform,
    token,
    domain: deps.domain,
    ...(text ? { text } : {}),
  }
  const owed = payment !== null && !payment.webhook.held
  if (!owed && !needsRegistration(await loadRegistration(), next)) {
    return false
  }
  const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
  const signature = await deps.sign(statementFor(deps, pubkey, token, timestamp))
  const request = deps.request ?? fetch
  // /api is the prefix the edge routes to the gateway; a path at the root answers from the LNURL
  // server instead, which accepts the request and does nothing with it.
  const response = await request(`${deps.gatewayUrl.replace(/\/+$/, '')}/api/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pubkey,
      platform: deps.platform,
      token,
      signature,
      timestamp,
      ...(text ?? {}),
      ...(payment ? { webhookSecret: payment.webhook.secret } : {}),
    }),
  })
  if (!response.ok) {
    const code = response.status === 409 || response.status === 410 ? await refusalCode(response) : undefined
    // The gateway refuses a deleted wallet's key with 409 `deleted`, which says this device may hold
    // no mark for it yet; the status read that follows writes one (deletionMark.ts).
    if (response.status === 409 && code === 'deleted') {
      noteGatewayDeleted({ pubkey })
    }
    // A forget that named this secret reached the gateway first, and the gateway wrote nothing of this
    // registration: a forget and a registration made with one secret end the same whichever arrives
    // first, since the forget's mark wins (a remove-wins set, as the 2P-Set in Shapiro et al., INRIA
    // RR-7506). Nothing is raised and nothing is sent again with this secret.
    if (response.status === 410 && code === 'forgotten' && payment) {
      await payment.webhook.forgotten()
      return false
    }
    // Not persisted on failure, so the next launch tries again rather than believing it is
    // registered while the gateway has no row.
    throw new Error(`device registration failed with ${response.status}`)
  }
  if (payment) {
    // An accepted v5 answers with the id the provider will post to. Without a usable one the file is
    // not written, so the next connect registers again rather than hold a secret nothing can use.
    const webhookId = await webhookIdOf(response)
    if (!webhookId) {
      throw new Error('device registration answered without a webhook id')
    }
    await payment.webhook.save(webhookId)
  }
  await saveRegistration(next)
  return true
}

function withoutPaymentWording(text: PushText): PushText {
  const rest = { ...text }
  delete rest.paymentTitles
  delete rest.paymentBodies
  return rest
}
