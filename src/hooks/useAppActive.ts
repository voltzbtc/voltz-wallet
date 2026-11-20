import { useEffect, useRef, type MutableRefObject } from 'react'
import { AppState } from 'react-native'

// Whether the app is in the foreground, as a ref a view reads at the moment it decides whether a line
// it put up was seen (releasedLines.ts). A line painted while the app is away is seen by nobody, and a
// process the system ends there takes it along, so a view out of the foreground counts as gone.
//
// A view is mounted by somebody looking at it, so the ref starts true, and every state other than
// 'active' counts as away, 'inactive' too: what the app switcher or a call covers is not being read,
// and a line kept for the next view is never lost, only said a moment later.
export function useAppActive(): MutableRefObject<boolean> {
  const active = useRef(true)
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      active.current = state === 'active'
    })
    return () => sub.remove()
  }, [])
  return active
}
