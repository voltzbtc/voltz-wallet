// Inbound `lightning:` deep links, as opened by a nostr client (Damus, Amethyst) handing off a zap
// invoice. Recognition is the only job here, because the raw URI goes to the Send flow, and spark.ts
// takes the scheme off (paymentInput) before any SDK call, exactly as for the NFC and Scan paths.
export function parseLightningDeeplink(url: string): string | null {
  const trimmed = url.trim()
  return /^lightning:/i.test(trimmed) ? trimmed : null
}

// URL capture is decoupled from navigation because the OS can deliver a URL while the app is
// locked or onboarding, before the navigator mounts. Capture happens in the always-mounted App,
// and a URL arriving with no handler is stashed and replayed once one registers.
type DeeplinkHandler = (destination: string) => void
let handler: DeeplinkHandler | null = null
let pending: string | null = null

export function routeLightningUrl(url: string): void {
  const destination = parseLightningDeeplink(url)
  if (!destination) {
    return
  }
  if (handler) {
    handler(destination)
  } else {
    pending = destination
  }
}

// Pass null on unmount so a URL arriving meanwhile (e.g. after the app re-locks) is stashed rather
// than lost.
export function setDeeplinkHandler(next: DeeplinkHandler | null): void {
  handler = next
  if (next && pending !== null) {
    const url = pending
    pending = null
    next(url)
  }
}
