import React from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { TabIcon, type TabIconName } from './TabIcon'
import { Txt } from './Txt'
import { colors, space } from '../theme'

const EMPTY_ICON = 32

type Props = {
  // Says plainly what is not here, as one translated string in a single Text, with no second
  // paragraph.
  message: string
  // A mark above the message, for a state that is all a screen shows, where a lone grey line reads as
  // unfinished.
  icon?: TabIconName
  // The way out, when there is one. A list with nothing in it and no way to add anything is a wall.
  action?: React.ReactNode
  style?: StyleProp<ViewStyle>
}

// The message a list shows when it holds nothing. Every empty state draws muted text with the same air
// around it, which is the kind of decision that should be made once.
//
// It draws the same whether a screen passes it as a `ListEmptyComponent` or renders it from a
// conditional of its own, so an empty list drawn by a different branch than a full one still keeps
// its padding.
//
// Body size for all of them, since an empty state is the only thing on the screen when it shows.
export function EmptyState({ message, icon, action, style }: Props): React.JSX.Element {
  return (
    <View style={[styles.wrap, style]}>
      {icon && <TabIcon name={icon} color={colors.textSecondary} size={EMPTY_ICON} />}
      <Txt role="body" tone="muted" style={styles.text}>
        {message}
      </Txt>
      {action}
    </View>
  )
}

const styles = StyleSheet.create({
  // Centred with room above, because it appears where a list would be and needs to read as a state
  // rather than as a stray line at the top of the screen.
  wrap: {
    alignItems: 'center',
    gap: space.lg,
    paddingVertical: space.xxl,
    paddingHorizontal: space.xl,
  },
  text: { textAlign: 'center' },
})
