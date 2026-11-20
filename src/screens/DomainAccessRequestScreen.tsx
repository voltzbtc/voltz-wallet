import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Share, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import QRCode from 'react-native-qrcode-svg'
import Clipboard from '@react-native-clipboard/clipboard'
import { sparkGetIdentityPubkey } from '../wallet/spark'
import { walletCode, walletKeyUri } from '../wallet/domainAccess'
import { Skeleton } from '../components/Skeleton'
import { TabIcon } from '../components/TabIcon'
import { colors, font, qrFrame, radius, rhythm, space, tracking } from '../theme'
import { Screen } from '../components/Screen'
import { Card } from '../components/Card'
import { ErrorBox } from '../components/ErrorBox'
import { Txt } from '../components/Txt'
import { GradientButton } from '../components/GradientButton'
import { useAccent } from '../wallet/dollarMode'
import { useSideBySide } from '../hooks/useSideBySide'

const QR_SIZE = 180

// What a guest shows the owner of a company domain. The value on screen is this wallet's public
// key, so nothing here is a credential: intercepting it gains an attacker nothing, since only the
// owner's signature grants access. The short code below it is the check that matters, because a
// substituted key would otherwise be invisible against 66 characters of hex.
export function DomainAccessRequestScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { accent } = useAccent()
  // Read on every render, so a text size chosen with the app open regroups the buttons at once.
  const sideBySide = useSideBySide()
  const [pubkey, setPubkey] = useState<string | null>(null)
  // The key could not be read, which is not the same as a read still in flight.
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  // Only the last read started may land, so a second Try again tap cannot be overtaken by the first.
  const readSeq = useRef(0)

  const read = useCallback(() => {
    const seq = ++readSeq.current
    setFailed(false)
    sparkGetIdentityPubkey()
      .then(key => {
        if (mounted.current && seq === readSeq.current) {
          setPubkey(key)
        }
      })
      .catch(() => {
        if (mounted.current && seq === readSeq.current) {
          setFailed(true)
        }
      })
  }, [])

  useEffect(() => {
    mounted.current = true
    read()
    return () => {
      mounted.current = false
    }
  }, [read])

  const copy = (): void => {
    if (!pubkey) {
      return
    }
    Clipboard.setString(pubkey)
    // The check and the word replace the copy mark only on screen, so a screen reader is told as well.
    AccessibilityInfo.announceForAccessibility(t('receive.copied'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Screen scroll layout="padded" contentStyle={styles.content}>
      <Txt role="caption" tone="muted">
        {t('domain.requestHint')}
      </Txt>

      {failed ? (
        // Outside the card, whose fill takes the red text under its contrast.
        <View style={styles.failed}>
          <ErrorBox message={t('domain.errFailed')} />
          <GradientButton label={t('common.retry')} variant="secondary" onPress={read} />
        </View>
      ) : (
        <Card padding="roomy" centered gap="sm">
          {pubkey === null ? (
            <>
              <Skeleton width={QR_SIZE} height={QR_SIZE} borderRadius={radius.md} />
              <Skeleton width={80} height={font.leading.xs} />
              <Skeleton width={110} height={font.size.xxl} />
            </>
          ) : (
            <>
              <View style={styles.qrWrap}>
                <QRCode value={walletKeyUri(pubkey)} size={QR_SIZE} />
              </View>
              <Txt role="micro" tone="muted">
                {t('domain.yourCode')}
              </Txt>
              <Txt role="titleStrong" tone="default" style={styles.code}>
                {walletCode(pubkey)}
              </Txt>
            </>
          )}
        </Card>
      )}

      <Txt role="caption" tone="muted" style={styles.check}>
        {t('domain.codeMatch')}
      </Txt>

      {/* Side by side each button has half the row, which at the larger text sizes breaks a label
          such as "Schlüssel kopieren" inside a word, so there they stack, each across the screen. */}
      {pubkey !== null && (
        <View style={[styles.actions, !sideBySide && styles.actionsStacked]}>
          <View style={sideBySide ? styles.actionHalf : styles.actionFull}>
            <GradientButton
              variant="secondary"
              singleLine={sideBySide}
              label={copied ? t('receive.copied') : t('domain.copyKey')}
              accessibilityLabel={t('domain.copyKey')}
              icon={<TabIcon name={copied ? 'check' : 'copy'} color={copied ? accent : colors.text} size={18} />}
              onPress={copy}
            />
          </View>
          <View style={sideBySide ? styles.actionHalf : styles.actionFull}>
            <GradientButton
              variant="secondary"
              singleLine={sideBySide}
              label={t('domain.share')}
              icon={<TabIcon name="share" color={colors.text} size={18} />}
              onPress={() => Share.share({ message: walletKeyUri(pubkey) }).catch(() => undefined)}
            />
          </View>
        </View>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { gap: rhythm.hintToContent },
  qrWrap: qrFrame,
  // Wide tracking is what makes six characters read as a code to compare rather than a word.
  code: { letterSpacing: tracking.code },
  check: { textAlign: 'center' },
  failed: { gap: space.md },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  actionsStacked: { flexDirection: 'column' },
  actionHalf: { flex: 1 },
  // Each stacked button stretched across the screen, against the row's centring.
  actionFull: { alignSelf: 'stretch' },
})
