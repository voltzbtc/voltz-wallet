import React, { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  DrawerContentScrollView,
  type DrawerContentComponentProps,
} from '@react-navigation/drawer'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
import { languageLabel } from '../i18n/languages'
import { MenuRow } from '../components/MenuRow'
import { TabIcon } from '../components/TabIcon'
import { emergencyExitLive } from '../wallet/emergencyExit'
import { hasPin } from '../wallet/pin'
import { loadDisplayCurrency } from '../wallet/settings'
import { type FiatCurrency } from '../wallet/fiat'
import { resolveDefaultFiat } from '../wallet/deviceLocale'
import { getWalletIdentity, onActiveWalletChanged } from '../wallet/wallet'
import { formatFingerprint, resolveWalletDisplay } from '../wallet/walletIdentity'
import { loadWalletMeta, type WalletMeta } from '../wallet/walletMeta'
import { WalletAvatar } from '../components/WalletAvatar'
import { Skeleton } from '../components/Skeleton'
import { version } from '../../package.json'
import type { RootStackParamList } from './RootNavigator'
import { colors, font, radius, space } from '../theme'
import { Touch } from '../components/Touch'
import { Txt } from '../components/Txt'

type RowScreen =
  | 'Wallets'
  | 'RecoveryPhrase'
  | 'PinSettings'
  | 'SetPin'
  | 'LnAddress'
  | 'Contacts'
  | 'StableBalance'
  | 'Currency'
  | 'Language'
  | 'NotificationSettings'
  | 'Explorers'
  | 'Support'
  | 'Legal'

export function DrawerContent(props: DrawerContentComponentProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const insets = useSafeAreaInsets()

  const [pinSet, setPinSet] = useState(false)
  const [currency, setCurrency] = useState<FiatCurrency>(
    resolveDefaultFiat(i18n.language),
  )
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [meta, setMeta] = useState<WalletMeta | null>(null)

  useFocusEffect(
    useCallback(() => {
      let active = true
      ;(async () => {
        const [pin, savedCurrency] = await Promise.all([hasPin(), loadDisplayCurrency()])
        if (!active) {
          return
        }
        setPinSet(pin)
        // Re-derived on focus, so the drawer does not keep a default from an earlier language.
        setCurrency(savedCurrency ?? resolveDefaultFiat(i18n.language))
      })()
      return () => {
        active = false
      }
    }, []),
  )

  // The number of the last identity read, the only one whose answer lands.
  const identityRead = useRef(0)
  const readIdentity = useCallback(() => {
    const mine = ++identityRead.current
    getWalletIdentity()
      .then(async id => {
        const fp = id.fingerprint || null
        // A mark that cannot be read leaves the default look, never the placeholder for good.
        const nextMeta = fp ? await loadWalletMeta(fp).catch(() => null) : null
        if (mine === identityRead.current) {
          setFingerprint(fp)
          setMeta(nextMeta)
        }
      })
      .catch(() => undefined)
  }, [])

  // A mount-only read leaves a stale identity after the active wallet is switched or deleted.
  useFocusEffect(
    useCallback(() => {
      readIdentity()
      return () => {
        identityRead.current += 1
      }
    }, [readIdentity]),
  )

  // A switch made with the drawer open: the previous wallet's name and mark give way to the
  // placeholder until the new wallet's are read, rather than standing for it meanwhile.
  useEffect(
    () =>
      onActiveWalletChanged(() => {
        setFingerprint(null)
        setMeta(null)
        readIdentity()
      }),
    [readIdentity],
  )

  // A row opens a screen of the root stack, an action the drawer's router never sees, so the drawer
  // stays open beneath it and back from that screen returns to the menu. Any other way off Home, a
  // deeplink or a tapped notification, is a flow of its own whose end on Home the drawer must not cover,
  // so the drawer closes when Main regains focus. Not on blur: on Android a drawer animated closed while
  // another screen covers Main can come back drawn open with its status closed, and then nothing closes
  // it.
  const drawer = props.navigation
  const leftByRow = useRef(false)
  useEffect(
    () =>
      navigation.addListener('focus', () => {
        if (!leftByRow.current) {
          drawer.closeDrawer()
        }
        leftByRow.current = false
      }),
    [navigation, drawer],
  )
  // A tap that lands while a deeplink is already covering Main leaves nothing by the row, so that flow
  // still closes the drawer on its way back.
  const openRow = (screen: RowScreen) => {
    leftByRow.current = navigation.isFocused()
    navigation.navigate(screen)
  }

  const display = fingerprint ? resolveWalletDisplay(fingerprint, meta, t('drawer.walletName')) : null

  return (
    <DrawerContentScrollView
      {...props}
      contentContainerStyle={[
        styles.container,
        { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.lg },
      ]}>
      <View style={styles.menu}>
        {/* The row is exactly as tall as the avatar, so a tap a pixel outside needs the slop. */}
        <Touch
          onPress={() => openRow('Wallets')}
          feedback="link"
          // A label replaces what a screen reader reads inside, so it names the wallet as well as
          // where the row leads.
          label={
            display && fingerprint
              ? t('drawer.identity', { name: display.name, fingerprint: formatFingerprint(fingerprint) })
              : t('wallets.title')
          }
          hitSlop={space.md}
          style={styles.identity}>
          {display ? (
            <WalletAvatar
              color={display.color}
              imagePath={display.imagePath}
              crop={display.imageCrop}
              monogram={display.monogram}
            />
          ) : (
            <Skeleton width={44} height={44} borderRadius={radius.full} />
          )}
          <View style={styles.identityText}>
            {display ? (
              <>
                <Txt role="subheading">{display.name}</Txt>
                {fingerprint && (
                  <Txt role="caption" tone="muted">
                    {formatFingerprint(fingerprint)}
                  </Txt>
                )}
              </>
            ) : (
              // The name's role declares no leading, so its bar takes the type size; the
              // fingerprint's caption line has one.
              <>
                <Skeleton width={120} height={font.size.lg} />
                <Skeleton width={72} height={font.leading.sm} />
              </>
            )}
          </View>
          <TabIcon name="chevron" color={colors.textSecondary} size={18} />
        </Touch>

        {/* Recovery first, as the most safety-critical row in a non-custodial wallet. */}
        <View>
          <MenuRow
            bleed
            icon="key"
            label={t('settings.recoveryPhrase')}
            onPress={() => openRow('RecoveryPhrase')}
          />
          <MenuRow
            bleed
            icon="lock"
            label={t('settings.pin')}
            onPress={() => openRow(pinSet ? 'PinSettings' : 'SetPin')}
          />
          <MenuRow
            bleed
            icon="bolt"
            label={t('settings.lnAddress')}
            onPress={() => openRow('LnAddress')}
          />
          <MenuRow
            bleed
            icon="contacts"
            label={t('contacts.title')}
            onPress={() => openRow('Contacts')}
          />
          <MenuRow
            bleed
            icon="dollar"
            label={t('settings.stableBalance')}
            onPress={() => openRow('StableBalance')}
          />
          <MenuRow
            bleed
            icon="banknote"
            label={t('settings.currency')}
            value={currency}
            onPress={() => openRow('Currency')}
          />
          <MenuRow
            bleed
            icon="globe"
            label={t('settings.language')}
            value={languageLabel(i18n.language)}
            onPress={() => openRow('Language')}
          />
          <MenuRow
            bleed
            icon="bell"
            label={t('notifications.title')}
            onPress={() => openRow('NotificationSettings')}
          />
          <MenuRow
            bleed
            icon="server"
            label={t('explorers.title')}
            onPress={() => openRow('Explorers')}
          />
          {emergencyExitLive() && (
            <MenuRow
              bleed
              icon="shield"
              label={t('emergencyExit.title')}
              onPress={() => {
                leftByRow.current = navigation.isFocused()
                navigation.navigate('EmergencyExit', { selection: 'all' })
              }}
            />
          )}
          <MenuRow
            bleed
            icon="help"
            label={t('settings.support')}
            onPress={() => openRow('Support')}
          />
          <MenuRow
            bleed
            divider={false}
            icon="document"
            label={t('settings.legal')}
            onPress={() => openRow('Legal')}
          />
        </View>
      </View>

      <Txt role="caption" tone="muted" style={styles.version}>
        {t('drawer.version', { version })}
      </Txt>
    </DrawerContentScrollView>
  )
}

const styles = StyleSheet.create({
  // Start and end, since the drawer's scroll sets its own 12 on those two and they beat a horizontal
  // padding, which left the rows off the app's gutter.
  container: {
    flexGrow: 1,
    paddingStart: space.xl,
    paddingEnd: space.xl,
  },
  menu: {
    flex: 1,
    gap: space.lg,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    // Carries the avatar-height row comfortably past the 44pt target.
    paddingVertical: space.xs,
  },
  identityText: {
    flex: 1,
    gap: space.xs,
  },
  version: {
    textAlign: 'center',
  },
})
