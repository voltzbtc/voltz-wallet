import React, { useEffect, useRef } from 'react'
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native'
import { Text } from './Text'
import LinearGradient from 'react-native-linear-gradient'
import { useAccent } from '../wallet/dollarMode'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { alpha, colors, dangerSoftSurface, font, press, radius, space, touch } from '../theme'
import { leadingText } from '../i18n/direction'
import { Ring } from './Ring'

type Variant = 'primary' | 'secondary' | 'danger'

const SPINNER_SIZE = 18
const SPINNER_WIDTH = 2
// The share of the ring the head covers, a quarter as a view's top edge drew it.
const SPINNER_HEAD = 0.25

type Props = {
  label: string
  onPress: () => void
  disabled?: boolean
  loading?: boolean
  variant?: Variant
  icon?: React.ReactNode
  /** Overrides the primary gradient. Ignored by the secondary variant. */
  gradient?: readonly [string, string]
  /** Required for icon-only buttons so they stay accessible. */
  accessibilityLabel?: string
  // Keeps the label on one line, shrinking it to fit, for a button too narrow to wrap it between
  // words, where the platform would otherwise break the word itself ("Envi / ar").
  singleLine?: boolean
}

// The design system bans ActivityIndicator, and a skeleton is for content rather than an action.
// The classic Animated API keeps this render-safe in jest without pulling in worklets. It keeps
// turning with reduced motion, since it is a progress indicator and a still ring reads as stuck.
export function Spinner({ head, track }: { head: string; track: string }): React.JSX.Element {
  const rot = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const anim = Animated.loop(
      Animated.timing(rot, {
        toValue: 1,
        // A loop period rather than a transition, because the number is how long one turn takes, so
        // it belongs to the spinner rather than to the motion scale.
        duration: 650,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    )
    anim.start()
    return () => anim.stop()
  }, [rot])
  const spin = rot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
  return (
    <Animated.View style={[styles.spinner, { transform: [{ rotate: spin }] }]}>
      <View style={StyleSheet.absoluteFill}>
        <Ring size={SPINNER_SIZE} width={SPINNER_WIDTH} color={track} />
      </View>
      <Ring size={SPINNER_SIZE} width={SPINNER_WIDTH} color={head} arc={SPINNER_HEAD} />
    </Animated.View>
  )
}

// iOS reads accessibilityElementsHidden and Android importantForAccessibility; each ignores the other.
const concealedProps = {
  pointerEvents: 'none',
  focusable: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const

// The gradient is an absolute background, never a container. LinearGradient does not measure its
// children on the New Architecture, so wrapping collapses the height and hides the label.
export function GradientButton({
  label,
  onPress,
  disabled = false,
  loading = false,
  variant = 'primary',
  icon,
  gradient,
  accessibilityLabel,
  singleLine = false,
}: Props): React.JSX.Element {
  const isSecondary = variant === 'secondary'
  const isDanger = variant === 'danger'
  const { accent, gradient: accentGradient } = useAccent()
  const reduced = useReduceMotion()
  const spinnerHead = isDanger ? colors.danger : isSecondary ? accent : colors.onPrimary
  // A filled CTA that cannot act yet is absent rather than faded. It keeps its box, so nothing on
  // the screen moves when it turns on, and it leaves touch, focus and screen readers. Loading keeps
  // it in sight at full strength, since the spinner is what says the action is under way, and a
  // faded spinner reads as a stuck one.
  const concealed = disabled && !loading && variant === 'primary'
  const faded = disabled && !loading

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: loading }}
      accessibilityLabel={accessibilityLabel ?? label}
      {...(concealed ? concealedProps : null)}
      style={({ pressed }) => [
        styles.body,
        isSecondary && styles.secondary,
        isDanger && styles.danger,
        // The shrink is movement and goes with reduced motion; the dim stays as the press feedback.
        pressed && (reduced ? styles.pressedReduced : styles.pressed),
        faded && styles.disabled,
        concealed && styles.concealed,
      ]}>
      {variant === 'primary' && (
        <LinearGradient
          colors={[...(gradient ?? accentGradient)]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      )}
      <View style={styles.content}>
        {loading ? <Spinner head={spinnerHead} track={colors.onPrimaryTrack} /> : icon}
        {label.length > 0 && (
          <Text
            numberOfLines={singleLine ? 1 : undefined}
            adjustsFontSizeToFit={singleLine}
            wholeWords={!singleLine}
            style={[
              leadingText(),
              styles.label,
              isSecondary && styles.secondaryLabel,
              isDanger && styles.dangerLabel,
            ]}>
            {label}
          </Text>
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  body: {
    paddingVertical: 14,
    minHeight: touch.min,
    paddingHorizontal: space.lg,
    // Apple HIG button radius. Cards stay at 16 so the hierarchy reads.
    borderRadius: radius.md,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  // Never wider than the button, so a label beside its icon shrinks or wraps inside it. Sized to its
  // content under the body's centring, the row would otherwise run past the button's edge and be cut.
  content: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  // One step above surfaceVariant, so the same button holds on a card, where surfaceVariant falls to
  // 1.15:1, as it does on the page and on a sheet.
  secondary: {
    backgroundColor: colors.surfaceRaised,
  },
  // The action that can cost what cannot come back: never the accent, which says go.
  danger: dangerSoftSurface,
  pressed: {
    opacity: press.scaled,
    transform: [{ scale: press.scale }],
  },
  pressedReduced: {
    opacity: press.scaled,
  },
  disabled: {
    opacity: alpha.disabled,
  },
  concealed: {
    opacity: alpha.concealed,
  },
  spinner: {
    width: SPINNER_SIZE,
    height: SPINNER_SIZE,
  },
  // Gives way beside the icon, so the label shrinks on one line or wraps between words inside the row.
  label: {
    flexShrink: 1,
    color: colors.onPrimary,
    textAlign: 'center',
    fontSize: font.size.base,
    ...font.family.semibold,
  },
  secondaryLabel: {
    color: colors.text,
  },
  dangerLabel: {
    color: colors.danger,
  },
})
