# Contributing

Thank you for helping. Read [docs/principles.md](docs/principles.md) first. It describes the three
rules no change can break (keys stay on the device, no custody of anything, no spread on a swap or an
exchange rate), and a pull request that weakens any of them is declined whatever else it improves.
[AGENTS.md](AGENTS.md) is the working guide to the code and lists the traps that break things without
breaking the tests.

## Contributor terms

The software is licensed under the [PolyForm Strict License 1.0.0](LICENSE), which gives no right to
make changes to it or to distribute it. These terms add what a contribution needs, and submitting a
contribution means you accept them. A contribution is any change you submit to this repository, such
as a pull request or a patch.

Bitwright LTDA gives you an additional permission to use, copy and make changes to the software, and
to keep them in a fork or branch on the service that hosts this repository, solely to prepare, test
and submit a contribution to this repository, whether or not that work is itself commercial. The
permission covers nothing else, so the changed software may not be used or distributed for any other
purpose.

By submitting a contribution, you grant Bitwright LTDA a perpetual, worldwide, non-exclusive,
royalty-free, irrevocable licence to use, reproduce, modify, distribute, sublicense and relicense
your contribution, including in commercial products. You keep the copyright in your contribution.
You confirm that you have the right to grant this licence, because the contribution is your own work
or because whoever owns it has given you permission.

## Setting up

Follow the setup in [README.md](README.md). Two points differ from a stock React Native project:

- Install with `npm run setup`, never `npm install`. Dependency install scripts are off in `.npmrc`,
  and the setup script fetches the Breez SDK's native artifacts explicitly and puts a Firebase
  placeholder in place of any missing config ([docs/firebase.md](docs/firebase.md)).
- Adding or bumping a dependency is a deliberate change. Follow
  [docs/supply-chain.md](docs/supply-chain.md), and read the `package-lock.json` diff before
  committing it.

## Before opening a pull request

Run the same checks CI runs, and make sure each one passes:

```bash
./scripts/typecheck.sh        # not tsc directly, see docs/breez-sdk-binding.md
npx eslint .
npx jest
node scripts/check-secrets.mjs
```

Then check the change against the rules the tools enforce only in part:

- Screens never import the Breez SDK. Only `src/wallet/spark.ts` and `src/wallet/passkey.ts` do,
  `passkey.ts` alone for the SDK's passkey provider.
- Logic that can run outside React lives in `src/wallet/*.ts` and has its own tests.
- Every user-facing string goes through i18n, in every locale (see [docs/i18n.md](docs/i18n.md)).
- UI values come from `src/theme.ts`, following [docs/design-system.md](docs/design-system.md).
- Anything that depends on a device (native modules, the Keychain, rendering, a live SDK connection)
  says in the pull request whether it was run on a device or simulator, and on which platform.

## Design

The app's screens and components are drawn in a Figma file anyone with the link can open,
[Voltz Wallet, design system e app](https://www.figma.com/design/HHYuNcpckPu4KfZyDtYkzf). Its variables
carry the names of the tokens in `src/theme.ts` (`color/surface` is `colors.surface`, `space/lg` is
`space.lg`), its text styles follow the roles of `Txt`, and its components carry the names of those in
`src/components`, each description naming the code it mirrors. A visual change starts from those
components and variables. The file draws text in Inter in place of the platform fonts, so type is
measured in the app, and where the file and the code disagree the code decides and the file is the one
corrected.

## Photos of a visual change

A change that touches a screen attaches a before and an after photo of that screen, on Android and
on iPhone, and the reviewer looks at them before approving. Lint and the design ratchet read the
source, and a number can be right while the screen is wrong, so a review of a visual change that saw
no photo did not review it. The pull request template has the place for them.

The app's window is `FLAG_SECURE` (`MainActivity.kt`), so `adb exec-out screencap` comes back black, on
an emulator too. An Android emulator reads its own framebuffer instead, which writes one PNG into the
folder named:

```bash
adb emu screenrecord screenshot ./photos/android   # an emulator only, a phone has no such command
xcrun simctl io booted screenshot ./photos/iphone.png
```

A black photo is a failed photo, not a dark screen: open it before attaching it. Use a test wallet,
never one that holds a real phrase, and keep amounts, addresses and words out of what is attached.

## Tests

- New logic comes with tests that validate it, including invalid input and edge cases.
- **Every fixed bug gets a test that fails without the fix.** Write it before the fix, watch it fail,
  then make it pass.
- When a test is meant to guard a behaviour, break that behaviour on purpose once and confirm the test
  goes red. A test that passes with the behaviour broken guards nothing.

Conventions and known pitfalls of the suite are in [docs/testing.md](docs/testing.md).

## Commit messages

A commit message explains why the change exists, not only what it does. Name the defect or need
behind it, and what was considered and ruled out. Keep each commit to one coherent change with the
suite passing.

## Writing

Code comments, documentation and commit messages are in English. Comments explain the reason and
the invariant in the present tense rather than restating the code. Prose in the repository and in
the app uses no em dash.
