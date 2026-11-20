import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { animateTo } from './animateTo'
import { motion } from '../theme'

type Props = {
  // What the content says, as text. A change while `armed` is what crosses the old content into the new.
  value: string
  // On around a read, so a figure the read brought fades.
  armed: boolean
  // What a tap decides about the content, such as its unit or whether it is hidden. A change here
  // answers at once whatever `armed` says, and ends a fade under way, whose old copy would go on
  // showing a figure a tap on hide just covered.
  tapped?: string
  style?: StyleProp<ViewStyle>
  children: React.ReactNode
}

// A figure changing without a jump. The new content is in its normal place and sets the size; the old
// one sits over it, takes no touch and says nothing to a screen reader, and leaves when the fade ends.
// Opacity alone, so it needs nothing under reduced motion.
export function CrossFade({ value, armed, tapped, style, children }: Props): React.JSX.Element {
  const [leaving, setLeaving] = useState<React.ReactNode>(null)
  const last = useRef({ value, tapped, children })
  const incoming = useRef(new Animated.Value(1)).current
  const outgoing = useRef(new Animated.Value(0)).current
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  // A layout effect, so the old content is back before the new one paints alone.
  useLayoutEffect(() => {
    const before = last.current
    last.current = { value, tapped, children }
    if (before.tapped !== tapped) {
      clearTimer()
      setLeaving(null)
      incoming.setValue(1)
      outgoing.setValue(0)
      return
    }
    if (before.value === value || !armed) {
      return
    }
    clearTimer()
    setLeaving(before.children)
    incoming.setValue(0)
    outgoing.setValue(1)
    animateTo(incoming, 1).start()
    animateTo(outgoing, 0).start()
    timer.current = setTimeout(() => {
      timer.current = null
      setLeaving(null)
    }, motion.base)
  }, [value, armed, tapped, children, incoming, outgoing, clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  return (
    <View style={style}>
      <Animated.View style={[style, { opacity: incoming }]}>{children}</Animated.View>
      {leaving !== null && (
        <Animated.View
          testID="cross-fade-leaving"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[style, StyleSheet.absoluteFill, { opacity: outgoing }]}>
          {leaving}
        </Animated.View>
      )}
    </View>
  )
}
