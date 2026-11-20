import React from 'react'
import { Linking, StyleSheet, type StyleProp, type TextStyle } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Text } from './Text'
import { Txt } from './Txt'
import { legalRuns, sitePageUrl, type SitePage } from '../i18n/legalLinks'
import { colors } from '../theme'

type Props = {
  style?: StyleProp<TextStyle>
}

// The line under the welcome's actions that says continuing accepts the terms, with each page's name
// a link to it in the app's language. The links are runs of the sentence rather than buttons, so
// they wrap with it in every language; an inline link is the one target sized by its line of text
// rather than by the 44pt floor (WCAG 2.5.8 exempts a target inside a sentence).
export function TermsAcceptance({ style }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const open = (page: SitePage) => () => Linking.openURL(sitePageUrl(page, language))

  return (
    <Txt role="caption" tone="muted" style={[styles.line, style]}>
      {legalRuns(t('welcome.terms')).map((run, i) =>
        run.page ? (
          <Text key={i} accessibilityRole="link" onPress={open(run.page)} style={styles.link}>
            {run.text}
          </Text>
        ) : (
          run.text
        ),
      )}
    </Txt>
  )
}

// Underlined as well as brighter, so the links do not rest on colour alone.
const styles = StyleSheet.create({
  line: { textAlign: 'center' },
  link: { color: colors.text, textDecorationLine: 'underline' },
})
