import React, { useEffect, useState } from 'react'
import { StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { passesDeviceCheck } from '../wallet/biometrics'
import { countUnconfirmedWallets, eraseAllWallets } from '../wallet/wallet'
import { space } from '../theme'
import { ErrorBox } from './ErrorBox'
import { Notice } from './Notice'
import { GradientButton } from './GradientButton'
import { Sheet } from './Sheet'
import { Txt } from './Txt'

type Props = {
  visible: boolean
  onClose: () => void
  // Once the device check passed, right before the erase starts.
  onErasing?: () => void
  // An erase that started and failed.
  onUnfinished?: () => void
  onErased: () => void
}

// What the erase costs, said before it can happen. The friction is on purpose, since nothing brings a
// wallet back without its recovery phrase: this sheet, a tap, and the device's own check.
export function ForgotPinSheet({ visible, onClose, onErasing, onUnfinished, onErased }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<'unchecked' | 'unfinished' | null>(null)
  // The wallets a person is about to lose unless they saved the words. Absent until read, and when the
  // read fails, where the sentence above it still warns of every wallet.
  const [unconfirmed, setUnconfirmed] = useState<number | null>(null)

  useEffect(() => {
    if (!visible) {
      return
    }
    let current = true
    countUnconfirmedWallets().then(
      count => {
        if (current) {
          setUnconfirmed(count)
        }
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [visible])

  async function erase() {
    setFailure(null)
    setBusy(true)
    let started = false
    try {
      const passed = await passesDeviceCheck({ title: t('pin.forgotCheckPrompt'), cancel: t('common.cancel') })
      if (!passed) {
        setFailure('unchecked')
        return
      }
      started = true
      onErasing?.()
      await eraseAllWallets()
      onErased()
    } catch (err) {
      console.warn(`erase did not finish: ${(err as Error)?.message ?? String(err)}`)
      setFailure('unfinished')
      if (started) {
        onUnfinished?.()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      visible={visible}
      // Closing halfway would leave an erase running behind the lock, with no message when it fails.
      onClose={busy ? () => undefined : onClose}
      closeLabel={t('common.close')}>
      <Txt role="subheading">{t('pin.forgotTitle')}</Txt>
      <Txt role="body" tone="muted">
        {t('pin.forgotBody')}
      </Txt>
      {unconfirmed !== null && unconfirmed > 0 && (
        // A warning rather than an alarm, so the one red block under it is the action.
        <Notice>
          <Txt role="bodyStrong">{t('pin.forgotUnconfirmed', { count: unconfirmed })}</Txt>
        </Notice>
      )}
      {failure && (
        <ErrorBox
          message={t(failure === 'unchecked' ? 'pin.forgotNotChecked' : 'pin.forgotFailed')}
          style={styles.error}
        />
      )}
      <GradientButton
        label={failure === 'unfinished' ? t('common.retry') : t('pin.forgotErase')}
        variant="danger"
        onPress={erase}
        loading={busy}
      />
      <GradientButton label={t('common.cancel')} variant="secondary" onPress={onClose} disabled={busy} />
    </Sheet>
  )
}

const styles = StyleSheet.create({
  error: {
    marginTop: space.xs,
  },
})
