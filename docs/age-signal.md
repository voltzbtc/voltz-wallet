# The stores' age signal

California's Digital Age Assurance Act (Civ. Code 1798.500 et seq.) has every app ask the operating
system or the app store for an age signal when it is downloaded and launched, from 1 January 2027. The
app asks once per launch, through Google's Play Age Signals API on Android and Apple's Declared Age
Range on iOS.

## The pieces

| Piece | What it does |
|-------|--------------|
| `specs/NativeVoltzAge.ts` | The codegen spec: `regulated()` and `request()` |
| `android/app/src/main/java/app/usevoltz/age/` | Play Age Signals 0.0.6, pinned in `android/gradle/verification-metadata.xml` |
| `ios/VoltzWallet/Age/` | Declared Age Range, weak linked (`-weak_framework DeclaredAgeRange`) so iOS below 26 still launches |
| `src/wallet/ageSignal.ts` | The one reader: asks once, reduces the answer to a verdict, and holds it in memory |
| `src/wallet/heldWallets.ts` | The fingerprints of wallets removed from this device, which the gate lets back |
| `src/hooks/useMinorSignal.ts` | Whether the verdict is a minor's, for the screens that gate |
| `src/components/AdultsOnly.tsx` | What replaces the ways to a new wallet |

## The flow

1. `App.tsx` calls `askAgeSignal()` on mount. It never holds the boot.
2. `regulated()` asks the store whether the person is in a region whose law makes the signal
   mandatory: Play's `getApplicableAgeFeatures` containing `MANDATORY_SHARING`, or
   `AgeRangeService.isEligibleForAgeFeatures` on iOS 26.2 and later. Anything else, and every iOS
   below 26.2, answers false, and nothing further is asked. Nobody outside a regulated region sees a
   prompt.
3. `request()` asks for the range. On Android it is `requestAgeSignalsAccess` with the current
   activity, which may show Play's sharing prompt, and then `checkAgeSignals` once access is
   `SHARED`. On iOS it is `requestAgeRange(ageGates: 18, in:)`, which may show the system's sheet.
   The JS side brackets it with `asOwnActivity`, since Play's prompt pauses the activity.
4. `verdictOf` reduces the answer: a top under 18 is `minor`, a floor of 18 or more is `adult`, and
   everything else (declined, verification required, a range open at both ends, a failure) is
   `unknown`. Only the verdict is kept, in memory, for the launch.

## What a minor's verdict stops

- A new wallet: `addFirstWallet` and `addAndActivateWallet` in `wallet.ts` throw `AgeRefusal` before
  anything is written. A wallet this device holds or held is not new and goes on: one `wallets.json`
  lists (with its seed, or without it after a backup carried the list), and one removed here, by
  Remove wallet or by the erase behind Forgot PIN and Erase and restore, whose fingerprints
  `heldWallets.ts` keeps so those sheets' promise of a restore holds. Welcome and Add wallet draw
  `AdultsOnly` in place of the choice and every step that draws new words, with a link to the import
  step, which stays: the write decides whether typed words are a wallet this device held. Words it
  refuses go back to `AdultsOnly`.
- A store purchase: `buyInStore` answers `{ kind: 'adultsOnly' }` before any order is opened, and the
  name and domain screens say so.

Nothing else reads the verdict. A wallet already on the device opens past the PIN and keeps Send,
Receive, its words and the emergency exit, whatever the signal says. `__tests__/ageSignal.test.ts`
lists the files that may read it and fails on a new one.

## Rules that hold it

- **A failure never blocks.** No module, no Play Store, a network error, a cancelled task, iOS below
  26.2 or a missing entitlement all end as `unknown`. A gated step waits at most `AGE_WAIT_MS` for an
  ask still in flight, then goes on.
- **The signal stays on the device.** Nothing in the reader or the native modules logs, writes or
  sends it, and a refusal's message names no age. Callers that would log a failed write skip the log
  for `AgeRefusal`. Play's policy limits the signal to complying with the law.
- **A new error case from a newer iOS is not a crash.** The Swift side catches every error and
  switches on `Response` with `@unknown default`, and it never reads `AgeRangeDeclaration`, whose
  cases grew in 26.2 and 26.5.

## What only a device proves

Jest drives the reader through the double in `specs/__mocks__/NativeVoltzAge.ts`. A real answer needs:

- Android: an install from Google Play (internal testing is enough), since the API answers only apps
  Play updates. A sideloaded APK gets an error, which blocks nothing. `FakeAgeSignalsManager` ships in
  the same artifact for a debug build.
- iOS: the `com.apple.developer.declared-age-range` entitlement on the App ID (automatic signing adds
  it), iOS 26.2 or later for `isEligibleForAgeFeatures`, and Apple's sandbox for age testing.
