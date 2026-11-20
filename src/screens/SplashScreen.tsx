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

// Split out of src/assets/voltz-text.svg, both halves keeping the source viewBox and translate.
const LETTERS_D =
  'M 109.43775,998.09493 l -2.04986,-4.76723 -48.036889,-114.5 -48.036885,-114.5 -0.926819,-1.76221 -0.9268181,-1.76222 37.1879561,0.26222 37.187956,0.26221 26.103769,68.25104 26.10376,68.25105 0.91882,-1.38046 0.91883,-1.38046 25.65222,-66.87059 25.65223,-66.87058 36.67895,-0.26232 36.67895,-0.26232 -0.006,0.76232 -0.006,0.76232 -50.33175,120 -50.33175,120 -25.19011,0.2672 -25.19012,0.2673 z M 515.54392,881.82770 v -121 h 32.99474 32.99474 l 0.25526,91.25 0.25526,91.25 39.25,0.26161 39.25,0.2616 v 29.4884 29.48839 h -72.5 -72.5 z M 710.54392,911.32770 v -91.5 h -27 -27 v -29.5 -29.5 h 87 87 v 29.5 29.5 h -27 -27 v 91.5 91.5 h -33 -33 z M 838.95918,1000.57770 l 1.46137,-2.25 55.00681,-89 55.00682,-89 -45.94513,-0.25999 -45.94513,-0.25998 V 790.31771 760.8277 h 103.5 103.49998 v 0.54905 0.54905 l -56,90.39301 -55.99998,90.393 v 0.55795 0.55794 h 49.99998 50 v 29.5 29.5 H 945.52087 837.49781 Z'
const BOLT_D =
  'M 290.54392,1054.28300 v -0.8781 l 7.06301,-35.4636 7.06301,-35.46357 -1.57104,-0.8792 -1.57103,-0.87919 -7.51661,-6.0468 -7.5166,-6.0468 -5.72537,-6.47889 -5.72537,-6.47888 -4.8268,-7.17014 -4.82681,-7.17013 -3.30056,-6.5 -3.30057,-6.5 -3.08125,-9 -3.08125,-9 -1.64806,-10 -1.64807,-10 0.58318,-15 0.58318,-15 2.0197,-8.29741 2.0197,-8.29741 3.59452,-8.68344 3.59452,-8.68344 3.93135,-6.73141 3.93135,-6.7314 5.80546,-7.28775 5.80545,-7.28774 6.38089,-5.89018 6.38089,-5.89018 6.03858,-4.39395 6.03858,-4.39395 9.50301,-4.86106 9.50301,-4.86106 8.07392,-2.53288 8.07392,-2.53288 8.28655,-1.57193 8.28655,-1.57193 11.63953,0.009 11.63953,0.009 5.25,0.6306 5.25,0.6306 v 0.8327 0.8327 l -45.36886,58.77801 -45.36887,58.77801 1.61887,0.66077 1.61886,0.66076 27.91064,2.08321 27.91064,2.08321 0.48073,0.48073 0.48073,0.48073 -34.78062,83.7753 -34.78062,83.77467 -0.36075,0.4167 -0.36075,0.4166 z M 354.04392,1001.17280 l -2,-0.4228 -7.25,-1.52936 -7.25,-1.52936 v -0.77623 -0.77623 l 52.89495,-69.40556 52.89494,-69.40556 -0.27991,-0.30164 -0.27992,-0.30164 -30.30141,-2.46807 -30.30141,-2.46808 -0.32673,-0.32673 -0.32673,-0.32672 28.25661,-73.57673 28.25661,-73.57672 0.21489,0.21489 0.21489,0.21489 -5.81534,34.16013 -5.81534,34.16013 6.46475,3.78072 6.46474,3.78073 8.14221,6.58584 8.1422,6.58584 6.76025,7.812 6.76025,7.812 4.62389,7.41873 4.62388,7.41872 3.90995,9.0692 3.90994,9.06919 2.49775,10.13166 2.49775,10.13166 0.59174,12.5 0.59174,12.5 -1.17015,9 -1.17015,9 -2.55102,9 -2.55101,9 -3.44808,7.46805 -3.44809,7.46805 -3.15775,5.03195 -3.15776,5.03195 -6.34755,8.23297 -6.34754,8.23297 -8.19193,7.09059 -8.19194,7.0906 -8.08699,4.88478 -8.087,4.88477 -4.93009,2.15258 -4.93009,2.15259 -8.5,2.91804 -8.5,2.91804 -9,1.46697 -9,1.4671 -13,-0.112 -13,-0.112 z'

const GROUP_TRANSLATE = 'translate(-9.4604788,-703.98137)'

const VB_W = 1056.0835
const VB_H = 351.17963

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
