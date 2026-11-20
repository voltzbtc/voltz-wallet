import React, { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { BiometryKind } from '../wallet/biometrics'
import { GradientButton } from '../components/GradientButton'
import { TabIcon } from '../components/TabIcon'
import { ErrorBox } from '../components/ErrorBox'
import { CenterStack, Screen } from '../components/Screen'
import { ScreenTitle } from '../components/ScreenTitle'
import { useAccent } from '../wallet/dollarMode'
import { space } from '../theme'

type Props = {
  kind: NonNullable<BiometryKind>
  // Rejects when the system prompt is cancelled or the write fails, which keeps this step on screen.
  onEnable: () => Promise<void>
  onSkip: () => void
}

// Shown once per device, right after the first PIN is set or, on an install whose PIN came first,
// after a keypad unlock, so unlocking with the fingerprint or the face is a choice put in front of
// the person rather than a switch found later in the settings.
export function BiometricOfferScreen({ kind, onEnable, onSkip }: Props): React.JSX.Element {
  const { t } = useTranslation()
  // Green when the offer follows an unlock of a wallet in dollar mode, orange in the first run.
  const { accent } = useAccent()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const face = kind === 'face'

  async function enable() {
    setBusy(true)
    setFailed(false)
    try {
      await onEnable()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <Screen layout="center">
      <View style={styles.icon}>
        <TabIcon name={face ? 'faceid' : 'fingerprint'} color={accent} size={34} />
      </View>
      <ScreenTitle
        centered
        title={face ? t('biometricOffer.titleFace') : t('biometricOffer.titleFingerprint')}
        subtitle={face ? t('biometricOffer.bodyFace') : t('biometricOffer.bodyFingerprint')}
      />
      <CenterStack>
        {failed && <ErrorBox message={t('biometricOffer.failed')} />}
        <GradientButton label={t('biometricOffer.enable')} onPress={enable} loading={busy} />
        <GradientButton
          variant="secondary"
          label={t('biometricOffer.skip')}
          onPress={onSkip}
          disabled={busy}
        />
      </CenterStack>
    </Screen>
  )
}

const styles = StyleSheet.create({
  icon: { marginBottom: space.lg },
})
