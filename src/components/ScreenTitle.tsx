import React from 'react'
import { StyleSheet, View } from 'react-native'
import { rhythm } from '../theme'
import { BackSlot } from './BackHeader'
import { Row } from './Row'
import { Txt } from './Txt'

type Props = {
  // Absent on a step whose header already carries the title, so the two never stack and the subtitle
  // keeps its place.
  title?: string
  subtitle?: string
  // Absent, the title stands alone: inside a navigator its header already goes back, and a step
  // with nowhere safe to go back to shows no chevron rather than one that does nothing.
  onBack?: () => void
  // For a screen laid out in the centre, whose title opens a group that ends in its action.
  centered?: boolean
}

// What a screen opens with when the title is its own: the chevron, the title and the subtitle under
// it. It owns the space inside and below, from `rhythm`, and takes no style, so a screen cannot choose
// its own distance from its title to what follows.
export function ScreenTitle({ title, subtitle, onBack, centered = false }: Props): React.JSX.Element {
  const align = centered ? styles.centeredText : undefined
  return (
    <View style={[styles.group, centered && styles.centered]}>
      {title !== undefined && (
        <Row gap="sm">
          <BackSlot onBack={onBack} />
          <Txt role="title" accessibilityRole="header" style={[styles.title, align]}>
            {title}
          </Txt>
        </Row>
      )}
      {subtitle !== undefined && (
        <Txt role="body" tone="muted" style={align}>
          {subtitle}
        </Txt>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  group: {
    gap: rhythm.titleToSubtitle,
    marginBottom: rhythm.titleToContent,
  },
  centered: {
    alignItems: 'center',
    marginBottom: rhythm.groupToAction,
  },
  centeredText: { textAlign: 'center' },
  // Wraps beside the chevron instead of pushing past the screen edge in the longer languages.
  title: {
    flexShrink: 1,
  },
})
