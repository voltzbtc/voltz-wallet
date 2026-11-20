import React, { useEffect, useRef } from 'react'
import { Animated, type StyleProp, type ViewStyle } from 'react-native'
import { animateTo } from './animateTo'

// A list line that fades in when it arrives `fresh`, and otherwise is a plain box. Opacity alone, so
// it needs nothing under reduced motion.
export function FadeInLine({
  fresh,
  style,
  children,
}: {
  fresh: boolean
  style?: StyleProp<ViewStyle>
  children: React.ReactNode
}): React.JSX.Element {
  const opacity = useRef(new Animated.Value(fresh ? 0 : 1)).current
  const arrivedFresh = useRef(fresh).current

  useEffect(() => {
    if (arrivedFresh) {
      animateTo(opacity, 1).start()
    }
  }, [arrivedFresh, opacity])

  return <Animated.View style={[style, { opacity }]}>{children}</Animated.View>
}
