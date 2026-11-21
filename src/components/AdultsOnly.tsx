import React from 'react'
import { StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { SUPPORT_EMAIL } from '../wallet/recover'
import { rhythm, space } from '../theme'
import { ScreenTitle } from './ScreenTitle'
import { SupportMailCard, useSupportMail } from './SupportMail'
import { Touch } from './Touch'
import { Txt } from './Txt'

type Props = {
  // The way to the import step, where words of a wallet this device held come back (the gate in
  // src/wallet/wallet.ts decides which). Absent where there is no import step to go to.
  restore?: { label: string; onPress: () => void }
}

// What takes the place of the ways to a new wallet when the store's age signal says the person is under
// 18 (src/wallet/ageSignal.ts): what the app is for, why, the way back for a wallet this device held,
// and how to contest it. The store holds the age, so correcting it there and opening the app again asks
// afresh; support is the other way.
export function AdultsOnly({ restore }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const mail = useSupportMail()
  return (
    <View testID="adultsOnly" style={styles.group}>
      <ScreenTitle centered title={t('ageGate.title')} subtitle={t('ageGate.body')} />
      <View style={styles.contest}>
        {restore && (
          <>
            <Txt role="body" tone="muted" style={styles.centred}>
              {t('ageGate.restore')}
            </Txt>
            <Touch onPress={restore.onPress} feedback="link">
              <Txt role="bodyStrong" tone="muted">
                {restore.label}
              </Txt>
            </Touch>
          </>
        )}
        <Txt role="body" tone="muted" style={styles.centred}>
          {t('ageGate.contest')}
        </Txt>
        <Touch onPress={() => mail.open(`mailto:${SUPPORT_EMAIL}`, null)} feedback="link">
          <Txt role="bodyStrong" tone="muted">
            {t('welcome.contactSupport')}
          </Txt>
        </Touch>
        {mail.note && <SupportMailCard note={mail.note} style={styles.card} />}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  group: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  // The way to contest sits a group away from what the app is for, and its parts a block apart.
  contest: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: space.lg,
    marginTop: rhythm.groupToAction,
  },
  centred: {
    textAlign: 'center',
  },
  card: {
    alignSelf: 'stretch',
  },
})
