import React, { useCallback, useState } from 'react'
import { StyleSheet, type ViewStyle } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { useTranslation } from 'react-i18next'
import { isUnconfirmed } from '../wallet/backupMark'
import { useAccent } from '../wallet/dollarMode'
import { colors } from '../theme'
import { Card } from './Card'
import { Row } from './Row'
import { TabIcon } from './TabIcon'
import { Touch } from './Touch'
import { Txt } from './Txt'

type Props = {
  // The wallet the figures on screen belong to.
  walletId: string | null
  // Whether that wallet holds anything. The card says nothing of how much, so a figure that is out of
  // date cannot make it false.
  funded: boolean
  // Bumped when Home reloads.
  refreshKey?: number
  onPress: () => void
  style?: ViewStyle
}

// The confirmation the first run left for later, asked for once there is something to lose. There is
// no way to dismiss it: only the right words clear the mark. A spent wallet hides it and keeps the
// mark, so it returns with the next payment.
//
// A reminder on Home, not a warning inside a flow, so it is a neutral row with the accent on its icon
// alone: a warning's soft fill on a screen a person opens every day would wear the warning out. The
// reason it gives is the hint a screen reader reads after the title.
export function BackupCard({ walletId, funded, refreshKey, onPress, style }: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const { accent } = useAccent()
  // The wallet the last answer was about, so an answer for the previous wallet shows nothing on this
  // one, and a read in flight on the same wallet leaves the card as it was.
  const [markedId, setMarkedId] = useState<string | null>(null)

  useFocusEffect(
    useCallback(() => {
      if (!walletId) {
        return
      }
      let current = true
      isUnconfirmed(walletId).then(marked => {
        if (current) {
          setMarkedId(marked ? walletId : null)
        }
      })
      return () => {
        current = false
      }
      // refreshKey carries no value here: a new one re-reads the mark.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [walletId, refreshKey]),
  )

  if (!funded || !walletId || markedId !== walletId) {
    return null
  }
  return (
    <Touch onPress={onPress} feedback="surface" hint={t('backup.cardBody')} style={style}>
      <Card>
        <Row gap="md">
          <TabIcon name="key" color={accent} size={20} />
          <Txt role="body" wholeWords style={styles.title}>
            {t('backup.verifyTitle')}
          </Txt>
          <TabIcon name="chevron" color={colors.textSecondary} size={18} />
        </Row>
      </Card>
    </Touch>
  )
}

const styles = StyleSheet.create({
  // Takes what the icons leave, so a long title wraps between them rather than pushing the chevron off.
  title: { flex: 1 },
})
