import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  BackHandler,
  I18nManager,
  Image,
  Keyboard,
  Linking,
  ScrollView,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native'
import { FontScaleProvider } from './src/components/Text'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import {
  getInitialNotification,
  getMessaging,
  onMessage,
  onNotificationOpenedApp,
  type RemoteMessage,
} from '@react-native-firebase/messaging'
import i18n from './src/i18n'
import { PRIMARY_ID } from './src/wallet/seed'
import { useSeedPair } from './src/hooks/useSeedPair'
import { useForegroundSync } from './src/hooks/useForegroundSync'
import { useRelock } from './src/hooks/useRelock'
import { dismissPresented } from './src/wallet/relock'
import { addFirstPasskeyWallet, addFirstWallet, settleActiveWallet } from './src/wallet/wallet'
import { activeWalletOwingWords, passkeyOffered, passkeyWordsOwed, type PasskeyWallet } from './src/wallet/passkey'
import { getActiveWalletId } from './src/wallet/walletRegistry'
import { SUPPORT_EMAIL } from './src/wallet/recover'
import { hasPin, savePin } from './src/wallet/pin'
import { routeLightningUrl } from './src/wallet/deeplink'
import { routeForegroundMessage, routePushNotification } from './src/wallet/pushRoute'
import { loadDisplayLanguage, loadDollarMode } from './src/wallet/settings'
import { settleDirection } from './src/i18n/directionRestart'
import { pinBundleLanguage } from './src/i18n/bundleLanguage'
import { BackupScreen } from './src/screens/BackupScreen'
import { ImportScreen } from './src/screens/ImportScreen'
import { PasskeyWordsScreen } from './src/screens/PasskeyWordsScreen'
import { PinScreen } from './src/screens/PinScreen'
import { BiometricOfferScreen } from './src/screens/BiometricOfferScreen'
import { ForgotPinSheet } from './src/components/ForgotPinSheet'
import {
  biometricOfferAfterUnlock,
  enableBiometricUnlock,
  getBiometryKind,
  markBiometricOffered,
  type BiometryKind,
} from './src/wallet/biometrics'
import { RootNavigator } from './src/navigation/RootNavigator'
import { DollarModeProvider } from './src/wallet/dollarMode'
import { onSparkConnected } from './src/wallet/spark'
import { startStoreSync } from './src/wallet/storePurchase'
import { getDistribution } from './src/config'
import { ensurePushRegistered } from './src/wallet/pushToken'
import { useNotificationRecheck } from './src/hooks/useNotificationRecheck'
import { SplashScreen } from './src/screens/SplashScreen'
import { ErrorBoundary } from './src/components/ErrorBoundary'
import { UnderLock } from './src/components/UnderLock'
import { GradientButton } from './src/components/GradientButton'
import { PasskeyChoice, PasskeyRestore } from './src/components/PasskeyAction'
import { Touch } from './src/components/Touch'
import { ScreenTitle } from './src/components/ScreenTitle'
import { Txt } from './src/components/Txt'
import { TermsAcceptance } from './src/components/TermsAcceptance'
import { SupportMailCard, useSupportMail, type SupportNote } from './src/components/SupportMail'
import { AdultsOnly } from './src/components/AdultsOnly'
import { askAgeSignal, isAgeRefusal } from './src/wallet/ageSignal'
import { useMinorSignal } from './src/hooks/useMinorSignal'
import { colors, layer, radius, space } from './src/theme'

type Stage =
  | 'loading'
  | 'bootFailed'
  | 'welcome'
  | 'backup'
  | 'import'
  | 'passkeyWords'
  | 'passkeyVerify'
  | 'setPin'
  | 'biometrics'
  | 'locked'
  | 'ready'

// The leading-edge swipe back on the first-run steps takes a strip as wide as the system's own, a few
// points of travel before it takes over from a scroll, and a distance or speed that completes it.
const EDGE_WIDTH = space.xl
const EDGE_START = space.sm
const EDGE_DISTANCE = 2 * space.xxl
const EDGE_FLING = 500
// One object for the app's whole life: the card starts at Copy again whenever its note is a new
// object, so a fresh literal on each render would undo Copied at every re-render.
const NO_NOTE: SupportNote = { mail: null, text: null }

// The first-run steps and the biometric offer, where Android back stays in the app. Welcome, the
// lock and the navigator keep the system's own back.
const ONBOARDING: ReadonlySet<Stage> = new Set<Stage>([
  'backup',
  'import',
  'passkeyWords',
  'passkeyVerify',
  'setPin',
  'biometrics',
])

function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [stage, setStage] = useState<Stage>('loading')
  // The stage of the latest render, for a callback held by a screen that may already be gone.
  const stageNow = useRef(stage)
  stageNow.current = stage
  const mail = useSupportMail()
  // Read at boot so the accent opens correct instead of flashing while the SDK connects.
  const [dollarModeInit, setDollarModeInit] = useState(false)
  const [splashDone, setSplashDone] = useState(false)
  // Set when the first seed write starts. A step back from there could lead into a second write, so
  // every step from it on has no back. Only a passkey's failed write clears it, since the next tap
  // derives the same words and nothing on screen is lost.
  const [committed, setCommitted] = useState(false)
  // The first write under way, so a second tap on I wrote them down or Restore waits on it and writes
  // nothing. Cleared only by a write that failed, which the step can try again.
  const writing = useRef<Promise<void> | null>(null)
  // The PIN just set or just verified, held only while the biometric offer is on screen.
  const [offer, setOffer] = useState<{ pin: string; kind: NonNullable<BiometryKind> } | null>(null)
  const [forgot, setForgot] = useState(false)
  // A boot that failed because the Keychain holds entries no key on this phone can open, which is
  // what a copy of the app's data from another phone leaves (Android's Keystore keys never move).
  const [unreadable, setUnreadable] = useState(false)
  // Kept from the press that opened the sheet, since the erase moves the stage while the sheet is up.
  const [forgotReason, setForgotReason] = useState<'forgot' | 'unreadable'>('forgot')
  // The lock takes only a typed PIN: a biometric unlock landed on words the wallet still owes, which
  // show only behind the typed PIN, as on the recovery phrase screen.
  const [typedOnly, setTypedOnly] = useState(false)
  // The wallet whose words are owed before the step after them. Only its id: the words stay in the
  // Keychain, and their screen reads them for as long as it is up.
  const [owed, setOwed] = useState<{ id: string; next: 'setPin' | 'ready' } | null>(null)
  // A passkey sheet open over the first run, which holds the ways out of the step.
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const seed = useSeedPair()
  const minor = useMinorSignal()
  useForegroundSync()
  useNotificationRecheck()

  // Set once a PIN has been entered or set in this process, and cleared by every boot. From then on,
  // on every stage, RELOCK_AFTER_MS in the background asks the PIN again.
  const [unlockedOnce, setUnlockedOnce] = useState(false)
  // Moved by every relock and by the start of an erase, so a step already under way (an unlock still
  // reading, the offer's write) lands on nothing past it. `lockSeq` is its copy for render: each lock
  // draws a PinScreen of its own, whose answers carry the generation it was drawn under, so a PIN or a
  // biometric that answers after a newer lock opens nothing.
  const lockGen = useRef(0)
  const [lockSeq, setLockSeq] = useState(0)
  // An erase under way from Forgot PIN, during which the lock draws no keypad, since an unlock there
  // would bring back the navigator the erase took down.
  const [erasing, setErasing] = useState(false)
  // The lock asked again over the navigator, drawn over it rather than in place of it, so nothing
  // under it unmounts.
  const [relocked, setRelocked] = useState(false)
  const lockDrawn = useRelock(unlockedOnce, stage === 'locked' || relocked, async () => {
    // iOS presents these over the app's whole view, above the lock; the native cover hides them until
    // they are gone.
    await dismissPresented()
    // A field focused under the lock would bring its keyboard back over it and take the keys.
    Keyboard.dismiss()
    setForgot(false)
    lockGen.current += 1
    setLockSeq(lockGen.current)
    // Read after the dismissal, since an unlock under way may have moved the stage meanwhile.
    if (stageNow.current === 'ready') {
      setRelocked(true)
      return
    }
    // The owed passkey words and the biometric offer keep no navigator under them, so the lock
    // takes their place and the PIN leads on as it does at boot: to the words while they are owed,
    // to the offer only while it was never made, otherwise to the wallet. The PIN the offer held goes
    // with it.
    setOffer(null)
    setStage('locked')
  })

  // Back on the lock leaves the app, as it does on the boot's lock, and never reaches the screens
  // under it.
  useEffect(() => {
    if (!relocked) {
      return
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      BackHandler.exitApp()
      return true
    })
    return () => sub.remove()
  }, [relocked])

  // Links must be captured from the moment the app is alive, including while locked, since the
  // navigator that routes them mounts later and drains what it finds.
  // Re-points this device whenever the active wallet connects, since the gateway holds one wallet
  // per device token. It is silent by design and answers from the permission already granted, so a
  // wallet switch never raises a dialog. The dialog belongs on the receive screen, where the user
  // just asked to be paid.
  useEffect(() => onSparkConnected(() => {
    ensurePushRegistered(false).catch(() => undefined)
  }), [])

  // The store hands a purchase approved later, or one a killed app left unfinished, to a listener
  // that has to be up for as long as the app is. Settling one means signing for it, so the sync waits
  // for a wallet to be ready, and a build that sells in sats has nothing to settle.
  useEffect(() => {
    if (stage !== 'ready' || getDistribution() !== 'store') {
      return
    }
    return startStoreSync()
  }, [stage])

  // One step back from each first-run step. Going back only changes the step: the drawn pair and the
  // Keychain stay as they are. Create wallet on the welcome draws a new pair all the same, so backing
  // out to the welcome and creating again shows other words.
  function stepBack(): Stage | null {
    // Past the write, and the one step back that exists there: the words are read again, and the way
    // out of them stays held until they are proved.
    if (stage === 'passkeyVerify') {
      return 'passkeyWords'
    }
    if (committed || passkeyBusy) {
      return null
    }
    switch (stage) {
      case 'backup':
      case 'import':
        return 'welcome'
      default:
        return null
    }
  }
  const back = stepBack()
  const goBack = back ? () => setStage(back) : undefined

  // iOS steps back with a swipe from the leading edge, which these first-run steps lack as they are not
  // in a navigator, so the swipe is drawn here. It takes the same step as the back button and Android
  // back, and none at all where they take none, past the seed write included.
  const edgeBack = Gesture.Pan()
    .withTestId('onboarding-edge-back')
    .runOnJS(true)
    .enabled(back !== null)
    .hitSlop(I18nManager.isRTL ? { right: 0, width: EDGE_WIDTH } : { left: 0, width: EDGE_WIDTH })
    .activeOffsetX(I18nManager.isRTL ? -EDGE_START : EDGE_START)
    .failOffsetY([-EDGE_START, EDGE_START])
    .onEnd((event, success) => {
      const along = I18nManager.isRTL ? -event.translationX : event.translationX
      const flung = (I18nManager.isRTL ? -event.velocityX : event.velocityX) > EDGE_FLING
      if (success && back && (along > EDGE_DISTANCE || flung)) {
        setStage(back)
      }
    })

  // Mid-onboarding, Android back takes the step back or does nothing. Leaving the app there would
  // drop a phrase the person may be halfway through writing down.
  const onboarding = ONBOARDING.has(stage)
  useEffect(() => {
    if (!onboarding) {
      return
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (back) {
        setStage(back)
      }
      return true
    })
    return () => sub.remove()
  }, [onboarding, back])

  useEffect(() => {
    Linking.getInitialURL()
      .then(url => url && routeLightningUrl(url))
      .catch(() => undefined)
    const sub = Linking.addEventListener('url', ({ url }) => routeLightningUrl(url))
    return () => sub.remove()
  }, [])

  // A tapped notification is captured here for the same reason a URL is, and drained by the same
  // navigator. Both entry points hand the payload to pushRoute, the only place that turns one into
  // a destination, so nothing off the wire ever names a screen.
  //
  // setBackgroundMessageHandler stays absent. Every message the gateway sends carries a
  // notification block, which the system draws on its own while the app is away, so a background
  // handler would buy an execution surface and change nothing.
  //
  // onMessage is here because that sentence is only true while the app is away. With the app in
  // front, FCM hands the message to the process and draws nothing, by design, so without a
  // listener a message that arrives while the app is open is lost, and a customer using the app at
  // that moment is the one most likely to be waiting for it.
  useEffect(() => {
    // A throw here is a crash on open, and the payload comes from the network, so nothing is read
    // off a message that is absent.
    const open = (message: RemoteMessage | null) => {
      if (!message) {
        return
      }
      routePushNotification(message.data)
    }
    // Wrapped because these two are synchronous, and a throw that leaves the effect keeps the app
    // from mounting, so a fault in notification routing would cost the wallet itself. Every other
    // call site reaches this module from an async function that swallows, and this one is the odd
    // one out only because it runs at boot, which is where it matters most.
    try {
      const messaging = getMessaging()
      // The tap that started the process, and then the taps that bring it back to the front.
      getInitialNotification(messaging).then(open).catch(() => undefined)
      const taps = onNotificationOpenedApp(messaging, open)
      // Arrivals while the app is in front, which the system does not draw. They are shown in the
      // app rather than posted to the tray, because somebody looking at the screen has already been
      // reached, and a second copy on the lock screen for something they can see is noise.
      const arrivals = onMessage(messaging, routeForegroundMessage)
      return () => {
        taps()
        arrivals()
      }
    } catch {
      return
    }
  }, [])

  // Set while a boot runs, so a second tap on Try again starts none of its own.
  const booting = useRef(false)
  const [booted, setBooted] = useState(true)

  const boot = useCallback(() => {
    if (booting.current) {
      return
    }
    booting.current = true
    setBooted(false)
    // A boot opens nothing, so nothing is past a PIN until the next one is entered or set.
    setUnlockedOnce(false)
    setRelocked(false)
    // A retry stays on the failure page with its button turning: the loading stage draws nothing, and
    // by then the splash that covered it at launch is gone.
    setStage(current => (current === 'bootFailed' ? current : 'loading'))
    ;(async () => {
      const savedLanguage = await loadDisplayLanguage()
      if (savedLanguage && savedLanguage !== i18n.language) {
        await i18n.changeLanguage(savedLanguage)
      }
      if (savedLanguage) {
        pinBundleLanguage(savedLanguage)
      }
      // A direction that disagrees with the running one restarts once; the boot after it continues
      // from here whether or not the restart took.
      if ((await settleDirection(savedLanguage ?? i18n.language)) === 'restarting') {
        return
      }
      // Settling may move the active pointer off a wallet whose seed is not on this device, so the
      // reads below take the id from the registry after it.
      if (!(await settleActiveWallet())) {
        setStage('welcome')
        return
      }
      setDollarModeInit(await loadDollarMode((await getActiveWalletId()) ?? PRIMARY_ID))
      // A wallet never opens without a PIN. A seed with none is a first run cut off between the seed
      // and the PIN, so the boot resumes at the PIN step it was on, where back does nothing. A first run
      // cut before its passkey words were proved resumes at those, which come before the PIN.
      const pinned = await hasPin()
      const owing = pinned ? null : await activeWalletOwingWords()
      if (owing) {
        setOwed({ id: owing, next: 'setPin' })
        setStage('passkeyWords')
        return
      }
      setStage(pinned ? 'locked' : 'setPin')
    })()
      .catch((err: unknown) => {
        // Rather than guess whether a wallet or a PIN exists, the boot fails closed on a stage that
        // opens no wallet and creates no PIN, and offers to run again or to write to support. A read
        // the Keystore could not decrypt is not an absent seed either, since the same code can come
        // from a passing fault, so it moves nothing; it adds the way out a person takes on purpose.
        console.warn(`boot did not finish: ${(err as Error)?.message ?? String(err)}`)
        setUnreadable((err as { code?: unknown } | null)?.code === 'E_CRYPTO_FAILED')
        setStage('bootFailed')
      })
      .finally(() => {
        booting.current = false
        setBooted(true)
      })
  }, [])

  useEffect(boot, [boot])

  // The store's age signal is asked at every launch, as California's law asks, and never holds the boot.
  useEffect(() => {
    askAgeSignal().catch(() => undefined)
  }, [])

  function contactSupport() {
    mail.open(`mailto:${SUPPORT_EMAIL}`, null)
  }

  function createWallet() {
    seed.setLength(12)
    seed.regenerate()
    setStage('backup')
  }

  // A failure reaches the step that asked, which says so and repeats through this same call, so every
  // retry writes what the screen still shows.
  function firstWrite(write: () => Promise<void>, derivable = false): Promise<void> {
    if (!writing.current) {
      setCommitted(true)
      writing.current = write().catch((err: unknown) => {
        // A refusal for age is shown, not logged, since a log of it would say the person's age.
        if (!isAgeRefusal(err)) {
          console.warn(`first write failed: ${(err as Error)?.message ?? String(err)}`)
        }
        writing.current = null
        if (derivable) {
          setCommitted(false)
        }
        throw err
      })
    }
    return writing.current
  }

  // Once the seed is stored the Keychain holds the only copy the app needs, so both drawn phrases
  // leave memory with the step.
  function afterFirstWrite() {
    seed.clear()
    setStage('setPin')
  }

  // The first writes of the two flows, so an onboarding abandoned before them leaves no wallet behind.
  // Both save the wallet as the active one (addFirstWallet) so the next open finds it whatever the
  // registry held. The words written are the ones on screen, read in the render that drew them.
  function finishCreate(): Promise<void> {
    const words = seed.mnemonic
    return firstWrite(async () => {
      await addFirstWallet(words, undefined, 'drawn')
      afterFirstWrite()
    })
  }

  // ImportScreen has validated the checksum by this point. An imported seed has its deletion status
  // read once Home can sign for it, as addAndActivateWallet does for one added later.
  function importWallet(imported: string, passphrase?: string): Promise<void> {
    return firstWrite(async () => {
      await addFirstWallet(imported, passphrase, 'typed')
      afterFirstWrite()
    })
  }

  // The words of a passkey that may not sync come before the PIN. Nothing connects until Home, past the
  // PIN, so the Keychain holds the seed before any of that.
  function finishPasskey(wallet: PasskeyWallet): Promise<void> {
    return firstWrite(async () => {
      const id = await addFirstPasskeyWallet(wallet)
      if (await passkeyWordsOwed(id)) {
        seed.clear()
        setOwed({ id, next: 'setPin' })
        setStage('passkeyWords')
        return
      }
      afterFirstWrite()
    }, true)
  }

  // The words screen answers after a write of its own, which can land after a relock replaced it,
  // and from there it moves nothing.
  function onWords(): boolean {
    return stageNow.current === 'passkeyWords' || stageNow.current === 'passkeyVerify'
  }

  function wordsProved() {
    if (!onWords()) {
      return
    }
    const next = owed?.next ?? 'setPin'
    setOwed(null)
    setStage(next)
  }

  async function persistPin(pin: string) {
    await savePin(pin)
    setUnlockedOnce(true)
    const gen = lockGen.current
    // Offered here, once, because a switch deep in the settings is one nobody finds. Without enrolled
    // biometry there is nothing to offer. Marked as made so the unlock does not offer it again; a
    // failed mark costs at most that one more offer.
    const kind = await getBiometryKind().catch(() => null)
    if (kind) {
      await markBiometricOffered().catch(() => undefined)
      if (gen !== lockGen.current) {
        return
      }
      setOffer({ pin, kind })
      setStage('biometrics')
      return
    }
    if (gen !== lockGen.current) {
      return
    }
    setStage('ready')
  }

  // A biometric unlock hands back no PIN, so only a keypad unlock, which has just verified one, leads
  // to the offer, and enabling stores that PIN. `gen` is the lock the answer was given to.
  async function unlocked(gen: number, pin: string) {
    if (gen !== lockGen.current) {
      return
    }
    setUnlockedOnce(true)
    // A wallet added after the first run and cut before its words were proved.
    const owing = await activeWalletOwingWords()
    if (gen !== lockGen.current) {
      return
    }
    if (owing && !pin) {
      // After a biometric unlock the words wait for a typed PIN, on a fresh keypad with no biometric.
      lockGen.current += 1
      setLockSeq(lockGen.current)
      setTypedOnly(true)
      return
    }
    setTypedOnly(false)
    if (owing) {
      setOwed({ id: owing, next: 'ready' })
      setStage('passkeyWords')
      return
    }
    const kind = pin ? await biometricOfferAfterUnlock() : null
    if (gen !== lockGen.current) {
      return
    }
    if (kind) {
      setOffer({ pin, kind })
      setStage('biometrics')
      return
    }
    setStage('ready')
  }

  // Throws when the system prompt Android shows for the write is cancelled or fails, which the offer
  // reports so the person can try again or skip.
  async function enableOffered() {
    if (!offer) {
      return
    }
    const gen = lockGen.current
    await enableBiometricUnlock(offer.pin, {
      title: t(offer.kind === 'face' ? 'biometricOffer.confirmFace' : 'biometricOffer.confirmFingerprint'),
      cancel: t('common.cancel'),
    })
    if (gen !== lockGen.current) {
      return
    }
    setOffer(null)
    setStage('ready')
  }

  // Declining writes nothing more, since the offer was marked as made when it showed. The switch in
  // the PIN settings stays available.
  function skipOffered() {
    setOffer(null)
    setStage('ready')
  }

  // The navigator comes down before the erase starts, so no screen kept under the lock reads or
  // connects the wallet whose seed is going, and the generation moves, so no unlock under way lands.
  function eraseStarted() {
    lockGen.current += 1
    setLockSeq(lockGen.current)
    setErasing(true)
    setRelocked(false)
    setOffer(null)
    setStage('locked')
  }

  // The one lock, at boot and over a running wallet alike. Its first layout is what lets the native
  // cover come down after a relock, so the return shows the PIN and never the wallet under it. The
  // keypad is keyed by the generation, so a newer lock draws a fresh one and the answer of the one
  // before goes to the generation it was given under.
  function lock(onDone: (gen: number, pin: string) => void | Promise<void>) {
    const gen = lockSeq
    return (
      <SafeAreaView testID="lock" style={styles.safeArea} onLayout={lockDrawn}>
        {!erasing && (
          <PinScreen
            key={gen}
            mode="enter"
            biometrics={!typedOnly}
            onDone={pin => onDone(gen, pin)}
            onForgot={() => {
              setForgotReason('forgot')
              setForgot(true)
            }}
          />
        )}
      </SafeAreaView>
    )
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <FontScaleProvider>
        <ErrorBoundary>
          <SafeAreaProvider>
            <StatusBar barStyle="light-content" backgroundColor={colors.background} />

            {stage === 'ready' ? (
              <UnderLock locked={relocked}>
                {/* NavigationContainer handles safe areas itself, so a SafeAreaView would double
                    the insets. */}
                <DollarModeProvider initial={dollarModeInit}>
                  <RootNavigator />
                </DollarModeProvider>
              </UnderLock>
            ) : stage === 'locked' ? (
              lock(unlocked)
            ) : stage === 'setPin' ? (
              <SafeAreaView style={styles.safeArea}>
                <PinScreen mode="set" onDone={persistPin} />
              </SafeAreaView>
            ) : (stage === 'passkeyWords' || stage === 'passkeyVerify') && owed ? (
              <SafeAreaView style={styles.safeArea}>
                <PasskeyWordsScreen
                  walletId={owed.id}
                  verifying={stage === 'passkeyVerify'}
                  onVerifying={verifying =>
                    onWords() && setStage(verifying ? 'passkeyVerify' : 'passkeyWords')
                  }
                  onDone={wordsProved}
                  onBack={goBack}
                />
              </SafeAreaView>
            ) : stage === 'biometrics' && offer ? (
              <SafeAreaView style={styles.safeArea}>
                <BiometricOfferScreen
                  kind={offer.kind}
                  onEnable={enableOffered}
                  onSkip={skipOffered}
                />
              </SafeAreaView>
            ) : (
              <SafeAreaView style={styles.safeArea}>
                <GestureDetector gesture={edgeBack}>
                  <View style={styles.stage}>
                    {/* Scrolls because at the largest text sizes the logo, the message, both
                        actions and the support address are taller than the screen, and a centred
                        overflow is cut at both ends. */}
                    {stage === 'bootFailed' && (
                      <ScrollView contentContainerStyle={styles.centredStage}>
                        <Image source={require('./src/assets/logo.png')} style={styles.logo} />
                        <ScreenTitle
                          centered
                          subtitle={t(unreadable ? 'welcome.bootUnreadable' : 'welcome.bootFailed')}
                        />

                        <View style={styles.welcomeAction}>
                          <GradientButton
                            label={t('common.retry')}
                            onPress={boot}
                            loading={!booted}
                          />
                        </View>
                        {unreadable && (
                          <Touch
                            onPress={() => {
                              setForgotReason('unreadable')
                              setForgot(true)
                            }}
                            feedback="link"
                            style={styles.welcomeSecondary}>
                            <Txt role="bodyStrong" tone="muted">
                              {t('welcome.bootRestore')}
                            </Txt>
                          </Touch>
                        )}
                        <Touch
                          onPress={contactSupport}
                          feedback="link"
                          style={styles.welcomeSecondary}>
                          <Txt role="bodyStrong" tone="muted">
                            {t('welcome.contactSupport')}
                          </Txt>
                        </Touch>
                        {/* The address is on screen whether or not a mail opens, since a boot
                            that cannot open the wallets leaves no other page that names it. */}
                        <SupportMailCard note={mail.note ?? NO_NOTE} />
                      </ScrollView>
                    )}

                    {/* The ways to a first wallet give way when the store's age signal says the
                        person is under 18. Nothing is on the device yet, so nothing is locked. */}
                    {minor && (stage === 'welcome' || stage === 'backup' || stage === 'import') && (
                      <ScrollView contentContainerStyle={styles.centredStage}>
                        <Image source={require('./src/assets/logo.png')} style={styles.logo} />
                        <AdultsOnly />
                      </ScrollView>
                    )}

                    {/* Scrolls as the boot failure does, since at the largest text sizes the
                        actions and the terms line under them can be taller than the screen. */}
                    {stage === 'welcome' && !minor && (
                      <ScrollView contentContainerStyle={styles.centredStage}>
                        <Image source={require('./src/assets/logo.png')} style={styles.logo} />
                        <ScreenTitle
                          centered
                          title={t('welcome.title')}
                          subtitle={t('welcome.subtitle')}
                        />

                        {passkeyOffered() ? (
                          <PasskeyChoice
                            mode="connect"
                            label={t('passkey.create')}
                            wordsButton={t('welcome.create')}
                            wordsLink={t('passkey.useWords')}
                            onWords={createWallet}
                            onWallet={finishPasskey}
                            busy={passkeyBusy}
                            onBusy={setPasskeyBusy}
                            actionStyle={styles.welcomeAction}
                            linkStyle={styles.welcomeSecondary}
                          />
                        ) : (
                          <View style={styles.welcomeAction}>
                            <GradientButton label={t('welcome.create')} onPress={createWallet} />
                          </View>
                        )}
                        <Touch
                          onPress={() => setStage('import')}
                          disabled={passkeyBusy}
                          feedback="link"
                          style={styles.welcomeSecondary}>
                          <Txt role="bodyStrong" tone="muted">
                            {t('welcome.import')}
                          </Txt>
                        </Touch>
                        <TermsAcceptance style={styles.welcomeTerms} />
                      </ScrollView>
                    )}

                    {stage === 'backup' && !minor && (
                      <BackupScreen
                        mnemonic={seed.mnemonic}
                        length={12}
                        lockLength
                        onConfirm={finishCreate}
                        onBack={goBack}
                      />
                    )}

                    {stage === 'import' && !minor && (
                      <ImportScreen
                        onImported={importWallet}
                        onBack={goBack}
                        above={
                          passkeyOffered() ? (
                            <PasskeyRestore onWallet={finishPasskey} onBusy={setPasskeyBusy} style={styles.passkeyRestore} />
                          ) : undefined
                        }
                      />
                    )}
                  </View>
                </GestureDetector>
              </SafeAreaView>
            )}

            {/* An unlock here only lifts the lock: the boot's steps after it would replace the
                navigator, and the wallet under it has been open since that boot. */}
            {relocked && stage === 'ready' && (
              <View testID="relock" style={styles.relock} accessibilityViewIsModal>
                {lock(gen => {
                  if (gen === lockGen.current) {
                    setRelocked(false)
                  }
                })}
              </View>
            )}

            {/* Out of the lock, so the move to a stage with no navigator when the erase starts keeps
                the sheet, its spinner and its error. */}
            <ForgotPinSheet
              visible={forgot}
              reason={forgotReason}
              onClose={() => setForgot(false)}
              onErasing={eraseStarted}
              onUnfinished={() => setErasing(false)}
              onErased={() => {
                setForgot(false)
                setErasing(false)
                boot()
              }}
            />
          </SafeAreaProvider>
        </ErrorBoundary>

        {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
      </FontScaleProvider>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  stage: {
    flex: 1,
  },
  relock: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: layer.cover,
  },
  welcomeTerms: {
    marginTop: space.xl,
  },
  // The restore step stacks it right on the words' length control, with no gap of its own between.
  passkeyRestore: {
    marginBottom: space.lg,
  },
  centredStage: {
    flexGrow: 1,
    padding: space.xl,
    justifyContent: 'center',
  },
  logo: {
    width: 88,
    height: 88,
    borderRadius: radius.xl,
    borderCurve: 'continuous',
    alignSelf: 'center',
    marginBottom: space.xl,
  },
  welcomeAction: {
    alignSelf: 'stretch',
  },
  welcomeSecondary: {
    alignSelf: 'center',
    paddingVertical: space.md,
    marginTop: space.lg,
  },
})

export default App
