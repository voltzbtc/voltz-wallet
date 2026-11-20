import React, { useEffect, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { AssetIcon } from './AssetIcon'
import { dividerBottom, space } from '../theme'
import { Sheet } from './Sheet'
import { SearchField } from './SearchField'
import { Txt } from './Txt'
import { Figure } from './Amount'
import { FigureRow } from './FigureRow'
import { Touch } from './Touch'
import { EmptyState } from './EmptyState'
import { TabIcon } from './TabIcon'
import { useAccent } from '../wallet/dollarMode'

// `iconId` draws a logo other than the item's own id (a network row carries its route id but shows
// the chain's mark). An empty `name` leaves the row a single line.
export type PickerItem = {
  assetId: string
  ticker: string
  name: string
  subtitle?: string
  iconId?: string
}

type Props = {
  visible: boolean
  title: string
  items: PickerItem[]
  onSelect: (assetId: string) => void
  onClose: () => void
  // The asset or route the screen will use, so the list opens on what is already chosen; null when
  // nothing is chosen yet. Required, so no caller can open a list that hides the current choice.
  selectedId: string | null
  // A short list reads faster without a search field above it.
  searchable?: boolean
}

export function AssetPickerSheet({
  visible,
  title,
  items,
  onSelect,
  onClose,
  selectedId,
  searchable = true,
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const { accent } = useAccent()
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (visible) {
      setQuery('')
    }
  }, [visible])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? items.filter(i => i.ticker.toLowerCase().includes(q) || i.name.toLowerCase().includes(q))
    : items

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      closeLabel={t('convert.close')}
      maxHeight={'80%'}
      // Only a search field brings the keyboard up, so only then does the sheet make room for it.
      keyboard={searchable}>
      <Txt role="subheading">{title}</Txt>
      {searchable && (
        <SearchField inSheet value={query} onChangeText={setQuery} label={t('convert.search')} />
      )}
      <FlatList
        data={filtered}
        keyExtractor={item => item.assetId}
        keyboardShouldPersistTaps="handled"
        style={styles.list}
        ListEmptyComponent={<EmptyState message={t('convert.noAsset')} />}
        renderItem={({ item, index }) => {
          const chosen = item.assetId === selectedId
          return (
            // On screen only the accent check marks the choice, so assistive tech hears it as selected.
            <Touch
              onPress={() => onSelect(item.assetId)}
              feedback="row"
              state={chosen ? { selected: true } : undefined}
              style={[styles.row, index < filtered.length - 1 && styles.divided]}>
              <AssetIcon assetId={item.iconId ?? item.assetId} ticker={item.ticker} size={36} />
              {/* The balance goes under the names at a large text size, by the rule every label
                  and figure share. */}
              <FigureRow
                label={
                  <View style={styles.rowText}>
                    <Txt role="bodyStrong">{item.ticker}</Txt>
                    {item.name ? (
                      <Txt role="caption" tone="muted" lines={1}>
                        {item.name}
                      </Txt>
                    ) : null}
                  </View>
                }>
                {item.subtitle ? (
                  <Figure role="caption" tone="muted" tabular>
                    {item.subtitle}
                  </Figure>
                ) : null}
              </FigureRow>
              {chosen ? <TabIcon name="check" color={accent} size={20} /> : null}
            </Touch>
          )
        }}
      />
    </Sheet>
  )
}

const styles = StyleSheet.create({
  list: {
    alignSelf: 'stretch',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    // Cancelling the sheet padding and adding it back inside runs the highlight to the edges.
    marginHorizontal: -space.xl,
    paddingHorizontal: space.xl,
  },
  // Off the last row, which has nothing under it to part from.
  divided: {
    ...dividerBottom,
  },
  rowText: {
    gap: space.xs,
  },
})
