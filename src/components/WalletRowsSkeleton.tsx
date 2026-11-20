import React from 'react'
import { StyleSheet, View } from 'react-native'
import { Skeleton } from './Skeleton'
import { CARD_HEIGHT } from './WalletList'
import { colors, font, radius, space } from '../theme'

// The design system bans ActivityIndicator, so even these short waits use a skeleton.
export function WalletRowsSkeleton({ count = 3 }: { count?: number }): React.JSX.Element {
  return (
    <View style={styles.wrap}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.row}>
          <Skeleton width={44} height={44} borderRadius={radius.full} />
          <View style={styles.info}>
            <Skeleton width="55%" height={font.leading.base} />
            <Skeleton width="35%" height={font.leading.sm} />
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.background,
    padding: space.xl,
    gap: space.sm, // matches the card-to-card pitch of the real list
  },
  row: {
    height: CARD_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  info: {
    flex: 1,
    gap: space.xs,
  },
})
