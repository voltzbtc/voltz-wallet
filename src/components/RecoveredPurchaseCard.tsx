import React from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useTranslation } from 'react-i18next'
import { TabIcon } from './TabIcon'
import { GradientButton } from './GradientButton'
import { helpMailUrl, type Recovery, type RecoveryStatus } from '../wallet/recover'
import { colors, dangerSoftSurface, primarySoftSurface, space } from '../theme'
import { Card } from './Card'
import { Row } from './Row'
import { Txt } from './Txt'
import { Touch } from './Touch'
import { SupportMailCard, useSupportMail } from './SupportMail'

type Props = {
  /** Null for almost every wallet on almost every open, and then this draws nothing at all. */
  result: Recovery | null
  onDismiss: () => void
  // Where a name bought through the store and not chosen yet is picked.
  onChooseName?: () => void
  style?: StyleProp<ViewStyle>
}

// One key pair per outcome, exhaustive, so adding a status to wallet/recover.ts fails the build here
// instead of putting a card with no words in it in front of somebody who paid.
const COPY: Record<RecoveryStatus, { title: string; body: string }> = {
  ready: { title: 'recover.readyNameTitle', body: 'recover.readyNameBody' },
  settling: { title: 'recover.settlingTitle', body: 'recover.settlingBody' },
  stuck: { title: 'recover.stuckTitle', body: 'recover.stuckBody' },
  blocked: { title: 'recover.blockedTitle', body: 'recover.blockedBody' },
  waiting: { title: 'recover.waitingTitle', body: 'recover.waitingBody' },
  credit: { title: 'recover.creditTitle', body: 'recover.creditBody' },
  repaid: { title: 'recover.repaidTitle', body: 'recover.repaidBody' },
  paidAgain: { title: 'recover.paidAgainTitle', body: 'recover.paidAgainBody' },
  paidAgainRepaid: { title: 'recover.paidAgainTitle', body: 'recover.paidAgainRepaidBody' },
  boughtBefore: { title: 'recover.boughtBeforeTitle', body: 'recover.boughtBeforeBody' },
}

// A year on a domain reads nothing like an address, so the good news has two wordings and the two
// failures have one each. The finished case needs the split, and so does a charge that bought what it
// was for before, which names a year or a name: the others say what happened to the payment, which is
// the same sentence whatever was being bought.
function copyFor(result: Recovery): { title: string; body: string } {
  if (result.status === 'ready' && result.kind === 'tier') {
    return { title: 'recover.readyDomainTitle', body: 'recover.readyDomainBody' }
  }
  if (result.status === 'boughtBefore' && result.kind === 'name') {
    return { title: 'recover.boughtBeforeNameTitle', body: 'recover.boughtBeforeNameBody' }
  }
  return COPY[result.status]
}

// What was picked back up, said in the words of somebody who paid and never heard anything.
//
// Nothing here asks the buyer to finish a purchase. By the time this draws, the payment has been
// confirmed and the thing granted, or it has not and no tap of theirs would change that. One button
// reaches a person, on the outcomes a person is needed for, which are those with sats nobody gave
// back yet. The other is a name bought through the store, which only the buyer can choose.
export function RecoveredPurchaseCard({
  result,
  onDismiss,
  onChooseName,
  style,
}: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const mail = useSupportMail()
  if (!result) {
    return null
  }
  const copy = copyFor(result)
  const needsAPerson = result.status === 'stuck' || result.status === 'blocked' || result.status === 'paidAgain'
  const values = { subject: result.subject }

  function sendToSupport(): void {
    if (!result) {
      return
    }
    const body = t('recover.mailBody', {
      pubkey: result.pubkey,
      reference: result.reference,
    })
    // Keyed by the purchase, since the card stays mounted while a later sweep or a dismiss changes the
    // result it shows, and a note about one purchase never sits beside another.
    mail.open(helpMailUrl(t('recover.mailSubject'), body), body, result.reference)
  }
  const note = mail.noteFor(result.reference)

  return (
    <View style={[styles.wrap, style]}>
      <Card gap="sm" style={needsAPerson ? styles.alarming : styles.calm}>
        {/* A plain row, mirrored by forceRTL on its own. The cart carries no direction, unlike the
            chevrons in TabIcon, so nothing here is flipped by hand. */}
        <Row gap="sm">
          <TabIcon
            name="cart"
            color={needsAPerson ? colors.danger : colors.primary}
            size={20}
            strokeWidth={2.5}
          />
          <Txt
            role="bodyBold"
            tone="default"
            style={[styles.title, needsAPerson && styles.alarmingTitle]}>
            {t(copy.title, values)}
          </Txt>
        </Row>

        <Txt role="caption" tone="muted">
          {t(copy.body, values)}
        </Txt>
      </Card>
      {/* Outside the card, as on the domain notice. The card says what happened and the buttons are
          what to do about it; inside an alarm-coloured box a button reads as part of the alarm. */}
      {needsAPerson && (
        <GradientButton label={t('recover.sendToSupport')} onPress={sendToSupport} />
      )}
      {needsAPerson && note && <SupportMailCard note={note} />}
      {result.status === 'credit' && onChooseName && (
        <GradientButton label={t('recover.chooseName')} onPress={onChooseName} />
      )}
      <Touch onPress={onDismiss} feedback="link" style={styles.secondary}>
        <Txt role="label" tone="muted">
          {t('recover.dismiss')}
        </Txt>
      </Touch>
    </View>
  )
}

const styles = StyleSheet.create({
  // The card and what follows it keep the spacing the domain notice has in its screen.
  wrap: { gap: space.md },
  // Touch gives it the 44pt floor, so only the sides are padded here.
  secondary: { alignSelf: 'center', paddingHorizontal: space.md },
  calm: primarySoftSurface,
  alarming: dangerSoftSurface,
  // Takes the row's remaining width, so a long title wraps beside the icon instead of running past
  // the card. The type comes from the bodyBold role.
  title: {
    flex: 1,
  },
  // The title carries the alarm colour, matching the icon beside it, as on the domain notice. White
  // reads as ordinary news, and a payment that needs a person is not ordinary news.
  alarmingTitle: {
    color: colors.danger,
  },
})
