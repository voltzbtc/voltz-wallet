import { Animated } from 'react-native'
import { motion } from '../theme'

// The app's plain transition: one value to one target on the native thread, on the shared scale.
export function animateTo(
  value: Animated.Value,
  toValue: number,
  duration: number = motion.base,
): Animated.CompositeAnimation {
  return Animated.timing(value, { toValue, duration, useNativeDriver: true })
}
