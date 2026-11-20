import React from 'react'
import { Linking, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { MenuRow } from '../components/MenuRow'
import { Screen } from '../components/Screen'
import { SupportMailCard, useSupportMail } from '../components/SupportMail'
import { SUPPORT_EMAIL, helpMailUrl, paymentEvidence, type PaymentEvidence } from '../wallet/recover'
import { sparkGetIdentityPubkey } from '../wallet/spark'
import { rhythm, space } from '../theme'

// Support content is hosted off-app (site, email), so this page carries only links, and the one card
// the mails leave under them.
export function SupportScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const mail = useSupportMail()
  const contactMail = useSupportMail()
  // The payment's card holds the address a contact mail leaves, along with the text naming the
  // payment, so it stands alone rather than over a second card that repeats it.
  const card = mail.note ?? contactMail.note

  // For the customer the recovery sweep found nothing for. That is a real case, because the gateway
  // keeps a charge for a limited window, and a payment the treasury never saw is in neither place
  // the app can ask. The mail carries what turns "I paid" into a row support can look up, and it is
  // assembled from the device so it still works when the network is what failed.
  //
  // The address and that same text stay on screen to copy whether the mail app opens or not, since a
  // mail app can open and still not send (useSupportMail), and a row that leaves nothing does nothing
  // for somebody already worried about a payment. Details that could not be read are said to be
  // unread, never filled in.
  async function paidAndGotNothing(): Promise<void> {
    mail.setNote(null)
    let evidence: PaymentEvidence
    try {
      evidence = await paymentEvidence(sparkGetIdentityPubkey)
    } catch {
      evidence = { pubkey: '', references: [], unread: true }
    }
    const { pubkey, references, unread } = evidence
    // Nothing read and something unreadable leaves no payment for a mail to name.
    if (unread && references.length === 0) {
      mail.setNote({ mail: null, unread: true, text: null })
      return
    }
    const body = t('recover.mailBody', {
      pubkey,
      reference: references.length > 0 ? references.join(', ') : t('recover.mailNoReference'),
    })
    try {
      await Linking.openURL(helpMailUrl(t('recover.mailSubject'), body))
      mail.setNote({ mail: 'opened', unread, text: body })
    } catch {
      mail.setNote({ mail: 'refused', unread, text: body })
    }
  }

  return (
    <Screen scroll layout="padded" contentStyle={styles.container}>
      <MenuRow
        bleed
        icon="help"
        label={t('support.faq')}
        onPress={() => Linking.openURL('https://www.usevoltz.app/support/#faq')}
      />
      <MenuRow
        bleed
        icon="cart"
        label={t('support.paid')}
        onPress={() => {
          paidAndGotNothing()
        }}
      />
      <MenuRow
        bleed
        divider={false}
        icon="mail"
        label={t('support.contact')}
        onPress={() => {
          contactMail.open(`mailto:${SUPPORT_EMAIL}`, null)
        }}
      />
      {card && <SupportMailCard note={card} style={styles.fallback} />}
    </Screen>
  )
}

const styles = StyleSheet.create({
  // A row's own 16 of padding makes up the 24 under the header.
  container: {
    paddingTop: rhythm.headerToContent - space.lg,
  },
  fallback: {
    marginTop: space.lg,
  },
})
