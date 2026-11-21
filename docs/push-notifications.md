# Push notifications while the app is closed

## What it is and why it exists

On Spark, a payment does not need the app open to arrive. The Breez docs say Lightning payments work
"even if the receiver is offline", and that lightning address payments "are received automatically
without any user interaction" (`guide/receive_payment.html`, `guide/lnurl_webhooks.html`). With the
app open, the payment subscription in `wallet/spark.ts` and `ReceivedOverlayHost` show the arrival.

With the app closed, nothing on the device notices. The push exists for that, to tell the person a
payment reached their lightning address, and the same channel carries the reminders about the
wallet's domain. It is **a notice, not a step the payment depends on**, so a device without push
still receives. `ReceiveSpark.tsx` treats a failed registration as silent for that reason.

## Flow

```
device: ensurePushRegistered() signs a registration with the wallet's identity key
        and POSTs the FCM token to the gateway on the wallet's domain (/api/device)
somebody pays the lightning address while the app is away
  → the gateway sends an FCM message carrying a notification block
  → the system draws the notification; no app code runs
with the app in front, FCM hands the message to the process instead,
  and App.tsx's onMessage shows it inside the app
```

## Design

- **The sender is the lightning address gateway**, which runs next to the LNURL server on the
  wallet's domain (see `docs/custom-domain.md`). It holds one wallet per device token, which is why
  the device registers again every time a wallet connects.
- **No `setBackgroundMessageHandler`.** Every message the gateway sends carries a notification block
  that the system draws on its own while the app is away, so a background handler would add an
  execution surface and change nothing.
- **The wording is rendered on the device** and sent with the registration, so the 24 locales have
  one copy. `{amount}` and `{domain}` stay literal and are filled in by the gateway.
- **What a locked screen shows of a notice is set by the person, not by the app.** Android draws a
  notice in full on a secure lock screen unless the person hides sensitive content there, and an app
  cannot make its own channel private: `NotificationChannel.setLockscreenVisibility` is modifiable
  only by the system, which resets it on every channel an app creates
  (`PreferencesHelper.createNotificationChannel`), so a new channel id would change nothing. iOS
  follows the person's Show Previews setting. What the app and the gateway decide is the wording,
  which carries `{amount}`, and the visibility a message may name
  (`android.notification.visibility` in FCM's message).
- **The iOS bundle identifier is `app.usevoltz`**, the same as the Android `applicationId`, named
  after the product's domain. A Firebase iOS app cannot change its bundle id after registration, so
  the id is fixed before anything registers it.
- **The push provider is FCM** (`@react-native-firebase/messaging`), which covers Android and iOS.

## What exists in the code

- `wallet/pushToken.ts`, `ensurePushRegistered(prompt)`. It asks for the notification permission
  (through the platform API on Android, a runtime permission from Android 13, and through Firebase
  on iOS, where only an authorized or provisional answer counts), reads the FCM token, and calls
  `registerPushDevice` in `wallet/push.ts` with the platform it runs on. It returns `false` when the
  app has no custom lightning address domain, when permission is refused or not yet given, and when
  the registration is unchanged.
- `App.tsx` calls it without prompting whenever a wallet connects, and `ReceiveSpark.tsx` does the
  same once the wallet has an address someone can pay. While the system's dialog is still to come,
  Receive shows its own card first, and only its Turn on calls it with the prompt; Not now keeps the
  card away for as long as the app runs.
- `App.tsx` routes a tapped notification and a foreground message through `wallet/pushRoute.ts`, the
  only place that turns a payload into a destination.
- Android is measured end to end on a handset, where a payment arriving with the app closed
  produces the push.
- iOS asks for the permission and registers as `ios` like Android does, in the same Firebase project.
  Its `GoogleService-Info.plist`, like the Android `google-services.json`, stays out of git and is
  replaced by a placeholder in a checkout without one
  (see [firebase.md](firebase.md)), and `AppDelegate.swift` calls `FirebaseApp.configure()` before
  the React tree.
- Payment notices beyond the lightning address come from the Spark provider's own webhooks
  (`guide/webhooks.html`), described in the next section.

## Payment notices from the Spark provider

The LNURL server tells the gateway only about lightning address receives. Every other payment event
the provider knows reaches the gateway through a webhook the wallet registers with it: a Lightning
receive on an invoice the wallet made, a Lightning send that finished either way (a hold invoice that
settles hours later included), an on-chain send and an on-chain deposit claimed. The provider has no
other event, so a Spark transfer, a token payment and a conversion still send no push.

- **The secret is drawn on the device**, 32 bytes from `crypto.getRandomValues`, and kept in the
  Keychain per wallet with the gateway's webhook id and a marker of the SDK webhook made with it
  (`wallet/webhookSecret.ts`). It travels only inside the signed `voltz-push:v5` registration and in
  `registerWebhook`. The registration file never holds it.
- **The v5 statement** is v4 with the five payment notices (`PAYMENT_EVENTS` in `wallet/push.ts`, in
  that order, joined by the unit separator) and then the secret, before the timestamp.
  `__tests__/push.test.ts` pins a golden vector and digest that the gateway has to build byte for
  byte. A device that cannot render the notices stays on v4. One whose secret cannot be read or
  drawn sends no registration at all, the lightning address notices
  included, and the next connect tries again (`ensurePushRegistered` in `wallet/pushToken.ts`). The
  gateway answers v5 with `{ webhookId }`, which is kept; an answer without a usable one leaves the
  registration unsaved, so the next connect sends it again.
- **The webhook URL** is `https://<domain>/api/push/spark/<webhookId>`. The push token never goes in
  it, since the provider is a third party.
- **Each connect runs one pass** (`wallet/paymentWebhook.ts`) after the registration, never awaited:
  list the wallet's webhooks, remove this device's stale ones, register one with the four events if
  the marker does not vouch for the one at the URL, and note the marker. A webhook counts as this
  device's only by proof (the URL of its current id, the marker's id or URL, or the old notify route
  with its token), since the provider's list is the wallet's and a wallet open on two devices has one
  webhook from each. A failed removal stops the pass before registering, and a pass that does not
  answer releases the queue after `PASS_WAIT_MS`. A wallet held by a deletion keeps no webhook.
- **The webhook comes off the provider** before a data deletion request is filed, when the wallet is
  removed from the device, and when notifications are turned off (`retirePaymentWebhook` and
  `retireWebhookState`). The secret, the id and the marker move into a removal marker in the Keychain,
  keyed by the wallet's identity key, which loses an entry only once a pass on that key removed the
  webhook or saw it gone, and every pass reads it first. A wallet removed while another one is
  connected keeps its marker until its key connects here again, since only that key can list or
  remove its webhooks. Notifications turned on again draw a new secret and register a new webhook.
- **The gateway forgets every registration made with a secret** that goes, by the same triggers
  (`wallet/deviceForget.ts`, `POST /api/device/forget` with the key and a proof). The proof is the
  lowercase hex HMAC-SHA256 of `voltz-push-forget:v1`, the domain and the key, joined by `\n`, keyed
  with the secret's UTF-8 bytes (`forgetProof` in `wallet/webhook.ts`), the primitive the provider
  signs its deliveries with, pinned by a golden vector in `__tests__/deviceForget.test.ts`. Every drop
  of a secret goes through `retireHeld` in `wallet/webhookSecret.ts`, reached from
  `retireWebhookState`, `retireForgottenSecret` and `webhookStateFor`, and it queues the key and the
  proof in the Keychain before it drops the secret, whether or not a webhook id came back; drawing a
  secret refuses one a
  queued forget names, so a forget never matches a later registration. Notifications off retires
  every wallet listed here, since they are off for the device. The queue needs neither the secret
  nor the words, so it survives a removal and the Forgot PIN erase; it is sent right after queueing,
  on every start, every connect and every return to the foreground, and loses an entry only on
  a 200. A 404 from an older gateway, any other answer and no network keep it, with no time limit.
  The proof has no timestamp, as a token revocation needs none (RFC 7009, section 2.2): it can only
  remove what its secret registered, and the gateway answers alike whether anything matched.
- **Notifications count as off** whenever the system says so, read on every connect and on every
  return from the background (`recheckNotifications`): on Android through RNFB's `hasPermission`,
  which reads `NotificationManagerCompat.areNotificationsEnabled` and so covers the settings switch
  on every SDK level, where `POST_NOTIFICATIONS` exists only from 13 on; on iOS an authorization
  that is not granted or provisional.
- **The amounts the notices state** come only from fields the provider's page defines as what moved:
  `invoice_amount` for a Lightning send, the HTLC or the invoice for a receive, and `credit_amount`
  ("Amount to be credited to the wallet") for a deposit. An on-chain send states none, since the page
  gives `total_amount` as the exit's total and never as what the recipient got, and a send that did not
  complete never says where the sats are.
- **The gateway keeps one record per secret**, each with an id of its own, so a new secret answers a
  new id and a new webhook URL, and the old secret's record stays until its forget lands, FCM reports
  the token gone, the device row it hangs on goes with a forget of the wallet that row names, or the
  wallet's data is deleted. A webhook at the right URL is still replaced unless the marker kept with
  the current secret names it, which is what a wallet
  removed and added again goes through. A forget takes the device row only while that row still names
  the wallet and no record of the wallet under another secret is left on it, so of two secrets of one
  wallet on one device the forget that lands last takes it.
- **The device row keeps the registration signed latest** by the device's own clock: the gateway
  stores the timestamp each registration signs, and one signed earlier than the stored one changes
  nothing. A registration that stalled for a wallet the person switched away from cannot take the
  device back from the wallet in front, which would otherwise lose its notices with nothing on the
  device to say so, since the saved registration did not change. A clock set back between two
  registrations that reach the gateway under 20 minutes apart, by more than the time between them,
  leaves the newer one out until the next registration with a change.

## APNs on iOS

FCM reaches an iPhone through APNs, with an APNs auth key (.p8) uploaded to the Firebase project
under Cloud Messaging, Apple app config. `ios/VoltzWallet/VoltzWallet.entitlements` carries
`aps-environment` as `development`, and Xcode switches it to production when it exports for the App
Store or TestFlight.

To try a notice with the app closed, use a Debug build (APNs sandbox) or TestFlight (production),
never a Release build signed for development. Firebase would label its sandbox token as production
and the send would fail, and if FCM answers `UNREGISTERED` the gateway drops the device, which the app
does not register again on its own.
