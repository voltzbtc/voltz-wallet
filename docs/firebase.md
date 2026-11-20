# Firebase client configuration

The app uses Firebase for one thing, push notifications through Firebase Cloud Messaging (FCM). The
gateway sends a push when a payment reaches the wallet's lightning address while the app is closed
(see [push-notifications.md](push-notifications.md)). Two files tell the Firebase SDK which Firebase
project the app belongs to:

| File | Platform | Read by |
|---|---|---|
| `android/app/google-services.json` | Android | the `com.google.gms.google-services` Gradle plugin, at build time |
| `ios/VoltzWallet/GoogleService-Info.plist` | iOS | `FirebaseApp.configure()` in `AppDelegate.swift`, at launch |

They hold the project's id and number, the app ids Firebase assigned, the sender id and an API key.
None of it opens the wallet, a key or funds, and Firebase documents that a key restricted to
Firebase services need not be treated as a secret. The files still name one particular Firebase
project, so they stay out of git. Both paths are in `.gitignore`.

## Placeholders

Each file has a committed placeholder beside it, `google-services.example.json` and
`GoogleService-Info.example.plist`. They keep the structure of the real files, the app's package
name and bundle id (`app.usevoltz`), and a placeholder in place of every project value.

A build needs a file in each path whether or not push works. The Gradle plugin fails the Android
build without `google-services.json`, and also when no client in it names the `applicationId`.
Xcode fails without `GoogleService-Info.plist`, because the project copies it into the app bundle,
and `FirebaseApp.configure()` raises at launch when the bundle has none.

`node scripts/firebase-config.mjs` copies the placeholder into each path that has no file and says
that push notifications are off. It never replaces a file that exists. `npm run setup` runs it
after installing, and the `device-smoke` workflow runs it before the Android build, so CI builds
with the placeholder and holds no Firebase secret.

### What a placeholder build does

The app starts and push is off. Nothing else in the app uses Firebase. On Android, once
notifications are allowed, FCM asks the Firebase Installations API for an identity, which answers
the placeholder key with `400 API key not valid`. Without that identity FCM has no token to give, so
`getToken` rejects inside `ensurePushRegistered` (`src/wallet/pushToken.ts`). Both callers catch the
rejection, `App.tsx` when a wallet connects and `ReceiveSpark.tsx` when the receive screen opens or
its alerts card's Turn on asks for the permission, and nothing is sent to the gateway. iOS takes the
same path after the permission prompt. The iOS 26.5 simulator on Apple silicon does register with
APNs when the app's bridge asks (SpringBoard logs `Send per-app token [80] to client for topic
app.usevoltz`), and with the placeholder Firebase Installations then fails
(`[FirebaseInstallations][I-FIS002003] Firebase Installation registration failed`), so `getToken`
rejects. A simulator build with the real file can therefore get an FCM token once notifications are
allowed, and register that simulator with the gateway. On an iPhone the placeholder key is expected
to stop `getToken` the way it does on Android, which has not been measured yet.

The placeholder values have the shape Firebase checks before it sends any request. The API key is
39 characters from the base64url alphabet starting with `A`, and the app ids read
`1:<number>:android:<hex>` and `1:<number>:ios:<hex>`. On iOS the shape is not optional.
`FirebaseApp.configure()` creates Firebase Installations at launch (it registers as always eager), and
its initializer raises an exception on a key of the wrong length, first letter or
alphabet, so a key such as `REPLACE_ME` stops the app before its first screen. Android starts with
either shape. `__tests__/firebaseConfig.test.ts` holds both placeholders to it.

## When Firebase starts

`firebase.json` at the repo root keeps Firebase Messaging from starting on its own. React Native
Firebase reads it at build time: `messaging_auto_init_enabled: false` becomes the manifest's
`firebase_messaging_auto_init_enabled` on Android and `FirebaseMessagingAutoInitEnabled` in the iOS
`Info.plist`, and `messaging_ios_auto_register_for_remote_messages: false` stops the APNs
registration RNFB otherwise makes at every launch. Without the file, a fresh Android install asks
Firebase Installations for an identity and FCM for a token at first launch, and an iPhone registers
with APNs, whose token makes FIRMessaging fetch an FCM token, all before anyone is asked.

`startMessaging` in `src/wallet/pushToken.ts` turns it on, and only after the permission read
answers granted: `setAutoInitEnabled(true)`, then on iOS the APNs registration and a wait for its
token, then `getToken`. The SDK persists the switch, so later launches keep the token fresh. Below
Android 13 the system grants notifications at install, so the first connection turns Firebase on
without a dialog, unless they were turned off in the system settings: every read that shows no
dialog, on any Android, goes through RNFB's `hasPermission`, which reads
`areNotificationsEnabled`.

### Asking and registering on iOS

The iOS dialog and the APNs registration go through the app's own TurboModule,
`specs/NativeVoltzNotifications.ts` with `ios/VoltzWallet/Notifications/`, and never through React
Native Firebase. RNFB's `requestPermission` registers with APNs after any answer, a refusal
included, and on a fresh install the APNs token alone makes FIRMessaging fetch an installation id
and an FCM token, whatever auto-init says (`setAPNSToken:withUserInfo:` in
`FIRMessagingTokenManager.m`). The module's `requestAuthorization` only asks, for alerts and sounds,
and its `registerForRemoteNotifications` is called only after a grant. The silent path reads the
answer with RNFB's `hasPermission`, which only reads the notification settings.

Every start after a grant registers again, the dialog's and the silent one on each connection.
FIRMessaging keeps the APNs token in memory only, and RNFB's `registerDeviceForRemoteMessages`
returns early once UIKit reports the app registered, a flag that survives a relaunch, so on a later
launch it would leave `getToken` without the token it needs (FIRMessaging declines with
`MissingDeviceToken`). The device token still reaches FIRMessaging through RNFB's app delegate
proxy, which is installed at launch whatever `firebase.json` says. `startMessaging` reads
`getAPNSToken` every 250 ms for up to ten seconds before `getToken`; that read is refused as
unregistered until an install's first registration completes and answers null until this process's
token arrives. A wait that runs out sends nothing to the gateway, and the next start tries again.
`__tests__/notificationsBridge.test.ts` reads the sources to hold the native side to this, since Jest
never runs it.

Two paths still reach Google before the switch, both on iOS and only on a device that ran an earlier
build with Firebase on. With a token cached, `didCompleteConfigure` (`FIRMessaging.m`) asks Firebase
Installations for its id at launch; the token itself is refreshed only once an APNs token is set,
which at launch it is not. A reinstall whose Keychain still holds an earlier check-in sends one request
to delete the old registrations (`resetCredentialsIfNeeded` in `FIRMessagingTokenManager.m`). An
install that first ships with `firebase.json` and the bridge never holds either state.

## Forks

A fork has two options.

1. **Keep the placeholders.** Everything but push works.
2. **Use a Firebase project of its own.** In the Firebase console, register an Android app with the
   fork's `applicationId` and an iOS app with its bundle id, download the two files into the paths
   above, and rebuild. They stay untracked. An FCM token accepts messages only from credentials of
   the project that issued it, so push also needs a gateway that sends with that project's
   credentials.

On iOS the signing is separate from Firebase. `ios/VoltzWallet/VoltzWallet.entitlements` asks for
push (`aps-environment`) and NFC tag reading, and the VoltzWallet target signs with the project's
team, `23ANVS9D98`, and automatic signing. A fork that builds for an iPhone sets `DEVELOPMENT_TEAM`
to a team of its own whose App ID has Push Notifications and NFC Tag Reading. Apple does not give a
free personal team the push capability, so a fork on one removes `CODE_SIGN_ENTITLEMENTS` from the
target, which leaves push and NFC off and the rest of the app working.

A simulator build needs none of this. Xcode signs it ad hoc, and it builds and starts with the team
set and no Apple account signed in. Its keychain group follows the team, though, so a simulator
wallet created by a build with `DEVELOPMENT_TEAM` emptied (the ad hoc overrides some local recipes
pass) is not visible to a build with the team, which opens on the welcome screen, and the other way
round. The wallet is still there, and a build signed the way it was created opens it again.

## Restricting the API keys

Firebase creates one API key per platform, named "Android key (auto created by Firebase)" and
"iOS key (auto created by Firebase)". An unrestricted key accepts requests from any app that copies
it, and those requests count against the project's quotas. Restricting each key to this app and to
the APIs FCM needs closes that.

In the Google Cloud console, open the project, then **APIs & Services**, then **Credentials**.

For the Android key:

1. Under **Application restrictions**, choose **Android apps** and add one entry per signing
   certificate that ships a build, each with package name `app.usevoltz` and that certificate's
   SHA-1 fingerprint.
2. Under **API restrictions**, choose **Restrict key** and keep the Firebase Installations API
   (`firebaseinstallations.googleapis.com`) and the FCM Registration API
   (`fcmregistrations.googleapis.com`).
3. Save.

For the iOS key, choose **iOS apps** under **Application restrictions** with bundle id
`app.usevoltz`, apply the same API restrictions, and save.

List every certificate that signs a build someone installs.

- **The release key.** `keytool` prints the fingerprint and asks for the store password itself, so
  the password is typed into the terminal and nowhere else. The keystore and alias are the
  `storeFile` (relative to `android/`) and `keyAlias` entries of `android/keystore.properties`.

  ```bash
  keytool -list -v -keystore android/<storeFile> -alias <keyAlias>
  ```

  The line that starts with `SHA1:` is the fingerprint.
- **The Google Play app signing key**, once the app ships through Play. Play signs what it
  delivers with its own key, so the certificate on a user's device is Google's, not the upload key.
  The Play Console shows its SHA-1 on the app's App signing page.
- **The debug key**, if debug builds should keep push. `android/app/debug.keystore` is the stock
  Android SDK debug key with the public password `android`.

  ```bash
  keytool -list -v -keystore android/app/debug.keystore -alias androiddebugkey -storepass android
  ```

A restriction that misses a certificate turns push off for builds signed with it and breaks nothing
else, which makes the gap easy to overlook. Firebase advises trying new restrictions on a test key
before changing a key that production apps use.
