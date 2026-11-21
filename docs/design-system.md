# Design system (Apple HIG conventions)

The source of truth for the app's visual tokens. **Read this before touching any UI.** Every value
derives from the [Apple Human Interface
Guidelines](https://developer.apple.com/design/human-interface-guidelines/layout). The tokens live in
`src/theme.ts`, and a spacing or radius number is never hardcoded in a screen.

The Figma file linked from [CONTRIBUTING.md](../CONTRIBUTING.md#design) draws these tokens as variables
of the same names and is the visual reference; when it and this document or `src/theme.ts` differ, the
code is right.

## Spacing (8pt grid)

`space` in `theme.ts`. Every margin and padding comes from here, never a loose number.

| Token | pt | Typical use |
|-------|----|-------------|
| `xs`  | 4  | gap between icon and label, fine adjustment |
| `sm`  | 8  | short gap between elements |
| `md`  | 12 | inner padding of a row or control |
| `lg`  | 16 | **the standard content margin** on Apple mobile, card padding |
| `xl`  | 24 | separation between blocks and sections |
| `xxl` | 32 | large breathing room (top of a screen, hero) |

Apple's rule puts the horizontal content margin on mobile at 16pt. The app uses **24 (`xl`)**
deliberately, which is roomier. That is the app's standard, and it is not mixed with 16.

### Vertical rhythm

- **Header to first content** is the container's margin (`space.xl`) and nothing else, on every
  screen. A `paddingTop` on the first block stacks on that margin, and 24 plus a 32 padding reads as a
  56pt gap.
- **Between sections** (balance, buttons, list) the gap is `space.xxl` (32), consistently.
- **Inside a group** (label, value, caption) the gap is `space.sm` (8), set as a `gap` on the
  container, with each text on the leading its size pairs with (`font.leading`) so the spaces read
  as equal. Two texts take a larger size's leading on purpose, both in the price band: the period, a
  `caption` on the 24 of the price across from it, and the "out of date" word, a `caption` on the
  name's 24, so the band's two columns pair line for line (`priceStrip.test.tsx` holds the pair).
  Never a `lineHeight` equal to the font size: iOS draws a line into a box exactly that tall and
  cuts what rises above it, which on Home took the top off Hindi vowel signs, Thai tone marks and
  Vietnamese stacked accents, and the digits on the same line with them. `rules.hugLineHeight` in
  `scripts/design-metrics.mjs` holds that at zero.
- **Control height** of a button is `minHeight: touch.min` (44), declared rather than
  computed. The `paddingVertical: 14` alongside it is breathing room and nothing more. Padding cannot
  guarantee the target, because a box is as tall as its **line height**, not its font size, and a sum
  such as 14 + 16 + 14 assumes the text stays 16pt and the device never scales type. A declared
  floor holds when neither assumption does.
- **Selector height** (a segmented track, a picker row or a text field) is `touch.selector` (48),
  shared so stacked choices read as one column. The track's segments come out at 40 and reach 48 of
  touch through a 4pt `hitSlop` above and below. Selectors sized by their content do not line up, and
  on the receive screen three of them measured 33, 34 and 48pt. A field and a picker row also share
  their 16 of side padding, so text stacked across them starts on one edge.

### A title and what follows it

One rule, in `rhythm` in `theme.ts`, for every screen.

| From | To | Token | pt |
|------|----|-------|----|
| A native header, or the top of a step | first content | `headerToContent` | 24 |
| A title | its subtitle | `titleToSubtitle` | 8 |
| A title, or the subtitle closing it | first block | `titleToContent` | 24 |
| A one-line hint under a header | first block | `hintToContent` | 16 |
| The last group of a form | its action | `groupToAction` | 32 |
| A section's muted label | the list under it | `sectionLabelToList` | 12 |
| One section | the next | `section` | 32 |
| A search field | its list | `searchToList` | 8 |

A title the screen draws itself is `ScreenTitle` (`title`, `subtitle`, `onBack`, `centered`),
which owns the space inside and below it and takes no style, so a screen cannot choose its own. A
centred screen passes `centered`, and its group ends at `groupToAction`, since what follows is the
action. A pushed screen's title stays the native header's (`HeaderTitle`). `searchToList` is 8 because
a row's own 16 of padding makes up the 24 under a title; a list that opens on a section label, which
has no padding, adds that 16 itself, as Currency does.
A step inside a navigator whose header carries its title takes `headerTitled` and passes no `title`,
so one title shows and the subtitle and the action stay where they are.

## Corner radius (per component type)

`radius` in `theme.ts`. Apple uses **different radii per type**, and the hierarchy is intentional
rather than free aesthetics.

| Token | pt | Component |
|-------|----|-----------|
| `sm`  | 8  | very small controls |
| `md`  | 12 | **buttons**, the segments inside a segmented control |
| `lg`  | 16 | **inputs, dropdowns, cards and panels**, the segmented control's track |
| `xl`  | 20 | large containers, sheets (top corners) |
| `xxl` | 28 | a large full-bleed panel or sheet, such as Home's asset panel |
| `full`| pill | chips, avatars, capsule controls |

**A button (12) is not a card (16).** Give both the same radius and the hierarchy disappears.

**Nested corners are concentric.** A shape inside another takes the outer radius minus the padding
between them, so the two curves stay parallel. The segmented track is 16 with 4 of padding, which is
why its segments are 12. A radius that ignores the padding looks pinched at the corners.

**Inputs use 16 (`lg`), not 8.** Every field in the app is `Field`, at `radius.lg` on
`surfaceVariant`. A field or dropdown reads as a content card, not as a tiny control, and keeping them
all at 16 is what makes it consistent.

**Continuous curvature (squircle).** Every rounded rectangle carries `borderCurve: 'continuous'`
alongside its `borderRadius`. iOS uses the continuous curve natively rather than RN's default
circular corner, and without this the rounding does not match native apps. (Circles at `radius.full`
do not need it, since curvature does not change on a perfect circle.)

## How this is enforced

1. **This document.** Read before changing any UI.
2. **`theme.ts`.** The single source, so screens import `space`, `radius` and `colors` rather
   than typing numbers.
3. **ESLint, in CI.** In `src` and `App.tsx` these are errors:
   - a raw number in `borderRadius`, which forces `radius.*`;
   - `borderWidth`, `borderColor`, `borderStyle`, every side of them, physical and logical, the
     `outline` family and `boxShadow`, quoted or computed, in any file but `theme.ts`, which defines
     the row divider, the one line allowed;
   - a raw colour: a hex, `rgb()`, `rgba()` or `hsl()` string anywhere, a colour's name where a colour
     goes, except in `theme.ts`;
   - importing `Switch`, `Text`, `TextInput`, `ActivityIndicator` or `Alert` from React Native.
4. **The ratchet, `__tests__/designRatchet.test.ts`.** It counts what a line of lint cannot see,
   through `scripts/design-metrics.mjs`: an input outside `Field`, a switch outside `Toggle`, a search
   outside `SearchField`, a title outside `ScreenTitle`, a margin, padding or gap written as a number.
   A number that falls lowers its line in the same commit.

`__tests__/designGates.test.ts` plants each mistake and sees it refused through the config CI runs,
beside a control that passes. A file that cannot meet the outline rule yet goes in
`scripts/design-pending.json`, is spared that rule and no other, and leaves when it is fixed: the
test fails on a listed file that is already clean, the count is under the ratchet, and the list ends
empty.

Spacing is a ratchet and not a lint rule, since 14 and 15 appear beside a 44pt floor on purpose.

A visual change is reviewed by eye as well. Everything above reads the source, and a screen can pass
all of it and still look wrong, so a change that touches a screen attaches a before and an after
photo of it, on Android and on iPhone, and the reviewer looks at them. The way to take them through
`FLAG_SECURE`, `adb emu screenrecord screenshot` on an emulator, is in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Typography

`font.size` in `theme.ts`. Apple uses the **Dynamic Type** scale (SF Pro), and the app's is close. Pick
the token by its semantic role, not by the pixel:

| Token | px | Role (iOS equivalent) |
|-------|----|-----------------------|
| `xs`      | 11 | tab bar label, smallest caption (Caption2), the uppercase unit or chip inside a control (`microCaps`) |
| `sm`      | 14 | label, caption (Footnote/Subheadline) |
| `base`    | 16 | body, button text (Body/Callout) |
| `lg`      | 18 | secondary value (fiat) |
| `xl`      | 20 | section title (Title3) |
| `xxl`     | 24 | title (Title2) |
| `xxxl`    | 28 | an asset's balance, through the `titleLarge` role of `Txt` (Title1) |
| `display` | 40 | brand hero (the balance), above the 34pt Large Title deliberately |

**The typeface is the system's** (San Francisco or SF Pro on iOS, Roboto on Android). No family is
bundled, since SF Pro is licensed for Apple platforms only. Weight comes from `font.family.*`, which
are **style fragments** (`{ fontWeight }`) that are **spread** into a style, not a `fontFamily`.

```ts
label: { fontSize: font.size.base, ...font.family.semibold }
```

See [Apple HIG, Typography](https://developer.apple.com/design/human-interface-guidelines/typography).

### Large text

Type scales with the system text size, up to about 3.1 times at the largest iOS accessibility size
and 2 times on Android, and every screen is checked at both.

- **Text and TextInput are imported from `components/Text`, never from React Native** (a lint
  error). The native side measures every text again when the size changes with the app open, but the
  next render React commits brings back the old measurement of each text it did not render again, so
  the glyphs grow inside their old boxes and stay cut until the app is reopened. The app's `Text` and
  `TextInput` are keyed by the font scale, which makes each a new one, measured at the size it draws.
  A field keeps its value, which is the caller's state, and loses its focus, so a size change made
  while typing closes the keyboard. An animated text, which is not the app's `Text`, takes
  `key={...fontScale}` from `useFontScale` itself (`ReceivedOverlay`). A layout that depends on the
  size reads it from `useWindowDimensions` or `useFontScale`, never from a value read once.
- **A glyph inside a shape of fixed size caps its scaling** with `maxFontSizeMultiplier`, from
  `textScale` in `theme.ts`. Keypad digits stop at `keypadMax` (1.4), as the system keypads do, which
  keeps a 24pt digit inside a 44pt key; an avatar's initials are drawn to the disc and stop at
  `badgeMax` (1). Titles and every other text keep scaling.
- **A money figure is drawn by `Figure` or `Amount`** (both in `Amount.tsx`), never by another text.
  `Figure` is a `Txt` on one line that shrinks to fit, and it gives way in a row (`flexShrink` 1,
  `minWidth` 0): React Native's default `flexShrink` is 0, so a figure beside a label that keeps its
  width is laid out at its full width past the row's edge and cut, with nothing left to shrink. Every
  box between a figure and its row gives way too, or is capped at a share of the row, which
  `FigureRow` does for every row that pairs a label with a figure (below). `Amount` draws the value
  and its unit as one paragraph so the two shrink together and never part. The floor is the platform's 4pt; the
  New Architecture parses `minimumFontScale` but its text layout on both platforms reads only an
  absolute minimum, so the prop does nothing. On iOS the fit compares the text with its frame in height too and a fixed line height never shrinks, so a frame a rounding error short would fall to that floor; `Figure` keeps the line half a point under the box it holds. `rules.figureOutsidePrimitive` in the design ratchet
  counts a formatter's output written into any other text and holds it at zero; an amount inside a
  sentence ("2 000 sats ready to claim") is prose and wraps between words, and its digits cannot part
  since the formatters group them with a no-break space.
- **A label never breaks inside a word.** Text breaks a word that is wider than the line on its own,
  so at the largest sizes a menu label read "recuperaç / ão". A label that holds words people read
  takes `wholeWords` (a prop of the app's `Text`, passed through `Txt`): it wraps between words as any
  text does, and when a line break lands inside a word it lowers its own font size by the share of
  the word that fit, until the word fits whole, never below the default size. It shrinks by size and
  not by `maxFontSizeMultiplier`: React Native's text measure cache tells layouts apart by size and
  multiplier but not by that cap (`TextMeasureCache.h`), so a cap alone draws the smaller glyphs in
  the box measured for the larger ones, measured on the simulator as a two-line label in a row three
  lines tall. Menu rows, History and the asset activity, the
  detail rows and the wrapping button labels use it; an address or a hash never does, since it fits
  only by breaking.
- **A label and a money figure share a row through `FigureRow`** (`components/FigureRow.tsx`), and
  no screen pairs them by hand. React Native's default `flexShrink` is 0, so a label that keeps its
  width beside a figure that gives way leaves the figure a few points at the largest sizes (a
  confirm figure drawn at a tenth of its size in pt-BR, none at all in Turkish), and a label that
  shrinks from its own width shrinks in step with the figure and still takes most of the row.
  `FigureRow` owns both halves of the rule. While the window holds `textScale.sideBySideFrom`
  (300pt) per unit of font scale (`useSideBySide`), as a 375pt or 402pt iPhone does up to its
  second largest standard size (1.235) but not at the largest (1.353), and a 411dp Android at 1.3,
  the figure side keeps its own width up to `cap` (60% by default, 65% on Home's asset rows, 70% for
  the price beside its change) and never shrinks, and the label grows into the rest and wraps there,
  whole-word when it is a string. Below that width the figure goes under the label and each has the
  row to itself. Inside a box that sizes itself to its content, as the incoming banner's pill, the
  row passes `hug`, so neither it nor the label grows into free space and the pill stays as wide as
  what it says. `figureFirst` puts the figure ahead of its label,
  as the price card does with its change. A value that is not money in the same list of rows (the
  network, the arrival, the date, the time a quote is valid) goes through it too, so a card regroups
  as one. Every such row uses it: the Send review, the cross-chain review, the transaction detail,
  History and the asset activity, Home's asset rows, the asset picker, the Send balance, the price
  card, Home's price band, the Convert fields and confirm sheet, a stable quote's rows, the incoming banner and the
  stable rewards and payouts. A menu row's value is a setting, not a figure, and keeps its own 50%
  cap. An asset row's name takes up to two lines when stacked, all asset rows growing alike since
  the drag moves them by whole slots.
- **Other rows regroup at the same width.** Home stacks Send, Receive and Scan across the screen
  below it, and the company domain request stacks Copy key and Share, each across the screen. A
  button's icon and label row is capped at the button's width, so the label shrinks or wraps inside
  it rather than running past the edge. A half-width button that cannot wrap between
  words takes `singleLine`, so its label shrinks on one line, and a header with a control across from
  its label wraps, so the control drops under it instead of leaving the screen.
- **A field keeps room for what is typed.** `Field` holds its input to four ems at the size it
  draws, and a trailing piece that would leave less wraps onto a line of its own inside the box, as
  the address sheet's domain suffix does at the largest sizes; before, the suffix alone filled the
  box and the typed name had no width. A sheet whose content can pass its cap scrolls inside it (the
  address sheet does), since `Sheet` itself never wraps its children in a scroll.
- **A pushed screen's title is the app's text** (`HeaderTitle`), since the native header title keeps
  the box it was laid out in and cut its glyphs at Android's 1.3. It follows the system size on one
  line, as a header, and shrinks to the room between the back control and the other side.
- **Android's tab bar grows with its labels**, by their extra leading over the 49pt bar and above the
  bottom inset, so at 200% they stay off the gesture bar. On iOS the navigation library draws the tab
  labels at their own size and shows them large on a long press, as UIKit does, so the bar keeps its
  height there.

## Icons

Apple's rule for SF Symbols is that **an icon follows the text beside it**, sized close to the
adjacent font, with a weight matching the text's. There is no separate icon scale, since the size is
contextual.

- An inline icon beside a 14pt label sits around 14 to 16; beside 16pt body text, around 18 to 22.
- Inside a selector, a mark follows the label the same way, 16 in a segment beside its 14pt label
  and 20 on a picker row beside its 16pt value. The same mark at 24 on a row makes the network list
  look louder than the coin chosen above it.
- A tab bar icon is 24 to 28.
- A standalone feature icon, such as scan, is larger, around 30 to 34.
- **A 44 by 44pt minimum touch target** for any tappable icon, through a container of at least 44 or
  through `hitSlop`. `Touch` builds the 44 in as a floor. In a row that hugs its text, such as the
  Home balance label, the icon is drawn smaller with `size` and reaches 44 by hit slop, since a 44pt
  box would set the row's height. A `Touch` laid across (`flexDirection: 'row'`) sets
  `alignItems: 'center'` itself, because the floor's own centring then runs along the row and the
  content rides at the top of the box.

See [Apple HIG, Icons](https://developer.apple.com/design/human-interface-guidelines/sf-symbols).

## Colour

`colors` in `theme.ts`. A dark theme, with the Bitcoin orange (`primary`) reserved for calls to
action and emphasis. Orange never goes on secondary text or a label, where it competes with the
actions. Secondary text and labels use `textSecondary`.

**Dollar mode repaints the accent, not the palette.** `useAccent()` returns `colors.dollar` (green)
while the dollar wallet is on and `colors.primary` otherwise, so a link or call to action reads its
colour from the hook and never from `colors.primary` directly. Warnings and chosen options keep the
orange `primarySoftSurface` in both modes, since a warning tinted green would read as news about the
balance.

**Colour is never the only sign of the mode.** Home names dollar mode by what it does, in the line
under the balance: "Bitcoin you receive turns into dollars", or, while sats sit under the conversion
minimum, how many are waiting to turn into dollars. The line opens the dollar wallet screen. It
stays when the figure is toggled to the local currency, and when no rate has loaded and the hero
falls back to sats, since either would otherwise leave only the green to say the mode is on.

**No outlines.** No card, field, sheet, chip, button, list group or any other component has an
outline, in any state, focus included. Surfaces separate by fill and space, in three steps above the
ground: `surface`, `surfaceVariant` and `surfaceRaised`. The one line left is the divider between two
rows of a list, which comes from `dividerBottom` or `dividerTop` in `theme.ts`, and a row at the end
of a group has none. A ring or a viewfinder is a graphic and is drawn as a shape (`Ring`, SVG), so the
rule has no exception.

Without a line, a state has to be carried by something else, and it is never colour alone:

| State | Fill | Beside the fill |
|-------|------|-----------------|
| Field in focus | `surfaceRaised` | the caret in the accent |
| Field in error | `dangerSoft` | the red line under the box |
| Warning inside a flow | `primarySoft` | the alert icon (`Notice`) |
| Reminder on Home | `surface`, as a card | the icon in the accent, a chevron (`BackupCard`) |
| Alarm, error box | `dangerSoft` | the alert icon (`Notice tone="danger"`, `ErrorBox`) |
| Chosen option | `primarySoft` | a check |
| Checkbox | `surfaceRaised`, the accent when on | a check (`CheckBox`) |

The soft fills are 0.24 strong, which `softPairs.test.ts` holds by contrast: 1.38:1 and 1.32:1 off the
ground, 1.49:1 and 1.41:1 when laid on a card, clear of a neutral card beside them, and body text at
11:1 or more on all of them. Those are figures of arithmetic over the theme's own colours, not a
reading off a panel. Red text on the danger fill is 5.2:1 on a page and 4.6:1 on a sheet and falls to
about 4:1 on a card, so an error box sits outside a card.

A secondary button is `surfaceRaised` everywhere, the one fill that holds on a card. A card inside a
sheet or inside a card takes `surfaceVariant`, as `surface` stands only 1.11:1 off a sheet and not at
all off a card. It stays the step below `surfaceRaised`, so a secondary button still holds inside it.

## Glass (Liquid Glass)

Glass surfaces (controls in future; the PIN keys are a solid fill, since the material's light rim would stand in a grid of twelve on every open) use the **native iOS 26 Liquid Glass**
material through [`@callstack/liquid-glass`](https://github.com/callstack/liquid-glass)
(`LiquidGlassView`, Fabric and TurboModules, which suits the New Architecture). It is the **same
material** as the native back button, with real blur and refraction of the content behind.

- **iOS 26 and up** uses `LiquidGlassView` (`effect="regular"`, `interactive`,
  `colorScheme="dark"`).
- **Android and iOS below 26** report `isLiquidGlassSupported` as `false`, and fall back to a fill
  with no line around it: `colors.glass` where there is content behind it, and `colors.surface`
  where it would sit on the plain ground, over which `colors.glass` nearly vanishes. The fallback is
  mandatory, so no surface is ever left without a background.
- The effect is only visible when there is **content behind** to blur. Over pure black it reads
  almost the same as the approximation, which is why the PIN screen changes little while cards over
  content gain the glass.
- It can only be validated on an **iOS 26 device or simulator**, so do not claim it "works" outside
  of that.

For an example, components needing glass wrap their content in `LiquidGlassView` and keep the
fallback path. See `screens/PinScreen.tsx` (`PinKey`).

**Cards are solid.** `GlassCard` is `colors.surface` on every platform, iOS 26 included, since the
material refracts nearby coloured content into the top of a card, and two card fills on a screen
would be all that told them apart.

## Loading (skeleton)

**The project's convention is a skeleton, never a "Loading" label.** While something loads, show
placeholders shaped like the real content rather than a word.

- The component is `components/Skeleton.tsx`, a `surfaceVariant` block that pulses (opacity, through
  reanimated). Its props are `width`, `height`, `borderRadius` and `style`.
- Build the skeletons with the **same structure and height** as the ready state, so the layout does
  not jump when the data arrives. Home while loading is the balance bar, the button pills and asset
  rows with a circle and bars; History is rows shaped like transactions.
- The camera's line is the one word on a load: while Scan checks a code it says so under the square,
  since the screen has no content whose shape a skeleton could take.
- It is reusable, so any new screen with a loading state uses `Skeleton`. Do not reach for an
  `ActivityIndicator` or a "loading" string. An action under way is not a load: a menu row that is
  working draws the button's `Spinner` where its chevron was, as a button does on its label.
- **A label that names a figure is part of its skeleton.** Home's "Total Balance" is true only of a
  figure that values every holding, which is not known until the read lands, so the label is a bar of
  the skeleton until then, and a failed connect, which has no figure, draws no label.
- **A pull is an action, not a load.** `hooks/usePullRefresh.tsx` gives the native spinner, the
  gesture's own answer, while the content stays on screen. It closes at `SYNC_WAIT_MS`, and a pull
  never brings a skeleton. The one exception is Home's failed first load: no figure is on screen to
  keep, so its pull reads again from the skeleton, as Try again does.
- **A read that failed is not an empty list.** The skeleton gives way to the error and a Try again
  button (`common.retry`), and the empty state is drawn only from a read that answered with nothing
  on a connection that synced.
  "No transactions yet" drawn after a failed read states something false about the wallet.
  A screen that stays mounted, such as a tab, starts a new read on every focus and on every Try
  again, and only the last read started may land, so a read that never answers cannot hold the
  skeleton or swallow the refocus. A list the screen edits itself, such as Contacts, gives way to
  the error when a read after a save or a removal fails, because the list still on screen would be
  the one from before the change.
- **After an action on money, the figure comes from a new read.** The pending funds card reads the
  deposits again after every claim run, whether it passed or failed, because a run that fails
  halfway leaves the old total counting what was already claimed. When that read fails too, the
  figure is hidden, the card says it could not check what is left to claim, and its button becomes
  Try again, which reads and claims nothing. A read after a claim run or a Try again that has not
  answered within `SYNC_WAIT_MS` counts as failed, so the spinner never outlives it; an answer after
  that is kept only while no newer read has started. The next read that answers, Try again or Home's own
  refresh, brings the figure back and clears the line. A refresh that fails leaves the card the same
  way, since the deposits may have been claimed meanwhile: a card that was up stays, with its figure
  hidden behind that line, and a card that was not up is never drawn, because nothing then says
  there are funds to claim. A deposit whose claim failed for a reason other than its fee or its size
  has a Try again of its own, which reads, claims each such deposit under the automatic ceiling and
  draws the read after, saying nothing of the claim's answer. The card never offers to send a deposit
  back; it offers only the retry of a return the network refused.
- **A quote that moved is drawn again, never signed.** The card reads the deposits again before it
  signs and signs only a deposit whose quote is the one on screen. Any other is left unsigned and
  drawn with the newest quote the card has read, or at its plain amount when its quote went away, so
  the next tap accepts what is then on screen. The card adds no line about the change; a screen
  reader is told the fee line as drawn, unless the balance is hidden.

## Motion

When the phone asks to reduce motion, every movement goes and fades stay: a translate, scale,
rotate, spring, slide or animated width becomes a fade or does not happen, and an opacity change may
keep its timing. Each component that moves something reads `useReduceMotion` once
(`hooks/useReduceMotion.ts`) and gates its movement with it, or passes a duration through
`motionFor`; one that only fades, such as the skeleton or the copy hint on Lightning address, needs
neither. A sheet fades in instead of sliding, a button press only dims, the banners and the received
overlay only fade, a dragged asset row keeps its size while the rows it passes jump to their slots,
the splash stands at rest, and a wrong PIN or recovery phrase order clears without a shake, its
error line being the feedback. A spinner keeps turning, since it says work is under way. Receive's
enlarged code fades in where it is drawn rather than flying out of the small one, Convert's arrow
stays put when the sides swap, the edit controls of the wallets list and Explorers appear in
place rather than sliding the rows over, the rings on the Android tag sheet stand still, and the
re-entry that answers a pull is a plain fade.

A pull answers on top of the spinner, which on Android floats over a screen that may not change.
When a Synced was heard and the read after it landed, the page re-enters: `Reenter` fades the parts
back in with a small rise, staggered, 200 ms in all, the hero, then the rows, then the price band on Home,
and the rows on History, whose card fills stay. It is Reenter's `entering`, so the key mounts the part
again, and what has to outlive a beat lives above it. A beat with a finger on the page, or with the
page dragged or gliding, is dropped, and a figure the read changed goes through `CrossFade` and a
line new since the pull through `FadeInLine` either way. A tap on hide or on the unit never fades,
and ends a fade under way, so a figure never stays over the dots. The read that counts is the one
that lands: the Synced also reaches the screen's event listener, whose read can overtake the pull's, so a replaced read hands the pull on to the read that
replaced it, and the beat waits for that one. If it fails, or none has answered within `SYNC_WAIT_MS`,
nothing moves, and a pull that heard nothing shows the mark that says the screen is not updated.
A pull that landed also says `home.updatedNow` to a screen reader, finger or not, since the page
moving reaches only the eye. Nothing draws that string, and no read but a pull says it.

Home keeps itself current with no pull (`useLiveFigures`). A read nobody asked for draws no skeleton,
crosses a changed figure over, and re-enters the page only when the wallet's holdings moved, since a
rate moves the total on every read and a page that rose for each would never sit still.
`animateTo` in `components/animateTo.ts` is the
plain transition every one of these uses.

Reanimated applies the setting by itself, as read once at launch: an animation created without its
own `reduceMotion` option ends on its first frame. So every animation of the splash, the received
overlay and the asset list passes `reduceMotion: ReduceMotion.Never`, which keeps a fade on its
timing, and `useReduceMotion` alone holds movement at rest. The wallet list and the skeleton pass no
option and stay under Reanimated's rule: with the setting on at launch, the wallet list's edit slide
and drag springs end on their first frame, and the skeleton stands still at its starting opacity
of 0.5 rather than pulsing, since a reversing repeat that would end where it began never starts. A view also keeps the keys of its first animated style, which renders before the setting
answers, and a later style only overwrites the keys it sets, so a style sets the same keys either
way: reduced, the asset list's lifted row reads `[{ scale: 1 }]` rather than going missing. The
wallet list's lifted card sets no transform when reduced, so it keeps the scale it last had.
`__tests__/support/reanimatedModel.ts` keeps both behaviours for the suites that test them. React
Native's own `Animated` does neither.

## Patterns (how pieces compose)

Tokens say what a thing looks like; patterns say which thing to use. Most examples come from the
receive screen.

**Choosing among options.**

| The choice | The control |
|------------|-------------|
| A mode with 2 to 3 short names (Bitcoin / Stablecoins) | `SegmentedControl`, one word per segment. Four crowds the track and a slash label ("USDT/USDC") reads as two things |
| An asset among several that each carry a mark (the stablecoins: USDB, DePix, USDT, USDC) | The "Asset" picker row, the same one the Bitcoin side uses, since the list grows with the wallet. Tiles take a third of the screen, and coin segments stop fitting at four. `SegmentedControl` still takes an `icon` per option for a short, fixed choice |
| 5 or more, or a list that grows (networks, assets) | A picker row (`receiveStyles.pickerRow`) that opens `AssetPickerSheet`, with the mark on the row and in the list. Search only when the list is long enough to need it; a list without search passes `searchable={false}` |

The price chart's period picker is the one `SegmentedControl` with six segments. The periods are one
scale read in order, from a day to all of it, with labels of two or three characters, and a picker row
would hide behind a tap the choice the chart exists for. Polish and Hebrew abbreviate their longest
labels to fit about 44pt each (see [price-chart.md](price-chart.md)).

Two segmented controls may stack when the second one refines the first (what, then how). Never put
unrelated axes in one control, as "Spark / Bitcoin / Lightning / USDT/USDC" would mix rails with an
asset.

**One order for every list.** Bitcoin first, then the dollars (USDB, USDT, USDC), then the real
(DePix), then any other token in the order it arrived, held or not. `byAssetOrder` in `tokens.ts` is
the single source, so the Home, Convert, Send and the Receive lists cannot drift apart. The dollar
wallet is the one deliberate exception on the Home: the same order, with Bitcoin moved to the end.

**A choice of one is not drawn.** USDB and DePix exist only on Spark, so they have no network row, and
a list with one entry never opens.

**How money arrives is not the first question.** Bitcoin on the receive screen opens on Lightning with
no rail selector. The Bitcoin and Spark addresses sit behind a quiet "More options" line under the
code, which stays on screen while the code loads or fails, because those addresses are the way out
when Lightning has no answer. The sheet offers Lightning back once another rail is showing. Spark is
also the rail for a token with no peg, which is why the asset row appears only there.

**The keypad opens on a tap, never by itself.** Where a code needs an amount first (a cross-chain
receive), the QR card's place holds a muted line saying so ("Enter the amount to generate the payment
address.") and the amount link above it opens the keypad. Opening it on arrival would cover the
choice the user came to make.

**Order on a receive screen.** What arrives, then the amount, then the code, then the other rails.
What arrives and the amount are one group, and the code with its buttons another, 32 apart with 8
inside each, on Receive and on Lightning address alike. An offer that is not about this payment, as
the payment alerts, is a quiet line that opens a sheet, never a card with a filled button.
The QR card is the same on every rail: the code and the address, nothing else, with Copy and Share as
two secondary buttons right under it, off until a code is on screen. The cross-chain panel copies two
values, so each keeps its own "tap to copy" and the header shares. Figures go
below it as label and value rows in an inset `Card` with `Row divider`, the way the cross-chain send
review lays them out: the label muted on the left, the value tabular on the right, a copy icon beside a
value that copies. Warnings follow in their box, and a provider note closes as a muted centred caption.

**A chip is its own piece, not a small secondary button.** Paste, Scan and Contacts on Send, and
Paste, Enter and Gallery on Scan, are chips: an icon beside a line in the `label` role (14), on
`surfaceVariant`, three to a row. Send's fourth chip, NFC, shown only on a device that has it, sits on
a row of its own under the three, since a fourth flex chip leaves each label
about 72pt on a 360pt phone. A third of a 360pt phone leaves the longer translations no room at
the button's body size, so a chip keeps the label role, and Send's shrink it to fit on one line. A
secondary button (Copy, Share) is one action at half or full width, on `surfaceRaised`, with the
body label (16). The two do not share a row, so their sizes are never read side by side.

**Words leave the tree under capture.** iOS can report a recording or a mirrored screen but not stop
it, so `useScreenCapture` takes the grid, the passphrase, the check's options and the restore fields
off the tree, and `CaptureNotice` says why. Hiding by opacity would still record them.

**One grid for the recovery phrase.** The backup and recovery phrase screens draw the words through
`SeedWordGrid`, so a person checking one sheet of paper against both sees the same cells. It draws
three columns from about 380pt of window per unit of font scale and two below that, the number takes
a floor that grows with the type and a gap before the word, and the word stays on one line, shrinking
to its cell rather than wrapping. A seed word is never cut. The grid draws only as many columns as
still hold "mushroom", the widest English BIP39 word, at 0.6 of its size, which is one column at the
largest text sizes; in that one column on a 320pt phone the word shrinks further instead. The count
comes from the grid's own laid out width, so a caller that insets the grid still gets columns its
words fit.

**A section title and an add row are components.** `SectionLabel` is the muted title over a card of
rows (History's days, Home's assets, the asset screen's activity, a review's sections), and starts on
the card's edge, as a field's label does. `AddRow` is the plus mark and label that adds one more under
a list (Home's assets, the wallets). Each owns only its inside; the screen passes the space around it
(`marginBottom: rhythm.sectionLabelToList` under a label, `marginTop: space.xs` above an add row), as
for every primitive. On Home the header row (the label, Convert and Done) and Add asset sit flush with
the card's edges on the 24pt gutter, so Home takes `AddRow`'s `space.xs` inset off through its style
and gives the controls across from the label none.

**Home's price band joins the tab bar.** The bitcoin price (`PriceStrip`) is a full-width band fixed
under Home's scroll and right on top of the tab bar, in the bar's own fill (`colors.surface`), with
no radius, margin, line or shadow between them, so band and bar read as one block; the bar's Android
elevation and the library's hairline along its top (`noTopEdge`) are off for that reason. Its inner
padding across is the page gutter (`space.xl`), so its text lines up with the content above. Its
left column is the name, "Bitcoin" in `subheadingBold` and the default tone, over the rate of one,
"1 BTC = <price>" in `body`, muted (a `Figure`), so the band reads in two levels, strong on top and
muted under it; its right column, at the row's end, is the change in `subheadingBold` and the
default tone, as the name, with its sign saying the direction, over its period, "24h" in `caption`,
muted. The asset screen's price card keeps the success and danger tones; the band is one quiet
block. The period is the window the change was measured on, the last 24 hours rolling, so it never
says "today". Each column is two lines on the same two leadings, so the change pairs with the name
and the period with the price, and below the width that fits both the right column goes under the
left, as in every `FigureRow`, on one line that holds the change with its period muted beside it in
one paragraph, or the out of date word, each shrinking on that line rather than wrapping, so at the
largest iOS size the band is three lines tall and not four. It never shows the balance, which Home
states at the top. Its height is fixed for the text size (`priceStripHeight`) whatever the read
does, with a skeleton of the same two columns before the first answer, a bar for each text, the
empty band when there is no price, nothing on the right when no change is known, and, once the price
is stale, the word `home.priceNotCurrent` ("out of date") muted across from the name in place of the
change, since the price line is muted either way; so neither the content above nor the block's edge
moves. The whole band is one target at the touch floor or above, says one line to a screen reader
and opens the bitcoin asset screen; a press lights it as a row, since shrinking it would pull it off
the bar. Home's content ends above it and never passes behind it, and no other screen has it.

**A failure is an `ErrorBox` above the action**, never a red caption and never under the button, and
a line about a field's value stays the field's `error`. On a centred screen the box and its buttons
go in `CenterStack` (from `Screen.tsx`), which holds them across the screen, as the centred layout
otherwise sizes each to its own content. A list edited in place says a failed change under its
card, as Home's assets do for a hide, so the rows stay under the finger that edits them.

**A list in a card is one card.** Its rows carry the lines between them, and the first and last carry
its corners when the rows are list items, as History and Contacts do. The padding sits on the rows, so
a highlight reaches the card's edges.

**Warnings are a box, never red text.** Red is an error in this app. A warning is a `Notice`, a card
in `primarySoftSurface` with the alert icon ahead of the text in the default colour, as on the
recovery phrase and the domain screen. The one exception is an alarm, where no later warning is left
to escalate to: a critical update, the domain notice from the year's last day on, and a recovered
purchase that needs a person. That card takes `dangerSoftSurface` and its title the danger colour
beside the icon, since a white title reads as ordinary news. Its buttons sit below the box, never
inside it, so an action does not read as part of the alarm.

**A reminder on Home is a neutral row; a warning inside a flow stays a `Notice`.** Home is opened
every day, and a soft warning fill there for as long as a task stays undone reads as an alarm that
never clears, which wears the fill out for the flows that need it. So the recovery phrase reminder
(`BackupCard`) is one row on the card's fill and radius (`Card`), with the accent only on its icon
(the key, from `useAccent`), the title in `body` and the default tone, and a muted chevron at the end.
The whole row is one target above the touch floor, and the reason it gives is its accessibility hint
(`Touch`'s `hint`), which a screen reader reads after the title. The recovery phrase and domain
screens keep their `Notice`, since there the warning is about the step in front of the person.

**One text field.** Every input is `Field`, and `Field` is the only thing that draws a `TextInput`.
Beyond the one-line box it takes `multiline` (a top-aligned box of a fixed `touch.multiline`, fixed
because iOS caches the native contentSize of a multiline input), `leading` and `trailing` inside the
box, `progress` for a read the typed value started, `invalid` for a fill with no line under the box,
and a `ref`. At rest the placeholder or the label says what the field is for, so a field with neither
is a mistake, and a field with no label passes `accessibilityLabel`.

**One search.** A list's search is `SearchField`, built on `Field`, with the same box, keyboard and
clear on every list. It takes no style: on a screen it keeps the gutter while the rows reach the
edges, and in a sheet it passes `inSheet` and leaves the space to the sheet. It stays up while a list
loads, and a search that finds nothing says so with `EmptyState`.

**One switch.** On and off is `Toggle`, on the platform `Switch`, with a white thumb in both states and
the track in the wallet's accent, or `surfaceRaised` when off. It takes the accent itself, so a screen
passes only the value and the handler.

**A filled button that cannot act yet is absent, not faded.** `GradientButton` draws a disabled
primary button at `alpha.concealed` (zero), out of touch, focus and screen readers, and keeps its
box, so the screen does not move when it turns on. Loading keeps it in sight at full strength with
its spinner. The secondary variant still dims, because it sits beside a filled button rather than
ending the screen. The kept box gives way only while the keyboard is up, where it would be an
empty band over the content right above the keyboard: a footer wraps such a button in `FooterAction`
(from `Screen.tsx`) with the same condition that conceals it, as Add asset does. Import has no button
at all until the last word is in, since its long grid would stop short of the screen above the kept
box.

**A question before an action is `ConfirmSheet`**, never the system's dialog, which is the one light
thing in a black app and follows the phone's theme rather than the app's. What an action could not
do is an `ErrorBox` on the screen, not a dialog. A sheet opened from a sheet would be a modal over a
modal, and one opened just after a sheet closes is refused on iOS while the first is still leaving,
so a sheet that has to ask does it in its own panel with `ConfirmBody`, as Lightning address, a
contact and the wallet picker do. A question closes before it acts, so a refusal that comes back
afterwards lands in an `ErrorBox`, never in another sheet. A sheet's choice that opens a system
picker or the camera waits for `Sheet`'s `onDismiss`, since iOS refuses the present while the sheet
is still leaving, as Edit wallet's photo sheet does.

**An action that can cost what cannot come back is `variant="danger"`**, the red on its soft fill,
and that is its one look: erasing a wallet, deleting a wallet's data at Voltz, removing a contact, and
the confirm of any of them. The accent says go, so it is never the colour of losing something, and
the way out beside it is the plain secondary button. No gradient says this and no link does. A menu
row that opens the screen where the action lives is still a row.

**A sheet's way out says what kind it is.** A secondary button cancels something with a consequence
(a conversion, an erase, a cancelled purchase); a muted link puts off something that costs nothing to
leave (saving a contact, the payment alerts).

**An error is a box or a line, by what it is about.** An action or a read that failed is an `ErrorBox`
above the action or in place of what did not arrive, and a problem with what was typed is the line
under its field, which `Field` draws. Both say the error to a screen reader through `useAnnounced`,
because `accessibilityRole="alert"` alone is silent on React Native 0.86 (TalkBack measured on
Android 16, and iOS maps the role to no trait), and any other error line calls the hook as well.

**A button's accessibility label replaces its text.** A screen reader reads the label and nothing
inside, so a row that shows a choice carries the choice in its label ("Tron, Choose the network"),
and a visual-only confirmation such as the copy check is announced with
`AccessibilityInfo.announceForAccessibility`.

**Marks, not letters.** Assets and networks show their official mark, bundled as SVG: Bitcoin, USDB and
DePix in `assets/asset-icons`, keyed by identifier in `AssetIcon`, and USDT, USDC, Spark and every network
the provider serves in `stableLogos.ts`. The letter badge is the
fallback for something the app has never seen, not a state the screen is designed around, and a test
fails when a served network has no mark. The same slug never reaches the screen as text either;
`chainDisplayName` turns `bsc` into "BNB Chain" wherever a network is named.

**A wallet's photo is drawn by `WalletAvatar` alone**, at every size and in every place that shows
the wallet. Beside the photo the wallet keeps its crop (`imageCrop` in `walletMeta.ts`), the square
of the source the adjust step framed, given as fractions of the source's width and height and square
in its pixels (`photoCrop.ts`), so it holds at any size. A photo without one, as every photo saved
before crops is, or with one `readCrop` refuses (not numbers, outside 0 to 1, empty, past the edge),
is drawn centred and covering the disc. Removing or replacing the photo drops its crop.

**A sheet closes by dragging its grabber down**, past 80pt or with a quick flick, and follows the
finger unless the phone asks to reduce motion; a sheet its screen keeps open, as Convert's review is
kept while a conversion runs, goes back in place. The amount sheet alone also has a close button. **A
sheet stops at 90% of the window.** `Sheet` caps every panel there unless the caller passes a
lower cap, so the backdrop above it always shows and always closes it. While the keyboard is up in a
sheet with a field, the default cap is the whole room above the keyboard instead, since 90% of that
room puts content that does not scroll under the keyboard. Content that can outgrow the
cap scrolls inside the sheet, as the transaction detail and the wallet picker do, and a sheet that
holds a virtualised list brings that list rather than a scroll. On Android, back with the keyboard
up hides the keyboard and keeps the sheet with what was typed in it; the next back closes it. The
amount sheet is a `Sheet` too: what sits above its keypad scrolls, the key rows shrink towards the
44pt floor so Confirm stays on a 667pt screen, an amount error stands beside Confirm outside the
scroll, and the keypad steps aside while the keyboard is up for the note.

The app has two keypads on purpose. The PIN's keys are round and fixed in size, since it is a gate
with nothing else on it and the keys stay under the thumb from one digit to the next; the amount
sheet's take the sheet's width and shrink with it, since the sheet shares the screen with what it
pays. On the PIN screen the error line and the rows under the keypad are held whether they show or
not, so a reject never moves a key from under the finger.

## Voice and tone

The copy is part of the design system, and it holds to the same standard in every locale. Examples
below are the en-US strings.

- **Direct and professional.** No colloquialisms or slang. Instructions are in the imperative ("Send
  only USDT on the Base network."), labels are nouns ("Exact amount to send").
- **A warning says what to do, then what happens otherwise.** One sentence each, in that order, as in
  "Send only USDT on the Base network. Funds sent as another asset or on another network may be
  permanently lost."
- **Say only what the system verified.** What depends on a third party is conditional ("may be
  lost"), an estimate carries "≈", and an exact figure shows every place it has, down to the
  received overlay, which counts up to the payment's own precision rather than to cents. **A
  conversion's row is the one exception.** Its token figures sit at two places, cut and never rounded
  up, so a row cannot read as more than arrived, and a figure under a hundredth keeps its digits rather
  than read as zero. The row is titled by the side it landed on ("Conversion to USDB"), never by the
  pair, and draws what left under the figure ("from 31 473 sats", or "from ≈ 31 473 sats" when that is
  only the quote the app kept). The detail stays exact.
- **Name the provider when it does the work**, and say plainly that Voltz does not intermediate or
  charge, as in "Converted and delivered by Flashnet. Voltz does not act as an intermediary or charge
  for this service."
- **Custody and brokerage words stay out** in every language: bank, deposit and withdraw as
  financial acts, trade, broker (see `AGENTS.md`). The app says "payment address", never "deposit
  address". The same goes for where the money comes from, "another wallet or platform" and never
  "exchange".
- **Brand names are not translated** (Tether USD, USD Coin, Flashnet, network names).
- **Complete sentences, without a long dash and without "Label: explanation".** A sentence is not
  split by a dash or by a colon into a label and its gloss; it is rewritten as one sentence.
