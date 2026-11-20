import React from 'react'
import { I18nManager, Platform, StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { Text, useFontScale } from './Text'
import { Txt, roles, tones, type Role, type Tone } from './Txt'
import { useAccent } from '../wallet/dollarMode'
import { holdDirection } from '../i18n/direction'
import { font, space } from '../theme'

type Props = {
  // Already formatted, by whichever of the app's formatters knows this unit. This component lays a
  // value out; it does not decide how many decimal places a unit has, which is knowledge that lives
  // with the unit rather than with the layout.
  value: string
  // Required, and never defaulted, because there is no safe default. The SDK denominates a token in
  // its own base units and bitcoin in sats, and a token amount rendered as sats is the worst thing
  // this app can put on a screen: 10 USDB reading as "10 sats" is off by five orders of magnitude and
  // looks entirely plausible. A default here would be a guess about money.
  unit: string
  // The role for the number. The app writes this at five different sizes, from a list row at 16 to
  // the balance at 40, and the unit follows it down one step.
  role?: Extract<Role, 'display' | 'titleLarge' | 'title' | 'heading' | 'bodyBold' | 'labelStrong'>
  // The same value in the person's currency, shown under it. Already formatted, same reason as above.
  fiat?: string
  // Colours the figure. The review screens draw a white value with a grey unit and the balance
  // screens draw both in the wallet accent, so the unit takes the accent when there is one and steps
  // back when there is not, which is why it is derived here rather than being a second prop. An
  // accent figure is the whole of what it says; a neutral one is a number with a qualifier beside it.
  //
  // The currency line underneath is always muted, so it is not a choice.
  tone?: Extract<Tone, 'default' | 'accent'>
  style?: StyleProp<ViewStyle>
}

// A value and its unit. The unit is the reason this is a component rather than a text role: a screen
// that writes ` sats` as a bare string has to remember that a token payment is not in sats, and one
// read without checking its tag shows 10 USDB as "10 sats".
//
// The unit steps down with the number. A 40pt value takes a 24pt unit (`titleStrong`, not `heading`,
// whose 20 reads as a different line), and the 28pt asset balance takes a 20pt one.
const UNIT_ROLE: Record<NonNullable<Props['role']>, Role> = {
  display: 'titleStrong',
  titleLarge: 'heading',
  title: 'bodyBold',
  heading: 'bodyBold',
  bodyBold: 'label',
  labelStrong: 'micro',
}

// The fiat line scales too. Fixed at one size it would be larger than the value itself on a list row.
//
// On the hero sizes the currency line is `subheading`, 18pt semibold. The lg size already carries two
// roles, at 600 and 700, and a third at 500 for one secondary line would spend a name on a hundred of
// weight.
const FIAT_ROLE: Record<NonNullable<Props['role']>, Role> = {
  display: 'subheading',
  titleLarge: 'subheading',
  title: 'label',
  heading: 'label',
  bodyBold: 'caption',
  labelStrong: 'micro',
}

// A money figure on its own line of type: one line at every text size, shrunk to fit its box, since
// a figure broken across lines reads as two numbers and a cut one misreads money. The floor is the
// platform's own 4pt. The New Architecture parses `minimumFontScale`, but its text layout on both
// platforms reads only an absolute minimum, which the Text view config does not pass through.
//
// The figure gives way inside a row (`flexShrink` 1, `minWidth` 0). React Native's default
// `flexShrink` is 0, so a figure beside a label that keeps its width would be laid out at its full
// width past the row's edge and cut there, with nothing left to shrink. Every box between a figure and
// its row gives way too, for the same reason.
//
// iOS decides the fit by comparing the used text rect with the frame, in height as well as in width,
// and a fixed line height keeps that rect the same at any font size (NSTextStorage+FontScaling.m). A
// frame that rounding leaves a hair under its own line therefore never fits, and the type falls to
// the floor on a line with room to spare, depending only on where the line lands on the pixel grid.
// So the line sits LINE_SLACK under the box the paragraph holds, which keeps the box's height.
type FigureProps = Omit<React.ComponentProps<typeof Txt>, 'lines' | 'adjustsFontSizeToFit'>

const LINE_SLACK = 0.5

// Every string in the figure, the runs of a mixed paragraph included, since the bidi algorithm reads
// the paragraph whole.
function heldRuns(node: React.ReactNode): React.ReactNode {
  if (typeof node === 'string') {
    return holdDirection(node)
  }
  if (Array.isArray(node)) {
    return React.Children.map(node, heldRuns)
  }
  return React.isValidElement<{ children?: React.ReactNode }>(node) && node.props.children != null
    ? React.cloneElement(node, undefined, heldRuns(node.props.children))
    : node
}

function lineWithSlack(line: number, scale: number): TextStyle {
  return { lineHeight: line - LINE_SLACK, minHeight: line * scale }
}

export function Figure({ style, children, ...rest }: FigureProps): React.JSX.Element {
  const fontScale = useFontScale()
  const { role = 'body', maxFontSizeMultiplier } = rest
  const line = StyleSheet.flatten<TextStyle>([roles[role], style]).lineHeight
  const scale = maxFontSizeMultiplier ? Math.min(fontScale, maxFontSizeMultiplier) : fontScale
  const slack = Platform.OS === 'ios' && line != null && lineWithSlack(line, scale)
  return (
    <Txt {...rest} lines={1} adjustsFontSizeToFit style={[styles.figure, style, slack]}>
      {I18nManager.isRTL ? heldRuns(children) : children}
    </Txt>
  )
}

export function Amount({
  value,
  unit,
  role = 'bodyBold',
  fiat,
  tone = 'default',
  style,
}: Props): React.JSX.Element {
  const { accent } = useAccent()
  const accented = tone === 'accent' && { color: accent }
  return (
    <View style={[styles.wrap, style]}>
      {/* One paragraph, so the value and its unit share a baseline, can never wrap apart, and
          shrink together. The space between them is at the unit's size, as the gap was. The runs
          inside are plain Text, since an alignment belongs to the paragraph. */}
      <Figure role={UNIT_ROLE[role]} style={role === 'display' && styles.displayLine}>
        <Text style={[roles[role], tones.default, accented]}>{value}</Text>
        {'\u00A0'}
        <Text style={[roles[UNIT_ROLE[role]], tones.muted, accented]}>{unit}</Text>
      </Figure>
      {fiat != null && (
        <Figure role={FIAT_ROLE[role]} tone="muted">
          {fiat}
        </Figure>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  // The hero's fiat line sits `space.sm` under its number, from the scale like every other gap. The
  // block gives way in a row like the figures inside it.
  wrap: { gap: space.sm, flexShrink: 1, minWidth: 0 },
  figure: { flexShrink: 1, minWidth: 0 },
  // The line every other 40pt figure on Home sits on. Left to the engine, a mixed paragraph comes out
  // taller on Android, whose line carries the font's padding, and the page moves with each unit.
  displayLine: { lineHeight: font.leading.display },
})
