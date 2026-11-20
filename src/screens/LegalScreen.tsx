import React from 'react'
import { Linking, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { MenuRow } from '../components/MenuRow'
import { Screen } from '../components/Screen'
import { sitePageUrl } from '../i18n/legalLinks'
import { rhythm, space } from '../theme'

// Legal text is hosted, not bundled, so it can change without an app release. Each page opens in the
// app's language, the same pages the welcome's acceptance line links to.
export function LegalScreen(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language

  return (
    <Screen layout="padded" contentStyle={styles.container}>
      <MenuRow
        bleed
        icon="document"
        label={t('legal.terms')}
        onPress={() => Linking.openURL(sitePageUrl('terms', language))}
      />
      <MenuRow
        bleed
        divider={false}
        icon="document"
        label={t('legal.privacy')}
        onPress={() => Linking.openURL(sitePageUrl('privacy', language))}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  // A row's own 16 of padding makes up the 24 under the header.
  container: {
    paddingTop: rhythm.headerToContent - space.lg,
  },
})
