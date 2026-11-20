import React, { useEffect, useMemo, useState } from 'react'
import { SectionList, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import { EmptyState } from '../components/EmptyState'
import { MenuRow } from '../components/MenuRow'
import { TabIcon } from '../components/TabIcon'
import { Flag } from '../components/Flag'
import { PickerSkeleton } from '../components/PickerSkeleton'
import { SectionLabel } from '../components/SectionLabel'
import { Skeleton } from '../components/Skeleton'
import { loadDisplayCurrency, saveDisplayCurrency } from '../wallet/settings'
import { configureFiatFormats, currencyCountry, type FiatCurrency } from '../wallet/fiat'
import { resolveDefaultFiat } from '../wallet/deviceLocale'
import { sparkListFiatCurrencies, type FiatCurrencyOption } from '../wallet/spark'
import { useAccent } from '../wallet/dollarMode'
import { useTransitionDone } from '../hooks/useTransitionDone'
import { font, rhythm, space } from '../theme'
import { Screen } from '../components/Screen'
import { SearchField } from '../components/SearchField'

// Used when the SDK fiat feed is unreachable, so the picker is never empty. USD and BRL are written
// with the symbol the language gives them (fiatSymbol) and never with the registry's, so the code
// stands in for the symbol the type asks for.
const FALLBACK: FiatCurrencyOption[] = [
  { id: 'USD', name: 'US Dollar', symbol: 'USD', fractionSize: 2 },
  { id: 'BRL', name: 'Brazilian Real', symbol: 'BRL', fractionSize: 2 },
]

// Ordered by crypto adoption rather than FX turnover, with USD first as the stablecoin reference.
const TOP_CURRENCIES = ['USD', 'INR', 'EUR', 'BRL', 'CNY', 'IDR', 'NGN', 'VND', 'TRY', 'RUB']

// Loading the list also configures the fiat formatter, so the pick renders with its own decimals.
export function CurrencyScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { accent } = useAccent()
  const insets = useSafeAreaInsets()
  const localeDefault: FiatCurrency = resolveDefaultFiat(i18n.language)
  const [current, setCurrent] = useState<FiatCurrency>(localeDefault)
  const [currencies, setCurrencies] = useState<FiatCurrencyOption[] | null>(null)
  const [query, setQuery] = useState('')
  const transitionDone = useTransitionDone()

  useEffect(() => {
    loadDisplayCurrency().then(saved => {
      if (saved) {
        setCurrent(saved)
      }
    })
  }, [])

  useEffect(() => {
    let alive = true
    sparkListFiatCurrencies()
      .then(list => {
        if (!alive) {
          return
        }
        const resolved = list.length > 0 ? list : FALLBACK
        configureFiatFormats(resolved, i18n.language)
        setCurrencies(resolved)
      })
      .catch(() => {
        if (alive) {
          configureFiatFormats(FALLBACK, i18n.language)
          setCurrencies(FALLBACK)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  // The feed's canonical name is unlocalized, so the code keeps the row unambiguous in any language.
  // There is no localized name to use instead: Hermes ships no Intl.DisplayNames on either platform.
  function labelFor(option: FiatCurrencyOption): string {
    return `${option.name} (${option.id})`
  }

  const sections = useMemo(() => {
    const list = currencies ?? []
    const q = query.trim().toLowerCase()
    if (q.length > 0) {
      const results = list.filter(
        c => c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
      )
      // No section at all for nothing found, since the list's empty state does not draw beside one.
      return results.length > 0 ? [{ title: '', data: results }] : []
    }
    const byId = new Map(list.map(c => [c.id, c]))
    const top = TOP_CURRENCIES.map(id => byId.get(id)).filter(
      (c): c is FiatCurrencyOption => c !== undefined,
    )
    const topIds = new Set(top.map(c => c.id))
    const rest = list.filter(c => !topIds.has(c.id))
    const out: { title: string; data: FiatCurrencyOption[] }[] = []
    if (top.length > 0) {
      out.push({ title: t('currency.sectionTop'), data: top })
    }
    out.push({ title: t('currency.sectionAll'), data: rest })
    return out
  }, [currencies, query, t])

  // The check moves once the choice is saved, since every figure reads the saved one. A refused write
  // leaves the last saved choice in place, and the check on it.
  function select(code: FiatCurrency) {
    saveDisplayCurrency(code).then(
      () => setCurrent(code),
      () => undefined,
    )
  }

  return (
    // Gives way to the keyboard, so while searching the list ends above it and its last rows stay
    // reachable.
    <Screen keyboard contentStyle={styles.container}>
      <SearchField value={query} onChangeText={setQuery} label={t('currency.search')} />

      {currencies === null || !transitionDone ? (
        <>
          <View style={styles.skeletonLabel}>
            <Skeleton width={110} height={font.leading.sm} />
          </View>
          <PickerSkeleton />
        </>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={c => c.id}
          keyboardShouldPersistTaps="handled"
          stickySectionHeadersEnabled={false}
          // Every row renders an SVG flag, and materializing the whole feed in one commit stalls the
          // picker.
          initialNumToRender={9}
          maxToRenderPerBatch={9}
          windowSize={5}
          removeClippedSubviews
          ListEmptyComponent={<EmptyState message={t('currency.noResult')} />}
          contentContainerStyle={{
            // A section label has no padding of its own, as the first row of a plain list has.
            paddingTop: space.lg,
            paddingHorizontal: space.xl,
            paddingBottom: space.xl + insets.bottom,
          }}
          // Air above every header but the first, so All reads as a new group rather than as the last
          // row of the top currencies.
          renderSectionHeader={({ section }) =>
            section.title ? (
              <SectionLabel style={[styles.sectionLabel, section !== sections[0] && styles.laterSection]}>
                {section.title}
              </SectionLabel>
            ) : null
          }
          renderItem={({ item, index, section }) => (
            <MenuRow
              bleed
              divider={index < section.data.length - 1}
              selected={current === item.id}
              leading={<Flag country={currencyCountry(item.id)} />}
              label={labelFor(item)}
              onPress={() => select(item.id)}
              right={current === item.id ? <TabIcon name="check" color={accent} size={20} /> : null}
            />
          )}
        />
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  // Horizontal padding sits on the list content, so a row's highlight reaches the screen edges. The
  // bottom does too: Screen's own bottom would stop the list short of the edge, and it would then end
  // in a cut line above the gesture bar.
  container: {
    paddingTop: space.xl,
    paddingBottom: 0,
  },
  // The list's own opening, so the rows stay put when it lands.
  skeletonLabel: {
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: rhythm.sectionLabelToList,
  },
  sectionLabel: {
    marginBottom: rhythm.sectionLabelToList,
  },
  laterSection: {
    marginTop: space.xl,
  },
})
