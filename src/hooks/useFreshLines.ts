import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from '../theme'

const NONE: ReadonlySet<string> = new Set()

// Which lines of a list are new since a pull began, so they can fade in. Told apart when the read
// lands and in the same render as the lines themselves, since a line can only fade in as it mounts.
// The answer empties once the fade is over, or a line scrolled off and back would fade again.
export function useFreshLines(): {
  fresh: ReadonlySet<string>
  pullStarted: (shown: string[]) => void
  readLanded: (ids: string[]) => void
  pullEnded: () => void
} {
  const [fresh, setFresh] = useState(NONE)
  const before = useRef<ReadonlySet<string> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const pullStarted = useCallback((shown: string[]) => {
    before.current = new Set(shown)
  }, [])

  const readLanded = useCallback(
    (ids: string[]) => {
      const seen = before.current
      if (seen === null) {
        return
      }
      const arrived = ids.filter(id => !seen.has(id))
      if (arrived.length === 0) {
        return
      }
      clear()
      setFresh(new Set(arrived))
      timer.current = setTimeout(() => {
        timer.current = null
        setFresh(NONE)
      }, motion.base)
    },
    [clear],
  )

  const pullEnded = useCallback(() => {
    before.current = null
  }, [])

  useEffect(() => clear, [clear])

  return { fresh, pullStarted, readLanded, pullEnded }
}
