import React, { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { clearUnconfirmed } from '../wallet/backupMark'
import { loadSeedFor } from '../wallet/seed'
import { ErrorBox } from '../components/ErrorBox'
import { GradientButton } from '../components/GradientButton'
import { Screen } from '../components/Screen'
import { space } from '../theme'
import { BackupScreen } from './BackupScreen'
import { VerifyBackupScreen } from './VerifyBackupScreen'

type Props = {
  walletId: string
  // Which of the two steps is on screen. Kept by the parent, whose back is what steps from the check
  // to the words: a person who did not note a word sees them again, and cannot leave them.
  verifying: boolean
  onVerifying: (verifying: boolean) => void
  onDone: () => void
  // Only for a flow drawn outside the navigator, which has no header of its own to go back with.
  onBack?: () => void
  // Inside a navigator whose header carries the title, so neither step draws it again.
  headerTitled?: boolean
}

// The words of a passkey the device does not say syncs, which may be the only way back to the wallet,
// so the step ends only at a confirmation. They are read from the Keychain for this step and go with
// it, and a boot cut in the middle comes back here, since what asks for this step is the mark a
// confirmation clears.
export function PasskeyWordsScreen({
  walletId,
  verifying,
  onVerifying,
  onDone,
  onBack,
  headerTitled = false,
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [mnemonic, setMnemonic] = useState('')
  const [failed, setFailed] = useState(false)
  const [notKept, setNotKept] = useState(false)

  useEffect(() => {
    if (failed) {
      return
    }
    let current = true
    loadSeedFor(walletId).then(
      words => {
        if (current) {
          if (words) {
            setMnemonic(words)
          } else {
            setFailed(true)
          }
        }
      },
      () => {
        if (current) {
          setFailed(true)
        }
      },
    )
    return () => {
      current = false
    }
  }, [walletId, failed])

  async function keep() {
    setNotKept(false)
    try {
      await clearUnconfirmed(walletId)
    } catch (err) {
      console.warn(`confirmation not kept: ${(err as Error)?.message ?? String(err)}`)
      setNotKept(true)
      onVerifying(false)
      return
    }
    setMnemonic('')
    onDone()
  }

  if (failed) {
    return (
      <Screen layout="center">
        {/* Stretched, since a centred screen would otherwise shrink the button to its label. */}
        <View style={styles.failed}>
          <ErrorBox message={t('recovery.readFailed')} />
          <GradientButton label={t('common.retry')} onPress={() => setFailed(false)} />
        </View>
      </Screen>
    )
  }

  if (verifying) {
    return (
      <VerifyBackupScreen
        headerTitled={headerTitled}
        mnemonic={mnemonic}
        onVerified={keep}
        onBack={onBack}
        onShowWords={() => onVerifying(false)}
      />
    )
  }

  return (
    <BackupScreen
      headerTitled={headerTitled}
      mnemonic={mnemonic}
      length={12}
      lockLength
      notice={t(notKept ? 'backup.confirmFailed' : 'passkey.wordsOwed')}
      onConfirm={() => onVerifying(true)}
    />
  )
}

const styles = StyleSheet.create({
  failed: {
    alignSelf: 'stretch',
    gap: space.md,
  },
})
