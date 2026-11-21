# AGENTS.md

Voltz Wallet is a self-custody Bitcoin wallet for iOS and Android, written in React Native and
TypeScript on the Breez SDK Spark. It holds bitcoin and Spark tokens (USDB, DePix and any token added
by its identifier), and it sends and receives over Spark, Lightning and on-chain Bitcoin. This file is
the working guide for anyone changing the code, person or agent. `CLAUDE.md` imports it.

## Invariants

Three rules outrank convenience, UX and deadlines. They are set out in
[docs/principles.md](docs/principles.md), and what each party can and cannot do is in
[docs/trust-model.md](docs/trust-model.md).

1. The wallet's private key is created on the device and never leaves it. No server run by the
   project receives a mnemonic, a seed, a key, a passkey or a passkey's PRF output, whatever the
   feature. A passkey wallet derives its mnemonic on the device from the user's passkey, which the
   user's own Apple or Google account may sync, end to end encrypted, and which the project never
   receives.
2. The project takes custody of nothing, fiat included. Bitcoin bought through Moonpay (`BuyScreen`)
   is delivered straight to the wallet's own address.
3. The app adds no spread to a swap, a conversion or an exchange rate. What it sells has a fixed
   price.

UI copy in every language never uses words that name custody or brokerage, such as bank, deposit and
withdraw as financial acts, trade, exchange or broker. `__tests__/locales.test.ts` holds every locale
to a list for its language.

## Stack

- React Native 0.86 on the New Architecture with Hermes, TypeScript, Node 22.11 or later.
- Breez SDK Spark (`@breeztech/breez-sdk-spark-react-native`) as the only wallet engine.
- React Navigation, i18next with react-i18next, react-native-keychain, react-native-svg.
- Jest with react-test-renderer, and Stryker for mutation runs over `src/wallet`.

## Commands

```bash
npm run setup                 # npm ci, the SDK's native artifacts, Firebase placeholders. Never npm install
cp .env.example .env          # then fill in BREEZ_SPARK_API_KEY
bundle install && (cd ios && bundle exec pod install)   # iOS, after native dependency changes

npm start                     # Metro. Add -- --reset-cache after any change to .env
npm run ios                   # macOS with Xcode
npm run android

npx jest                      # the whole suite, or npx jest <files> for a subset
./scripts/typecheck.sh        # the type check. Never run tsc directly
npx eslint .
node scripts/check-secrets.mjs  # no seed, key, filled API key or home path in tracked files
npm run mutate                # Stryker over src/wallet, slow
```

CI runs `./scripts/typecheck.sh`, `npx eslint .` and `npx jest --ci` (`app-check`), and
`node scripts/audit-gate.mjs` and `node scripts/check-secrets.mjs` (`app-audit`), on every pull
request and on every push to `main`. `device-smoke` builds a debug APK and checks that the app starts
on an Android emulator, on manual dispatch only; the same walk runs locally with
`node scripts/device-smoke.mjs --android --boot-only` before a release.

## Source layout

```
App.tsx                 boot, PIN gate, RTL direction check
src/
  config.ts             the only module that reads '@env'
  theme.ts              design tokens (space, radius, colors, font, touch, motion)
  i18n/                 i18next setup, languages.ts (picker list, isRTL), pluralRules.ts, locales/ with 24 locales
  wallet/               logic kept out of components and tested directly (dollarMode.tsx is its one React module)
    spark.ts passkey.ts the only modules that import the Breez SDK, passkey.ts alone for its passkey provider
    seed.ts             BIP39 generation, validation and Keychain storage
    wallet.ts           wallet lifecycle over walletRegistry.ts (add, switch, remove)
    amount.ts fiat.ts   amount parsing, fiat conversion and formatting for any currency code
    tokens.ts assets.ts known Spark tokens, the Home asset list and its order
    history.ts payment.ts   history model, grouping, date and time formatting
    paymentNotice.ts    what an in-app payment notice says: the record's rail, the asset, the amount
    conversionNotes.ts      what the SDK quoted for a Convert, read only where it gives nothing else
    lnaddress.ts        lightning address rules (LUD-16)
    price.ts            bitcoin price series for the asset screen
    errors.ts           raw SDK errors mapped to stable codes that screens translate
    store.ts storePurchase.ts   the store bridge's one reader, and a store purchase's talk with the gateway
    screenCapture.ts qrImage.ts the iOS capture bridge's one reader, and the still image QR reader's
    emergencyExit.ts    the switch of everything an emergency exit adds, off until it is measured
    chainRelay.ts       the one reader of the public chain hosts, which takes only hex, txids and addresses
    exitFeeKey.ts       the BIP84 key that pays an exit's fees, derived from words and passphrase, never kept
    exitQuote.ts        whether an exit's quote may go on, what arrives, what of a live exit the balance counts, and when a quote is too old
    exitPlan.ts         the one record of an exit, one file per wallet, the only writer of it
    exitPass.ts         prepare, build, and the pass that checks, writes, sends and writes again
    exitHold.ts         whether an exit holds Send and Receive, asked of the active and the connected wallet
    updateNotice.ts appVersion.ts   the signed update file's one reader, and the version it compares
    relock.ts           the native cover's and leave stamp's one reader, and the rule that asks the PIN again
    webhook.ts webhookSecret.ts paymentWebhook.ts   the provider's payment webhook: what it should be,
                        the secret kept in the Keychain per wallet, the removal marker kept per key
                        until the provider confirms, and the pass each connect runs
    deviceForget.ts     the one sender of the forgets the gateway is still owed
  hooks/  navigation/  components/  screens/
  assets/               bundled flags, asset and network marks, logos
__tests__/              the suite
__mocks__/              native and ESM-only modules replaced under Jest
scripts/                typecheck.sh, audit-gate.mjs, check-secrets.mjs, design-metrics.mjs, design-pending.json, device-smoke.mjs
docs/                   engineering notes
```

## Architecture rules

- **Screens never talk to the SDK.** `src/wallet/spark.ts` and `src/wallet/passkey.ts` are the two
  modules that import `@breeztech/breez-sdk-spark-react-native`, and `passkey.ts` is the one reader of
  its `passkey-prf-provider` entry, reached from inside a function so that a device below the minimum
  never loads it. Everything else calls their functions and reads the UI-shaped types they return.
- **Logic that can run outside React lives in `src/wallet/*.ts`** and is tested there, not inside a
  component. Backup verification, amount validation and currency formatting are tested this way.
- **One engine.** Each money rail is a thin wrapper that forwards to its Spark screen (`SendScreen`
  renders `SendSpark`, and the same holds for Receive, Redeem and Convert).
- **Store purchases go through `src/wallet/store.ts`.** Names and domain years are sold through the
  App Store and Google Play by one thin native module per store (`specs/NativeVoltzStore.ts`,
  `ios/VoltzWallet/Store/`, `android/app/src/main/java/app/usevoltz/store/`), and `store.ts` is its
  only reader, as `spark.ts` is for the SDK. The gateway opens an order before the store's sheet, asks
  the store itself whether the purchase was paid, and delivers; the device never consumes a Play
  purchase and never finishes an App Store transaction on its own verdict. A build sells in sats only
  when it is a development build whose `.env` says `direct` (`distributionFor` in `src/config.ts`).
  Detail in [docs/store-bridge.md](docs/store-bridge.md).
- **`src/config.ts` is the only reader of `@env`.** The dotenv Babel plugin inlines values at build
  time, so the rest of the code depends on functions that tests can mock.
- **UI takes its sizes and colours from `src/theme.ts`.** Read
  [docs/design-system.md](docs/design-system.md) before touching UI. No component has an outline in
  any state: an outline, a raw colour and a literal number in any `border*Radius` are lint errors, and
  surfaces separate by fill and space. The one line is a row divider, from `dividerBottom` and
  `dividerTop`. Every input is `Field`, every list search `SearchField`, every switch `Toggle`, and a
  title the screen draws is `ScreenTitle`. Loading states use `components/Skeleton.tsx`, never an
  `ActivityIndicator` or a "Loading" string. The one spinner is the pull gesture's own
  (`hooks/usePullRefresh.tsx`), over content that stays on screen, and a pull never shows a skeleton. Glass surfaces use `LiquidGlassView` and fall back to
  a plain fill when `isLiquidGlassSupported` is false (Android, iOS below
  26). "Liquid Glass" is Apple's UI material and is unrelated to any Breez SDK.
- **Every UI string goes through i18next**, and numbers, currency and dates follow the locale. The
  rules are in [docs/i18n.md](docs/i18n.md).

## Traps

Each of these breaks something without breaking the suite.

- **The binding's types outrank the SDK documentation's examples.** `connect()` resolves to an
  interface whose methods do the work, `balanceSats` is a `bigint`, variants are enums and tagged
  classes, and events are tagged unions read through `.tag` and `.inner`. Open the `.d.ts` before
  using a new method. Detail in [docs/breez-sdk-binding.md](docs/breez-sdk-binding.md).
- **The SDK's native artifacts are not checked against the package version.** The download step
  skips itself when the artifact directories exist, whatever version put them there. An Android
  crash with `checksum mismatch` at startup has its own diagnosis. Both are in
  [docs/breez-sdk-binding.md](docs/breez-sdk-binding.md).
- **Dependencies install with `npm run setup`.** `.npmrc` sets `ignore-scripts=true` and
  `min-release-age=7`, so a plain install never fetches the SDK's native artifacts, and the iOS and
  Android builds fail while the JavaScript tests still pass. Changing a dependency follows
  [docs/supply-chain.md](docs/supply-chain.md).
- **A release build is never signed with the debug key.** The tracked `android/app/debug.keystore`
  holds the stock Android SDK debug key, whose private half is on every machine with the SDK, so an
  APK signed with it installs as an update of the app and inherits its Keystore. `assembleRelease`
  and `bundleRelease` fail when `android/keystore.properties` is missing, on purpose. See
  [docs/release-signing.md](docs/release-signing.md).
- **Storage and entropy hardening needs a real device.** Requiring `SECURE_HARDWARE` from the Android
  Keystore makes wallet creation fail on devices without a TEE. `seed.ts` refuses to generate a seed
  when `crypto.getRandomValues` is missing or when the draw falls back to `Math.random`, and any
  stricter rule is validated on hardware before it lands.
- **Screens are never frozen.** `enableFreeze` and the `freezeOnBlur` option of `react-native-screens`
  hide a screen by suspending it on react-freeze's one shared thenable, and React 19 retries three or
  more such boundaries in a loop ([react/react#37556](https://github.com/react/react/issues/37556)).
  The JS thread then commits about 150 times a second with no update scheduled, every timer stands
  still, and an overlay that closes on a timer stays up for up to a minute. `__tests__/entry.test.ts`
  keeps the entry from turning it back on.
- **An animated view's resting value reaches React late.** React keeps a Reanimated view's
  first-render style until a JS timer hands it the value the animation rested on. Reanimated before
  4.5.3 discards that value two seconds after the last frame whether React has it or not, so a JS
  thread busy at a cold start leaves the drawer drawn closed while its status stays open, and Back and
  TalkBack act on a drawer nobody sees
  ([reanimated#9527](https://github.com/software-mansion/react-native-reanimated/pull/9527)).
  `__tests__/reanimatedSettledProps.test.ts` holds the version the lockfile installs.
- **iOS reports a capture and cannot stop one.** Android's `FLAG_SECURE` blocks screenshots and
  recordings at the window. On iOS `specs/NativeVoltzCapture.ts` only relays UIKit's signals, so a
  screen that draws words goes through `useScreenCapture`, which keeps them off the tree until the
  first read answers and while the screen is recorded or mirrored, and takes the confirm with them.
  A screenshot cannot be undone, only asked to be deleted. Android has no such module, so its words
  are drawn at once. From API 34 the activity window is also accessibility data sensitive
  (`MainActivity`), so only services declared as accessibility tools read its text; React Native
  copies `FLAG_SECURE` into a Modal window but not that mark, so words and passphrases never go in a
  Modal, which `__tests__/androidActivity.test.ts` holds.
- **A decoded image is a scanned code.** Text from `src/wallet/qrImage.ts` goes through `submit` in
  `ScanScreen`, never to a confirm, and an image with two different codes answers neither. ML Kit
  comes from VisionCamera's `implementation`, so the app compiles against it with a `compileOnly` at
  the same version and adds nothing to the APK. The Vision half is Swift because an Objective-C++
  import does not link a framework.
- **iOS offers to save a passphrase as a password.** A secure field iOS takes for a password is
  offered to Passwords once it leaves the screen, and one tap on Save puts the BIP39 passphrase in
  iCloud Keychain, off the device. `textContentType="none"`, `autoComplete="off"` and
  `importantForAutofill="no"` did not stop it on iOS 26.5; `textContentType="oneTimeCode"` does, so
  every secure field carries it, and `__tests__/secureFieldSave.test.ts` reads src to hold that.
- **Pasting into a controlled `TextInput` does not fire `onChangeText`** on React Native 0.86 with
  the New Architecture. The text shows in the native field while React state stays empty, so
  `ImportScreen` and `AddAssetScreen` have an explicit Paste button that reads `Clipboard.getString()`
  and routes the text through the same path as typing. A unit test that calls `onChangeText` directly
  does not see this.
- **On iOS the read that shows the paste permission prompt can return an empty string.** A Paste
  button treats an empty read as nothing to do, never as an error, so the next tap pastes, which is
  what both paste buttons do.
- **On Android 15 and later `adjustResize` does nothing.** An app targeting SDK 35 or later is drawn
  edge to edge there, and React Native 0.86 turns that on for the activity and for every Modal
  window whatever `edgeToEdgeEnabled` says (`WindowUtil.kt`, `ReactModalHostView.kt`). The system
  does not resize an edge-to-edge window for the keyboard, so a field or a footer stays above it only
  through a `KeyboardAvoidingView` with `behavior="padding"` on both platforms, which `Screen` and
  `Sheet` add when given `keyboard`. An emulator on Android 14 or earlier still resizes and hides the
  problem.
- **The leave is stamped and covered natively, and JS only decides.** A JS `'background'` handler runs
  only on the return when iOS suspends first, and a cover drawn from JS comes after the snapshot and
  the first frame back. So `applicationDidEnterBackground` and `MainActivity.onPause` (before super)
  stamp the leave on the boot clock (`CLOCK_MONOTONIC_RAW`, `elapsedRealtime`) and raise a native
  cover above every Modal, and `useRelock` decides on `'active'` through
  `specs/NativeVoltzPrivacy.ts`: under `RELOCK_AFTER_MS` it only lowers the cover; at the limit it draws
  the PIN over the mounted navigator in the commit that closes every Modal (`useCloseOnLock`), and
  lowers the cover once the PIN lays out, through `hideCoverAfterModals`. Android plays a closed
  Dialog's exit after the app lets go of its window, so there the cover waits for each Modal window
  under it to close and finish its exit. Every Modal in src calls `useCloseOnLock`, which
  `__tests__/relock.test.tsx` holds. A prompt or picker the app starts goes through `asOwnActivity`,
  which times Android's pause under it against `RELOCK_AFTER_OWN_MS` (ten minutes) instead of two.
  See [docs/app-lock.md](docs/app-lock.md).
- **Switching wallets does not reconnect the SDK.** `switchWalletWithoutReconnecting` repoints the
  registry and notifies listeners, which is what the wallet picker wants. The SDK reconnects when
  `HomeScreen`, `HistoryScreen` or `AssetDetailScreen` gains focus. A flow that switches and then calls the SDK
  without navigating uses `switchWalletAndConnect`; otherwise it signs with the previously connected
  wallet and keeps that wallet's lightning address domain, which the SDK reads once at connect.
  Adding, switching, removing and the boot all move the pointer through `activate` in `wallet.ts`,
  which announces the move; a bare `setActiveWallet` leaves Home on the previous wallet's figure. The
  one exception is the boot's repair of an unreadable list, which writes the pointer with the rebuilt
  list before any screen listens.
- **A listed wallet can have no seed on the device.** The registry (`wallets.json`) lives in
  Documents, which an iCloud or computer backup carries to a new iPhone, while every seed is stored
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which Apple says does not migrate to a new device. So `activate`
  asks `hasSeedFor` before any move and refuses an absent seed with `WalletSeedAbsent`; the boot
  (`settleActiveWallet`) moves the pointer to the first listed wallet that has its seed, then to a
  primary seed the registry does not list, and shows Welcome only when none has; the first-run
  onboarding registers and activates its wallet (`addFirstWallet`). The words of a listed wallet whose
  seed is absent take that wallet's id back, in the first run and in Add wallet, because the domain,
  the remembered address, purchase proofs and deletion marks are kept per id; other words take the
  primary id only when the registry is empty. A read that throws is not an absent seed: it moves
  nothing, and the boot stops on its error screen. Android reaches this state through no backup: the
  manifest sets `allowBackup="false"`, and `res/xml/data_extraction_rules.xml` excludes every domain
  from cloud backup and from device-to-device transfer, which some makers still run without it. A copy
  that arrives anyway brings ciphertexts whose Keystore keys stayed behind, so the boot's first read
  rejects with `E_CRYPTO_FAILED`; the boot moves nothing on it, since a passing Keystore fault answers
  the same, and its error screen says what happened and offers the Forgot PIN erase.
  The SDK's own folder (`Documents/spark`), with the payments, the contacts and the address in the
  clear, is flagged out of backups at every connect, so it never crosses; the network gives it back.
  The registry and `passkey-wallets.json` still cross, since they hold ids and fingerprints, not
  payments, and the words of a listed wallet take its id back only because the list crossed.
- **A file whose loss costs wallets or money is never written in place.** Android's `writeFile`
  truncates before it writes, so a process killed mid write leaves the file torn, and a reader that
  takes an unreadable file for an empty one hands the next writer an empty start to write over. Such
  files go through `src/wallet/durableFile.ts`, which writes whole to a temporary copy first and
  throws `UnreadableFile` rather than answer empty, with every read and write of a file in one queue.
  RNFS never syncs, and an emulator power cut seconds after a write left an exit plan at 0 bytes, so
  the copy is synced, renamed over the file and the directory synced before a write resolves, through
  `specs/NativeVoltzDurable.ts` (F_FULLFSYNC on iOS, where fsync stops at the drive's cache);
  a few readers answer empty by design and say why where they read, such as the address memory. A
  file is torn only when its bytes are. A read the platform refuses rejects with its own error, which
  nothing takes for torn, sets aside or writes over, and the screens that guard a payment read it as
  a record they could not read. RNFS decodes UTF-8 in JS, so a file cut inside a multibyte character
  fails its text read too, and `readAt` tells the two apart by reading the bytes as base64. A
  `wallets.json` that cannot be read is rebuilt at boot from the seeds the Keychain lists, each under
  the fingerprint of its words and passphrase, and the file is set aside as `wallets.json.unreadable`,
  never deleted; listed wallets whose seeds are not on the device are lost from the list, and on iOS,
  where the Keychain can keep an app's items after the app is deleted, the rebuilt list also brings
  back wallets whose seeds an earlier install left there. A boot that cannot finish, that repair
  included, shows a way out (Try again, Write to support) rather than the splash, and opens no wallet.
- **A balance read before the first sync is the last sync's figure, however old.** `getInfo` with
  `ensureSynced: false` answers the stored account state, and `ensureSynced: true` blocks until a sync
  that never comes offline. Its `lastSyncedAt` is kept in storage across connects, so it dates the
  figure and never makes one current on a new connection. Its `lastSyncError` is the reverse: set, it
  says the latest sync could not refresh the balances, and unset it proves nothing, since each connect
  clears it. Each connection in `spark.ts` counts as synced after its own first `SdkEvent.Synced`, and
  again after the first one heard since each return from the background (`sparkNoteResumed`), and
  `sparkGetWalletInfo` reports `waiting`, `stale` (past `SYNC_WAIT_MS`) or `synced`. A reported failure
  makes it `stale` at once, whatever the wait says, and its text stays in `spark.ts`, since the SDK
  writes it for logs. Only the SDK's first `Synced` waits for the wallet's own sync. A later one is
  sent when any part of a sync succeeded, so `spark.ts` reads `lastSyncError` before it takes one as
  proof, and a figure counted as synced after a resume can still predate the suspension only when a
  `Synced` lands before the wallet's own sync has ended; see
  [docs/breez-sdk-binding.md](docs/breez-sdk-binding.md). A screen shows a balance as current only
  when it is `synced`, keeps the skeleton while `waiting`, marks it as not updated when `stale`, and
  re-reads through `useSyncRefresh`. Home reads by itself as well (`useLiveFigures`), on every SDK
  event, on a return from the background and every 30 s while it is in front, one read at a time, and
  those rules hold for each read; such a read leaves the editor open and the rows in the order shown. The payment list follows the same rule, and says it holds no
  transactions only when `synced`. A pull (`sparkRefreshWallet`) proves nothing by resolving, since
  `syncWallet` answers `Ok` when the wallet sync failed and puts the failure in its answer, so a
  reported failure, or no `Synced` heard, leaves the connection `stale` at once, until the next
  `Synced` with no failure behind it.
- **A total that skips a holding is not the total.** Without the rates (offline, or a feed missing a
  peg's currency) a pegged token has no value, and a token with no peg never has one. Home labels its
  figure the total only when `walletFiatTotal` values every nonzero holding; otherwise it shows the
  bitcoin balance under its own label and leaves the tokens to the asset list. A tap on the figure
  walks the total, sats and BTC and skips what cannot be stated: with tokens the sats and BTC figures
  are that total at the rate and carry the approximate mark, since tokens are not bitcoin (`heroRead`
  in `src/wallet/heroFigure.ts`).
- **An empty address read is not an empty wallet.** `getLightningAddress` answers nothing both
  while a domain is off the edge and after a refund took a bought name back, and a wallet holds one
  address, so registering is replacing. A wallet that remembers a name never mints over it:
  `sparkEnsureLnAddress` asks the gateway (`POST /api/name/state`, `src/wallet/nameState.ts`) and
  moves on only when the answer says the name was taken back, or is another wallet's after a
  transfer, and nothing is live, to the wallet's first name or, when it has none, a generated name
  that is never the one taken back; no answer claims the remembered name back. A wallet that
  remembers nothing (every Android restore) asks about its key alone before it mints, since the
  gateway makes only a wallet's first name free once it has one: it takes that first name back, notes
  a live address without touching it, and mints only with no first name or no answer. A transfer's
  claim forgets the name on the wallet that gave it, and removing a wallet forgets its memory. The
  SDK's cache keeps a name a refund took back until the next connect, so the purchase sweep, seeing
  an annulled credit, has `sparkRefreshTakenBackAddress` reconnect once for that wallet and name,
  after the address turn and never while a send, a prepare or an address change is in flight.
  Every register, transfer claim and delete runs in one turn (`inAddressTurn`), and an automatic
  register reads the address and the memory again inside it, so a name chosen meanwhile is the one
  kept and a delete meanwhile is not undone.
- **The SDK's passkey provider does not fit its own bridge.** It rejects with an exception the generated
  callback does not recognise, which reaches Rust as a panic in a library built to abort, so a sheet
  the person closed could take the app down; it answers absent fields with null and the domain check
  with a plain object, which never lower, so the Rust call never answers; and it iterates the
  ArrayBuffers of a pinned sign-in. `bridgedProvider` in `passkey.ts` is what crosses, and
  `PasskeyClient` built with no provider is never used. All of it is read in the generated code and
  reproduced with the real provider under Jest, not on a device. See [docs/passkey.md](docs/passkey.md).
- **`PASSKEY_LIVE` and `VoltzWallet.entitlements` change in one commit.** Without
  `webcredentials:usevoltz.app` every ceremony fails with a configuration error while the availability
  check says yes. On iOS that check is answered `Skipped` in `bridgedProvider` without reaching the
  native module, which takes two arguments where the package passes one and ends the app when asked.
  `__tests__/passkeyWallet.test.ts` reads both and fails
  on one without the other. The relying party, its name and the label are constants for the same kind
  of reason: changing any leaves every passkey without its wallet.
- **An exit's plan is the one record of it, and preparing the same leaves again starts a rival.** The
  SDK keeps no recovery: `checkRecoverFunds` follows only what it is handed, so the plan goes to disk
  before the first transmission and each check replaces it before the next, and a failed write sends
  nothing. Only `exitPlan.ts` writes it, through its own codec, since JSON has no bigint and the
  binding's converters read `tag` and `inner`. While a plan is alive the drawer row and the Home card
  open the follow-up, `prepareExit` and `startExit` refuse, `removeWalletById` refuses with
  `WalletHasLiveExit`, Send neither prepares nor confirms and Receive draws no code (`exitHold.ts`),
  reading on each focus and again at the press, and `spark.ts` refuses every spend, every receive (Buy
  included) and every lightning address made, claimed or read for that wallet before the SDK is called.
  No connection of it runs automatic leaf optimization or a stable balance, whatever path opened it, and
  a pass transmits only after `sparkStopSpendsOnItsOwn`. Home and the asset screen draw the SDK's own
  figure, never as the total, under a line saying the wallet is held and part of the figure may be
  leaving, since the binding gives no status per leaf and the SDK takes a branch's leaves out on its
  own; every exit figure is what arrives (`exitArriving`). An unreadable plan holds as a live one does. Starting over names the same
  leaves with the funding kept in the plan, never `All`. `EMERGENCY_EXIT_LIVE` is on since the real
  SDK (0.28.0, release build) connected and quoted with the operators down, and a real package was
  accepted by a host and confirmed. `Done` and `recoverFunds` with
  the operators down are not measured yet. Only Jest can force the switch, and a bundle keeps the value
  it ships with. See [docs/emergency-exit.md](docs/emergency-exit.md).
- **`parse` answers the same for an address that does not exist and for a network that is down.**
  The SDK swallows the reason, and `sparkClassify` returns `other` for both. Anything that would call
  an address wrong checks first: the send field speaks of the connection when the wallet has no sync
  behind it, and `verifyLightningAddress` takes a refusal to the URL the SDK asked, where a 400, 404
  or 410 denies the address and any other answer, or silence, is no verdict. Text with an `@` goes
  over the network as soon as it reaches `parse`, so the send field holds it back until
  `couldBeAddress` passes, which is as wide as the SDK's parser rather than the rule for a name the
  app registers.
- **An empty contact list is proof of nothing until the read answered.** The SDK refuses no duplicate,
  so a read that failed must not look like an address that is new; `useContacts` says whether the
  newest read answered. A contact made on another device lands on a later `Synced`, which
  `onSparkSynced` does not report, so `ContactsScreen` reads again on any SDK event, and its empty
  line waits for a sync.
- **Token amounts are in the token's base units, fees included.** USDB has 6 decimals and DePix 8.
  `SparkSendQuote.amount` and `.fee` are sats when `tokenIdentifier` is undefined and base units
  otherwise. In `SparkCrossChainQuote`, `amountIn` is in the unit its `source` names, sats or USDB
  base units, `feeSat` is sats, and `estimatedOut` and `feeAmount` are base units of the destination
  asset. History reads
  `details.tag === 'Token'`, or 10 USDB renders as 10 sats. See
  [docs/stablecoin-usdb.md](docs/stablecoin-usdb.md).
- **A Spark token is identified by its identifier, never its name.** Anyone can issue a token called
  DePix. `KNOWN_TOKENS` in `tokens.ts` is what the app recognises by identifier (peg, mark, the
  lookalike warning in `AddAssetScreen`), and `DEFAULT_TOKENS` is what every wallet lists at zero
  balance. A held token always shows, and only a zero-balance catalog row can be hidden. What a person
  adds or hides belongs to the wallet in front (`tokenPrefs.ts`, keyed by wallet id), and removing a
  wallet drops its lists. A payment notice names a token only through `KNOWN_TOKENS`; any other goes
  unnamed, with a line saying the app does not recognise it (`paymentNotice.ts`), which the arriving
  pill, too narrow for it, only speaks to a screen reader.
- **Spark has no browsable token registry.** A token is added only by its identifier, which
  `sparkResolveToken` looks up through `getTokensMetadata`, so there is no search by name.
  `TokenMetadata` carries no icon, so a token's logo is bundled with the app and keyed by identifier
  in `AssetIcon`, and any other token shows a letter badge.
- **The SDK refuses to sign a message that starts with `breez-lnurl:`.** That namespace is reserved,
  and `signMessage` fails with `InvalidInput` before any request is made. Every statement the app
  signs uses its own `voltz-<purpose>:v<n>` prefix (`voltz-domain:v1`, `voltz-push:v4`), which also
  keeps those signatures from being replayed against the LNURL server. See
  [docs/breez-sdk-binding.md](docs/breez-sdk-binding.md).
- **The SDK gives the current price, not a history.** `listFiatRates()` returns one rate per
  currency. The chart takes its shape from Kraken's keyless OHLC endpoint and is rescaled to end on
  the SDK rate, and it lives on the asset screen rather than on Home. See
  [docs/price-chart.md](docs/price-chart.md).
- **An update banner cannot be told apart from a scam by its words, so the file has none.** The
  notice carries versions only: `updateNotice.ts` reads one signed file, whose banner strings and
  store link are fixed in the app, and whatever else the file holds is ignored. Anything short of a
  signed, readable answer shows nothing, nothing about the answer is stored, and neither the boot nor
  the navigator imports it, so at no level can it stand between a person and their funds. The read
  waits for Home's first frame and `@noble/curves` loads on first use through Metro's `inlineRequires`,
  because the signature check is pure JS on the JS thread. A release moves `APP_VERSION` together with
  `versionName` and `MARKETING_VERSION`, and `__tests__/appVersion.test.ts` holds the three.
- **The store link is a store app's own scheme, never https.** An https link would add
  `apps.apple.com` and `play.google.com` to the hosts the app calls. A simulator has no App Store, so
  there the tap does nothing, and it needs a real device to prove.
- **Hermes has no `Intl.PluralRules`.** Without it i18next picks `_one` for 1 and `_other` for
  anything else in every language, while Jest on Node picks the CLDR category, so a plural form can
  pass the suite and never show on a device. `src/i18n/pluralRules.ts` installs CLDR's rules for the
  shipped languages, held to ICU by its test, and each locale carries a form for every category its
  language uses. See [docs/i18n.md](docs/i18n.md).
- **`.env` is compiled into the bundle.** Metro caches the transformed module, so after editing
  `.env` restart it with `npm start -- --reset-cache`, or the app keeps the old value.

## Tests

- Pure logic in `src/wallet/*.ts` is tested with negative and edge cases, not only the happy path.
- Flow tests drive the real components (the whole onboarding, for example), not isolated functions.
- A fixed bug gets a test that fails without the fix. Break the implementation on purpose and watch
  the test go red before trusting it.
- Jest runs against the mocks in `__mocks__/`. Keychain, entropy, rendering and the SDK connection
  are only exercised on a device or simulator, so a claim that something works on a device needs a
  run there.

Conventions and known traps of the suite are in [docs/testing.md](docs/testing.md).

## Commits and pull requests

A commit message explains why the change exists, naming the defect or need behind it and what was
ruled out.
Checks to run before a pull request are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Further reading

- [docs/custom-domain.md](docs/custom-domain.md), lightning addresses on a domain of your own
- [docs/passkey.md](docs/passkey.md), a wallet whose words come from a passkey, and what the bridge
  to the SDK's provider has to fix
- [docs/onboarding.md](docs/onboarding.md), the first-run stages and what going back does in each
- [docs/firebase.md](docs/firebase.md), the Firebase files kept out of git and their placeholders
- [docs/push-notifications.md](docs/push-notifications.md), the notices sent while the app is closed,
  and the provider's payment webhook
- [docs/nfc.md](docs/nfc.md), reading a destination from an NFC tag on Send
- [docs/store-bridge.md](docs/store-bridge.md), the App Store and Google Play bridge and its tests
- [docs/data-deletion.md](docs/data-deletion.md), deleting a wallet's data at Voltz and the mark that holds it
- [docs/emergency-exit.md](docs/emergency-exit.md), moving funds on-chain without the operators
- [docs/app-lock.md](docs/app-lock.md), the PIN asked again after time away, and the native cover before it
- [docs/breez-sdk-binding.md](docs/breez-sdk-binding.md), [docs/i18n.md](docs/i18n.md),
  [docs/testing.md](docs/testing.md)
- [docs/design-system.md](docs/design-system.md), [docs/supply-chain.md](docs/supply-chain.md),
  [docs/release-signing.md](docs/release-signing.md)
