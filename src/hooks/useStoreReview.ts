import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { openModalCount, useUnderLock } from '../components/UnderLock'
import { homeInFront } from '../navigation/homeInFront'
import { sparkConnectedWalletId, sparkSpendInFlight } from '../wallet/spark'
import { considerReview, noteAnnouncedReceive } from '../wallet/storeReview'

type NavRef = { isReady(): boolean; getRootState(): unknown }

// The received overlay's two moments for the store's review card (storeReview.ts): `announced` when it
// shows a completed receive, `closed` once it is gone. The decision runs in the commit after the close,
// when the overlay's own Modal has unmounted and a leave from Receive has put Home in front.
export function useStoreReview(navRef: NavRef): { announced: () => void; closed: () => void } {
  const locked = useUnderLock()
  const lockedNow = useRef(locked)
  lockedNow.current = locked
  const [closes, setCloses] = useState(0)

  const announced = useCallback(() => noteAnnouncedReceive(sparkConnectedWalletId()), [])
  const closed = useCallback(() => setCloses(n => n + 1), [])

  useEffect(() => {
    if (closes === 0) {
      return
    }
    considerReview(() => ({
      homeInFront: navRef.isReady() && homeInFront(navRef.getRootState() as Parameters<typeof homeInFront>[0]),
      locked: lockedNow.current,
      appActive: AppState.currentState === 'active',
      modalsOpen: openModalCount(),
      spendInFlight: sparkSpendInFlight(),
    })).catch(() => undefined)
  }, [closes, navRef])

  return { announced, closed }
}
