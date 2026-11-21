import React from 'react'
import {
  DefaultTheme,
  NavigationContainer,
  useNavigationContainerRef,
} from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import type { NavigatorScreenParams } from '@react-navigation/native'
import { useTranslation } from 'react-i18next'
import { AppDrawer } from './AppDrawer'
import { backToHomeTab } from './backToHomeTab'
import type { HomeTabsParamList } from './HomeTabs'
import { releaseDeeplinksAfterUnlock, setDeeplinkHandler } from '../wallet/deeplink'
import {
  setForegroundNoticeHandler,
  setPushHandler,
  type ForegroundNotice as ForegroundNoticeData,
  type PushDestination,
} from '../wallet/pushRoute'
import { ForegroundNotice } from '../components/ForegroundNotice'
import { useSettledSendNotice } from '../hooks/useSettledSendNotice'
import { HeaderTitle } from '../components/HeaderTitle'
import { useUnderLock } from '../components/UnderLock'
import { ReceivedOverlayHost } from '../components/ReceivedOverlayHost'
import { ReceiveScreen } from '../screens/ReceiveScreen'
import { SendScreen } from '../screens/SendScreen'
import { ScanScreen } from '../screens/ScanScreen'
import { RedeemScreen } from '../screens/RedeemScreen'
import { ConvertScreen } from '../screens/ConvertScreen'
import { AssetDetailScreen } from '../screens/AssetDetailScreen'
import { AssetHistoryScreen } from '../screens/AssetHistoryScreen'
import { AddAssetScreen } from '../screens/AddAssetScreen'
import { NotificationsScreen } from '../screens/NotificationsScreen'
import { NotificationSettingsScreen } from '../screens/NotificationSettingsScreen'
import { LanguageScreen } from '../screens/LanguageScreen'
import { CurrencyScreen } from '../screens/CurrencyScreen'
import { StableBalanceScreen } from '../screens/StableBalanceScreen'
import { UseMyDomainScreen } from '../screens/UseMyDomainScreen'
import { DomainScreen } from '../screens/DomainScreen'
import { DomainWalletsScreen } from '../screens/DomainWalletsScreen'
import { AuthorizeWalletScreen } from '../screens/AuthorizeWalletScreen'
import { DomainAccessRequestScreen } from '../screens/DomainAccessRequestScreen'
import { LnAddressScreen } from '../screens/LnAddressScreen'
import { ContactsScreen } from '../screens/ContactsScreen'
import { ExplorersScreen } from '../screens/ExplorersScreen'
import { RefundDepositScreen } from '../screens/RefundDepositScreen'
import { EmergencyExitScreen } from '../screens/EmergencyExitScreen'
import { emergencyExitLive } from '../wallet/emergencyExit'
import type { ExitSelection } from '../wallet/exitPass'
import { RecoveryPhraseScreen } from '../screens/RecoveryPhraseScreen'
import { SupportScreen } from '../screens/SupportScreen'
import { LegalScreen } from '../screens/LegalScreen'
import { EditWalletScreen } from '../screens/EditWalletScreen'
import { DeleteDataScreen } from '../screens/DeleteDataScreen'
import { AdjustWalletPhotoScreen } from '../screens/AdjustWalletPhotoScreen'
import type { PhotoCrop } from '../wallet/photoCrop'
import { WalletsScreen } from '../screens/WalletsScreen'
import { AddWalletScreen } from '../screens/AddWalletScreen'
import { PinScreen } from '../screens/PinScreen'
import { PinSettingsScreen } from '../screens/PinSettingsScreen'
import { savePin } from '../wallet/pin'
import { disableBiometricUnlock, enableBiometricUnlock, getBiometryKind } from '../wallet/biometrics'
import { useAccent } from '../wallet/dollarMode'
import { colors } from '../theme'

export type RootStackParamList = {
  Main: NavigatorScreenParams<{ Tabs: NavigatorScreenParams<HomeTabsParamList> }> | undefined
  // `assetId` uses the Home list id namespace, BITCOIN_ASSET_ID for Bitcoin and btkn for a token.
  Receive: { assetId?: string } | undefined
  // `picked` tells a second choice of one address from no choice at all, the screen being the same
  // one each time.
  Send: { destination?: string; contactName?: string; assetId?: string; picked?: number } | undefined
  Redeem: { destination?: string } | undefined
  // `mode` diverts the result instead of routing a payment: 'token' returns the id to Add asset,
  // 'wallet' returns a wallet key to the authorise screen.
  Scan: { mode?: 'token' | 'wallet'; domain?: string } | undefined
  Convert: undefined
  Notifications: undefined
  NotificationSettings: undefined
  Language: undefined
  Currency: undefined
  StableBalance: undefined
  // `choose` opens the sheet that picks a name, for a screen that sends the owner here to choose one.
  LnAddress: { choose?: boolean } | undefined
  Contacts: { pick?: boolean } | undefined
  Explorers: undefined
  RefundDeposit: { txid: string; vout: number }
  EmergencyExit: { selection: ExitSelection }
  RecoveryPhrase: undefined
  Support: undefined
  Legal: undefined
  PinSettings: undefined
  SetPin: undefined
  ChangePin: undefined
  EnableBiometrics: undefined
  // `photo` is a photo the adjust step returns, with the square of it the avatar shows.
  EditWallet: { photo?: { uri: string; crop: PhotoCrop } } | undefined
  // The picker's copy, with the size it reported for it.
  AdjustWalletPhoto: { uri: string; width: number; height: number }
  // `thenRemove` names the wallet to remove once Voltz holds the deletion request for it.
  DeleteData: { thenRemove?: string } | undefined
  Wallets: undefined
  AddWallet: undefined
  // `name` rides along so the header title is right on the first frame instead of after the load.
  AssetDetail: { assetId: string; name: string }
  AssetHistory: { assetId: string }
  AddAsset: { scanned?: string } | undefined
  DomainWallets: { domain: string }
  AuthorizeWallet: { domain: string; scanned?: string }
  Domain: undefined
  DomainAccessRequest: undefined
  // `renew` names the domain whose year is being bought again. Present, the screen opens straight at
  // the payment: the domain is already known, so asking for it again would be a press spent on
  // something the app can answer itself.
  UseMyDomain: { renew?: string } | undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()

// Distinct keys force a fresh mount, since a reused instance carries the six filled dots over.
export function ChangePinFlow({ onDone }: { onDone: (pin: string) => void }): React.JSX.Element {
  const [verified, setVerified] = React.useState(false)
  if (!verified) {
    return <PinScreen key="verify" mode="enter" biometrics={false} onDone={() => setVerified(true)} />
  }
  return <PinScreen key="set" mode="set" setup="change" onDone={onDone} />
}

// The typed PIN is what gets stored behind the biometric gate, so the keypad is forced. On Android the
// write raises the system prompt, worded here as the first-run offer words it, or the library shows
// its own English default. A cancelled or failed prompt stores nothing and leaves like a success: the
// PIN settings read the switch again on focus, so it shows off.
export function EnableBiometricsFlow({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <PinScreen
      mode="enter"
      biometrics={false}
      onDone={async pin => {
        const kind = await getBiometryKind().catch(() => null)
        await enableBiometricUnlock(pin, {
          title: t(kind === 'face' ? 'biometricOffer.confirmFace' : 'biometricOffer.confirmFingerprint'),
          cancel: t('common.cancel'),
        }).catch(() => undefined)
        onDone()
      }}
    />
  )
}

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.background,
    card: colors.background,
    text: colors.text,
    // The tab bar and a header draw an edge in this colour by default, and the app draws none.
    border: 'transparent',
    primary: colors.primary,
  },
}

// The route's title, drawn by the app's text so it follows the system text size. Outside the
// navigator, so the header gets the same function on every render.
const renderHeaderTitle = ({ children }: { children: string }) => <HeaderTitle>{children}</HeaderTitle>

export function RootNavigator(): React.JSX.Element {
  const { t } = useTranslation()
  const navRef = useNavigationContainerRef<RootStackParamList>()
  const { accent } = useAccent()
  const theme = { ...navTheme, colors: { ...navTheme.colors, primary: accent } }

  // A payment fulfils the invoice on screen, so only Receive has nothing left to show. Back to the Main
  // beneath, since this runs on every payment and a pushed one would pile up under Home.
  const leaveReceiveForHome = () => {
    if (navRef.isReady() && navRef.getCurrentRoute()?.name === 'Receive') {
      navRef.dispatch(backToHomeTab())
    }
  }

  // This lives only while the navigator is mounted, so App.tsx replays earlier URLs into it.
  const pendingDeeplink = React.useRef<string | null>(null)
  const goToSend = React.useCallback(
    (destination: string) => {
      if (navRef.isReady()) {
        navRef.navigate('Send', { destination })
      } else {
        pendingDeeplink.current = destination
      }
    },
    [navRef],
  )
  // Send reads the destination over the network as it opens, so a link that arrives under the PIN, or
  // on a return whose lock is still being decided, waits in deeplink.ts and reaches Send once, after
  // the unlock.
  const underLock = useUnderLock()
  React.useEffect(() => {
    if (underLock) {
      return
    }
    setDeeplinkHandler(goToSend)
    releaseDeeplinksAfterUnlock()
    return () => setDeeplinkHandler(null)
  }, [goToSend, underLock])

  // A tapped notification needs the same stash for the same reason. The destination is one of the
  // words in the pushRoute table, never a field off the wire, which is what keeps navigate() out of
  // reach of whoever can deliver a message to this device.
  const pendingPush = React.useRef<PushDestination | null>(null)
  const goToPushDestination = React.useCallback(
    (destination: PushDestination) => {
      if (navRef.isReady()) {
        navRef.navigate(destination)
      } else {
        pendingPush.current = destination
      }
    },
    [navRef],
  )
  React.useEffect(() => {
    setPushHandler(goToPushDestination)
    return () => setPushHandler(null)
  }, [goToPushDestination])

  // The same message the system would have drawn had the app been away. It is shown here rather
  // than by a screen because it can arrive on any of them, and because this is where the tap
  // already lands: both roads end at goToPushDestination, so nothing off the wire names a screen.
  const [notice, setNotice] = React.useState<ForegroundNoticeData | null>(null)
  React.useEffect(() => {
    setForegroundNoticeHandler(setNotice)
    return () => setForegroundNoticeHandler(null)
  }, [])

  // The end of a send the confirm screen left on the way.
  useSettledSendNotice(setNotice)

  const pushedScreenOptions = {
    headerShown: true,
    headerStyle: { backgroundColor: colors.background },
    headerShadowVisible: false,
    headerTintColor: colors.text,
    headerTitle: renderHeaderTitle,
    headerBackButtonDisplayMode: 'minimal' as const,
  }

  return (
    <>
    <NavigationContainer
      ref={navRef}
      theme={theme}
      onReady={() => {
        if (pendingDeeplink.current !== null) {
          navRef.navigate('Send', { destination: pendingDeeplink.current })
          pendingDeeplink.current = null
        }
        if (pendingPush.current !== null) {
          navRef.navigate(pendingPush.current)
          pendingPush.current = null
        }
      }}>
      <Stack.Navigator
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        {/* Its header is hidden, but iOS names the back button of every screen pushed from here after
            this title, for VoiceOver and the long-press menu, and falls back to the route name. */}
        <Stack.Screen name="Main" component={AppDrawer} options={{ title: t('nav.home') }} />
        <Stack.Screen
          name="Receive"
          component={ReceiveScreen}
          options={{ ...pushedScreenOptions, title: t('receive.title') }}
        />
        <Stack.Screen
          name="Send"
          component={SendScreen}
          // The long-press back menu would jump past the review interception in usePreventRemove.
          options={{ ...pushedScreenOptions, title: t('send.title'), headerBackButtonMenuEnabled: false }}
        />
        <Stack.Screen
          name="Redeem"
          component={RedeemScreen}
          options={{ ...pushedScreenOptions, title: t('redeem.title') }}
        />
        <Stack.Screen
          name="Scan"
          component={ScanScreen}
          options={{ ...pushedScreenOptions, title: t('scan.title') }}
        />
        <Stack.Screen
          name="Convert"
          component={ConvertScreen}
          options={{ ...pushedScreenOptions, title: t('convert.title') }}
        />
        <Stack.Screen
          name="AssetDetail"
          component={AssetDetailScreen}
          options={({ route }) => ({ ...pushedScreenOptions, title: route.params.name })}
        />
        <Stack.Screen
          name="AssetHistory"
          component={AssetHistoryScreen}
          options={{ ...pushedScreenOptions, title: t('asset.activity') }}
        />
        <Stack.Screen
          name="AddAsset"
          component={AddAssetScreen}
          options={{ ...pushedScreenOptions, title: t('addAsset.title') }}
        />
        <Stack.Screen
          name="Notifications"
          component={NotificationsScreen}
          options={{ ...pushedScreenOptions, title: t('notifications.title') }}
        />
        <Stack.Screen
          name="NotificationSettings"
          component={NotificationSettingsScreen}
          options={{ ...pushedScreenOptions, title: t('notifications.settingsTitle') }}
        />
        <Stack.Screen
          name="Language"
          component={LanguageScreen}
          options={{ ...pushedScreenOptions, title: t('settings.language') }}
        />
        <Stack.Screen
          name="Currency"
          component={CurrencyScreen}
          options={{ ...pushedScreenOptions, title: t('settings.currency') }}
        />
        <Stack.Screen
          name="StableBalance"
          component={StableBalanceScreen}
          options={{ ...pushedScreenOptions, title: t('stable.title') }}
        />
        <Stack.Screen
          name="LnAddress"
          component={LnAddressScreen}
          options={{ ...pushedScreenOptions, title: t('settings.lnAddress') }}
        />
        <Stack.Screen
          name="Domain"
          component={DomainScreen}
          options={{ ...pushedScreenOptions, title: t('domain.hub') }}
        />
        <Stack.Screen
          name="DomainWallets"
          component={DomainWalletsScreen}
          options={{ ...pushedScreenOptions, title: t('domain.allowed') }}
        />
        <Stack.Screen
          name="AuthorizeWallet"
          component={AuthorizeWalletScreen}
          options={{ ...pushedScreenOptions, title: t('domain.authorizeWallet') }}
        />
        <Stack.Screen
          name="UseMyDomain"
          component={UseMyDomainScreen}
          options={{ ...pushedScreenOptions, title: t('useDomain.entry') }}
        />
        <Stack.Screen
          name="DomainAccessRequest"
          component={DomainAccessRequestScreen}
          options={{ ...pushedScreenOptions, title: t('domain.request') }}
        />
        <Stack.Screen
          name="Contacts"
          component={ContactsScreen}
          options={{ ...pushedScreenOptions, title: t('contacts.title') }}
        />
        <Stack.Screen
          name="Explorers"
          component={ExplorersScreen}
          options={{ ...pushedScreenOptions, title: t('explorers.title') }}
        />
        <Stack.Screen
          name="RefundDeposit"
          component={RefundDepositScreen}
          options={{ ...pushedScreenOptions, title: t('deposits.refundTitle') }}
        />
        {emergencyExitLive() && (
          <Stack.Screen
            name="EmergencyExit"
            component={EmergencyExitScreen}
            options={{ ...pushedScreenOptions, title: t('emergencyExit.title') }}
          />
        )}
        <Stack.Screen
          name="RecoveryPhrase"
          component={RecoveryPhraseScreen}
          options={{ ...pushedScreenOptions, title: t('settings.recoveryPhrase') }}
        />
        <Stack.Screen
          name="Support"
          component={SupportScreen}
          options={{ ...pushedScreenOptions, title: t('settings.support') }}
        />
        <Stack.Screen
          name="Legal"
          component={LegalScreen}
          options={{ ...pushedScreenOptions, title: t('settings.legal') }}
        />
        <Stack.Screen
          name="EditWallet"
          component={EditWalletScreen}
          options={{ ...pushedScreenOptions, title: t('editWallet.title') }}
        />
        <Stack.Screen
          name="AdjustWalletPhoto"
          component={AdjustWalletPhotoScreen}
          options={{ ...pushedScreenOptions, title: t('adjustPhoto.title') }}
        />
        <Stack.Screen
          name="DeleteData"
          component={DeleteDataScreen}
          options={{ ...pushedScreenOptions, title: t('deleteData.title') }}
        />
        <Stack.Screen
          name="Wallets"
          component={WalletsScreen}
          options={{ ...pushedScreenOptions, title: t('wallets.title') }}
        />
        <Stack.Screen
          name="AddWallet"
          component={AddWalletScreen}
          // The iOS long-press back menu would jump past the stage interception in usePreventRemove.
          options={{ ...pushedScreenOptions, title: t('addWallet.title'), headerBackButtonMenuEnabled: false }}
        />
        <Stack.Screen
          name="PinSettings"
          component={PinSettingsScreen}
          options={{ ...pushedScreenOptions, title: t('settings.pin') }}
        />
        <Stack.Screen name="SetPin" options={{ ...pushedScreenOptions, title: t('settings.setPin') }}>
          {({ navigation }) => (
            <PinScreen
              mode="set"
              onDone={async pin => {
                await savePin(pin)
                // The biometric entry holds a copy of the old PIN, which would still unlock.
                await disableBiometricUnlock()
                navigation.goBack()
              }}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="ChangePin" options={{ ...pushedScreenOptions, title: t('settings.changePin') }}>
          {({ navigation }) => (
            <ChangePinFlow
              onDone={async pin => {
                await savePin(pin)
                await disableBiometricUnlock()
                navigation.goBack()
              }}
            />
          )}
        </Stack.Screen>
        <Stack.Screen
          name="EnableBiometrics"
          options={{ ...pushedScreenOptions, title: t('settings.biometricTitle') }}>
          {({ navigation }) => <EnableBiometricsFlow onDone={() => navigation.goBack()} />}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
    <ReceivedOverlayHost onDismiss={leaveReceiveForHome} />
    {notice && (
      <ForegroundNotice
        title={notice.title}
        body={notice.body}
        onPress={() => {
          setNotice(null)
          if (notice.destination) {
            goToPushDestination(notice.destination)
          }
        }}
        onDismiss={() => setNotice(null)}
      />
    )}
    </>
  )
}
