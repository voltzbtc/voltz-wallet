import React, { createContext, useContext, useEffect, useRef } from 'react'
import { StyleSheet, View } from 'react-native'

const UnderLockContext = createContext(false)

// True for whatever is mounted under the PIN asked again over a running wallet, while it is up. The
// PIN is drawn in the app's own view, which sits under every Modal, since each Modal is a window of its
// own (a presented view controller on iOS, a Dialog on Android). So every Modal closes when the lock
// lands (useCloseOnLock), and every line said to a screen reader on its own waits for it to lift. A
// trip away that does not lock changes nothing here: the native cover hides the app meanwhile.
export function useUnderLock(): boolean {
  return useContext(UnderLockContext)
}

// Every Modal asks its owner through this to close it when the lock lands while it is open, as a
// dismissal by the person would. It answers whether the lock is up, which keeps the Modal off the
// screen until it lifts, so an owner that keeps it open (a send in flight) has it back after the
// unlock. Only a real lock closes anything; the cover over a short trip does not reach here.
export function useCloseOnLock(open: boolean, close: () => void): boolean {
  const locked = useUnderLock()
  const latest = useRef({ open, close })
  latest.current = { open, close }
  useEffect(() => {
    if (locked && latest.current.open) {
      latest.current.close()
    }
  }, [locked])
  return locked
}

// Keeps its children mounted whether locked or not, so a review, an amount or a send in flight is where
// it was after the unlock. The view is never flattened, so the navigator under it keeps one native
// parent across lock and unlock, and while locked nothing in it can be touched or reached by a screen
// reader.
export function UnderLock({
  locked,
  children,
}: {
  locked: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <UnderLockContext.Provider value={locked}>
      <View
        testID="under-lock"
        collapsable={false}
        style={styles.fill}
        pointerEvents={locked ? 'none' : 'auto'}
        accessibilityElementsHidden={locked}
        importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}>
        {children}
      </View>
    </UnderLockContext.Provider>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
})
