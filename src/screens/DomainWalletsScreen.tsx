import React, { useCallback, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import { useTranslation } from 'react-i18next'
import {
  changeDomainAccess,
  listDomainWallets,
  loadLabels,
  walletCode,
  type AuthorizedWallet,
} from '../wallet/domainAccess'
import { identitySigner } from '../wallet/identitySigner'
import { MenuRow } from '../components/MenuRow'
import { ConfirmSheet, type ConfirmRequest } from '../components/ConfirmSheet'
import { ErrorBox } from '../components/ErrorBox'
import { Skeleton } from '../components/Skeleton'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { font, rhythm, space } from '../theme'
import { Screen } from '../components/Screen'
import { Txt } from '../components/Txt'
import { EmptyState } from '../components/EmptyState'
import { GradientButton } from '../components/GradientButton'

// Who the owner has let onto their domain. The gateway holds pubkeys and nothing else, so the names
// shown here are read from this device; a wallet with no name is shown by its short code.
export function DomainWalletsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<{ navigate: (screen: string, params?: object) => void }>()
  const { domain } = useRoute<RouteProp<RootStackParamList, 'DomainWallets'>>().params
  const [wallets, setWallets] = useState<AuthorizedWallet[] | null>(null)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<ConfirmRequest | null>(null)
  // The list could not be read, which is not the same as a domain no other wallet uses.
  const [loadFailed, setLoadFailed] = useState(false)
  // A focus, a revoke and Try again can each start a read, and only the last one started may land.
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setError(null)
    setLoadFailed(false)
    try {
      const owner = await identitySigner()
      const [list, names] = await Promise.all([
        listDomainWallets({
          gatewayUrl: `https://${domain}`,
          domain,
          ownerPubkey: owner.pubkey,
          sign: owner.sign,
        }),
        loadLabels(),
      ])
      if (seq === loadSeq.current) {
        setWallets(list)
        setLabels(names)
      }
    } catch (err) {
      if (seq === loadSeq.current) {
        // The gateway answers with a code meant for an operator, which shown raw is untranslated and
        // reads as a crash, so the screen says the general message and the code goes to the log.
        console.warn('domain wallets not read:', (err as Error)?.message ?? err)
        setLoadFailed(true)
      }
    }
  }, [domain])

  const retry = (): void => {
    setWallets(null)
    load().catch(() => undefined)
  }

  // Reloads on return from the authorize screen, so a wallet just let in appears without a pull.
  useFocusEffect(
    useCallback(() => {
      // load reports its own failures into the error box, so there is nothing left to catch here.
      load().catch(() => undefined)
    }, [load]),
  )

  const nameOf = (pubkey: string): string => labels[pubkey.toLowerCase()] ?? walletCode(pubkey)

  const revoke = async (wallet: AuthorizedWallet): Promise<void> => {
    const owner = await identitySigner()
    await changeDomainAccess(
      {
        gatewayUrl: `https://${domain}`,
        domain,
        ownerPubkey: owner.pubkey,
        sign: owner.sign,
      },
      'revoke',
      wallet.pubkey,
    )
    await load()
  }

  const askRevoke = (wallet: AuthorizedWallet): void => {
    setAsking({
      title: t('domain.revokeTitle', { name: nameOf(wallet.pubkey) }),
      // States the surprising half plainly, that the address they already hold keeps working,
      // because taking away permission to create names is a different act from taking a name away.
      body: t('domain.revokeBody'),
      confirm: t('domain.revoke'),
      cancel: t('common.cancel'),
      danger: true,
      onConfirm: () => {
        revoke(wallet).catch((err: Error) => {
          // The gateway answers with a code meant for an operator. Shown raw it is untranslated
          // and reads as a crash, so anything unrecognised becomes the general message.
          console.warn('revoke refused:', err.message)
          setError(t('domain.errFailed'))
        })
      },
    })
  }

  return (
    <Screen scroll layout="padded" contentStyle={styles.content}>
      <View style={styles.heading}>
        <Txt role="subheading" tone="default">
          {domain}
        </Txt>
        <Txt role="caption" tone="muted">
          {t('domain.walletsHint')}
        </Txt>
      </View>

      {loadFailed ? (
        <View>
          <ErrorBox message={t('domain.errFailed')} style={styles.error} />
          <GradientButton label={t('common.retry')} variant="secondary" onPress={retry} />
        </View>
      ) : wallets === null ? (
        // The wallet rows themselves, flat and divided, with a bar where the wallet's code goes, so the
        // list takes the ready rows' height.
        <View>
          {[0, 1].map(index => (
            <MenuRow
              key={index}
              bleed
              divider={index === 0}
              icon="key"
              label=""
              right={<Skeleton width="40%" height={font.leading.base} />}
            />
          ))}
        </View>
      ) : wallets.length === 0 ? (
        <EmptyState message={t('domain.noWallets')} />
      ) : (
        // No gap, so each divider meets the row under it.
        <View>
          {wallets.map((wallet, index) => (
            <MenuRow
              key={wallet.pubkey}
              bleed
              divider={index < wallets.length - 1}
              icon="key"
              label={nameOf(wallet.pubkey)}
              value={walletCode(wallet.pubkey)}
              onPress={() => askRevoke(wallet)}
            />
          ))}
        </View>
      )}

      <MenuRow
        bleed
        divider={false}
        icon="plus"
        label={t('domain.authorizeWallet')}
        onPress={() => navigation.navigate('AuthorizeWallet', { domain })}
      />
      <ErrorBox message={error} />
      <ConfirmSheet request={asking} onClose={() => setAsking(null)} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { gap: rhythm.hintToContent },
  heading: { gap: space.sm },
  error: {
    marginBottom: space.md,
  },
})
