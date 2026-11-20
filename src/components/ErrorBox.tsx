import React from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useAnnounced } from '../hooks/useAnnounced'
import { colors, dangerSoftSurface, radius, space } from '../theme'
import { TabIcon } from './TabIcon'
import { Txt } from './Txt'

type Props = {
  message: string | null | undefined
  style?: StyleProp<ViewStyle>
}

// Renders nothing without a message, so call sites stay a one-liner. Owns only its inside; the
// screen passes the space around it, as for every primitive. The icon stands beside the fill so
// colour is never the only sign of the error. Red caption on this fill keeps its contrast on a page
// and on a sheet, not on a card, so a card holding an error sets it below the card. A screen reader
// hears the message as it appears, which the alert role alone does not do.
export function ErrorBox({ message, style }: Props): React.JSX.Element | null {
  useAnnounced(message)
  if (!message) {
    return null
  }
  return (
    <View style={[styles.box, style]} accessibilityRole="alert">
      <TabIcon name="alert" color={colors.danger} size={18} strokeWidth={2.5} />
      <Txt role="caption" tone="danger" style={styles.text}>
        {message}
      </Txt>
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    ...dangerSoftSurface,
    flexDirection: 'row',
    gap: space.sm,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    padding: space.md,
  },
  // Takes what the icon leaves, so a long message wraps beside it rather than past the box.
  text: {
    flex: 1,
  },
})
