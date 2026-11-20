import { useEffect, useRef } from 'react'
import { onSparkConnected, onSparkSynced, sparkSyncWaitLeftMs } from '../wallet/spark'
import { onSparkResumed } from '../wallet/resumeNotice'

// Runs `refresh` when the live connection hears its first sync, and again when its wait for that sync
// runs out, so a screen that read before the sync moves to the synced figure, or to the stored one
// marked as not updated. Each connect re-arms the wait for the connection it made, and so does each
// return from the background, which restarts that wait.
export function useSyncRefresh(refresh: () => void): void {
  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
    const arm = () => {
      clear()
      const left = sparkSyncWaitLeftMs()
      if (left <= 0) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        // A timer can land a hair before the clock it was set from says the wait is over.
        if (sparkSyncWaitLeftMs() > 0) {
          arm()
        } else {
          latest.current()
        }
      }, left)
    }
    const offConnected = onSparkConnected(arm)
    const offResumed = onSparkResumed(arm)
    const offSynced = onSparkSynced(() => {
      clear()
      latest.current()
    })
    return () => {
      offConnected()
      offResumed()
      offSynced()
      clear()
    }
  }, [])
}
