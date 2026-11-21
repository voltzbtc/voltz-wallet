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

// A return from the background can bring its URL before the lock decision for that return (Android
// delivers the new intent before onResume), so a handler alone would open Send under a PIN about to be
// drawn. `deciding` runs from the leave to that decision (useRelock), and `locked` from a decision that
// drew the PIN to the unlock. Either keeps every URL stashed.
type Hold = 'none' | 'deciding' | 'locked'
let hold: Hold = 'none'

function deliverPending(): void {
  if (handler && hold === 'none' && pending !== null) {
    const url = pending
    pending = null
    handler(url)
  }
}

export function routeLightningUrl(url: string): void {
  const destination = parseLightningDeeplink(url)
  if (!destination) {
    return
  }
  pending = destination
  deliverPending()
}

// Pass null on unmount and while the PIN is drawn over the navigator, so a URL arriving meanwhile is
// stashed rather than lost, and opens nothing before the unlock.
export function setDeeplinkHandler(next: DeeplinkHandler | null): void {
  handler = next
  deliverPending()
}

// Called as the app leaves, so every URL waits for the decision its return makes.
export function holdDeeplinks(): void {
  hold = 'deciding'
}

// The decision for a return: a lock keeps the URLs for the unlock, no lock lets them through.
export function settleDeeplinkHold(locked: boolean): void {
  hold = locked ? 'locked' : 'none'
  deliverPending()
}

// The PIN a decision drew was passed. A decision still to come is not cut short, since what passed was
// a PIN drawn before the leave.
export function releaseDeeplinksAfterUnlock(): void {
  if (hold === 'locked') {
    hold = 'none'
  }
  deliverPending()
}
