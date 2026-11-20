import { PermissionsAndroid, Platform } from 'react-native'
import RNFS from 'react-native-fs'
import {
  AuthorizationStatus,
  getAPNSToken,
  getMessaging,
  getToken,
  hasPermission,
  setAutoInitEnabled,
} from '@react-native-firebase/messaging'
import NativeVoltzNotifications from '../../specs/NativeVoltzNotifications'
import { expiryTemplates, paymentTemplates, readyTemplates, registerPushDevice } from './push'
import { identitySigner, walletSigner } from './identitySigner'
import { deletionHolds } from './deletionMark'
import { syncPaymentWebhook } from './paymentWebhook'
import { sendDeviceForgets } from './deviceForget'
import { noteGatewayWebhookId, retireForgottenSecret, retireWebhookState, webhookStateFor } from './webhookSecret'
import { loadRegistry } from './walletRegistry'
import { getBreezLnurlDomain } from '../config'
import { asOwnActivity } from './relock'
import i18n from '../i18n'
import type { PushText } from './push'

// The lock screen wording, rendered here and sent to the gateway. Translating it there would mean a
// second copy of 24 locales, and that copy is the one that goes stale. `{amount}` and `{domain}`
// stay literal: only the gateway knows the value and the host, and i18next leaves single braces
// alone. Resolving `{domain}` here would store one owner's host and send it to every device.
//
// The domain reminders are rendered at registration and not at send time because the gateway keeps
// them for a year and fires them while the app is closed, with no way to ask what language this
// owner reads.
function notificationText(): PushText {
  const locale = i18n.language
  return {
    locale,
    titleTemplate: i18n.t('push.receivedTitle'),
    bodyTemplate: i18n.t('push.receivedBody'),
    ...(expiryTemplates(locale, (key, lng) => i18n.t(key, { lng })) ?? {}),
    ...(readyTemplates(locale, (key, lng) => i18n.t(key, { lng })) ?? {}),
    ...(paymentTemplates(locale, (key, lng) => i18n.t(key, { lng })) ?? {}),
  }
}

// POST_NOTIFICATIONS is a runtime permission from Android 13 on. Below it there is no dialog, and
// installing the app grants notifications until the person turns them off in the system settings.
const RUNTIME_PERMISSION_SDK = 33

// Whether the system shows this app's notifications at all. RNFB's hasPermission reads
// NotificationManagerCompat.areNotificationsEnabled on Android, which covers every SDK level and the
// system settings switch, where POST_NOTIFICATIONS exists only from 13 on.
async function androidNotificationsEnabled(): Promise<boolean> {
  return (await hasPermission(getMessaging())) === AuthorizationStatus.AUTHORIZED
}

// Whether the system notification dialog was shown on this device. Android needs it, because
// PermissionsAndroid.check answers false both before the first ask and after a refusal, and only
// the first may be followed by an explanation and the dialog. A plain file, since it is no secret,
// written as the dialog shows rather than when it is answered, so closing the app on it still counts.
const ASKED = `${RNFS.DocumentDirectoryPath}/notification-asked.json`

async function markSystemAsked(): Promise<void> {
  await RNFS.writeFile(ASKED, JSON.stringify({ asked: true }), 'utf8').catch(() => undefined)
}

async function systemAsked(): Promise<boolean> {
  return RNFS.exists(ASKED)
}

// iOS asks through the app's own bridge and never through Firebase's requestPermission, which
// registers with APNs after any answer, a refusal included (RNFBMessagingModule.mm), and on a fresh
// install the APNs token alone makes FIRMessaging fetch an FCM token whatever auto-init says
// (setAPNSToken in FIRMessagingTokenManager.m). The bridge asks for alerts and sounds only, since
// nothing sets a badge and a wallet has nothing to say in a car. hasPermission only reads the settings.
// Provisional counts as granted, since those notifications are still delivered, quietly.
async function requestIosPermission(prompt: boolean): Promise<boolean> {
  if (!prompt) {
    const status = await hasPermission(getMessaging())
    return status === AuthorizationStatus.AUTHORIZED || status === AuthorizationStatus.PROVISIONAL
  }
  if (!NativeVoltzNotifications) {
    return false
  }
  await markSystemAsked()
  const status = await NativeVoltzNotifications.requestAuthorization()
  return status === 'authorized' || status === 'provisional'
}

// On Android the Firebase SDK's own requestPermission is a documented no-op that resolves as
// authorized without ever prompting, so asking through it would report success while no notification
// is ever shown. The platform API is the one that actually asks.
//
// `prompt` false answers from what was already granted, without showing anything. That is what lets
// a wallet switch re-point the device silently, while the dialog stays on the screen where a person
// asks to be paid.
export async function requestNotificationPermission(prompt = true): Promise<boolean> {
  if (Platform.OS === 'ios') {
    return requestIosPermission(prompt)
  }
  if (Platform.OS !== 'android') {
    return false
  }
  if (!prompt || Number(Platform.Version) < RUNTIME_PERMISSION_SDK) {
    return androidNotificationsEnabled()
  }
  await markSystemAsked()
  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
  // The system's dialog is an activity over the app, so a trip that begins under it raises no cover
  // and is timed against ten minutes instead of two.
  return (await asOwnActivity(() => PermissionsAndroid.request(permission))) === PermissionsAndroid.RESULTS.GRANTED
}

// Whether ensurePushRegistered(true) would show the system dialog now, so a screen can explain it
// first and show it only on a tap. The system shows its dialog once; after that only the system
// settings change the answer, so an explanation then would lead nowhere. The checks run in the order
// ensurePushRegistered runs them, so a wallet held by a deletion is never asked.
export async function pushPromptDue(): Promise<boolean> {
  const platform = Platform.OS
  if (platform !== 'android' && platform !== 'ios') {
    return false
  }
  if (platform === 'android' && Number(Platform.Version) < RUNTIME_PERMISSION_SDK) {
    return false
  }
  if (!getBreezLnurlDomain()) {
    return false
  }
  const signer = await identitySigner()
  if (await deletionHolds({ pubkey: signer.pubkey })) {
    return false
  }
  if (platform === 'ios') {
    // A build without the bridge cannot show the dialog, so a card offering it would lead nowhere.
    if (!NativeVoltzNotifications) {
      return false
    }
    // Before the first request iOS answers NOT_DETERMINED, and any answer to the dialog moves it on.
    return (await hasPermission(getMessaging())) === AuthorizationStatus.NOT_DETERMINED
  }
  if (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)) {
    return false
  }
  return !(await systemAsked())
}

// How long an iOS start waits for APNs to hand over the device token, in reads of it. RNFB gives its
// own registration ten seconds.
const APNS_READS = 40
const APNS_READ_INTERVAL_MS = 250

// FIRMessaging declines getToken with MissingDeviceToken until it holds the APNs token, which it keeps
// in memory only and receives from RNFB's app delegate proxy after each registration. Reading it
// through getAPNSToken is refused as unregistered until an install's first registration completes,
// and answers null until this process's token arrives.
async function apnsTokenArrived(messaging: ReturnType<typeof getMessaging>): Promise<boolean> {
  for (let read = 1; ; read++) {
    try {
      if (await getAPNSToken(messaging)) {
        return true
      }
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'messaging/unregistered') {
        throw error
      }
    }
    if (read >= APNS_READS) {
      return false
    }
    await new Promise(resolve => setTimeout(resolve, APNS_READ_INTERVAL_MS))
  }
}

// firebase.json starts Firebase Messaging switched off, with no installation id, no token and, on
// iOS, no APNs registration at launch. It is switched on here, and only once notifications are
// allowed, so an Android device whose owner refused or never answered, and an iPhone whose owner
// refused, never answered or was never asked, are never known to Firebase. The SDK persists the
// switch and keeps the token fresh on later launches.
//
// On iOS every start registers with APNs again, already registered or not, because the APNs token
// FIRMessaging needs lives only as long as the process; RNFB's registerDeviceForRemoteMessages returns
// early once UIKit says registered, which leaves a later launch with no token. Null when no APNs
// token arrived in time: nothing is sent, and the next start tries again.
async function startMessaging(platform: 'android' | 'ios'): Promise<string | null> {
  const messaging = getMessaging()
  await setAutoInitEnabled(messaging, true)
  if (platform === 'ios') {
    if (!NativeVoltzNotifications) {
      return null
    }
    await NativeVoltzNotifications.registerForRemoteNotifications()
    if (!(await apnsTokenArrived(messaging))) {
      return null
    }
  }
  return getToken(messaging)
}

// Points this device at the gateway so a payment to the wallet's lightning address can reach it
// while the app is closed. Returns false when nothing was sent, which covers the ordinary cases:
// permission refused, an unchanged registration, an APNs token that did not arrive, or a platform
// without push. It also returns false, raising nothing, when the gateway refused the wallet's secret
// as forgotten; that secret is retired and the next connect registers a fresh one.
//
// The gateway holds one wallet per device token, so this has to run again whenever the active wallet
// changes. Otherwise the device keeps pointing at the wallet it was registered for and the new one
// is never notified.
//
// The registration also carries the wallet's payment webhook secret, and each run ends by queueing the
// pass that keeps the provider's webhook in line with the id the gateway answered (paymentWebhook.ts),
// and sends the forgets the gateway is still owed (deviceForget.ts). Neither is awaited, so neither a
// connect nor the screen that asked waits on the provider or the gateway. With notifications off, every
// wallet's webhook here is retired: the pass removes the connected one's from the provider, the others'
// wait for their own connect, and a forget of each secret is queued and sent.
export async function ensurePushRegistered(prompt = true): Promise<boolean> {
  const platform = Platform.OS
  if (platform !== 'android' && platform !== 'ios') {
    return false
  }
  const domain = getBreezLnurlDomain()
  if (!domain) {
    // Without a custom domain the address lives on the SDK default, whose payments never reach the
    // Voltz gateway, so there would be nothing for it to notify about.
    return false
  }
  const gatewayUrl = `https://${domain}`
  // Read before the permission, so a wallet held by a deletion is not asked for a permission it has
  // no use for.
  const signer = await walletSigner()
  const target = { walletId: signer.walletId, pubkey: signer.pubkey, gatewayBase: gatewayUrl }
  let token: string | null = null
  try {
    if (await deletionHolds({ pubkey: signer.pubkey })) {
      // Its webhook goes as well, through the pass below, since a held wallet notifies no device.
      return false
    }
    const allowed = await requestNotificationPermission(prompt)
    lastAllowed = allowed
    if (!allowed) {
      // With notifications off the provider stops posting this wallet's payments to the gateway, and
      // the gateway is asked to forget every registration made with each wallet's secret. Turned on
      // again, a new secret is drawn and registered, and a new webhook made.
      await retireEveryWallet(signer.walletId, signer.pubkey)
      return false
    }
    token = await startMessaging(platform)
    if (!token) {
      return false
    }
    // A secret that cannot be read or drawn sends nothing: registering without it would tell the
    // gateway this wallet has no payment webhook, and the next connect tries again. A forget still
    // queued for an older secret of this wallet matches nothing this registration makes, whichever
    // reaches the gateway first, so the two need no order between them. One that names this very
    // secret, sent while this registration is in flight, wins either way: the gateway removes what
    // the registration wrote, or refuses it as forgotten and this secret is retired.
    const hook = await webhookStateFor(signer.walletId, signer.pubkey)
    return await registerPushDevice({
      gatewayUrl,
      domain,
      platform,
      token,
      identity: async () => signer.pubkey,
      sign: signer.sign,
      text: notificationText(),
      webhook: {
        secret: hook.secret,
        held: hook.webhookId !== undefined,
        save: webhookId => noteGatewayWebhookId(signer.walletId, hook.secret, webhookId, signer.pubkey),
        forgotten: () => retireForgottenSecret(signer.walletId, hook.secret, signer.pubkey),
      },
    })
  } finally {
    // On every connect whatever came before, a refusal included: a 409 deleted marks the wallet and
    // the pass then takes its webhook away, and a removal the provider has not confirmed is tried again.
    syncPaymentWebhook({ ...target, ...(token ? { token } : {}) }).catch(() => undefined)
    sendDeviceForgets().catch(() => undefined)
  }
}

// Notifications are off for the device, not for one wallet, so every wallet listed here stops being
// notified. The connected one first, since its key is the one that can also take the provider's webhook
// down now. A wallet whose state cannot be read keeps it, and the next run tries again.
async function retireEveryWallet(walletId: string, pubkey: string): Promise<void> {
  await retireWebhookState(walletId, pubkey)
  const { wallets } = await loadRegistry().catch(() => ({ wallets: [] as { id: string }[] }))
  for (const wallet of wallets.filter(w => w.id !== walletId)) {
    await retireWebhookState(wallet.id).catch(() => undefined)
  }
}

// The last answer the system gave about notifications, read silently on every registration. Null
// before the first read of this process.
let lastAllowed: boolean | null = null

/**
 * Reads the system's answer again on a return to the foreground, where the person may have just turned
 * notifications off or on in the system settings, and runs a registration when it changed: off retires
 * and forgets, on registers again. An unchanged answer costs one read and no request.
 */
export async function recheckNotifications(): Promise<void> {
  const platform = Platform.OS
  if (platform !== 'android' && platform !== 'ios') {
    return
  }
  const allowed = await requestNotificationPermission(false)
  if (allowed === lastAllowed) {
    return
  }
  await ensurePushRegistered(false)
}
