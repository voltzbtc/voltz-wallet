import { useCallback, useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { liftCover, liftCoverAfterModals, mustLock, readAway, whenInFront } from '../wallet/relock'
import { holdDeeplinks, settleDeeplinkHold } from '../wallet/deeplink'

// If the lock is in the tree and its layout never reported, the cover comes down after this anyway, so
// a lost layout event cannot leave the app behind a cover with no way past it.
export const LIFT_FALLBACK_MS = 1_000

// Decides on each return to 'active' whether the PIN is asked again, after the native side has stamped
// the leave and raised the cover (specs/NativeVoltzPrivacy.ts). Under RELOCK_AFTER_MS the cover comes
// down and nothing else happens: every screen and sheet is as it was. At the limit or past it, while
// `armed`, `lock` runs, and the cover comes down only once the lock reports its first layout through
// the returned callback, so the return never shows a frame of the wallet and a touch never reaches it.
// Already on the lock (`locked`), `lock` runs and the cover comes down when it has. A cover lowered
// after `lock` waits for the Modals it closed to leave the screen (liftCoverAfterModals).
//
// 'inactive' decides nothing: it is the iOS app switcher, a system sheet or the Face ID prompt the lock
// itself raises, none of which leaves the app. On Android the decision waits for onPostResume, before
// which a biometric prompt cannot be shown and the native side drops a hide. Returns arriving while a
// decision runs join it, and the latest one decides again once it ends.
export function useRelock(armed: boolean, locked: boolean, lock: () => Promise<void>): () => void {
  const armedNow = useRef(armed)
  armedNow.current = armed
  const lockedNow = useRef(locked)
  lockedNow.current = locked
  const lockNow = useRef(lock)
  lockNow.current = lock
  // Whether 'background' was heard since the last decision, so a trip the native side did not stamp
  // locks rather than counting as no trip.
  const left = useRef(false)
  const deciding = useRef(false)
  const again = useRef(false)
  // Set from the lock decision until the lock reports its layout. While set, nothing else lowers the
  // cover.
  const awaitingDraw = useRef(false)

  const lockDrawn = useCallback(() => {
    if (awaitingDraw.current) {
      awaitingDraw.current = false
      liftCoverAfterModals()
    }
  }, [])

  useEffect(() => {
    let alive = true
    let fallback: ReturnType<typeof setTimeout> | undefined

    async function decide(): Promise<void> {
      if (deciding.current) {
        again.current = true
        return
      }
      deciding.current = true
      try {
        do {
          again.current = false
          if (!(await whenInFront()) || !alive) {
            // Left again before the return settled; the next 'active' decides.
            return
          }
          const tooLong = mustLock(readAway(), left.current)
          left.current = false
          if (!tooLong || !armedNow.current) {
            settleDeeplinkHold(false)
            if (!awaitingDraw.current) {
              liftCover()
            }
            continue
          }
          if (lockedNow.current) {
            // The PIN is already drawn and lays out no more. Locking again still cancels an unlock
            // that was reading when the app left.
            await lockNow.current()
            settleDeeplinkHold(true)
            if (!awaitingDraw.current) {
              liftCoverAfterModals()
            }
            continue
          }
          awaitingDraw.current = true
          await lockNow.current()
          // Only once the lock is set: an unlock that was reading when the app left can still open the
          // navigator before it, and that must not let a link through.
          settleDeeplinkHold(true)
          clearTimeout(fallback)
          fallback = setTimeout(() => {
            if (lockedNow.current) {
              lockDrawn()
            }
          }, LIFT_FALLBACK_MS)
        } while (again.current && alive)
      } finally {
        deciding.current = false
      }
    }

    // Subscribed once for the app's life, so a render that changes `armed` never drops a trip.
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background') {
        left.current = true
        // A link the return brings waits for this trip's decision (deeplink.ts).
        holdDeeplinks()
      } else if (state === 'active') {
        decide().catch(() => undefined)
      }
    })
    // A cover raised before this mounted (a leave during the cold start, a reload while away) has no
    // 'active' coming to lower it.
    if (AppState.currentState === 'active') {
      decide().catch(() => undefined)
    }
    return () => {
      alive = false
      clearTimeout(fallback)
      sub.remove()
    }
  }, [lockDrawn])

  return lockDrawn
}
