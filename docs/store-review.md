# The store's review card

The app asks the store for its review card at most once per wallet, after a completed receive the app
announced for that wallet, at a quiet moment on Home. It adds no UI and no string of its own: the card
is the store's.

## What the stores ask for

- Google Play In-App Review
  ([developer.android.com/guide/playcore/in-app-review](https://developer.android.com/guide/playcore/in-app-review)):
  ask after the person has had a meaningful experience, never from a button, and expect nothing back.
  Play enforces a quota, and the API does not say whether the card showed. Unit tests use a fake.
- Apple StoreKit
  ([Requesting App Store reviews](https://developer.apple.com/documentation/storekit/requesting-app-store-reviews)):
  the system shows the prompt at most three times in 365 days, never in response to a user action,
  always in a development build and never in TestFlight.
- The open source `react-native-in-app-review` module (MIT) is the reference for both bridges:
  `requestReviewFlow` then `launchReviewFlow` on Android, and the foreground active window scene on iOS.

## The pieces

| Piece | What it does |
|-------|--------------|
| `specs/NativeVoltzReview.ts` | The codegen spec: `request()` |
| `android/app/src/main/java/app/usevoltz/review/` | Play In-App Review 2.0.2, pinned in `android/gradle/verification-metadata.xml` |
| `ios/VoltzWallet/Review/` | `AppStore.requestReview(in:)` from iOS 16, `SKStoreReviewController.requestReview(in:)` below it |
| `src/wallet/storeReview.ts` | The one reader: the asked record, the decision, the call |
| `src/navigation/homeInFront.ts` | Whether Home's tab is in front with the drawer closed |
| `src/hooks/useStoreReview.ts` | The received overlay's two moments, announced and closed |
| `src/components/UnderLock.tsx` | `openModalCount()`: every Modal registers through `useCloseOnLock` while open |

## The rules

1. `ReceivedOverlayHost` calls `onAnnounced` when it shows a completed receive, which notes the wallet
   whose connection it came on. A pending or failed receive, a sent payment and a conversion leg never
   reach it (`receiveUpdateFromEvent` in `spark.ts`), and the host only mounts once the wallet is open,
   so onboarding never asks.
2. The overlay's close is the one chance for that receive. The decision runs in the commit after the
   close, when the overlay's own Modal has unmounted and the leave from Receive has put Home in front.
   It asks only when Home's tab is in front with the drawer closed, no Modal or sheet is open, the PIN
   asked again is not up, the app is active, no send or prepare is running and the wallet has no send
   left pending, and only for the wallet in front. Otherwise the receive is used up, and the next
   announced receive is the next chance. No timer asks later.
3. `store-review.json` lists the wallets asked. The wallet goes on the list before the store is asked,
   so a process killed between the two leaves it never asked. A list that cannot be read counts every
   wallet as asked and is never written over. Removing a wallet drops it from the list.
4. A failure, or no native module, asks nothing and says nothing, and the wallet stays on the list.
   Android starts the card as an activity of the app's own (`asOwnActivity`), so its pause is timed
   against `RELOCK_AFTER_OWN_MS`.
5. Nothing leaves the device but the store's own prompt.

## Not measured

The card on a device: Play shows it only for an install from Play (internal testing, or internal app
sharing), and its quota can hide it. iOS shows it in a development build on a device or simulator.
