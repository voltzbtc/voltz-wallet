// Waiting for money to arrive, after the call that sent it has already returned.
//
// A swap's `sendPayment` resolves when the swap is accepted; the other asset lands as a separate
// Spark transfer tens of seconds later. A balance read at the moment of the return is therefore the
// balance from before the swap, and a success shown against it is a success shown over a stale
// number, on a path that moves money.
//
// Polling rather than an SDK event because the caller already reads balances this way, and one more
// read on a timer is less to get wrong than a subscription with its own lifecycle. Bounded, so a
// swap that never lands costs a fixed number of reads rather than a timer outliving the screen.
export type SettleWatch = {
  /** How many times to look, including the first. */
  attempts: number
  /** How long to wait between looks. */
  delayMs: number
}

export const DEFAULT_SETTLE_WATCH: SettleWatch = { attempts: 14, delayMs: 2000 }

/**
 * Reads until the value changes, or until the attempts run out.
 *
 * Returns whether it changed, so a caller can tell "the money arrived" from "the wait ran out",
 * which are the same picture on screen and different things to say about them.
 */
export async function waitForChange(
  read: () => Promise<number>,
  before: number,
  sleep: (ms: number) => Promise<void>,
  watch: SettleWatch = DEFAULT_SETTLE_WATCH,
): Promise<boolean> {
  for (let attempt = 0; attempt < watch.attempts; attempt += 1) {
    await sleep(watch.delayMs)
    // A read that throws is a network blip, not an answer, so it costs an attempt and not the wait.
    const now = await read().catch(() => before)
    if (now !== before) {
      return true
    }
  }
  return false
}
