import React, { useLayoutEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useNavigation, usePreventRemove } from '@react-navigation/native'
import { useTranslation } from 'react-i18next'
import { PinScreen } from './PinScreen'
import { VerifyBackupScreen } from './VerifyBackupScreen'
import { PRIMARY_ID, loadPassphraseFor, loadSeedFor } from '../wallet/seed'
import { getActiveWalletId } from '../wallet/walletRegistry'
import { walletIdentityOf } from '../wallet/wallet'
import { formatFingerprint, resolveWalletDisplay, type WalletDisplay } from '../wallet/walletIdentity'
import { loadWalletMeta } from '../wallet/walletMeta'
import { clearUnconfirmed, isUnconfirmed } from '../wallet/backupMark'
import { font, space } from '../theme'
import { CenterStack, Screen } from '../components/Screen'
import { ScreenTitle } from '../components/ScreenTitle'
import { SuccessMark } from '../components/SuccessMark'
import { Card } from '../components/Card'
import { Notice } from '../components/Notice'
import { Row } from '../components/Row'
import { Txt } from '../components/Txt'
import { ErrorBox } from '../components/ErrorBox'
import { GradientButton } from '../components/GradientButton'
import { WalletAvatar } from '../components/WalletAvatar'
import { SeedWordGrid } from '../components/SeedWordGrid'
import { CaptureNotice } from '../components/CaptureNotice'
import { useAnnounced } from '../hooks/useAnnounced'
import { useScreenCapture } from '../hooks/useScreenCapture'

type Revealed = {
  // The wallet the words are, so a confirmation clears that wallet's mark whichever is active by then.
  id: string
  // Whether the words still wait for a confirmation.
  unconfirmed: boolean
  words: string[]
  passphrase: string | undefined
  // The wallet the words were read for, named as the drawer names it.
  wallet: { display: WalletDisplay; fingerprint: string }
}

// The Keychain read happens only after the PIN gate resolves, so revealing the phrase always
// costs a re-authentication.
//
// The words are the active wallet's, read by its id. The drawer opens this screen under the active
// wallet's name, and a backup of another wallet's words reads as done while the funds stay
// unrecoverable, so the screen also names the wallet it read. A passphrase is part of what restores
// the wallet: it shows with the words, and when it cannot be read the words do not show alone.
//
// A wallet with its words unconfirmed offers the confirmation from here, over the words already in
// memory, so the gate is the same gate and nothing about the words travels through navigation.
export function RecoveryPhraseScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation()
  const [state, setState] = useState<'gate' | 'failed' | Revealed>('gate')
  const [verifying, setVerifying] = useState(false)
  const [notKept, setNotKept] = useState(false)
  // Set once the confirmation is kept, which the screen says before it is left.
  const [confirmed, setConfirmed] = useState(false)
  const capture = useScreenCapture(typeof state === 'object' && !verifying && !confirmed)
  const drawn = capture.phase === 'shown'

  // The check asks its own question on screen, so the header keeps the short name in every step and
  // never shrinks a long one to fit.
  useLayoutEffect(() => {
    navigation.setOptions({ title: t('settings.recoveryPhrase') })
  }, [navigation, t])

  // Back from the check returns to the words, where a person who did not note one can look again.
  // usePreventRemove is the native-stack-safe API, where beforeRemove + preventDefault desyncs.
  usePreventRemove(verifying, () => setVerifying(false))
  // The tap that brings it lands on an option the screen no longer has, so the outcome is said.
  useAnnounced(confirmed ? t('backup.confirmedTitle') : null)

  async function reveal() {
    try {
      const id = (await getActiveWalletId()) ?? PRIMARY_ID
      const [mnemonic, secret] = await Promise.all([loadSeedFor(id), loadPassphraseFor(id)])
      // The active wallet always has words, so none read is a read that failed, and a passphrase
      // never shows without the words it belongs to.
      if (!mnemonic) {
        setState('failed')
        return
      }
      // Of the words and the passphrase read here, the fingerprint the drawer and the wallets list
      // show, so the screen names the wallet these words restore under the name it has everywhere.
      const { fingerprint } = await walletIdentityOf(mnemonic, secret)
      const meta = await loadWalletMeta(fingerprint).catch(() => null)
      setState({
        id,
        unconfirmed: await isUnconfirmed(id),
        words: mnemonic.split(' '),
        passphrase: secret || undefined,
        wallet: { display: resolveWalletDisplay(fingerprint, meta, t('drawer.walletName')), fingerprint },
      })
    } catch {
      setState('failed')
    }
  }

  if (state === 'gate') {
    return <PinScreen mode="enter" onDone={reveal} />
  }

  if (state === 'failed') {
    return (
      <Screen layout="padded">
        <ErrorBox message={t('recovery.readFailed')} style={styles.error} />
        <View style={styles.retry}>
          <GradientButton label={t('common.retry')} onPress={() => setState('gate')} />
        </View>
      </Screen>
    )
  }

  const { id, unconfirmed, words, passphrase, wallet } = state
  const spaces = edgeSpaceWarning(passphrase)

  async function keepConfirmation() {
    setNotKept(false)
    try {
      await clearUnconfirmed(id)
    } catch (err) {
      console.warn(`confirmation not kept: ${(err as Error)?.message ?? String(err)}`)
      setVerifying(false)
      setNotKept(true)
      return
    }
    setVerifying(false)
    setConfirmed(true)
  }

  // Said only once the mark is off the disk, so it never claims a confirmation that was not kept.
  if (confirmed) {
    return (
      <Screen layout="center">
        <View style={styles.mark}>
          <SuccessMark />
        </View>
        <ScreenTitle
          centered
          title={t('backup.confirmedTitle')}
          subtitle={t('backup.confirmedBody')}
        />
        <CenterStack>
          <GradientButton label={t('backup.confirmedDone')} onPress={() => navigation.goBack()} />
        </CenterStack>
      </Screen>
    )
  }

  if (verifying) {
    return (
      <VerifyBackupScreen
        headerTitled
        mnemonic={words.join(' ')}
        onVerified={keepConfirmation}
        onShowWords={() => setVerifying(false)}
      />
    )
  }

  return (
    <Screen scroll layout="padded">
      <Row gap="md" style={styles.wallet}>
        <WalletAvatar
          color={wallet.display.color}
          imagePath={wallet.display.imagePath}
          crop={wallet.display.imageCrop}
          monogram={wallet.display.monogram}
        />
        <View style={styles.walletText}>
          <Txt role="bodyBold">{wallet.display.name}</Txt>
          <Txt role="caption" tone="muted">
            {formatFingerprint(wallet.fingerprint)}
          </Txt>
        </View>
      </Row>

      <Notice style={styles.warningBox}>
        <Txt role="caption">{t('recovery.warning')}</Txt>
      </Notice>

      {capture.phase !== 'captured' && <SeedWordGrid words={drawn ? words : null} length={words.length} />}
      <CaptureNotice capture={capture} style={styles.captureNotice} />

      {/* Part of what restores the wallet, so it goes with the words. */}
      {passphrase !== undefined && drawn && (
        <>
          <Card gap="sm" style={styles.passphraseBox}>
            <Txt role="caption" tone="muted">
              {t('passphrase.field')}
            </Txt>
            <Txt role="bodyBold" style={styles.passphrase}>
              {passphrase}
            </Txt>
          </Card>
          {spaces && (
            <Notice style={styles.passphraseBox}>
              <Txt role="caption" testID="recovery-passphrase-spaces">
                {spaces.end === 0
                  ? t('recovery.passphraseSpacesStart', { count: spaces.start })
                  : spaces.start === 0
                    ? t('recovery.passphraseSpacesEnd', { count: spaces.end })
                    : t('recovery.passphraseSpacesBoth', { start: spaces.start, end: spaces.end })}
              </Txt>
            </Notice>
          )}
        </>
      )}

      {unconfirmed && (
        <View style={styles.confirm}>
          {notKept && <ErrorBox message={t('backup.confirmFailed')} />}
          <GradientButton
            label={notKept ? t('common.retry') : t('backup.confirmWords')}
            onPress={notKept ? keepConfirmation : () => setVerifying(true)}
          />
        </View>
      )}
    </Screen>
  )
}

// An edge space is invisible on screen and part of the secret all the same, so the warning says at
// which end and how many: what trimStart and trimEnd remove. A passphrase of spaces alone counts once,
// at the start, so the two ends never count the same space twice.
function edgeSpaceWarning(passphrase: string | undefined): { start: number; end: number } | null {
  if (passphrase === undefined || passphrase === passphrase.trim()) {
    return null
  }
  const start = passphrase.length - passphrase.trimStart().length
  if (start === passphrase.length) {
    return { start, end: 0 }
  }
  return { start, end: passphrase.length - passphrase.trimEnd().length }
}

const styles = StyleSheet.create({
  captureNotice: {
    marginBottom: space.lg,
  },
  wallet: {
    marginBottom: space.lg,
  },
  walletText: {
    flex: 1,
    gap: space.xs,
  },
  warningBox: {
    marginBottom: space.xl,
  },
  passphraseBox: {
    marginTop: space.lg,
  },
  // Read character by character, like an address.
  passphrase: {
    fontFamily: font.mono,
  },
  confirm: {
    marginTop: space.xl,
    gap: space.md,
  },
  retry: {
    marginTop: space.lg,
  },
  error: {
    marginBottom: space.md,
  },
  mark: {
    marginBottom: space.xl,
  },
})
