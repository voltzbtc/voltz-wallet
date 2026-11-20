import { useCallback, useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { answerWithin } from '../wallet/answerWithin'
import { onSparkResumed } from '../wallet/resumeNotice'
import { SYNC_WAIT_MS } from '../wallet/spark'

// How often figures nothing announces are read again: the rates, which no event carries, and a balance
// whose change the SDK stayed quiet about.
export const LIVE_READ_EVERY_MS = 30_000

// `event` is something that can have moved a balance and `timer` the clock, which asks less of a read.
export type LiveSource = 'event' | 'timer'

const outranks = (a: LiveSource | null, b: LiveSource | null): LiveSource | null =>
  a === 'event' || b === 'event' ? 'event' : a ?? b

// Keeps a screen's figures current with no pull. It reads when asked, on a return from the background,
// and on the clock while the screen is in front: the clock stops on blur and in the background, where
// nothing else moves the rates.
//
// One read is out at a time. Whatever is asked during it comes to one more read after it, so a burst
// of settled payments costs two reads, and the last one started after the last request. A read that
// never answers frees the line at the bound, so it cannot stop the figures for good.
export function useLiveFigures(
  read: (source: LiveSource) => Promise<unknown>,
  focused: boolean,
): (source?: LiveSource) => void {
  const latestRead = useRef(read)
  latestRead.current = read
  const running = useRef(false)
  const asked = useRef<LiveSource | null>(null)
  // A read asked for during the last one runs after it settles, which can be after the screen is gone.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const request = useCallback((source: LiveSource = 'event') => {
    if (!mounted.current) {
      return
    }
    if (running.current) {
      asked.current = outranks(asked.current, source)
      return
    }
    running.current = true
    const settled = () => {
      running.current = false
      const next = asked.current
      asked.current = null
      if (next !== null) {
        request(next)
      }
    }
    answerWithin(latestRead.current(source), SYNC_WAIT_MS).then(settled, settled)
  }, [])

  useEffect(() => onSparkResumed(() => request()), [request])

  useEffect(() => {
    if (!focused) {
      return
    }
    let every: ReturnType<typeof setInterval> | null = null
    const stop = () => {
      if (every !== null) {
        clearInterval(every)
        every = null
      }
    }
    const start = () => {
      stop()
      every = setInterval(() => request('timer'), LIVE_READ_EVERY_MS)
    }
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') {
        start()
      } else {
        stop()
      }
    })
    // A view is mounted by somebody looking at it, unless the system woke the app in the background.
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') {
      start()
    }
    return () => {
      stop()
      appState.remove()
    }
  }, [focused, request])

  return request
}
