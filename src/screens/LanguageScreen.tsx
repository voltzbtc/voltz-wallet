import React, { useMemo, useRef, useState } from 'react'
import { FlatList, I18nManager, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import { EmptyState } from '../components/EmptyState'
import { MenuRow } from '../components/MenuRow'
import { SearchField } from '../components/SearchField'
import { TabIcon } from '../components/TabIcon'
import { Flag } from '../components/Flag'
import { PickerSkeleton } from '../components/PickerSkeleton'
import { saveDisplayLanguage } from '../wallet/settings'
import { isRTL, languageMatches, LANGUAGES } from '../i18n/languages'
import { settleDirection } from '../i18n/directionRestart'
import { pinBundleLanguage } from '../i18n/bundleLanguage'
import { useAccent } from '../wallet/dollarMode'
import { useTransitionDone } from '../hooks/useTransitionDone'
import { space } from '../theme'
import { Screen } from '../components/Screen'

export function LanguageScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const [current, setCurrent] = useState(i18n.language)
  const [query, setQuery] = useState('')
  const { accent } = useAccent()
  const insets = useSafeAreaInsets()
  // Held from a tap that needs a restart until the restart starts, which ends this screen. A second
  // tap meanwhile would save a language the restarting runtime was not started for.
  const restarting = useRef(false)

  // Sorting by endonym also keeps each base language just before its regional variants.
  const sorted = useMemo(() => [...LANGUAGES].sort((a, b) => a.label.localeCompare(b.label)), [])
  const languages = useMemo(() => sorted.filter(l => languageMatches(l, query)), [sorted, query])
  const transitionDone = useTransitionDone()

  return (
    // Gives way to the keyboard, so while searching the list ends above it and its last rows stay
    // reachable.
    <Screen keyboard contentStyle={styles.container}>
      <SearchField value={query} onChangeText={setQuery} label={t('settings.languageSearch')} />
      {!transitionDone ? (
        <PickerSkeleton />
      ) : (
        <FlatList
          data={languages}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<EmptyState message={t('settings.languageNoResult')} />}
          keyExtractor={l => l.code}
          // Every row renders an SVG flag, and mounting them all at once blocks the transition.
          initialNumToRender={9}
          maxToRenderPerBatch={9}
          windowSize={5}
          removeClippedSubviews
          contentContainerStyle={{
            paddingHorizontal: space.xl,
            paddingBottom: space.xl + insets.bottom,
          }}
          renderItem={({ item, index }) => (
            <MenuRow
              bleed
              divider={index < languages.length - 1}
              selected={current === item.code}
              leading={<Flag country={item.country} />}
              label={item.label}
              onPress={async () => {
                if (restarting.current) {
                  return
                }
                pinBundleLanguage(item.code)
                // The direction is read once per JS runtime, so a language that changes it restarts
                // the app, which boots in the language saved here.
                if (isRTL(item.code) !== I18nManager.isRTL) {
                  restarting.current = true
                  const outcome = await saveDisplayLanguage(item.code)
                    .then(() => settleDirection(item.code))
                    .catch(() => 'settled' as const)
                  if (outcome === 'restarting') {
                    return
                  }
                  // No restart came, because a write failed or a restart for this direction already
                  // did not take, so the words change in place and the layout waits for a cold start.
                  restarting.current = false
                }
                i18n.changeLanguage(item.code)
                // A refused write leaves the last saved language in place for the next launch.
                saveDisplayLanguage(item.code).catch(() => undefined)
                setCurrent(item.code)
              }}
              right={
                current === item.code ? <TabIcon name="check" color={accent} size={20} /> : null
              }
            />
          )}
        />
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  // Horizontal padding sits on the list content, so a row's highlight reaches the screen edges. The
  // bottom inset does too, so the list scrolls to the screen's edge rather than stopping short of it.
  container: {
    paddingTop: space.xl,
    paddingBottom: 0,
  },
})
