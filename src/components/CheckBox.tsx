import React from 'react'
import { StyleSheet, View } from 'react-native'
import { useAccent } from '../wallet/dollarMode'
import { colors, radius, space } from '../theme'
import { TabIcon } from './TabIcon'

// The mark of a checkbox, which sits inside a Touch that carries the role and the state. Off is a
// fill, on is the accent fill with a check, so the state is never only a colour.
export function CheckBox({ on }: { on: boolean }): React.JSX.Element {
  const { accent } = useAccent()
  return (
    <View style={[styles.box, on && { backgroundColor: accent }]}>
      {on && <TabIcon name="check" color={colors.onPrimary} size={14} />}
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    width: space.xl,
    height: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
})
