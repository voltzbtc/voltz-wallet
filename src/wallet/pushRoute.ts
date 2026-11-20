// Where a tapped notification is allowed to land. The payload names a `type` and never a screen, a
// path or params, and this table is the only thing that turns one into the other, so whoever can
// deliver a message to this device still cannot choose where the app goes.
export type PushDestination = 'LnAddress'

// Null prototype, so a `type` naming an inherited member (`toString`, `constructor`) misses the
// table instead of resolving to a function, and a polluted `Object.prototype` names no destination.
const DESTINATIONS: Readonly<Record<string, PushDestination | undefined>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, PushDestination | undefined>, {
    domain: 'LnAddress',
  } as const),
)

// Anything the table does not name is null, and no wire input throws, because a throw inside the
// notification handler is a crash on open.
export function pushDestination(data: unknown): PushDestination | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const type = (data as { type?: unknown }).type
  if (typeof type !== 'string') {
    return null
  }
  return DESTINATIONS[type] ?? null
}

/**
 * A message that arrived while the app was in front. The system draws nothing then, by design, so
 * this is the only thing between the message and being lost.
 *
 * The words come from the message and are never composed here: the device chose the language when it
 * registered, so the gateway already sends the wording this person reads, and translating again
 * would give two sources for one sentence.
 *
 * A message with no notification block is not shown. Those exist to carry data, and a banner with
 * an empty title is worse than silence.
 */
export type ForegroundNotice = { title: string; body: string; destination: PushDestination | null }

export function foregroundNotice(message: unknown): ForegroundNotice | null {
  if (typeof message !== 'object' || message === null) {
    return null
  }
  const notification = (message as { notification?: unknown }).notification
  if (typeof notification !== 'object' || notification === null) {
    return null
  }
  const title = (notification as { title?: unknown }).title
  const body = (notification as { body?: unknown }).body
  if (typeof title !== 'string' || title === '') {
    return null
  }
  const data = (message as { data?: unknown }).data
  // A message that names no kind is the payment notice, which the gateway sends with a title and a
  // body and no data at all. The wallet announces a payment itself while it is open, from the SDK
  // event, and does it better: the amount, the fiat line, and the overlay that belongs to money
  // landing. Showing this on top of that is the same news twice, once worse.
  //
  // The check is for presence, not a name, because anything that says what it is came from a
  // sender that knows this screen exists, and a kind this build does not recognise is still news
  // worth reading.
  if (typeof data !== 'object' || data === null || typeof (data as { type?: unknown }).type !== 'string') {
    return null
  }
  return {
    title,
    body: typeof body === 'string' ? body : '',
    destination: pushDestination(data),
  }
}

type NoticeHandler = (notice: ForegroundNotice) => void
let noticeHandler: NoticeHandler | null = null

// Dropped rather than stashed, unlike a tap. A tap is somebody asking to go somewhere, and it has to
// survive a wait that can be long, since the navigator does not mount while the app is locked or in
// onboarding. An arrival has no such request behind it, and the window where nobody is listening is
// the lock screen, seconds. Whoever opens the app in those seconds sees the state on the address
// screen itself, which is where holding one with a deadline would have sent them anyway.
export function routeForegroundMessage(message: unknown): void {
  const notice = foregroundNotice(message)
  if (notice && noticeHandler) {
    noticeHandler(notice)
  }
}

// For news the app itself has, in its own words, which comes from no message and has nowhere else to
// surface once the screen that asked has gone. Dropped without a listener, as above.
export function showForegroundNotice(notice: ForegroundNotice): void {
  noticeHandler?.(notice)
}

export function setForegroundNoticeHandler(next: NoticeHandler | null): void {
  noticeHandler = next
}

// A tap can be delivered while the app is locked or onboarding, before the navigator mounts, so a
// destination arriving with no handler is stashed and replayed once one registers. Same shape as
// the `lightning:` router in deeplink.ts.
type PushHandler = (destination: PushDestination) => void
let handler: PushHandler | null = null
let pending: PushDestination | null = null

export function routePushNotification(data: unknown): void {
  const destination = pushDestination(data)
  if (!destination) {
    return
  }
  if (handler) {
    handler(destination)
  } else {
    pending = destination
  }
}

// Pass null on unmount so a tap arriving meanwhile (e.g. after the app re-locks) is stashed rather
// than lost.
export function setPushHandler(next: PushHandler | null): void {
  handler = next
  if (next && pending !== null) {
    const destination = pending
    pending = null
    next(destination)
  }
}
