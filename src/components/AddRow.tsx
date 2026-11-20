import React from 'react'
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import { Touch } from './Touch'
import { Txt } from './Txt'
import { TabIcon } from './TabIcon'
import { useAccent } from '../wallet/dollarMode'
import { space } from '../theme'

type Props = {
  label: string
  onPress: () => void
  // Where the row sits under its list, which belongs to the screen.
  style?: StyleProp<ViewStyle>
}

// The row that adds one more under a list, such as Home's assets and the wallets: the plus mark in the
// accent beside its label, laid across from the left edge rather than from the card's inset. The
// label carries no "+", since the mark draws it.
export function AddRow({ label, onPress, style }: Props): React.JSX.Element {
  const { accent } = useAccent()
  return (
    <Touch onPress={onPress} feedback="link" hitSlop={space.sm} style={[styles.row, style]}>
      <TabIcon name="plus" color={accent} size={18} strokeWidth={2.5} />
      <Txt role="bodyBold" tone="accent">
        {label}
      </Txt>
    </Touch>
  )
}

const styles = StyleSheet.create({
  // Laid across by the style, since a Touch is a column that centres its content.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.xs,
  },
})
