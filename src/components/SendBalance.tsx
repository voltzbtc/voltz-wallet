import React from 'react'
import { StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { BITCOIN_ASSET_ID, formatRowAmount } from '../wallet/assets'
import type { BalanceSync } from '../wallet/spark'
import { AssetIcon } from './AssetIcon'
import { Skeleton } from './Skeleton'
import { SectionLabel } from './SectionLabel'
import { Card } from './Card'
import { Row } from './Row'
import { Figure } from './Amount'
import { FigureRow } from './FigureRow'
import { Txt } from './Txt'
import { dividerBottom, font, rhythm, space } from '../theme'

export type BalanceRow = {
  assetId: string
  name: string
  ticker: string
  amount: string
}

// Sats only, since a token bills in its own unit and has no sats figure to show.
export function sendBalanceRows(balanceSat: number): BalanceRow[] {
  return [{ assetId: BITCOIN_ASSET_ID, name: 'Bitcoin', ticker: 'sats', amount: String(balanceSat) }]
}

type Props = {
  balanceSat: number
  // Before the connection's first sync the figure is the last sync's, so it waits as a skeleton and,
  // past the wait, shows marked as not updated.
  sync: BalanceSync
  /** Replaces the sats row when a token funds the send, since sats are not what gets spent. */
  token?: BalanceRow
}

export function SendBalance({ balanceSat, sync, token }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const rows = token ? [token] : sendBalanceRows(balanceSat)
  // The sats word comes from the locale; a token's ticker is its own name in every language.
  const unit = (row: BalanceRow) => (row.assetId === BITCOIN_ASSET_ID ? t('common.sats') : row.ticker)

  return (
    <View>
      <SectionLabel style={styles.label}>{t('send.balanceTitle')}</SectionLabel>
      <Card padding="inset">
        {rows.map((row, i) => (
          // The figure goes under the name at a large text size, by the rule every label and figure
          // share.
          <FigureRow
            key={row.assetId}
            label={
              <Row gap="sm">
                <AssetIcon assetId={row.assetId} ticker={row.ticker} size={28} />
                <Txt role="bodyStrong" wholeWords style={styles.name}>
                  {row.name}
                </Txt>
              </Row>
            }
            style={[styles.line, i < rows.length - 1 && styles.divider]}>
            {sync === 'waiting' ? (
              <Skeleton width={80} height={font.leading.base} />
            ) : (
              <Figure role="body" tabular>
                {formatRowAmount(row)} {unit(row)}
              </Figure>
            )}
          </FigureRow>
        ))}
      </Card>
      {sync === 'stale' && (
        <Txt role="caption" tone="muted" style={styles.staleMark}>
          {t('home.notUpdated')}
        </Txt>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  label: {
    marginBottom: rhythm.sectionLabelToList,
  },
  // The padding and hairline of the app's list rows.
  line: {
    paddingVertical: space.md,
  },
  divider: {
    ...dividerBottom,
  },
  // The name wraps between words beside its icon rather than running past the row.
  name: {
    flexShrink: 1,
  },
  staleMark: {
    marginTop: space.sm,
  },
})
