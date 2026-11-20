import React from 'react'
import { StyleSheet, type StyleProp, type TextStyle } from 'react-native'
import { Text } from './Text'
import { useAccent } from '../wallet/dollarMode'
import { leadingText } from '../i18n/direction'
import { colors, font, tracking } from '../theme'

// Typography, without colour. Indexing styles by size, weight and colour together multiplies the
// names with every new colour, so size and weight live in roles, colour lives in tones, and any role
// combines with any tone. `caption` in the accent colour needs no name of its own.
//
// Leading comes with the size and is never chosen beside it, so one size never sits on two different
// line heights.
export type Role =
  | 'display'
  | 'titleLarge'
  | 'title'
  | 'titleStrong'
  | 'heading'
  | 'subheading'
  | 'subheadingBold'
  | 'body'
  | 'bodyStrong'
  | 'bodyBold'
  | 'label'
  | 'labelStrong'
  | 'caption'
  | 'micro'
  | 'microCaps'
  | 'section'

// Colour, without typography. `accent` follows the wallet, so the dollar wallet recolours it along
// with the rest of the chrome, and it is a tone rather than a role because the app draws accent text
// at several sizes: as a role it could only ever be one of them.
export type Tone = 'default' | 'muted' | 'accent' | 'danger' | 'success' | 'inherit'

type Props = {
  children: React.ReactNode
  role?: Role
  tone?: Tone
  // Digits of even width, so a number does not jump sideways as it changes. Every figure of money
  // wants it; forgetting it makes a balance dance while it updates.
  tabular?: boolean
  // One prop instead of remembering `numberOfLines`. It is deliberately not defaulted per role,
  // because truncating by default hides content nobody chose to hide. The screens that need it are
  // the ones drawing something a person typed or a server sent.
  lines?: number
  style?: StyleProp<TextStyle>
  // `role` is omitted from the passthrough too: Text carries an ARIA `role` of its own, and
  // intersecting the two would narrow this one to the single value both unions share.
} & Omit<React.ComponentProps<typeof Text>, 'style' | 'children' | 'numberOfLines' | 'role'>

export function Txt({
  children,
  role = 'body',
  tone = 'default',
  tabular = false,
  lines,
  style,
  ...rest
}: Props): React.JSX.Element {
  return tone === 'accent' ? (
    <Accented role={role} tabular={tabular} lines={lines} style={style} {...rest}>
      {children}
    </Accented>
  ) : (
    <Text
      style={[roles[role], tones[tone], leadingText(), tabular && styles.tabular, style]}
      numberOfLines={lines}
      {...rest}>
      {children}
    </Text>
  )
}

// Its own component so the hook runs only for the tone that needs it. Called from the main body it
// would run for every piece of text in the app, and switching to the dollar wallet would redraw the
// whole tree rather than the parts that actually change colour.
function Accented({
  children,
  role = 'body',
  tabular,
  lines,
  style,
  ...rest
}: Omit<Props, 'tone'>): React.JSX.Element {
  const { accent } = useAccent()
  return (
    <Text
      style={[roles[role], { color: accent }, leadingText(), tabular && styles.tabular, style]}
      numberOfLines={lines}
      {...rest}>
      {children}
    </Text>
  )
}

// Size, weight and leading. No colour anywhere in this table, which is the point of the split.
export const roles = StyleSheet.create({
  // The balance, and nothing else. Above Apple's 34pt Large Title on purpose.
  display: { fontSize: font.size.display, ...font.family.bold },
  // The xxxl step, which the asset balance draws. Every step of `font.size` from xs to display has a
  // role, so no screen has to round its size to the nearest one that does.
  titleLarge: { fontSize: font.size.xxxl, ...font.family.bold },
  title: { fontSize: font.size.xxl, ...font.family.bold },
  titleStrong: { fontSize: font.size.xxl, ...font.family.semibold },
  heading: { fontSize: font.size.xl, ...font.family.semibold },
  subheading: { fontSize: font.size.lg, ...font.family.semibold },
  subheadingBold: { fontSize: font.size.lg, ...font.family.bold },
  body: { fontSize: font.size.base, lineHeight: font.leading.base, ...font.family.regular },
  bodyStrong: { fontSize: font.size.base, lineHeight: font.leading.base, ...font.family.medium },
  bodyBold: { fontSize: font.size.base, lineHeight: font.leading.base, ...font.family.semibold },
  label: { fontSize: font.size.sm, lineHeight: font.leading.sm, ...font.family.medium },
  labelStrong: { fontSize: font.size.sm, lineHeight: font.leading.sm, ...font.family.semibold },
  caption: { fontSize: font.size.sm, lineHeight: font.leading.sm, ...font.family.regular },
  micro: { fontSize: font.size.xs, lineHeight: font.leading.xs, ...font.family.regular },
  microCaps: {
    fontSize: font.size.xs,
    lineHeight: font.leading.xs,
    ...font.family.medium,
    textTransform: 'uppercase',
    letterSpacing: tracking.caps,
  },
  // Uppercase section heading. `textTransform` and `letterSpacing` travel together as one pattern,
  // so they are a role rather than a pair each screen writes out. 14pt medium at tracking 1 is the one
  // section heading form; `microCaps` is the uppercase unit or chip inside a control.
  section: {
    fontSize: font.size.sm,
    lineHeight: font.leading.sm,
    ...font.family.medium,
    textTransform: 'uppercase',
    letterSpacing: tracking.heading,
  },
})

// Colour, and nothing else.
export const tones = StyleSheet.create({
  default: { color: colors.text },
  muted: { color: colors.textSecondary },
  danger: { color: colors.danger },
  success: { color: colors.success },
  // The resting value only. Overwritten at render with whatever the wallet's accent is now.
  accent: { color: colors.primary },
  // Takes its colour from whatever contains it, for text drawn inside something already coloured.
  inherit: {},
})

const styles = StyleSheet.create({
  tabular: { fontVariant: ['tabular-nums'] },
})
