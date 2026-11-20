import React, { useEffect } from 'react'
import { StyleSheet, type DimensionValue, type ViewStyle } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { colors, radius } from '../theme'

type Props = {
  width?: DimensionValue
  height?: number
  borderRadius?: number
  style?: ViewStyle
}

// The project loading standard, never a spinner or a "loading" label.
export function Skeleton({
  width = '100%',
  height = 16,
  borderRadius = radius.sm,
  style,
}: Props): React.JSX.Element {
  const opacity = useSharedValue(0.5)

  useEffect(() => {
    opacity.value = withRepeat(withTiming(1, { duration: 800 }), -1, true)
  }, [opacity])

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }))

  return (
    <Animated.View
      style={[styles.base, { width, height, borderRadius }, animatedStyle, style]}
    />
  )
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.surfaceVariant,
    borderCurve: 'continuous',
  },
})
