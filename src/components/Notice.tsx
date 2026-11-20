import React from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { colors, dangerSoftSurface, primarySoftSurface, space } from '../theme'
import { Card } from './Card'
import { TabIcon } from './TabIcon'

type Props = {
  children: React.ReactNode
  // `warning` keeps the Bitcoin orange in dollar mode, as primarySoftSurface says. `danger` is for an
  // alarm no later warning can escalate to, and for nothing softer.
  tone?: 'warning' | 'danger'
  style?: StyleProp<ViewStyle>
}

// A warning or an alarm: a filled card with its icon ahead of the text. The icon is what stops colour
// being the only sign of the state, for a person who cannot tell the fill from a plain card.
export function Notice({ children, tone = 'warning', style }: Props): React.JSX.Element {
  const danger = tone === 'danger'
  return (
    <Card style={[danger ? dangerSoftSurface : primarySoftSurface, style]}>
      <View style={styles.row}>
        <TabIcon name="alert" color={danger ? colors.danger : colors.primary} size={20} strokeWidth={2.5} />
        <View style={styles.body}>{children}</View>
      </View>
    </Card>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm },
  // Takes what the icon leaves, so a long warning wraps beside the icon rather than past the card.
  body: { flex: 1, gap: space.sm },
})
