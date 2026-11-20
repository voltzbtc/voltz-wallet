// Who hears that a send the app left pending reached the SDK's last word. Apart from spark.ts, as
// resumeNotice.ts is, so the navigator can listen without depending on every stand-in for spark.ts.
// spark.ts is the one sender, and it sends only after the record gave the send up, so each send is
// announced at most once. The facts are the record's, read when the end was heard.
import type { PaymentFacts, SettledOutcome } from './paymentNotice'

export type SendSettled = SettledOutcome

type Listener = (outcome: SendSettled, facts: PaymentFacts) => void

const listeners = new Set<Listener>()

export function onSendSettled(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// Whether anyone would show it. With nobody listening the send stays in the record for a later read,
// rather than leaving it untold.
export function sendSettledHeard(): boolean {
  return listeners.size > 0
}

export function announceSendSettled(outcome: SendSettled, facts: PaymentFacts): void {
  listeners.forEach(cb => cb(outcome, facts))
}
