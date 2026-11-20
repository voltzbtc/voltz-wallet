import React from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { Txt, type Role, type Tone } from './Txt'
import { useSideBySide } from '../hooks/useSideBySide'
import { space } from '../theme'

type Percent = `${number}%`

type Props = {
  // What the figure is. A string is drawn whole-word in `labelRole`; a node (a name beside its icon,
  // two lines of labels, a selector) is laid out in the label's box as given.
  label: React.ReactNode
  labelRole?: Role
  labelTone?: Tone
  // The figure side holds a Figure, an Amount, or a column of them, or a value that is not money but sits
  // in the same list of rows.
  children: React.ReactNode
  // The most of the row the figure side takes beside the label. Past it the figure shrinks its type.
  cap?: Percent
  // The figure leads and the label follows, as a price and its change.
  figureFirst?: boolean
  align?: 'center' | 'baseline' | 'flex-start'
  // The row sits in a box that sizes itself to its content (the incoming banner's pill): neither the
  // row nor the label grows into free space, so the box stays as wide as what it says. Both still
  // shrink when the box meets the screen's edge.
  hug?: boolean
  style?: StyleProp<ViewStyle>
}

// A label and a money figure on one row, laid out by one rule so neither can take the row from the
// other. React Native's default flexShrink is 0, so a label that keeps its width beside a figure that
// gives way squeezes the figure to a few points at the largest text sizes, and the reverse drops the
// label.
//
// Below the width that fits both (useSideBySide) the figure goes under the label, and each has the
// row to itself. Side by side the figure side keeps its own width up to `cap` and never shrinks, while
// the label grows into the rest and wraps there. Inside a box that sizes itself to its content, growing
// would stretch the box to the whole width it may take, so such a row passes `hug`.
export function FigureRow({
  label,
  labelRole = 'body',
  labelTone = 'muted',
  children,
  cap = '60%',
  figureFirst = false,
  align = 'center',
  hug = false,
  style,
}: Props): React.JSX.Element {
  const sideBySide = useSideBySide()
  const labelBox = (
    <View
      style={sideBySide ? [styles.labelSide, hug && styles.noGrow, figureFirst && styles.atEnd] : styles.labelStacked}>
      {typeof label === 'string' ? (
        <Txt role={labelRole} tone={labelTone} wholeWords>
          {label}
        </Txt>
      ) : (
        label
      )}
    </View>
  )
  const figureBox = (
    <View
      style={
        sideBySide
          ? [styles.figureSide, !figureFirst && styles.atEnd, { maxWidth: cap }]
          : styles.figureStacked
      }>
      {children}
    </View>
  )
  return (
    <View style={[sideBySide ? [styles.row, { alignItems: align }] : styles.stacked, hug && styles.noGrow, style]}>
      {figureFirst ? figureBox : labelBox}
      {figureFirst ? labelBox : figureBox}
    </View>
  )
}

const styles = StyleSheet.create({
  // Gives way in a row of its own, beside an icon or a badge, like the figures inside it.
  row: { flexDirection: 'row', gap: space.md, flexGrow: 1, flexShrink: 1, minWidth: 0 },
  stacked: { flexDirection: 'column', gap: space.xs, flexGrow: 1, flexShrink: 1, minWidth: 0 },
  labelSide: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  labelStacked: { alignSelf: 'stretch' },
  figureSide: { flexShrink: 0, minWidth: 0 },
  figureStacked: { alignSelf: 'flex-start', alignItems: 'flex-start', maxWidth: '100%' },
  atEnd: { alignItems: 'flex-end' },
  noGrow: { flexGrow: 0 },
})
