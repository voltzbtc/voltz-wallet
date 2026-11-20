import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, RefreshControl, type RefreshControlProps } from 'react-native'
import { useAccent } from '../wallet/dollarMode'
import { SYNC_WAIT_MS } from '../wallet/spark'
import { space } from '../theme'

// The pull gesture for a scrolling screen. The spinner is the gesture's own answer and the content
// stays put under it, so it follows from the action rather than from a loading state, and it closes at
// SYNC_WAIT_MS whatever the action is still waiting on.
//
// On Android the spinner's disc is 40 across and comes to rest 64 under the top (ReactSwipeRefreshLayout),
// over the first line of every screen, since the content stays put and only the margin above it is
// free. With no disc only the arc is drawn, under 20 across, which that margin holds, and the top of
// the bare disc can run off the view unseen. iOS moves the content down by itself, and reads the same
// prop as an offset of its own, so it is left without one.
//
// `enabled` is off where the gesture has nothing to do. Android alone honours the prop, and there the
// element has to stay: ScrollView wraps itself in the control on Android, so taking it away remounts
// everything inside the scroll (a drag in progress in the asset list, for one). iOS ignores the prop,
// and holds the control as a child that can come and go.
const DISC = 40
const RESTS_AT = 64
const ARC_IN_MARGIN = space.xl / 2 - DISC / 2 - (RESTS_AT - DISC)

export function usePullRefresh(
  action: () => Promise<void>,
  enabled: boolean = true,
): React.ReactElement<RefreshControlProps> | undefined {
  const { accent } = useAccent()
  const [refreshing, setRefreshing] = useState(false)
  const latest = useRef(action)
  latest.current = action
  // The limit of the pull in flight, and through it the pull itself: an answer arriving after the limit
  // closed the spinner has no business closing the spinner of a later pull.
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onRefresh = useCallback(() => {
    if (limit.current !== null) {
      return
    }
    setRefreshing(true)
    const finish = () => {
      if (limit.current === own) {
        clearTimeout(own)
        limit.current = null
        setRefreshing(false)
      }
    }
    const own = setTimeout(finish, SYNC_WAIT_MS)
    limit.current = own
    latest.current().catch(() => undefined).finally(finish)
  }, [])

  useEffect(
    () => () => {
      if (limit.current !== null) {
        clearTimeout(limit.current)
        limit.current = null
      }
    },
    [],
  )

  if (!enabled && Platform.OS === 'ios') {
    return undefined
  }
  return (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      enabled={enabled}
      tintColor={accent}
      colors={[accent]}
      progressBackgroundColor="transparent"
      progressViewOffset={Platform.OS === 'android' ? ARC_IN_MARGIN : undefined}
    />
  )
}
