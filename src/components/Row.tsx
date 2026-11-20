import React from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { dividerBottom, space } from '../theme'

// Vertical padding. `none` is the default because most rows in the app set none, and a fixed default
// would silently add space above and below every one of them.
type Pad = 'none' | 'tight' | 'default' | 'loose'

type Props = {
  children: React.ReactNode
  pad?: Pad
  // Pushes the first and last child apart, for a label on one side and a value on the other. A row
  // without it lets a `flex: 1` child take the slack.
  spread?: boolean
  // The hairline between lines of a list, always in the same colour. It is a hairline rather than a
  // 1pt border, because on a 3x screen that is one physical pixel against three.
  //
  // Pass nothing on the last row of a group, so the line does not dangle over empty space.
  divider?: boolean
  gap?: keyof typeof GAPS
  style?: StyleProp<ViewStyle>
}

// `none` exists because without it a row with an icon touching its label could not be expressed. The
// default is `sm` because it is the most common gap between the parts of a row.
const GAPS = {
  none: undefined,
  xs: space.xs,
  sm: space.sm,
  md: space.md,
  lg: space.lg,
} as const

// A line of content, laid across. Only two properties make a row a row, laid across and centred on
// the cross axis, and everything else here is a prop because rows disagree about all of it.
//
// The direction is physical rather than logical on purpose. React Native mirrors `flexDirection:
// 'row'` under RTL by itself, and the header, the tab bar and the drawer all rely on that.
export function Row({
  children,
  pad = 'none',
  spread = false,
  divider = false,
  gap = 'sm',
  style,
}: Props): React.JSX.Element {
  return (
    <View
      style={[
        styles.row,
        PAD[pad],
        GAPS[gap] != null && { gap: GAPS[gap] },
        spread && styles.spread,
        divider && styles.divider,
        style,
      ]}>
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  spread: { justifyContent: 'space-between' },
  divider: {
    ...dividerBottom,
  },
  padNone: {},
  padTight: { paddingVertical: space.sm },
  padDefault: { paddingVertical: space.md },
  padLoose: { paddingVertical: space.lg },
})

const PAD: Record<Pad, ViewStyle> = {
  none: styles.padNone,
  tight: styles.padTight,
  default: styles.padDefault,
  loose: styles.padLoose,
}
