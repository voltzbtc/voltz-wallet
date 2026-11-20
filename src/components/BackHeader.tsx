import React, { useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { alpha, colors, space, touch } from '../theme'
import { TabIcon } from './TabIcon'
import { Touch } from './Touch'

// The mark the native header draws on each platform, so a step drawn outside the navigator goes back
// with the same one as every other screen. Both mirror under RTL by themselves.
function backIcon(): 'arrow-left' | 'chevron-left' {
  return Platform.OS === 'android' ? 'arrow-left' : 'chevron-left'
}

// The back control of a step drawn outside the navigator, shared by every such step.
export function BackButton({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Touch onPress={onBack} feedback="link" label={t('common.back')} hitSlop={space.md} style={styles.back}>
      <TabIcon name={backIcon()} color={colors.text} size={22} />
    </Touch>
  )
}

// The chevron's place in a header. A step that opened with a Back and loses it, as one does when a
// first write starts, keeps a concealed chevron of the same size there, so the title beside it does
// not jump sideways; a step drawn without one, inside the navigator, leaves no gap. Decided at mount.
// The concealed chevron does nothing, so screen readers never reach it.
export function BackSlot({ onBack }: { onBack?: () => void }): React.JSX.Element | null {
  const [held] = useState(onBack !== undefined)
  if (onBack) {
    return <BackButton onBack={onBack} />
  }
  if (!held) {
    return null
  }
  return (
    <View
      testID="back-slot"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.back, styles.slot]}>
      <TabIcon name={backIcon()} color={colors.text} size={22} />
    </View>
  )
}

const styles = StyleSheet.create({
  back: {
    marginLeft: -space.xs,
  },
  // The box Touch gives the live chevron, so the title stays where it was.
  slot: {
    minHeight: touch.min,
    minWidth: touch.min,
    justifyContent: 'center',
    opacity: alpha.concealed,
  },
})
