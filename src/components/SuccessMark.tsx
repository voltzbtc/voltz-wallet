import React, { useEffect, useRef } from 'react'
import { Animated, StyleSheet } from 'react-native'
import { useAccent } from '../wallet/dollarMode'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { colors, motion, radius, space } from '../theme'
import { animateTo } from './animateTo'
import { TabIcon } from './TabIcon'

// The disc and the mark of the received overlay's badge, so a step that ends well says it in the
// look a payment already taught: a 48 mark with 24 around it is the badge's 96.
const MARK = 48
const MARK_STROKE = 3
const FROM_SCALE = 0.6

// A done step's mark: a check on a disc of the accent, grown in as it arrives. With reduced motion
// it only fades. Decorative, since the title beside it says what happened.
export function SuccessMark(): React.JSX.Element {
  const { accent } = useAccent()
  const reduced = useReduceMotion()
  const opacity = useRef(new Animated.Value(0)).current
  const scale = useRef(new Animated.Value(FROM_SCALE)).current

  useEffect(() => {
    animateTo(opacity, 1).start()
    animateTo(scale, 1, motion.slow).start()
  }, [opacity, scale])

  return (
    <Animated.View
      testID="success-mark"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        styles.disc,
        { backgroundColor: accent, opacity },
        !reduced && { transform: [{ scale }] },
      ]}>
      <TabIcon name="check" color={colors.onPrimary} size={MARK} strokeWidth={MARK_STROKE} />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  disc: {
    padding: space.xl,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
