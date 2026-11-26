import React, { useEffect, useRef } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import Svg, { Defs, G, LinearGradient, Mask, Path, Rect, Stop } from 'react-native-svg'
import { colors, layer } from '../theme'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { BOLT_D, GROUP_TRANSLATE, LETTERS_D, VB_H, VB_W } from '../components/wordmark'

const LOGO_W = 232
const SCALE = LOGO_W / VB_W
const LOGO_H = VB_H * SCALE

// Bolt center in wordmark space, from getBBox, because RN has no `transform-box: fill-box`. An
// approximate center makes the O orbit instead of spinning in place.
const O_CX = 361.61
const O_CY = 175.59
const O_BOX = 436
const O_BOX_PX = O_BOX * SCALE
const O_LEFT = O_CX * SCALE - O_BOX_PX / 2
const O_TOP = O_CY * SCALE - O_BOX_PX / 2
const O_VIEWBOX = `${O_CX - O_BOX / 2} ${O_CY - O_BOX / 2} ${O_BOX} ${O_BOX}`

// Durations run tighter than the design mock, whose slow two-turn spin drags on a device.
const T = {
  lettersDelay: 100,
  lettersDur: 420,
  oOpacityDur: 150,
  oSpinDur: 820, // the full -720deg -> 0deg (two turns), fast so it doesn't drag
  shineDelay: 960, // right after the O parks
  shineDur: 560,
  shineFadeInDur: 90,
  shineFadeOutDur: 130,
  fadeDelay: 1740,
  fadeDur: 260,
}
// Hands over the moment the fade ends. A splash that is clear but still mounted would take the first
// tap meant for the PIN keypad under it.
const HANDOVER = T.fadeDelay + T.fadeDur

// A stronger overshoot bezier swings the two-turn spin visibly back past upright at this speed.
const EASE_SPIN = Easing.out(Easing.cubic)
const EASE_OUT = Easing.bezier(0, 0, 0.58, 1)
const EASE_IN_OUT = Easing.bezier(0.42, 0, 0.58, 1)

// Every animation here opts out of Reanimated's own reduce-motion rule, which would end the screen's
// fade on its first frame, leaving an invisible splash that still takes the tap, and reads the setting
// once at launch. useReduceMotion decides what moves.
const OWN = ReduceMotion.Never

const AnimatedRect = Animated.createAnimatedComponent(Rect)

type Props = { onDone: () => void }

// Covers the cold start while the app resolves where to go. A tap anywhere skips it.
export function SplashScreen({ onDone }: Props): React.JSX.Element {
  const reduced = useReduceMotion()
  const root = useSharedValue(1)
  const lettersO = useSharedValue(0)
  const lettersS = useSharedValue(0.95)
  const oO = useSharedValue(0)
  const oRot = useSharedValue(-720)
  const oScale = useSharedValue(0.15)
  const shineO = useSharedValue(0)
  const shineX = useSharedValue(-180)

  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const finished = useRef(false)

  const finish = () => {
    if (finished.current) {
      return
    }
    finished.current = true
    onDone()
  }

  useEffect(() => {
    lettersO.value = withDelay(
      T.lettersDelay,
      withTiming(1, { duration: T.lettersDur, easing: EASE_OUT, reduceMotion: OWN }),
      OWN,
    )
    lettersS.value = withDelay(
      T.lettersDelay,
      withTiming(1, { duration: T.lettersDur, easing: EASE_OUT, reduceMotion: OWN }),
      OWN,
    )
    oO.value = withTiming(1, { duration: T.oOpacityDur, reduceMotion: OWN })
    oRot.value = withTiming(0, { duration: T.oSpinDur, easing: EASE_SPIN, reduceMotion: OWN })
    oScale.value = withTiming(1, { duration: T.oSpinDur, easing: EASE_SPIN, reduceMotion: OWN })
    shineO.value = withDelay(
      T.shineDelay,
      withSequence(
        OWN,
        withTiming(1, { duration: T.shineFadeInDur, reduceMotion: OWN }),
        withDelay(
          T.shineDur - T.shineFadeInDur,
          withTiming(0, { duration: T.shineFadeOutDur, reduceMotion: OWN }),
          OWN,
        ),
      ),
      OWN,
    )
    shineX.value = withDelay(
      T.shineDelay,
      withTiming(VB_W + 180, { duration: T.shineDur, easing: EASE_IN_OUT, reduceMotion: OWN }),
      OWN,
    )
    root.value = withDelay(
      T.fadeDelay,
      withTiming(0, { duration: T.fadeDur, easing: EASE_OUT, reduceMotion: OWN }),
      OWN,
    )

    doneTimer.current = setTimeout(finish, HANDOVER)
    return () => {
      if (doneTimer.current) {
        clearTimeout(doneTimer.current)
      }
      ;[root, lettersO, lettersS, oO, oRot, oScale, shineO, shineX].forEach(cancelAnimation)
    }
    // shared values are stable refs; run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // With reduced motion the logo stands at rest with no shine crossing it, and the screen still fades
  // out on its schedule. The setting answers after the first frame, so this stops what already began,
  // and each style sets the same keys either way, since a key it stops setting keeps its last value.
  useEffect(() => {
    if (!reduced) {
      return
    }
    lettersO.value = 1
    lettersS.value = 1
    oO.value = 1
    oRot.value = 0
    oScale.value = 1
    shineO.value = 0
    cancelAnimation(shineX)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced])

  const rootStyle = useAnimatedStyle(() => ({ opacity: root.value }))
  const lettersStyle = useAnimatedStyle(() => ({
    opacity: lettersO.value,
    transform: [{ scale: reduced ? 1 : lettersS.value }],
  }))
  // Rotating about the box's own center avoids an offset pivot and an elliptical swing.
  const oStyle = useAnimatedStyle(() => ({
    opacity: oO.value,
    transform: [{ rotate: `${reduced ? 0 : oRot.value}deg` }, { scale: reduced ? 1 : oScale.value }],
  }))
  const shineStyle = useAnimatedStyle(() => ({ opacity: shineO.value }))
  const shineProps = useAnimatedProps(() => ({ x: shineX.value }))

  return (
    <Animated.View style={[styles.root, rootStyle]}>
      {/* Out of the screen reader, which would otherwise announce one unnamed button over the whole
          screen; the splash ends by itself and a tap still skips it. Hidden as GradientButton hides a
          concealed button, with both platforms' props since each reads only its own. */}
      <Pressable
        style={styles.fill}
        onPress={finish}
        accessibilityRole="button"
        focusable={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants">
        <View style={styles.logo}>
          <Animated.View style={[styles.layer, lettersStyle]}>
            <Svg width={LOGO_W} height={LOGO_H} viewBox={`0 0 ${VB_W} ${VB_H}`}>
              <G transform={GROUP_TRANSLATE}>
                <Path d={LETTERS_D} fill={colors.primary} />
              </G>
            </Svg>
          </Animated.View>

          <Animated.View style={[styles.oLayer, oStyle]}>
            <Svg width={O_BOX_PX} height={O_BOX_PX} viewBox={O_VIEWBOX}>
              <G transform={GROUP_TRANSLATE}>
                <Path d={BOLT_D} fill={colors.primary} />
              </G>
            </Svg>
          </Animated.View>

          <Animated.View style={[styles.layer, shineStyle]} pointerEvents="none">
            <Svg width={LOGO_W} height={LOGO_H} viewBox={`0 0 ${VB_W} ${VB_H}`}>
              <Defs>
                <LinearGradient id="voltzShine" x1="0" y1="0" x2="1" y2="0">
                  <Stop offset="0" stopColor={colors.text} stopOpacity={0} />
                  <Stop offset="0.5" stopColor={colors.text} stopOpacity={1} />
                  <Stop offset="1" stopColor={colors.text} stopOpacity={0} />
                </LinearGradient>
                <Mask id="voltzMask">
                  <G transform={GROUP_TRANSLATE}>
                    <Path d={LETTERS_D} fill={colors.text} />
                    <Path d={BOLT_D} fill={colors.text} />
                  </G>
                </Mask>
              </Defs>
              <G mask="url(#voltzMask)">
                <AnimatedRect
                  y={-20}
                  width={150}
                  height={VB_H + 40}
                  fill="url(#voltzShine)"
                  transform="skewX(-16)"
                  animatedProps={shineProps}
                />
              </G>
            </Svg>
          </Animated.View>
        </View>
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background,
    zIndex: layer.cover,
  },
  fill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: LOGO_W,
    height: LOGO_H,
  },
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: LOGO_W,
    height: LOGO_H,
  },
  oLayer: {
    position: 'absolute',
    left: O_LEFT,
    top: O_TOP,
    width: O_BOX_PX,
    height: O_BOX_PX,
    overflow: 'visible',
  },
})
