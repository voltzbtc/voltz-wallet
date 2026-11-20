import React, { useEffect, useRef } from 'react'
import { AccessibilityInfo, Animated, PanResponder, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, layer, radius, space } from '../theme'
import { animateTo } from './animateTo'
import { TabIcon } from './TabIcon'
import { Txt } from './Txt'
import { useAccent } from '../wallet/dollarMode'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useUnderLock } from './UnderLock'

type Props = {
  title: string
  body: string
  onPress: () => void
  onDismiss: () => void
}

// Shown for a notification that arrived while the app was in front, which the system does not draw.
// FCM hands the message to the process instead, by design, and without this it is lost.
//
// In the app rather than posted to the tray, because somebody looking at the screen has already been
// reached and a copy on their lock screen for something in front of them is noise. It carries the
// gateway's own words, which the device chose the language of, so nothing is translated twice. The app
// reuses it for news of its own (showForegroundNotice), already in the language on screen.
//
// Shaped after IncomingBanner, the app's other floating banner, with the same corner from the top,
// the same surface with no rim and the same 260ms entrance. It is a card rather than a pill because
// it carries two lines and a tap, and radius.lg is what theme.ts gives a card.
const SHOWN_MS = 6000

// It sits over the navigation header, back button included, so a swipe up puts it away before its
// time. A drag this far up, or a flick, dismisses; anything shorter goes back. The slop leaves a
// tap to the card, which still opens what the notice is about.
const SWIPE_SLOP = 8
const SWIPE_DISMISS = 32
const FLICK = 0.5

export function ForegroundNotice({ title, body, onPress, onDismiss }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets()
  // The card is a tap target, so its mark follows the wallet's accent as every action does.
  const { accent } = useAccent()
  // With reduced motion the card only fades in and does not follow the finger; a swipe still
  // dismisses it by the same distances.
  const reduced = useReduceMotion()
  const enter = useRef(new Animated.Value(0)).current
  // Held in a ref so the timer that fires later calls the current one, not the one captured when the
  // notice first rendered. A stale dismiss leaves a banner on screen forever.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const drag = useRef(new Animated.Value(0)).current
  // The swipe and the timer both end the notice, and whichever comes second finds it already gone,
  // so the caller hears about it once.
  const done = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const close = useRef(() => {
    if (done.current) {
      return
    }
    done.current = true
    if (timer.current) {
      clearTimeout(timer.current)
    }
    dismiss.current()
  }).current

  // Drawn over whatever is in front without taking focus, so a screen reader hears it only if told, and
  // not while the lock is up.
  const underLock = useUnderLock()
  useEffect(() => {
    if (!underLock) {
      AccessibilityInfo.announceForAccessibility(`${title}, ${body}`)
    }
  }, [underLock, title, body])

  useEffect(() => {
    animateTo(enter, 1).start()
    timer.current = setTimeout(close, SHOWN_MS)
    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [enter, close])

  // A drag short of dismissing is under 32pt, so the card snaps back rather than animating, which
  // adds no motion beyond the entrance.
  const settle = () => drag.setValue(0)
  const swipe = useRef(
    PanResponder.create({
      // Captured, because the card's own press would otherwise keep the touch for itself.
      onMoveShouldSetPanResponderCapture: (_, g) =>
        g.dy < -SWIPE_SLOP && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => drag.setValue(Math.min(0, g.dy)),
      onPanResponderRelease: (_, g) => {
        if (g.dy < -SWIPE_DISMISS || g.vy < -FLICK) {
          close()
        } else {
          settle()
        }
      },
      onPanResponderTerminate: () => settle(),
    }),
  ).current

  return (
    <Animated.View
      pointerEvents="box-none"
      {...swipe.panHandlers}
      style={[
        styles.wrap,
        { top: insets.top + space.sm },
        reduced
          ? { opacity: enter }
          : {
              opacity: enter,
              transform: [
                {
                  translateY: Animated.add(
                    enter.interpolate({ inputRange: [0, 1], outputRange: [-space.xl, 0] }),
                    drag,
                  ),
                },
              ],
            },
      ]}>
      <Pressable onPress={onPress} accessibilityRole="button" style={styles.card}>
        <TabIcon name="globe" color={accent} size={20} strokeWidth={2.5} />
        <View style={styles.words}>
          <Txt role="bodyBold" lines={2}>
            {title}
          </Txt>
          <Txt role="caption" tone="muted" lines={2}>
            {body}
          </Txt>
        </View>
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space.xl, right: space.xl, zIndex: layer.banner },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
  words: { flex: 1, gap: space.xs },
})
