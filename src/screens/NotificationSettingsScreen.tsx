import React from 'react'
import { Linking, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { MenuRow } from '../components/MenuRow'
import { Screen } from '../components/Screen'
import { Txt } from '../components/Txt'
import { space } from '../theme'

// The OS owns notification permission, so the only control here is a shortcut to its settings.
export function NotificationSettingsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Screen layout="padded">
      <Txt role="caption" tone="muted" style={styles.intro}>
        {t('notifications.settingsIntro')}
      </Txt>
      <MenuRow
        bleed
        divider={false}
        icon="bell"
        label={t('notifications.openSystem')}
        // Settings that will not open leave the row for another try, and nothing else here could help.
        onPress={() => Linking.openSettings().catch(() => undefined)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  intro: {
    marginBottom: space.md,
  },
})
