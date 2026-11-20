import { useCallback, useEffect, useRef } from 'react'
import { AccessibilityInfo } from 'react-native'
import { useUnderLock } from '../components/UnderLock'

// Says a line to the screen reader when it appears or changes, and nothing on a render that keeps
// it. `accessibilityRole="alert"` names the role and says nothing by itself on React Native 0.86:
// iOS maps it to no trait, and Android sets a role description with no live region, so TalkBack
// drops the content change that draws the line.
//
// It does not ask whether its screen is the one in front. A screen kept under another that draws an
// error from a read of its own, such as Contacts reading again on a reconnect, would say it there.
//
// Nothing is said while the lock is up over its screen, and a line still drawn when the lock lifts is
// said then.
export function useAnnounced(line: string | null | undefined): void {
  const underLock = useUnderLock()
  useEffect(() => {
    if (line && !underLock) {
      AccessibilityInfo.announceForAccessibility(line)
    }
  }, [line, underLock])
}

// Says a line in answer to something that lands later (a pull, a read), only while no lock is up over
// its screen. One that lands under the lock is dropped rather than held, since by the unlock it no longer
// says what just happened.
export function useAnnounce(): (line: string) => void {
  const underLock = useUnderLock()
  const lockedNow = useRef(underLock)
  lockedNow.current = underLock
  return useCallback((line: string) => {
    if (!lockedNow.current) {
      AccessibilityInfo.announceForAccessibility(line)
    }
  }, [])
}
