# The migration to the design system

What moving the screens onto the design system changed, and above all **what it left out and why**.
This file exists so those decisions are not rediscovered and the refused pieces are not rebuilt.

The system itself (scales, tokens, rules) is in `design-system.md`. This file is about the migration.

## What changed, measured

Measured with `scripts/design-metrics.mjs` before and after the migration.

|                               | before | after |
| ----------------------------- | ------ | ----- |
| style blocks                  | 784    | 591   |
| duplicated blocks             | 57%    | 24%   |
| distinct text styles          | 47     | 34    |
| targets that announce nothing | 24     | 4     |
| raw line height               | 1      | 0     |
| raw tracking                  | 21     | 9     |
| tests                         | 1402   | 1779  |

The migration covers 28 screens. They build on nine primitives (`Screen`, `Sheet`, `Touch`, `Txt`,
`Amount`, `Card`, `Row`, `EmptyState`, `Field`), and `<Field>` has ten consumers.

The meter is `scripts/design-metrics.mjs` and the gate is `__tests__/designRatchet.test.ts`. **Every
change to the shape of the ratchet is commented in that file, with its reason.**

## What is left out on purpose

None of these is a pending item. Each line carries its reason, and the reason always has the same
shape: **the same look, a different thing.**

| what                                                          | why                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SendSpark.input` (the destination)                           | fixed height of 96, an asymmetric `paddingRight` that reserves room for the absolute clear button, multiline aligned to the top |
| `ScanScreen.manualInput`                                      | multiline, autofocus, aligned to the top                                                                                 |
| `AddAssetScreen.input`                                        | multiline, `minHeight: 72`                                                                                               |
| `ImportScreen.cell` (12 or 24)                                | index on the left, transparent border at rest, error in solid red. It is a word grid, not a form                         |
| the `HomeScreen` skeleton                                     | it has to keep reproducing the real row height, or it stops working as a skeleton                                        |
| `DiceFace` (`face`, `faceRow`, `cell`, `pip`)                 | a drawing, not content                                                                                                   |
| the inside of `AmountSheet`                                   | it is drawn on `Sheet`, but its fields sit in one scroll, so the shared gap spaces only the scroll, the keypad and Confirm, and the eight `marginTop`s in four values inside stay |
| `ReceivedOverlay`                                             | adopts the **contract** of `<Amount>` without the piece, since the number counts up inside an `Animated.Text`            |
| `ScanScreen`, `PinScreen`, `SplashScreen` outside `<Screen>`  | their roots are a camera, a `Pressable` and an `Animated.View`                                                           |
| the two 12pt uppercase labels in `ConvertSpark`               | the app's three `xs` blocks carry three weights and two trackings between them. They are not a repeated shape             |

## Three pieces that are refused

Each refusal rests on a measurement.

- **`<QrFrame>` is a shared style, not a component** (`qrFrame` and `qrFrameLarge` in `theme.ts`).
  Two of the four sites apply the frame to an element that already exists, so a component would add
  a `View` to carry what is only a style. And **it is not a `<Card>` variant**, because the white is
  a requirement for reading the QR, not a finish.
- **`accentSoft` in `useAccent` is not built.** Seven blocks pair a soft fill with a solid colour,
  and all seven use `primarySoft`, for warnings about the recovery phrase and the domain, which **must
  not follow the mode** (a seed warning tinted green reads as something about the dollar balance). No
  block with a soft fill follows the mode, so no honest consumer exists.
- **`<Badge>` is not built.** There are two sites, not three, and both keep a neutral fill while the
  text takes four colours. The third candidate has an animated dot with a colour computed at runtime,
  which is the same silhouette with a different job.

The measurement behind the first two refusals is in the comment beside the code (`theme.ts` for
the QR frame, `dollarMode.tsx` for the soft accent); the count behind `<Badge>` is the one above.

## A role's name does not state its size

A role with an obvious name can carry a size or weight the block it replaces does not have. Each of
these reads right by name and differs on one axis:

1. `titleStrong` is semibold, lighter than `title`, which is bold.
2. `labelStrong` is 14pt, so it is not the strong form of a 16pt label.
3. `section` is 14pt, medium, at tracking 1, the form the majority of uppercase headings share on
   each axis.
4. `heading` is 20pt against the heroes' 24, which is why `UNIT_ROLE.display` points at
   `titleStrong`.
5. `subheading` is 18pt semibold, so a medium 18pt line moved onto it matches in size and colour and
   still changes **weight**.

**The rule that closes this** is to compare all **three** axes (size, weight, colour) against the
block when moving it onto a role, never the role's name against the intent.

## Four choices in the shape of the ratchet

All four share one cause, a number whose denominator or population moves for reasons unrelated to
what it is meant to watch.

1. `styleBlocks` is reported and not held, because a perfect new screen still adds blocks.
2. Mute targets are held as a count (`a11y.mute`), not as `mutePercent`, because consolidating
   removes a **labelled** target from the denominator.
3. Duplication is held as a count (`clonedBlocks`), not as `clonePercent`, and only over blocks of
   two declarations or more, because adopting a token turns a one-key block into a copy of every
   other one-key block.
4. `labelPercent` is off the ratchet, because a label on a target that already has text makes the
   announcement **worse**, so a higher label count is not good in itself.

## Invariants a migration breaks quietly

Each of these reads correct at a glance when it is broken, and each has a regression test.

- **The received overlay takes its figure, unit and format as one prop**
  (`receivedOverlay.test.tsx`). As separate props with defaults, a caller passing only the figure
  looks correct and draws 0.25 USDB as "0 USDB".
- **Hiding the balance hides the fiat line beside it** (`home.test.tsx`, `assetDetail.test.tsx`). The
  mask lives in three places, and the fiat line masks with four dots where the figure uses six, so a
  test on one place alone passes with the fiat still showing.
- **The dice "Generate" button sits in the footer of `<Screen>`**, which carries the safe-area inset
  (`screen.test.tsx`), so the button clears the gesture indicator.
- **The Send and Redeem review actions sit in the footer of `<Screen>`** (`sendSpark.test.tsx`,
  `redeemSpark.test.tsx`). As the review's last row they fell below the fold on a 16:9 Android
  screen, under the gesture indicator of an edge-to-edge window, where the payment could not be seen
  without scrolling.
- **The dice keys show press feedback** (`diceScreen.test.tsx`, `touch.test.tsx`). A 24-word seed
  takes 99 taps in a row, and without feedback a missed tap looks like one that landed.
- **A wrong twelfth word turns red when its cell loses focus** (`importScreen.test.tsx`), which needs
  a real `onBlur` handler behind the comment that promises it.
- **The manual entry field on Scan and the name field on the address sheet take focus once their
  sheet is shown** (`scan.test.tsx`, `lnAddressSheet.test.tsx`), because on iOS a Modal's
  `autoFocus` fires before the sheet is presented.
- **A token the app cannot resolve borrows nothing from USDB** (`amount.test.tsx`). A fallback that
  answers "not found" with USDB's decimals and ticker puts the amount off by orders of magnitude
  under another token's name.
- **The backup skeleton takes its height from the same arithmetic as the word cell**
  (`backupScreen.test.tsx`), so the grid does not jump when the words arrive.
- **The warning and error soft fills match by composite luminance, not by alpha**
  (`softPairs.test.ts`), so neither reads stronger than the other over the dark ground.

## Test where a bug can be, not only where one is known

The screens that handle money most directly each have a test file (`RecoveryPhraseScreen`,
`BackupScreen`, `PassphraseScreen`, `AddAssetScreen`, `ImportScreen`, `AssetPickerSheet`), and
`Field` asserts on the element that takes the typing. Without them, deleting the 12 words from the
recovery phrase, leaving the passphrase permanently visible, or disabling the balance eye would all
keep the suite green.

**The rule** is to mutate what a screen **draws** when migrating it, not only what it decides.

## Targets that still announce nothing

The ratchet holds `a11y.mute` at 1. The drawer button, the QR zoom and the wallet colour swatches
have since been named. The meter reads a `Figure`, an `Amount` or a `FigureRow` inside a target as
text, as it reads a `Text` or a `Txt`, so the add-amount links on Receive and on the stable receive
panel no longer count. A target whose own tag hides it from assistive tech on both platforms
(`accessibilityElementsHidden` and `importantForAccessibility="no-hide-descendants"`) is no target
for a screen reader and is left out; one of the two hides it from one platform's reader only, so the
target still counts. What the count still holds is the whole `SplashScreen`, one `Pressable` that
skips the animation.

## Movement that ignores reduce motion

`rules.motionUnreduced` counts the files that start an animation driving a transform or a size, or
open a `Modal` that slides, and never read `useReduceMotion`. A fade alone is left out, since the
setting is about movement. Receive and Convert read it; the ratchet names the ten files left, each
gated by the work that owns it, and goes to zero once they land. A loading spinner counts too, since
iOS keeps its own spinner turning under the setting.

## Checks that need a device

| what                                 | the test, in one sentence                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| the 24-word grid                     | open with a 24-word phrase and see whether it fits without extra scrolling (the line height adds 40pt)   |
| a full VerifyBackup tray             | fill all 24 chips and count the rows (each chip is 44pt tall)                                             |
| the contact sheet on an iPhone SE    | open a contact, focus the **second** field, and see whether the title is still visible                     |
| the inset inside a `Modal` on Android | print `insets.bottom` in an open sheet. If it is zero, the bottom padding disappears                      |
| a field at 200% text size            | raise the system type size and see whether the box **grows** instead of clipping                          |
| the destination's `height: 96` on iOS | type three lines, delete everything, and see whether the box returns to 96. If it does, `minHeight` works there |
