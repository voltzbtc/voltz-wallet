import React, { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { GradientButton } from '../components/GradientButton'
import { SegmentedControl } from '../components/SegmentedControl'
import { Skeleton } from '../components/Skeleton'
import { TabIcon } from '../components/TabIcon'
import type { MnemonicLength } from '../wallet/seed'
import { formatFingerprint } from '../wallet/walletIdentity'
import { colors, font, space } from '../theme'
import { Screen } from '../components/Screen'
import { Notice } from '../components/Notice'
import { Row } from '../components/Row'
import { Txt } from '../components/Txt'
import { Touch } from '../components/Touch'
import { ScreenTitle } from '../components/ScreenTitle'
import { ErrorBox } from '../components/ErrorBox'
import { PassphraseField } from '../components/PassphraseField'
import { SeedWordGrid } from '../components/SeedWordGrid'
import { CaptureNotice } from '../components/CaptureNotice'
import { useScreenCapture } from '../hooks/useScreenCapture'

type Props = {
  // Empty while the parent draws the seed pair, which shows the skeleton grid and disables the CTA.
  mnemonic: string
  // Derived and cached by the parent, so a step back or a length toggle skips the PBKDF2. Absent where
  // the phrase is the only wallet there is, so nothing needs telling apart.
  fingerprint?: string | null
  length: MnemonicLength
  // A dice seed is bound to the length rolled for, and switching would replace it with an RNG one.
  lockLength?: boolean
  onLengthChange?: (length: MnemonicLength) => void
  onRegenerate?: () => void
  // Draws the closed passphrase link. Without it the confirm hands back ''.
  passphrase?: boolean
  // Stores the wallet, or moves on when a step still comes first. A rejection is the write failing:
  // the screen says so and the same button repeats it with the same words.
  onConfirm: (passphrase: string) => void | Promise<void>
  // Only for a flow drawn outside the navigator, which has no header of its own to go back with.
  onBack?: () => void
  // Why these words are being shown, where the warning alone would not say it.
  notice?: string
  // The navigator's header carries the title, so the screen does not draw it a second time.
  headerTitled?: boolean
}

export function BackupScreen({
  mnemonic,
  fingerprint,
  length,
  lockLength = false,
  onLengthChange,
  onRegenerate,
  passphrase: offerPassphrase = false,
  onConfirm,
  onBack,
  notice,
  headerTitled = false,
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const ready = mnemonic !== ''
  const words = ready ? mnemonic.split(' ') : []
  const capture = useScreenCapture(ready)
  const drawn = capture.phase === 'shown'
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [adding, setAdding] = useState(false)
  const [pass, setPass] = useState('')

  async function confirm() {
    setFailed(false)
    setBusy(true)
    try {
      await onConfirm(adding ? pass : '')
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  function toggleAdding() {
    setAdding(open => !open)
    setPass('')
  }

  return (
    <Screen scroll keyboard={offerPassphrase} layout="padded">
      {!headerTitled && <ScreenTitle title={t('backup.title')} onBack={onBack} />}

      {/* The id comes from the words and the passphrase, so a passphrase being typed makes this one wrong. */}
      {fingerprint !== undefined && !(adding && pass.length > 0) && (
        <Row style={styles.walletIdRow}>
          <Txt role="caption" tone="muted">
            {t('backup.walletId')}
          </Txt>
          {fingerprint ? (
            <Txt role="labelStrong">{formatFingerprint(fingerprint)}</Txt>
          ) : (
            <Skeleton width={72} height={font.leading.sm} />
          )}
        </Row>
      )}

      {!lockLength && onLengthChange && (
        <View style={styles.length}>
          <SegmentedControl
            options={[
              { label: t('welcome.words', { count: 12 }), value: 12 },
              { label: t('welcome.words', { count: 24 }), value: 24 },
            ]}
            value={length}
            onChange={onLengthChange}
          />
        </View>
      )}

      <Notice style={styles.warningBox}>
        <Txt role="body">{t('backup.warning')}</Txt>
        {notice !== undefined && <Txt role="body">{notice}</Txt>}
      </Notice>

      {capture.phase !== 'captured' && (
        <SeedWordGrid words={ready && drawn ? words : null} length={length} style={styles.grid} />
      )}
      <CaptureNotice capture={capture} style={styles.captureNotice} />

      {onRegenerate && (
        <Touch onPress={onRegenerate} disabled={!ready} feedback="link" style={styles.regenerate}>
          <TabIcon name="refresh" size={16} color={colors.textSecondary} />
          <Txt role="labelStrong" tone="muted">
            {t('backup.regenerate')}
          </Txt>
        </Touch>
      )}

      {offerPassphrase && (
        <View style={styles.passphrase}>
          <Touch onPress={toggleAdding} feedback="link" hitSlop={space.md} style={styles.passphraseLink}>
            <Txt role="bodyStrong" tone="muted">
              {adding ? t('passphrase.remove') : t('passphrase.add')}
            </Txt>
          </Touch>
          {adding && (
            <>
              <Notice>
                <Txt role="caption">{t('passphrase.warning')}</Txt>
              </Notice>
              {/* It can be revealed, so it leaves a recorded screen with the words and keeps its value. */}
              {drawn && <PassphraseField value={pass} onChangeText={setPass} />}
            </>
          )}
        </View>
      )}

      {failed && <ErrorBox message={t('backup.saveFailed')} style={styles.error} />}

      <GradientButton
        label={t('backup.confirm')}
        onPress={confirm}
        // Words that are not on screen cannot have been written down.
        disabled={!ready || !drawn || (adding && pass.length === 0)}
        loading={busy}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  captureNotice: {
    marginBottom: space.lg,
  },
  walletIdRow: {
    marginBottom: space.lg,
  },
  length: {
    marginBottom: space.lg,
  },
  warningBox: {
    marginBottom: space.xl,
  },
  grid: {
    marginBottom: space.lg,
  },
  passphrase: {
    gap: space.md,
    marginBottom: space.lg,
  },
  passphraseLink: {
    alignSelf: 'center',
  },
  error: {
    marginBottom: space.md,
  },
  regenerate: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    alignSelf: 'center',
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    marginBottom: space.md,
  },
})
