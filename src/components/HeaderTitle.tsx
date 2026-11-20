import React from 'react'
import { StyleSheet, useWindowDimensions } from 'react-native'
import { Txt } from './Txt'
import { space, touch } from '../theme'

// A pushed screen's title, drawn by the app's own text so it follows the system text size: the native
// title kept the box it was laid out in, and at Android's 1.3 its glyphs grew inside it and were cut.
// One line that shrinks to the room between the back control and an action on the other side,
// rather than wrapping under the header or cutting a word.
export function HeaderTitle({ children }: { children: string }): React.JSX.Element {
  const { width } = useWindowDimensions()
  return (
    <Txt
      role="subheading"
      lines={1}
      adjustsFontSizeToFit
      wholeWords
      accessibilityRole="header"
      style={[styles.title, { maxWidth: width - 2 * (touch.min + space.lg) }]}>
      {children}
    </Txt>
  )
}

// The header centres the title on iOS and leads with it on Android, so it carries no alignment.
const styles = StyleSheet.create({
  title: { flexShrink: 1 },
})
