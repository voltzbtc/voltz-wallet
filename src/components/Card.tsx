import React from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { colors, radius, space } from '../theme'

// How much air the card puts around what it holds.
//
//   `default`  16 on every side
//   `roomy`    24
//   `inset`    horizontal only, for a card holding rows that bring their own vertical rhythm
//   `none`     nothing at all, for a card that is purely a surface, such as the history list, where
//              every row draws its own everything
//
// The last two are the point. A card with no vertical padding holding rows with their own is the most
// common arrangement in the app, and it needs both halves: the card letting go of its padding and the
// row letting go of its own.
type Padding = 'none' | 'inset' | 'default' | 'roomy'

type Props = {
  children: React.ReactNode
  padding?: Padding
  // For a card that centres what it holds, such as a QR code, an icon or a single message.
  centered?: boolean
  gap?: keyof typeof GAPS
  style?: StyleProp<ViewStyle>
}

const GAPS = {
  none: undefined,
  sm: space.sm,
  md: space.md,
  lg: space.lg,
} as const

// The app's card. It separates by its fill and the space around it, with no outline in any state, and
// a warning or an alarm is a Notice. Fields and chips share its radius and curve but are not cards.
//
// `borderCurve: 'continuous'` is the line a hand-written card forgets, and it is why one looks subtly
// wrong beside a native surface: iOS draws a squircle and React Native defaults to a circular corner.
export function Card({
  children,
  padding = 'default',
  centered = false,
  gap = 'none',
  style,
}: Props): React.JSX.Element {
  return (
    <View
      style={[
        styles.card,
        PADDING[padding],
        centered && styles.centered,
        GAPS[gap] != null && { gap: GAPS[gap] },
        style,
      ]}>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  // Everything that makes a card a card, and nothing about how much room it leaves. The background
  // belongs here: without it a card is an invisible box, and a suite that only checks what the props
  // toggle never notices it is gone.
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
  centered: { alignItems: 'center', justifyContent: 'center' },
  paddingNone: {},
  paddingInset: { paddingHorizontal: space.lg },
  paddingDefault: { padding: space.lg },
  paddingRoomy: { padding: space.xl },
})

const PADDING: Record<Padding, ViewStyle> = {
  none: styles.paddingNone,
  inset: styles.paddingInset,
  default: styles.paddingDefault,
  roomy: styles.paddingRoomy,
}
