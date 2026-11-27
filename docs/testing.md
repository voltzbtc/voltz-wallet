# Testing

```bash
npx jest                                  # the whole suite, as CI runs it with --ci
npx jest __tests__/amount.test.ts         # a subset while working
npm run mutate                            # Stryker over src/wallet, slow
node scripts/device-smoke.mjs --boot-only # the app starts and draws its first screen
```

## What a test is for

A test validates behaviour. A test that would still pass with the behaviour broken is noise, and it
reads as protection it does not give.

- **Pure logic is tested where it lives.** Anything that can run outside React sits in
  `src/wallet/*.ts` and has its own test file, with negative and edge cases (invalid input, a failing
  dependency, boundary values), not only the happy path.
- **Flow tests drive real components.** `onboarding.test.tsx` renders `App` and presses through the
  real screens, so the wiring between them is under test too, not only each function.
- **Every fixed bug gets a regression test** that fails without the fix. Write it first and watch it
  go red.

## Mutation checks

A test that passes before and after a change proves nothing about that change. To show that a test
guards what it claims to:

1. Break the implementation on purpose, one change at a time.
2. Confirm that the mutation is in the file, then confirm that the right test goes red.
3. Restore the implementation and confirm that the suite is green again.

A mutation that survives means the behaviour is not covered, whatever the test is called. Say so in
the pull request rather than presenting the test as a guard.

`npm run mutate` runs Stryker over `src/wallet/**/*.ts` with `enableFindRelatedTests`, so each mutant
reruns only the suites that import the file it changed. The screen flow tests are excluded from
mutation runs (see `stryker.config.json`). The report is written to `reports/mutation/`, and the
sandbox lives in `.stryker-tmp/`, both gitignored. `jest.config.js` ignores `.stryker-tmp/`, because a
leftover sandbox would otherwise make Jest collect every test twice.

## Doubles and fixtures

- **A fake keeps the contract of what it replaces.** When an injected fake does something the real
  implementation does not, such as reconnecting the SDK after a wallet switch, the suite stays green
  over a broken flow. Check the real implementation against the contract the fake assumes.
- **A fake can represent failure.** A double of the SDK with no way to express an empty balance or an
  error cannot test the screens that handle those states.
- **Fixtures copy the real shape.** A fixture with a placeholder such as `{domain}` in it can tell a
  filled string from a raw one; a fixture with plain text cannot.

## Known traps

- **`toContain` on a string matches a substring.** Seed words compared that way pass by accident,
  since the BIP39 word `all` is inside "wallet". Compare whole words, or check membership in the
  wordlist.
- **A screen rendered on its own skips `App.tsx`**, so i18next is never initialised and `t()` returns
  the raw key. Import `'../src/i18n'` in the test.
- **`Pressable` cannot be found by type** on React Native 0.86, since it renders as an inner `View`.
  Locate a control by the pair of an `onPress` prop and its label (text or `accessibilityLabel`).
- **Components built on reanimated are stubbed** in `jest.setup.js` (the drawer, `AssetList`,
  `WalletList`, `Skeleton`, `Reenter`, `ReceivedOverlay` and `SplashScreen`). Assert on the props they
  receive, for example the `assets` prop of `AssetList` or the `beat` of `Reenter`, not on text they
  would have rendered. The suites
  that test these components themselves (`receivedOverlay.test.tsx`, `dragLists.test.tsx`) unmock
  them and replace reanimated and gesture-handler with inert stand-ins.
- **react-test-renderer does not clean up on its own.** `jest.setup.js` unmounts every tree after each
  test; a tree left mounted keeps scheduling work and fails unrelated tests once the environment is
  torn down.
- **A cold cache charges the first render.** Each react-native export is a getter that requires its
  module on first read, and with no transform cache that module is compiled on the spot, which cost
  Convert's first test 2.8 s locally and more than the 5 s limit on the CI runner. `jest.setup.js`
  reads the exports listed in `jest.rnWarmup.js` before any test, and `jestWarmup.test.ts` fails when
  the app imports one the list lacks. Measured on 2026-09-29 with `npx jest --ci --no-cache`: 117
  suites green with the warm-up, 8 failing without it. A warm local run hides this, so a timeout that
  only CI sees is checked with `--no-cache` first.
- **Jest resolves react-native for iOS, whose `BackHandler` drops every listener**, so a test of the
  Android back gesture sees nothing. `onboardingBack.test.tsx` and `addWalletBack.test.tsx` mock
  `react-native/Libraries/Utilities/BackHandler` with the actual `BackHandler.android` module and emit
  `hardwareBackPress` on `DeviceEventEmitter`. That module calls the listeners newest first and exits
  the app when none takes the press, so a spy on `BackHandler.exitApp` is what tells a step back from
  leaving the app.
- **The app's `Text` wraps React Native's.** `findAllByType(Text)` with React Native's `Text` still
  finds every text, but a test that climbs from a text to the box around it walks up to the first
  `View` rather than counting parents, since the wrapper adds a level.
- **A money figure is checked by the boxes Yoga lays it out in.** `__tests__/support/figureFit.ts`
  finds the figures in a rendered tree and reads every row each one sits in, nested rows included.
  `figuresHeldOut` names a figure behind a box that neither shrinks nor is capped at a share of the
  row, or whose floor is wider than a touch target, which pushes it past the row's edge on a device,
  and a figure beside a box that keeps its width, which squeezes it to a few points at the largest
  sizes. A box beside the figure passes when a number of points bounds it, a share of the row short
  of the whole caps it, it takes only what is left, or it shrinks with no floor beside a figure side
  that is capped and never shrinks, which is how `FigureRow` lays a label out,
  so a label drawn beside a figure by hand turns its caller's test red. A tree with no figure fails
  rather than passes. `__tests__/support/` holds helpers, so Jest does not collect it as suites.
- **A gesture is fired by its test id.** A gesture built with `.withTestId(...)` is driven with
  `fireGestureHandler(getByGestureTestId(id), [...])` from `react-native-gesture-handler/jest-utils`,
  as `onboardingBack.test.tsx` does for the edge swipe. A disabled gesture receives nothing, as on a
  device.
- **Other copies of the repository are kept out.** The Stryker sandbox and Claude Code's worktrees
  under `.claude/` each hold a copy of the tests and of `__mocks__`, and a plain `jest` would collect
  the tests and pick the wrong mocks, so `jest.config.js` ignores both. Jest matches those patterns
  against absolute paths, and a worktree's own path contains `/.claude/`, so both `.claude/` entries
  start at `<rootDir>`. A bare `/.claude/` keeps the worktrees out of a run from the main checkout,
  but it also makes `npx jest` inside a worktree collect none of its own tests and stop at "No tests
  found", which reads as a problem with the files asked for rather than with the config. Anchored, a
  run from the main checkout still lists no worktree test, and a run inside a worktree lists its own.

## Mocks

`__mocks__/` replaces modules that are native or ship ESM that Jest does not transform:

- `@breeztech/breez-sdk-spark-react-native`
- `@callstack/liquid-glass`
- `@react-native-clipboard/clipboard`
- `@react-native-firebase/messaging`
- `react-native-fs`
- `react-native-get-random-values`
- `react-native-keychain`
- `react-native-localize`
- `react-native-nfc-manager`
- `react-native-qrcode-svg`
- `react-native-safe-area-context`
- `react-native-vision-camera`

The Keychain mock stores nothing and answers every read with absent. A test that adds a wallet,
through the onboarding or Add wallet, gives it an implementation that keeps what it is given and
resets the in-memory fs between tests, because making a wallet active reads its seed's presence back
and refuses an absent one, and the first run lands on the primary id only while the registry is empty.
Its listing of services answers an empty list as well, so a test of the boot's repair of an unreadable
`wallets.json` makes `getAllGenericPasswordServices` name the services its in-memory Keychain holds,
as `bootRepair.test.tsx` and `walletRestore.test.ts` do.

`specs/__mocks__/NativeVoltzCapture.ts` and `NativeVoltzQrImage.ts` are not wired in `jest.setup.js`:
a suite about capture or the gallery asks for them with `jest.mock`, and every other suite runs with
no module, as Android runs for capture and an older binary for the gallery. A read of the capture
double stays in flight until the test answers it, and the QR double reads a file, so code that
deletes the picked image first fails as on a phone. `NativeVoltzShare.ts`, the Android image share,
is asked for the same way, and its double also reads the file it is handed and keeps what it found.

Every `.svg` import resolves to `__mocks__/svgMock.js` through `moduleNameMapper`, since Jest does not
run the SVG transformer that Metro uses. `react-native-restart` is mocked in `jest.setup.js`.

## What the suite cannot see

Jest runs against those mocks, so the Keychain, real entropy, rendering, native modules and the SDK
connection are never exercised by it. Liquid Glass renders only on iOS 26 and later. A claim that
something works on a device needs a run on a device or simulator.

The SDK double has the binding's shapes but not its timing. Its `syncWallet` answers at once and its
listener never hears an event unless a test sends one, while the real SDK sends `Synced` before
`syncWallet` returns and returns only after collecting exit data, which can take seconds. So no race
between an event and an answer happens on its own under Jest. A test of one writes the order by hand,
holding the answer in a promise and sending the event itself, as `refreshWallet.test.ts` does with
`hanging()` and `synced()`, and an order no test writes is not covered.

`scripts/device-smoke.mjs` drives a booted iOS simulator (through `idb`) or Android emulator
(through `adb`). With `--boot-only` it asserts that the app starts and draws a screen of its own, and
CI runs that on an Android emulator. The rest of the walk needs a wallet that already holds a
lightning address, so it runs on a machine that has one.
