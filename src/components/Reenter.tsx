import React from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import Animated, { FadeIn, FadeInDown, ReduceMotion } from 'react-native-reanimated'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { space } from '../theme'

// One part's fade and the gap to the next: three parts come to 200 ms in all.
const ENTER_MS = 120
const STEP_MS = 40
const LAST_STEP = 2

// The entry for the part at `order`, the third and later together. `reduceMotion` is Never because
// Reanimated would end the fade on its first frame with the setting on, which it reads once at launch;
// useReduceMotion decides what moves, and with it on only the rise goes.
export function reentry(order: number, reduced: boolean): FadeIn | FadeInDown {
  const entry = reduced
    ? new FadeIn()
    : new FadeInDown().withInitialValues({ translateY: space.sm })
  return entry
    .duration(ENTER_MS)
    .delay(Math.min(order, LAST_STEP) * STEP_MS)
    .reduceMotion(ReduceMotion.Never)
}

type Props = {
  // A new number enters the content again, and 0 is the first paint, which has nothing to answer.
  beat: number
  // The place in the page's stagger, from 0.
  order: number
  style?: StyleProp<ViewStyle>
  children: React.ReactNode
}

// The page answering a refresh, as a feed does: the content leaves its place and rises back into it.
// Reanimated enters a view when it mounts, so the key mounts this one again, and what is under it
// starts over: state that has to outlive a beat lives above it.
export function Reenter({ beat, order, style, children }: Props): React.JSX.Element {
  const reduced = useReduceMotion()
  return (
    <Animated.View key={beat} entering={beat === 0 ? undefined : reentry(order, reduced)} style={style}>
      {children}
    </Animated.View>
  )
}
