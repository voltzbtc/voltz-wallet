import React, { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Modal, Pressable, StyleSheet, View } from 'react-native'
import { Text, useFontScale } from './Text'
import { Txt } from './Txt'
import { Figure } from './Amount'
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
import Svg, { G, Path } from 'react-native-svg'
import { useTranslation } from 'react-i18next'
import { useAccent } from '../wallet/dollarMode'
import { colors, font, radius, space } from '../theme'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useCloseOnLock } from './UnderLock'
import { Ring } from './Ring'
import { leadingText } from '../i18n/direction'

const AnimatedPath = Animated.createAnimatedComponent(Path)

// From src/assets/voltz-text.svg, its two subpaths reconnected into one.
const BOLT_D =
  'm 290.54392,1054.283 v -0.8781 l 7.06301,-35.4636 7.06301,-35.46357 -1.57104,-0.8792 -1.57103,-0.87919 -7.51661,-6.0468 -7.5166,-6.0468 -5.72537,-6.47889 -5.72537,-6.47888 -4.8268,-7.17014 -4.82681,-7.17013 -3.30056,-6.5 -3.30057,-6.5 -3.08125,-9 -3.08125,-9 -1.64806,-10 -1.64807,-10 0.58318,-15 0.58318,-15 2.0197,-8.29741 2.0197,-8.29741 3.59452,-8.68344 3.59452,-8.68344 3.93135,-6.73141 3.93135,-6.7314 5.80546,-7.28775 5.80545,-7.28774 6.38089,-5.89018 6.38089,-5.89018 6.03858,-4.39395 6.03858,-4.39395 9.50301,-4.86106 9.50301,-4.86106 8.07392,-2.53288 8.07392,-2.53288 8.28655,-1.57193 8.28655,-1.57193 11.63953,0.009 11.63953,0.009 5.25,0.6306 5.25,0.6306 v 0.8327 0.8327 l -45.36886,58.77801 -45.36887,58.77801 1.61887,0.66077 1.61886,0.66076 27.91064,2.08321 27.91064,2.08321 0.48073,0.48073 0.48073,0.48073 -34.78062,83.7753 -34.78062,83.77467 -0.36075,0.4167 -0.36075,0.4166 z m 63.5,-53.1102 -2,-0.4228 -7.25,-1.52936 -7.25,-1.52936 v -0.77623 -0.77623 l 52.89495,-69.40556 52.89494,-69.40556 -0.27991,-0.30164 -0.27992,-0.30164 -30.30141,-2.46807 -30.30141,-2.46808 -0.32673,-0.32673 -0.32673,-0.32672 28.25661,-73.57673 28.25661,-73.57672 0.21489,0.21489 0.21489,0.21489 -5.81534,34.16013 -5.81534,34.16013 6.46475,3.78072 6.46474,3.78073 8.14221,6.58584 8.1422,6.58584 6.76025,7.812 6.76025,7.812 4.62389,7.41873 4.62388,7.41872 3.90995,9.0692 3.90994,9.06919 2.49775,10.13166 2.49775,10.13166 0.59174,12.5 0.59174,12.5 -1.17015,9 -1.17015,9 -2.55102,9 -2.55101,9 -3.44808,7.46805 -3.44809,7.46805 -3.15775,5.03195 -3.15776,5.03195 -6.34755,8.23297 -6.34754,8.23297 -8.19193,7.09059 -8.19194,7.0906 -8.08699,4.88478 -8.087,4.88477 -4.93009,2.15258 -4.93009,2.15259 -8.5,2.91804 -8.5,2.91804 -9,1.46697 -9,1.4671 -13,-0.112 -13,-0.112 z'

const HOLD_MS = 3600
// A sentence takes longer to read than a figure.
const NOTE_HOLD_MS = 7000

// Every animation here opts out of Reanimated's own reduce-motion rule, which would end each fade on
// its first frame and reads the setting once at launch. useReduceMotion decides what moves.
const OWN = ReduceMotion.Never

type Props = {
  visible: boolean
  // The figure, its unit and how to write it, in one prop, because they are one fact. As separate
  // props with a unit defaulting to "sats", a caller passing a token amount and forgetting the other
  // two reads as correct at the call site and draws 10 USDB as "10 sats".
  //
  // `format` is required for the same reason: a default that rounds to a whole number is right for
  // sats and wrong for anything with decimals, drawing 0.25 USDB as "0 USDB".
  amount: { value: number; unit: string; format: (n: number) => string }
  label?: string
  feeLabel?: string
  fiat?: string
  /** A line under the figure, drawn as given, for a figure that is itself the approximate one. */
  beneath?: string
  zap?: { comment?: string }
  /** Words from the other side of the payment, never through t(). */
  note?: string
  // Set while the payment has no end yet: the line that says how its end will be told. The badge then
  // shows a clock rather than the check, which stands for a payment that completed.
  pending?: string
  onDone: () => void
}

export function ReceivedOverlay({
  visible,
  amount,
  label,
  feeLabel,
  fiat,
  beneath,
  zap,
  note,
  pending,
  onDone,
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const fontScale = useFontScale()
  const { accent } = useAccent()
  // With reduced motion the same pieces only fade, on the same timing: the ring keeps its size, the
  // badge and the amount do not grow or rise, and the bolt and the check are drawn whole. A style sets
  // the same keys either way, since a key it stops setting keeps its last value on the view.
  const reduced = useReduceMotion()
  // The PIN asked again closes it, and a result that lands under the lock is neither drawn nor said over
  // it.
  const underLock = useCloseOnLock(visible, onDone)
  const [count, setCount] = useState(0)
  const { value, unit, format: fmt } = amount

  // react-native-svg exposes no pathLength, so editing a path means remeasuring it.
  const BOLT_LEN = 1622
  const CHECK_LEN = 38

  const scrim = useSharedValue(0)
  const boltO = useSharedValue(0)
  const boltDash = useSharedValue(BOLT_LEN)
  const boltFill = useSharedValue(0)
  const ringScale = useSharedValue(0.4)
  const ringO = useSharedValue(0)
  const badge = useSharedValue(0)
  const checkDash = useSharedValue(CHECK_LEN)
  const labelO = useSharedValue(0)
  const amountO = useSharedValue(0)
  const amountY = useSharedValue(18)
  const fiatO = useSharedValue(0)

  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const raf = useRef<number>(0)

  useEffect(() => {
    if (!visible) {
      return
    }
    scrim.value = 0
    boltO.value = 0
    boltDash.value = BOLT_LEN
    boltFill.value = 0
    ringScale.value = 0.4
    ringO.value = 0
    badge.value = 0
    checkDash.value = CHECK_LEN
    labelO.value = 0
    amountO.value = 0
    amountY.value = 18
    fiatO.value = 0
    setCount(0)

    scrim.value = withTiming(1, { duration: 240, reduceMotion: OWN })
    // One sequence, because a second synchronous `.value =` cancels the first instead of chaining.
    boltO.value = withDelay(
      100,
      withSequence(
        OWN,
        withTiming(1, { duration: 120, reduceMotion: OWN }),
        withDelay(1080, withTiming(0, { duration: 260, reduceMotion: OWN }), OWN),
      ),
      OWN,
    )
    boltDash.value = reduced
      ? 0
      : withDelay(
          120,
          withTiming(0, { duration: 560, easing: Easing.out(Easing.ease), reduceMotion: OWN }),
          OWN,
        )
    boltFill.value = withDelay(660, withTiming(1, { duration: 420, reduceMotion: OWN }), OWN)
    ringScale.value = withDelay(
      720,
      withTiming(2.1, { duration: 820, easing: Easing.out(Easing.ease), reduceMotion: OWN }),
      OWN,
    )
    ringO.value = withDelay(
      720,
      withSequence(
        OWN,
        withTiming(0.5, { duration: 1, reduceMotion: OWN }),
        withTiming(0, { duration: 820, reduceMotion: OWN }),
      ),
      OWN,
    )
    // Reduced, the badge's value is its opacity, which an overshoot would only clip.
    badge.value = withDelay(
      1320,
      withTiming(1, {
        duration: 500,
        easing: Easing.out(reduced ? Easing.ease : Easing.back(1.5)),
        reduceMotion: OWN,
      }),
      OWN,
    )
    checkDash.value = reduced
      ? 0
      : withDelay(
          1620,
          withTiming(0, { duration: 320, easing: Easing.out(Easing.ease), reduceMotion: OWN }),
          OWN,
        )
    labelO.value = withDelay(1420, withTiming(1, { duration: 300, reduceMotion: OWN }), OWN)
    amountO.value = withDelay(1460, withTiming(1, { duration: 420, reduceMotion: OWN }), OWN)
    amountY.value = withDelay(
      1460,
      withTiming(0, { duration: 520, easing: Easing.out(Easing.back(1.2)), reduceMotion: OWN }),
      OWN,
    )
    fiatO.value = withDelay(1740, withTiming(1, { duration: 320, reduceMotion: OWN }), OWN)

    // Progress reads elapsed wall-clock, so a late frame does not restart the ramp.
    const countTimer = setTimeout(() => {
      const start = Date.now()
      const dur = 800
      const step = () => {
        const p = Math.min(1, (Date.now() - start) / dur)
        const eased = 1 - Math.pow(1 - p, 3)
        setCount(value * eased) // stays a float, since the caller's formatter decides the places
        if (p < 1) {
          raf.current = requestAnimationFrame(step)
        }
      }
      step()
    }, 1480)
    timers.current.push(countTimer)

    // rAF freezes while backgrounded, stranding the hero below the amount that arrived.
    const settleTimer = setTimeout(() => setCount(value), 1480 + 800)
    timers.current.push(settleTimer)

    const doneTimer = setTimeout(onDone, note || pending ? NOTE_HOLD_MS : HOLD_MS)
    timers.current.push(doneTimer)

    return () => {
      timers.current.forEach(clearTimeout)
      timers.current = []
      cancelAnimationFrame(raf.current)
      ;[
        scrim,
        boltO,
        boltDash,
        boltFill,
        ringScale,
        ringO,
        badge,
        checkDash,
        labelO,
        amountO,
        amountY,
        fiatO,
      ].forEach(v => cancelAnimation(v))
    }
    // Shared values are stable refs, so visibility and amount are the only real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, value])

  // The setting answers after the overlay's first frame, so a draw already under way ends whole.
  useEffect(() => {
    if (reduced) {
      boltDash.value = 0
      checkDash.value = 0
    }
  }, [reduced, boltDash, checkDash])

  // The figure counts up from zero, so a screen reader is given the amount that arrived instead.
  const title = label ?? (zap ? t('history.zapReceived') : t('receive.gotIt'))
  // A token the app does not recognise has no unit, and its figure stands alone.
  const figure = unit ? `${fmt(value)} ${unit}` : fmt(value)
  const spoken = `${title}, ${figure}${beneath ? `, ${beneath}` : ''}${pending ? `, ${pending}` : ''}`
  useEffect(() => {
    if (visible && !underLock) {
      AccessibilityInfo.announceForAccessibility(spoken)
    }
  }, [visible, underLock, spoken])

  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrim.value }))
  const boltStyle = useAnimatedStyle(() => ({ opacity: boltO.value }))
  const boltFillProps = useAnimatedProps(() => ({ fillOpacity: boltFill.value }))
  const boltStrokeProps = useAnimatedProps(() => ({ strokeDashoffset: boltDash.value }))
  const ringStyle = useAnimatedStyle(() => ({
    opacity: ringO.value,
    transform: [{ scale: reduced ? 1 : ringScale.value }],
  }))
  const ring2Style = useAnimatedStyle(() => ({
    opacity: ringO.value * 0.8,
    transform: [{ scale: reduced ? 1 : ringScale.value * 0.8 }],
  }))
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: reduced ? badge.value : 1,
    transform: [{ scale: reduced ? 1 : badge.value }],
  }))
  const checkProps = useAnimatedProps(() => ({ strokeDashoffset: checkDash.value }))
  const labelStyle = useAnimatedStyle(() => ({ opacity: labelO.value }))
  const amountStyle = useAnimatedStyle(() => ({
    opacity: amountO.value,
    transform: [{ translateY: reduced ? 0 : amountY.value }],
  }))
  const fiatStyle = useAnimatedStyle(() => ({ opacity: fiatO.value }))
  const words = note ?? zap?.comment

  return (
    <Modal visible={visible && !underLock} transparent animationType="none" onRequestClose={onDone}>
      <Animated.View style={[styles.scrim, scrimStyle]} />
      <Pressable style={styles.center} onPress={onDone} accessibilityRole="button" accessibilityLabel={spoken}>
        <View style={styles.iconSlot}>
          <Animated.View style={[styles.ring, ringStyle]}>
            <Ring size={RING_SIZE} width={RING_WIDTH} color={accent} />
          </Animated.View>
          <Animated.View style={[styles.ring, ring2Style]}>
            <Ring size={RING_SIZE} width={RING_WIDTH} color={accent} />
          </Animated.View>

          <Animated.View style={[styles.icon, boltStyle]}>
            <Svg width={72} height={92} viewBox="235.9 -4 251.5 359.2">
              <G transform="translate(-9.4604788,-703.98137)">
                <AnimatedPath d={BOLT_D} fill={accent} animatedProps={boltFillProps} />
                <AnimatedPath
                  d={BOLT_D}
                  fill="none"
                  stroke={accent}
                  strokeWidth={8}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeDasharray={BOLT_LEN}
                  animatedProps={boltStrokeProps}
                />
              </G>
            </Svg>
          </Animated.View>

          {pending ? (
            <Animated.View testID="overlay-pending" style={[styles.icon, styles.badge, styles.pendingBadge, badgeStyle]}>
              <Svg width={52} height={52} viewBox="0 0 52 52">
                <Path
                  d={CLOCK_HANDS}
                  fill="none"
                  stroke={accent}
                  strokeWidth={6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            </Animated.View>
          ) : (
            <Animated.View
              testID="overlay-check"
              style={[styles.icon, styles.badge, badgeStyle, { backgroundColor: accent }]}>
              <Svg width={52} height={52} viewBox="0 0 52 52">
                <AnimatedPath
                  d="M14 27 L23 36 L39 17"
                  fill="none"
                  stroke={colors.text}
                  strokeWidth={7}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={CHECK_LEN}
                  animatedProps={checkProps}
                />
              </Svg>
            </Animated.View>
          )}
        </View>

        {/* Keyed by the font scale like the app's Text, which these animated ones are not. */}
        <Animated.Text key={`title-${fontScale}`} style={[leadingText(), styles.label, labelStyle]}>
          {title}
        </Animated.Text>
        <Animated.View style={[styles.amountBox, amountStyle]}>
          <Figure role="display" tabular style={styles.amount}>
            {fmt(count)}
            {unit ? <Text style={styles.unit}> {unit}</Text> : null}
          </Figure>
        </Animated.View>
        {/* User text, never through t(), and capped because this overlay auto-dismisses. */}
        {words ? (
          <Animated.Text
            key={`comment-${fontScale}`}
            style={[leadingText(), styles.zapComment, fiatStyle]}
            numberOfLines={3}>
            {words}
          </Animated.Text>
        ) : null}
        {feeLabel || fiat || beneath ? (
          <Animated.View style={[styles.subLines, fiatStyle]}>
            {feeLabel ? (
              <Figure role="caption" tone="muted">
                {feeLabel}
              </Figure>
            ) : null}
            {fiat ? (
              <Figure role="caption" tone="muted">
                {t('receive.approxFiat', { amount: fiat })}
              </Figure>
            ) : null}
            {beneath ? (
              <Figure role="caption" tone="muted">
                {beneath}
              </Figure>
            ) : null}
          </Animated.View>
        ) : null}
        {pending ? (
          <Animated.View style={[styles.pendingLine, fiatStyle]}>
            <Txt role="caption" tone="muted" style={styles.pendingText}>
              {pending}
            </Txt>
          </Animated.View>
        ) : null}
      </Pressable>
    </Modal>
  )
}

// A clock's two hands, from the centre of the badge's 52 box up to twelve and across to about four.
const CLOCK_HANDS = 'M26 13 L26 26 L35 32'

const RING_SIZE = 120
const ICON_SLOT = 96
const RING_WIDTH = 2

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background,
  },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
  },
  iconSlot: {
    width: ICON_SLOT,
    height: ICON_SLOT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    // Centers the ring over the icon's slot.
    top: (ICON_SLOT - RING_SIZE) / 2,
    left: (ICON_SLOT - RING_SIZE) / 2,
  },
  // The bolt and the badge are stacked in the slot and fill it.
  icon: {
    position: 'absolute',
    width: ICON_SLOT,
    height: ICON_SLOT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    borderRadius: radius.full,
    backgroundColor: colors.primary,
  },
  // A pending payment's badge is the raised surface with the hands in the accent, so the clock is told
  // from the check by its shape and its fill alike.
  pendingBadge: {
    backgroundColor: colors.surfaceRaised,
  },
  label: {
    color: colors.textSecondary,
    fontSize: font.size.base,
    ...font.family.semibold,
  },
  // The full width, so the figure is centred in the screen margin and shrinks inside it.
  amountBox: {
    alignSelf: 'stretch',
  },
  // The digits are tabular, so the count-up changes them in place instead of shifting the line
  // sideways as wide and narrow digits swap.
  amount: {
    textAlign: 'center',
    paddingHorizontal: space.xl,
  },
  unit: {
    color: colors.textSecondary,
    fontSize: font.size.xl,
    ...font.family.semibold,
  },
  zapComment: {
    color: colors.text,
    fontSize: font.size.base,
    ...font.family.regular,
    textAlign: 'center',
    paddingHorizontal: space.xl,
  },
  subLines: {
    alignItems: 'center',
    gap: space.xs,
  },
  pendingLine: {
    paddingHorizontal: space.xl,
  },
  pendingText: {
    textAlign: 'center',
  },
})
