import React from 'react'
import { StyleSheet, View, type ViewStyle } from 'react-native'
import { colors, radius, space } from '../theme'

type Props = {
  children: React.ReactNode
  style?: ViewStyle
}

// A card is a solid surface on every platform, the same fill as Card: Liquid Glass refracts nearby
// coloured content into the top of a card, so no card takes the material, and with no outline two
// card fills on one screen would be all that told them apart.
export function GlassCard({ children, style }: Props): React.JSX.Element {
  return <View style={[styles.card, style]}>{children}</View>
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    overflow: 'hidden',
    // The one card padding, Card's own, so text in two cards on a screen starts on the same line.
    padding: space.lg,
    backgroundColor: colors.surface,
  },
})
