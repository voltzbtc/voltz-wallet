import React, { useState } from 'react'
import { I18nManager, StyleSheet, View } from 'react-native'
import { TabIcon } from './TabIcon'
import { Touch } from './Touch'
import { Row } from './Row'
import { Txt } from './Txt'
import { colors } from '../theme'

type Props = { label: string; children: React.ReactNode }

// Closed by default, so what only some readers need stays one tap away instead of in everyone's way.
// The state lives here, and a parent resets it by keying the fold to what it shows.
export function DetailsFold({ label, children }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <View>
      <Touch onPress={() => setOpen(now => !now)} feedback="row" state={{ expanded: open }}>
        <Row spread pad="default" gap="md" divider>
          <Txt role="body" tone="muted">
            {label}
          </Txt>
          <View style={open ? styles.pointUp : styles.pointDown}>
            <TabIcon name="chevron" color={colors.textSecondary} size={18} />
          </View>
        </Row>
      </Touch>
      {open ? children : null}
    </View>
  )
}

// The chevron mirrors under RTL, which flips the way a quarter turn points it.
const styles = StyleSheet.create({
  pointDown: { transform: [{ rotate: I18nManager.isRTL ? '-90deg' : '90deg' }] },
  pointUp: { transform: [{ rotate: I18nManager.isRTL ? '90deg' : '-90deg' }] },
})
