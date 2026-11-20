import React from 'react'
import { StyleSheet, View } from 'react-native'
import { TabIcon } from './TabIcon'
import type { HistoryDirection } from '../wallet/payment'
import { colors, radius } from '../theme'

type Props = {
  direction: HistoryDirection
  /** Badge diameter. The arrow scales with it. */
  size?: number
}

// Only received is green, since it is the one thing worth spotting while scrolling. A conversion
// stays muted and carries the swap arrows so it never passes for money arriving.
export function DirectionBadge({ direction, size = 40 }: Props): React.JSX.Element {
  const received = direction === 'received'
  const converted = direction === 'converted'
  return (
    <View style={[styles.badge, { width: size, height: size }]}>
      <TabIcon
        name={converted ? 'convert' : received ? 'receive' : 'send'}
        color={received ? colors.success : colors.textSecondary}
        size={Math.round(size * 0.5)}
        strokeWidth={3}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: radius.full,
    borderCurve: 'continuous',
    backgroundColor: colors.surfaceVariant,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
