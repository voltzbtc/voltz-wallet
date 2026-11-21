# The lock after time away

The PIN is asked at every cold start and again when the app comes back after two minutes or more in
the background (`RELOCK_AFTER_MS` in `src/wallet/relock.ts`). Without the second ask, an unlocked
phone holding a wallet still in memory could send the whole balance without the PIN.

The design follows Signal (the stamp and the clock) and MetaMask mobile's PrivacyCover, PR 37256 (the
cover and where the decision runs).

## Who does what

The native side, `specs/NativeVoltzPrivacy.ts`, acts in the platform's own leave callback, before any
JS runs:

- **iOS**: `applicationDidEnterBackground` in `AppDelegate.swift` calls `VoltzPrivacyCover`, which
  stamps the leave and shows a window of its own at `.alert + 1`. UIKit takes the switcher snapshot
  once that callback returns, so the snapshot and the first frame back are the cover.
- **Android**: `MainActivity.onPause`, before `super.onPause`, calls `PrivacyCover`, which stamps the
  leave and adds a decor-view child and a full-screen `Dialog` with `FLAG_SECURE`, shown after any open
  Dialog. A decor child alone sits under React Native Modals, which are Dialog windows of their own.

The cover is the app's background with the Voltz mark at the size the app draws its logo. It takes
every touch and Back, closes the keyboard (a window above it that would come back with what was being
typed), and is all a screen reader finds. It stays up until the JS side lowers it, and at least 250 ms
so it never flickers. A hide that finds the app away again, or that was held for the floor while a new
leave came, does nothing.

The JS side, `useRelock` in `App.tsx`, decides on `'active'`. On Android it first waits for
`onPostResume` (`whenInFront`), before which a biometric prompt cannot show and a hide is dropped.
Then:

- **under two minutes**: the cover comes down and nothing else happens; every screen and every sheet
  is as it was;
- **at two minutes or more**, once a PIN was entered or set in this process: what UIKit presented over
  the app (the share sheet, `ActionSheetIOS`, the photo picker) is dismissed, and the commit that draws
  the lock closes every open Modal (`useCloseOnLock`), as a dismissal by the person would; one its
  owner keeps open stays off the screen until the unlock. The cover comes down only when the lock
  reports its first layout, and then through `hideCoverAfterModals`, which on Android also waits for
  every Modal window under the cover to close and for its exit animation to end.

Android removes a closed Dialog's window after the app has let go of it and plays the exit animation
then, with the theme fixed when the Dialog was made, so the `'none'` animation a Sheet takes under the
lock arrives too late. `PrivacyCover` lists the app's Dialog windows when the cover goes up
(`WindowInspector`, Android 10), notes when each is removed, and reads the length of its exit from the
window's own animation style at the window animation scale; the cover outlasts the last exit by
`EXIT_MARGIN_MS`. A window still open after `CLOSE_WAIT_MS` is one the lock does not close, such as an
Alert, and the cover comes down anyway. Below Android 10, where the windows cannot be listed, a hide
after the lock waits out `config_shortAnimTime`, the exit React Native gives every Modal. Any hide
waits for an exit already under way; a short return's hide does not wait for the sheets it keeps. iOS
takes the `'none'` in the update that hides the Modal and lowers the cover at once.

## Measuring time away

Time away is the native stamp's alone, on a clock that counts sleep and that nothing can set:
`SystemClock.elapsedRealtime()` on Android and `clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)` on iOS.
`Date.now()` is the wall clock, which Settings can set back while the app is away, and
`performance.now()` is the C++ steady clock, which stops while the phone sleeps; neither is read.

The first leave of each kind since the last decision keeps its stamp, so a second leave never
restarts the clock. A stamp whose clock read zero, or that runs backwards by the return, locks. So does a `'background'`
that the JS side heard with no stamp behind it, and a binary without the module after a
`'background'`. `'inactive'` alone (the app switcher, Control Center, the Face ID prompt) decides
nothing.

## The app's own activities

Android pauses the app for every activity the app starts, and React Native calls that
`'background'`. `asOwnActivity` brackets each of them on the native side: the biometric prompts, the
device check, the photo pickers, the camera and its permission dialog, the notification permission,
the passkey sheet and the store's purchase sheet. A configuration change's recreation counts the same
way. Share, links and the system settings are not bracketed: they lead to another app.

A pause inside the bracket raises no cover, and is stamped apart. Nothing more reaches the app when
Home is pressed inside one of these activities, so its trip is timed from the activity's start, against
ten minutes (`RELOCK_AFTER_OWN_MS`) instead of two: a long pick or a slow prompt asks nothing, while Home
pressed inside a picker and a return later locks. `takeAway` answers both trips, and either one at its
limit locks, so Home pressed just after a picker closed still locks at two minutes. A return from an own
trip at its limit raised no cover on the way out, so `PrivacyCover.onResume` covers it, at the same
figure (`OWN_LOCK_AFTER_MS`, which `__tests__/ownActivity.test.ts` holds equal). An activity whose
bracket never closes leaves every later pause inside the bracket, so every trip is then timed against
ten minutes and raises no cover on the way out, which is less than the two minute lock and never none.
That lasts until the activity is destroyed: `PrivacyCover.release` sets the depth back to zero, since a
destroyed activity gets none of the answers an open bracket waits for.

## Where the lock lands

- **The wallet** (`'ready'`): the boot's PIN is drawn over the navigator, which stays mounted under
  `UnderLock`, so a review, a typed amount and a send in flight are where they were after the unlock.
  Nothing under it takes a touch or reaches a screen reader, and every line said on its own waits for
  the unlock, except one that answers something landing under the lock (a pull's "updated now"), which
  `useAnnounce` drops since it is no longer news by then. Back leaves the app.
- **The steps past the unlock with no navigator** (the biometric offer, owed passkey words): the stage
  goes back to `'locked'` and the PIN leads on as it does at boot. A step under way when the lock came
  back (an unlock still reading, the offer's write, the words' own write) lands on nothing past it.
- **Before the first unlock**: nothing changes, and the cover comes down on the return.
- **A `lightning:` link that arrives while the app is away** is held from the leave until the return's
  lock decision. A return under the limit hands it to Send at once. A return that locks keeps it until
  the PIN is passed, and then hands over only the latest link, once. An unlock that lands before the
  decision releases nothing. `useRelock` sets and settles the hold, and `RootNavigator` releases it with
  the handler it registers (`src/wallet/deeplink.ts`).

Every lock moves a generation, and draws a keypad of its own keyed by it. A PIN or a biometric is
checked after a read, which can answer once the app has left and a newer lock is up; the answer carries
the generation of the keypad it was given to, and opens nothing when a newer one exists. The newer lock
starts from an empty keypad, which raises its own biometric prompt as the boot's does.

Forgot PIN on the lock over the wallet erases every wallet, and Home's reads under the lock connect the
SDK on a timer and on every event. So once the device check passes, the app moves to `'locked'`, which
has no navigator and draws no keypad until the erase ends, and the generation moves. `eraseAllWallets`
runs inside `whileSparkErasing`, which cuts every queued connect, waits for a `connectActiveSpark`
already past its turn, and refuses every connect until the erase ends: the next first wallet takes the
erased primary id, and a connection left on the erased seed would be kept for it. An erase that fails
brings the keypad back with the sheet's error. One started from the boot that could not read the
wallets goes back to that screen instead, since its keypad would ask for a PIN the phone cannot read,
and that screen hides Erase and restore while a Try again runs.

## What a biometric may stand in for

The PIN exists so that a phone that is unlocked, or whose passcode someone knows, does not open the
wallet. A biometric stands in for the PIN only where the passcode cannot release it:

- **iOS** keeps the PIN's copy in the Keychain behind `BiometryCurrentSet`. `BiometryAny`, which
  earlier versions wrote, opens for a face or finger enrolled afterwards, and enrolling needs only
  the passcode. A change to the enrolled set leaves the entry unreadable, and the next unlock removes
  it, so the switch shows off.
- **Android** keeps it under a key of the app's own module, `specs/NativeVoltzBiometric.ts`, that the
  Keystore lets work for one operation at a time, after a strong biometric on the prompt that carries
  that operation (`BiometricPrompt.CryptoObject`), and that a new enrollment invalidates. Every key
  react-native-keychain makes for an authenticated entry (10.0.0 and 11.0.0) opens for five seconds
  after any strong biometric or device credential, the lock screen's unlock included, and the library
  decrypts before it prompts, so unlocking the phone with its passcode and opening the app within five
  seconds released the PIN with no prompt. The pattern is the one in Android's biometric guide and in
  Blockstream Green (`AndroidKeystore.kt`). An invalidated key is found only when it is used, so after
  a new enrollment the switch still reads on until the next biometric unlock, which fails, removes the
  entry and takes the keypad's biometric key away; from then the switch shows off. Sealed bytes the key
  cannot open (`AEADBadTagException`, left by an enroll whose prompt was cancelled) end the entry the
  same way, while any other Keystore failure keeps it for the next unlock. A prompt asked for once the
  app has left is refused at once as unavailable, since `BiometricPrompt` would never show it or
  answer.
- **The recovery words** always ask for the typed PIN, as Phoenix asks its own PIN before showing them
  (`DisplaySeedView.kt`). The words are the wallet, and no platform rule about biometrics should
  decide whether they show.

## Wrong PINs

Six digits fall to automation in days at a few tries a second, so `enterPin` in `src/wallet/pin.ts`
counts wrong PINs in a row in the Keychain beside the PIN, and counts each attempt before it compares,
so ending the app mid-check still counted it. After five, each wrong PIN waits twice as long as the one
before, from 30 s up to an hour, about 24 tries a day at the top; nothing is erased, as Phoenix erases
nothing (`CheckPinViewModel.kt`). The wait runs on the process's steady clock, which Settings cannot
move, and a new process waits the whole wait for the count again, so neither setting the clock forward
nor closing the app shortens it. That clock stops while the phone sleeps, so a wait counts only time
awake and can run longer than its figure, never shorter. A right PIN, or a biometric, clears the count,
and so does erasing the PIN. A biometric's clear waits for any check under way, which would otherwise
write its count over it; erasing the PIN clears it at once, so an erase never waits on a check. Every
keypad that asks for the PIN shares it: the lock, the recovery words, changing the PIN and turning on
biometric unlock.

The process keeps the count it read and every count it wrote, so a Keychain that fails on the count
never takes the wait away. A count that cannot be read waits as the first wait does, as an unreadable
one does, and one that cannot be written still counts for as long as the app runs. A check that fails
anyway says so on the keypad and takes the next try. A PIN typed while a wait runs is refused without
being compared, so it is not called wrong.

## Accepted residue

- The keyboard is closed on every leave, short trips included, since it is a window above the cover.
- On Android, a person who leaves the app from inside one of its own activities (the home button on
  the photo picker) is locked after ten minutes, not two, and the trip is counted from the activity's
  start.
- A person who waits out each wait while the keypad is open still gets about 24 tries a day.
- iOS system sheets that are not presented controllers (the App Store purchase sheet, the passkey
  sheet) are not dismissed by the lock.
- Forgot PIN erases every wallet with no device check where the device reports no lock to check: a
  phone with no screen lock, and Android below 11, which react-native-keychain reports as having none
  whatever is set (`passesDeviceCheck` in `src/wallet/biometrics.ts`). The erase reveals nothing, and
  each wallet comes back from its recovery phrase.

## Only a device can confirm

- The cover is in the iOS switcher snapshot and is the first frame back on both platforms.
- The Android cover Dialog is above an open sheet's Dialog, and the cover is gone within 250 ms of a
  short return.
- TalkBack and VoiceOver find only the mark while the cover is up.
- The iOS clock keeps counting across a real sleep, and a date changed in Settings moves neither
  clock.
- On Android, unlocking the phone with its passcode and opening the app at once shows the biometric
  prompt, never the wallet; a fingerprint enrolled after biometric unlock was turned on makes the next
  biometric unlock fail and remove the entry, after which the switch shows off; and on iOS a face or
  finger enrolled afterwards does the same.
- On Android, a cancelled re-enroll leaves an entry the next biometric unlock removes, and a biometric
  prompt asked for while the app is in the background answers at once.
- The biometric prompt over the lock, the photo picker and the store's sheet ask nothing on Android
  when answered within ten minutes, and Home pressed inside the photo picker with a return after ten
  minutes comes back covered and shows the PIN.
- A share sheet or `ActionSheetIOS` left open is gone when the PIN shows after two minutes, and an
  open sheet closes without its slide showing over the PIN, on Android under the cover until its
  exit has ended.
- A per-app language change, which recreates the Android activity, neither locks nor leaves the cover
  up.
- Back on Android's root screen, which ends the activity, and a return after two minutes: the new
  activity is covered from `onResume` and shows the PIN, never the wallet.
