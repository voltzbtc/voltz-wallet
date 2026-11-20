import React, { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import { useTranslation } from 'react-i18next'
import Clipboard from '@react-native-clipboard/clipboard'
import { changeDomainAccess, parseWalletKey, saveLabel, walletCode } from '../wallet/domainAccess'
import { identitySigner } from '../wallet/identitySigner'
import { GradientButton } from '../components/GradientButton'
import { ErrorBox } from '../components/ErrorBox'
import { MenuRow } from '../components/MenuRow'
import { Screen } from '../components/Screen'
import { Card } from '../components/Card'
import { Txt } from '../components/Txt'
import { Touch } from '../components/Touch'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { space, tracking } from '../theme'
import { Field } from '../components/Field'

// The owner confirms one wallet onto their domain. The key arrives by scan or paste; what is shown
// for confirmation is the short code, because comparing 66 hex characters by eye is not a check
// anyone performs. The label never leaves this device: the gateway stores pubkeys only.
export function AuthorizeWalletScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<{
    goBack: () => void
    navigate: (screen: string, params?: object) => void
    setParams: (params: { scanned?: string }) => void
  }>()
  const params = useRoute<RouteProp<RootStackParamList, 'AuthorizeWallet'>>().params
  const [key, setKey] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The scanner navigates back to this screen, which is already mounted, so a scan arrives as a
  // params update rather than a fresh mount.
  const scanned = params?.scanned
  useEffect(() => {
    if (!scanned) {
      return
    }
    const parsed = parseWalletKey(scanned)
    setKey(parsed)
    setError(parsed ? null : t('domain.notAWallet'))
  }, [scanned, t])

  const paste = async (): Promise<void> => {
    const parsed = parseWalletKey(await Clipboard.getString())
    setKey(parsed)
    setError(parsed ? null : t('domain.notAWallet'))
  }

  // Back to scan and paste. The scanned param is cleared too, since the effect above reads a scan
  // only when the param changes: left in place, scanning the same key again would show nothing.
  // The label goes with the key, so a name typed for one wallet never lands on another.
  const readAnother = (): void => {
    setKey(null)
    setLabel('')
    setError(null)
    navigation.setParams({ scanned: undefined })
  }

  const authorize = async (): Promise<void> => {
    if (!key || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const owner = await identitySigner()
      await changeDomainAccess(
        {
          gatewayUrl: `https://${params.domain}`,
          domain: params.domain,
          ownerPubkey: owner.pubkey,
          sign: owner.sign,
        },
        'authorize',
        key,
      )
      await saveLabel(key, label)
      navigation.goBack()
    } catch (err) {
      setError(reason(t, (err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen scroll keyboard layout="padded" contentStyle={styles.content}>
      {key === null ? (
        <>
          <Txt role="caption" tone="muted">
            {t('domain.scanHint')}
          </Txt>
          {/* One group, so the divider meets the row under it rather than floating in the gap. */}
          <View>
            <MenuRow
              bleed
              icon="scan"
              label={t('domain.scan')}
              onPress={() => navigation.navigate('Scan', { mode: 'wallet', domain: params.domain })}
            />
            <MenuRow
              bleed
              divider={false}
              icon="copy"
              label={t('domain.paste')}
              onPress={() => paste().catch(() => setError(t('domain.notAWallet')))}
            />
          </View>
        </>
      ) : (
        <>
          <Card padding="roomy" centered gap="sm">
            <Txt role="micro" tone="muted">
              {t('domain.theirCode')}
            </Txt>
            <Txt role="titleStrong" style={styles.code}>
              {walletCode(key)}
            </Txt>
          </Card>
          <Txt role="caption" tone="muted" style={styles.centre}>
            {t('domain.codeMatch')}
          </Txt>
          <Touch
            onPress={readAnother}
            disabled={busy}
            feedback="link"
            hitSlop={space.sm}
            style={styles.another}
          >
            <Txt role="bodyStrong" tone="accent">
              {t('domain.useAnotherWallet')}
            </Txt>
          </Touch>

          <Field
            value={label}
            onChangeText={setLabel}
            label={t('domain.labelPlaceholder')}
            hint={t('domain.labelPrivate')}
            maxLength={40}
            autoCapitalize="words"
          />

          <ErrorBox message={error} />
          <GradientButton
            label={t('domain.authorize')}
            onPress={() => authorize().catch((err: Error) => setError(reason(t, err.message)))}
            loading={busy}
          />
        </>
      )}
      {key === null && <ErrorBox message={error} />}
    </Screen>
  )
}

// The gateway answers with a machine-readable reason; anything unrecognised keeps its own text so a
// failure is never silent.
function reason(t: (key: string) => string, code: string): string {
  const known: Record<string, string> = {
    domain_is_public: 'domain.errPublic',
    only_the_owner_may_authorize: 'domain.errNotOwner',
    unknown_domain: 'domain.errUnknown',
    invalid_wallet_key: 'domain.notAWallet',
  }
  if (known[code]) {
    return t(known[code]!)
  }
  // An unrecognised code is written for an operator, not for the person holding the phone, and
  // reads to them as though the app broke.
  console.warn('domain authorization refused:', code)
  return t('domain.errFailed')
}

const styles = StyleSheet.create({
  content: { gap: space.lg },
  // Only what the role does not carry. The wide tracking is what makes six characters read as a
  // code to be compared rather than as a word.
  code: { letterSpacing: tracking.code },
  centre: { textAlign: 'center' },
  another: { alignSelf: 'center' },
})
