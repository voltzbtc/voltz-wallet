import React, { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { GradientButton } from '../components/GradientButton'
import { space } from '../theme'
import { Screen } from '../components/Screen'
import { Notice } from '../components/Notice'
import { Txt } from '../components/Txt'
import { Touch } from '../components/Touch'
import { PassphraseField } from '../components/PassphraseField'
import { ScreenTitle } from '../components/ScreenTitle'
import { CaptureNotice } from '../components/CaptureNotice'
import { useScreenCapture } from '../hooks/useScreenCapture'

type Props = {
  // Receives '' for no passphrase. The caller is what persists it.
  onDone: (passphrase: string) => void
  // Only for a flow drawn outside the navigator, which has no header of its own to go back with.
  onBack?: () => void
  // Inside a navigator whose header carries the title, so the step does not draw it again.
  headerTitled?: boolean
}

// The step a dice phrase takes after it is confirmed. Add wallet's other phrases carry the same choice
// behind a link on the phrase itself.
export function PassphraseScreen({ onDone, onBack, headerTitled = false }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [adding, setAdding] = useState(false)
  const [pass, setPass] = useState('')
  // The field can be revealed, so it leaves the screen while it is recorded or mirrored, as the words do.
  const capture = useScreenCapture(pass.length > 0)

  const canContinue = !adding || pass.length > 0

  function proceed() {
    if (!canContinue) {
      return
    }
    onDone(adding ? pass : '')
  }

  function cancelAdding() {
    setAdding(false)
    setPass('')
  }

  return (
    <Screen
      scroll
      keyboard
      layout="padded"
      footer={
        <View style={styles.footer}>
          <GradientButton
            label={t('passphrase.continue')}
            onPress={proceed}
            disabled={!canContinue}
          />
          <Touch
            onPress={adding ? cancelAdding : () => setAdding(true)}
            feedback="link"
            hitSlop={space.md}
            style={styles.secondary}>
            <Txt role="bodyStrong" tone="muted">
              {adding ? t('passphrase.remove') : t('passphrase.add')}
            </Txt>
          </Touch>
        </View>
      }>
      <ScreenTitle
        title={headerTitled ? undefined : t('passphrase.title')}
        subtitle={t('passphrase.subtitle')}
        onBack={onBack}
      />

      <Notice style={styles.warningBox}>
        <Txt role="caption">{t('passphrase.warning')}</Txt>
      </Notice>

      {adding && <CaptureNotice capture={capture} style={styles.captureNotice} />}
      {adding && capture.phase === 'shown' && <PassphraseField value={pass} onChangeText={setPass} />}
    </Screen>
  )
}

const styles = StyleSheet.create({
  warningBox: {
    marginBottom: space.xl,
  },
  captureNotice: {
    marginBottom: space.lg,
  },
  footer: {
    padding: space.xl,
    gap: space.md,
  },
  secondary: {
    alignSelf: 'center',
  },
})
