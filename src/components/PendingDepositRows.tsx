import React from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { DepositStage, SparkDeposit } from '../wallet/spark'
import { formatSats } from '../wallet/amount'
import { refundNeedsHigherFee } from '../wallet/refund'
import { space } from '../theme'
import { Card } from './Card'
import { DirectionBadge } from './DirectionBadge'
import { Figure } from './Amount'
import { FigureRow } from './FigureRow'
import { GradientButton } from './GradientButton'
import { Row } from './Row'
import { Touch } from './Touch'
import { Txt } from './Txt'

type Props = {
  deposits: SparkDeposit[]
  // Marks the rows when no row of the list sits under them to carry the mark.
  stale?: boolean
  // Opens the way out of a return the network refused.
  onRefund: (deposit: SparkDeposit) => void
  // Opens the deposit's detail, where its transaction id and explorer link are.
  onOpen: (deposit: SparkDeposit) => void
  // The space around the card, which is the caller's, since nothing is drawn with no deposit.
  style?: StyleProp<ViewStyle>
}

const STAGE_LABEL: Record<DepositStage, string> = {
  arriving: 'deposits.arriving',
  needsFee: 'deposits.waiting',
  tooSmall: 'deposits.waiting',
  stuck: 'deposits.waiting',
  returning: 'deposits.returning',
}

// Where a deposit stands, in the words its row and its detail both use.
export function depositStatusKey(deposit: SparkDeposit): string {
  return refundNeedsHigherFee(deposit) ? 'deposits.refundStalled' : STAGE_LABEL[deposit.stage]
}

// A deposit has no date, so it sits above the days rather than in one. The figure is the gross amount
// and nothing here is in the balance, which is why it reads approximate and pending, never received.
// A return the network refused will not end on its own, so its row says so and offers the way out,
// as Home's card does, rather than reading as in progress.
export function PendingDepositRows({
  deposits,
  stale = false,
  onRefund,
  onOpen,
  style,
}: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  if (deposits.length === 0) {
    return null
  }
  return (
    <>
      {stale ? (
        <Txt role="caption" tone="muted" style={styles.stale}>
          {t('home.notUpdated')}
        </Txt>
      ) : null}
      <Card padding="inset" style={style}>
        {deposits.map((deposit, index) => {
          const refused = refundNeedsHigherFee(deposit)
          return (
            <React.Fragment key={`${deposit.txid}:${deposit.vout}`}>
              <Touch
                onPress={() => onOpen(deposit)}
                feedback="row"
                hint={t('history.detail.depositHint')}>
                <Row pad="default" gap="md" divider={!refused && index < deposits.length - 1}>
                  <DirectionBadge
                    direction={deposit.stage === 'returning' ? 'sent' : 'received'}
                    size={40}
                  />
                  <FigureRow
                    label={
                      <Txt role="bodyStrong" wholeWords>
                        {t(depositStatusKey(deposit))}
                      </Txt>
                    }>
                    <Figure role="bodyBold" tone="muted" tabular>
                      {t('deposits.approx', { amount: formatSats(deposit.amountSat) })}
                    </Figure>
                  </FigureRow>
                </Row>
              </Touch>
              {refused ? (
                <View style={styles.retry}>
                  <GradientButton
                    label={t('deposits.refundRetry')}
                    variant="secondary"
                    onPress={() => onRefund(deposit)}
                  />
                </View>
              ) : null}
            </React.Fragment>
          )
        })}
      </Card>
    </>
  )
}

const styles = StyleSheet.create({
  stale: {
    marginBottom: space.sm,
    textAlign: 'center',
  },
  retry: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
})
