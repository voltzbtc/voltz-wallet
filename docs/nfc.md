# NFC on Send

A **Tap** chip on the Send screen reads an NFC tag carrying a destination (a `bitcoin:` or
`lightning:` URI, or an invoice or address as text), fills the field and moves the screen to review.
It exists only on Send, since Receive has no NFC.

## Code

- `wallet/nfc.ts`, `nfcState()`, `openNfcSettings()`, `readNfcDestination()` and `cancelNfcRead()`,
  isolating `react-native-nfc-manager` the way `wallet/spark.ts` isolates the SDK. Tests in
  `__tests__/nfc.test.ts`.
- `SendSpark.tsx` hides the chip where the phone has no NFC or the check fails. With NFC switched
  off (Android only, since the library answers enabled on iOS) the chip says to turn it on and a tap
  opens the system NFC setting (`goToNfcSetting`) instead of reading. The state is asked again on
  every focus, on every return to the app and when the quick settings over the app hand focus back,
  so NFC switched on shows the reading chip without reopening Send. A cancelled read is silent. The
  chip has its own row, since a fourth chip in the row of three spills its label on a 360dp phone.
- `hooks/useNfcRead.ts` runs a read as a person sees it, and `components/NfcReadSheet.tsx` is the
  sheet Android shows while it waits for a tag, since Android gives a waiting read no interface of
  its own. iOS draws its own system sheet. Cancel, the back gesture and leaving the screen all end the
  read (`__tests__/nfcReadSheet.test.tsx`).
- An `nfc` icon in `TabIcon`, and the `send.nfc`, `send.nfcOff`, `send.nfcSettingsFailed` and
  `send.nfcFailed` strings.
- On Android, `AndroidManifest.xml` carries `uses-permission NFC` and `uses-feature nfc
  required=false`.
- On iOS, `Info.plist` carries `NFCReaderUsageDescription`, and
  `ios/VoltzWallet/VoltzWallet.entitlements` carries `com.apple.developer.nfc.readersession.formats`
  set to `["TAG"]`. `TAG` and not `NDEF`, because the library reads NDEF through an
  `NFCTagReaderSession`, and App Store uploads that ask for `NDEF` have been refused with "NDEF is
  disallowed" (Apple Developer Forums, thread 781403). A device build needs the NFC capability in its
  provisioning profile, which automatic signing adds from the entitlement as **Near Field
  Communication Tag Reading**.

## The library is loaded only when its native module is linked

`react-native-nfc-manager` runs `new NativeEventEmitter(NativeModules.NfcManager)` as it loads.
Without the pod installed, `NativeModules.NfcManager` is `undefined` and `new NativeEventEmitter()`
requires a non-null argument. A try/catch does not hold this, because Metro's dev loader
(`guardedLoadModule`) reports the init throw straight to LogBox, a red screen, before the catch is
reached. So `wallet/nfc.ts` checks `NativeModules.NfcManager` before requiring, and without the native
module the library is never loaded, so NFC reads as unavailable, the chip disappears, and no screen
crashes. Linking it takes `npx pod-install ios` and a rebuild, since a Metro reload is not enough.

## Trying it on a device

The iOS simulator has no NFC and the Android emulator does not read a tag, so a read needs a physical
phone with NFC on, an iPhone 7 or newer on iOS.

- Write an NDEF tag with `lightning:<invoice>` or `bitcoin:<address>`, using something like NFC
  Tools.
- Touch it to the phone with Send open. The destination field fills and review opens. Cancelling the
  read shows no error.

Jest covers the module, the hook and the sheet. A read from a real tag is not measured.
