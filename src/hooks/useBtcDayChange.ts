import { useEffect, useState } from 'react'
import { dayChangePct, fetchBtcPriceSeries, onDaySeriesFetched } from '../wallet/price'

// A series' figure is as old as the series cache lets it be, so a held change never outlives it.
const HELD_MS = 5 * 60 * 1000

// The change over 24 hours of the bitcoin price at `spot`, or null while there is none to state: no
// spot, no series, or a series that does not cover the last day. It holds across a spot that moves,
// because the series is rescaled by one constant factor and the percentage does not depend on the
// spot, so the strip does not blink on every price read. A spot that goes takes it along, which keeps
// a figure from an earlier session from standing beside a new price.
//
// The asset screen's 1D chart states the same change, and the two agree only when both read the same
// series. So this reads again on every price read, `readAt`, which keeps it within a read of the
// series' lifetime with no timer of its own, and whenever anything fetched a newer series.
export function useBtcDayChange(spot: number | null, readAt: number | null = null): number | null {
  const [read, setRead] = useState<{ pct: number | null; at: number } | null>(null)

  useEffect(() => {
    if (spot === null) {
      setRead(null)
      return
    }
    let latest = 0
    const read = () => {
      const mine = ++latest
      fetchBtcPriceSeries('1D', spot)
        .then(points => {
          if (mine === latest) {
            const at = Date.now()
            setRead({ pct: points === null ? null : dayChangePct(points, at), at })
          }
        })
        .catch(() => {
          if (mine === latest) {
            setRead(null)
          }
        })
    }
    const off = onDaySeriesFetched(read)
    read()
    return () => {
      latest += 1
      off()
    }
  }, [spot, readAt])

  return spot !== null && read !== null && Date.now() - read.at < HELD_MS ? read.pct : null
}
