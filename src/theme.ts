import { Platform, StyleSheet } from 'react-native'

// Dark theme on the platform system font (SF Pro on iOS, Roboto on Android), no bundled family.
// Rules the app must not drift from live in docs/design-system.md. `primary` is reserved for CTAs
// and highlights, never for labels, and every margin, radius and size comes from a token below.

export const colors = {
  background: '#000000',
  surface: '#1a1a1a',
  surfaceVariant: '#262626',
  // Darker than `surface` on purpose, as a sheet at that lightness reads as muddy gray over black.
  sheet: '#0e0e10',
  // One step above surfaceVariant, the fill that carries what an outline would have: a field holding
  // the keyboard, a secondary button that has to stand on a card, a sheet's grabber.
  surfaceRaised: '#333333',
  primary: '#ff7a00',
  // Strong enough to hold a state with no outline around it. At 0.24 the fill stands 1.38:1 from the
  // ground, 1.49:1 when it sits on a card, and clear of a neutral card beside it, and body text on it
  // keeps 11:1. __tests__/softPairs.test.ts holds those figures.
  primarySoft: 'rgba(255, 122, 0, 0.24)',
  dangerSoft: 'rgba(255, 90, 90, 0.24)',
  pressedOverlay: 'rgba(255, 255, 255, 0.14)',
  text: '#ffffff',
  textSecondary: '#a0a0a0',
  onPrimary: '#ffffff',
  onPrimaryTrack: 'rgba(255, 255, 255, 0.35)',
  danger: '#ff5a5a',
  success: '#22c55e',
  // USDB brand green, taken from the token's own SVG fill so the app matches the coin.
  dollar: '#00875A',
  // Mandatory fallback for when `isLiquidGlassSupported` is false (Android, iOS < 26).
  glass: 'rgba(38, 38, 38, 0.55)',
  // The one line the app draws, between the rows of a list. Reached through dividerBottom and
  // dividerTop below.
  divider: 'rgba(255, 255, 255, 0.08)',
  scrim: 'rgba(0, 0, 0, 0.6)',
  // Around the scan square: dark enough that the square is where the eye goes, light enough that
  // the person still sees what the camera points at.
  cameraMask: 'rgba(0, 0, 0, 0.7)',
  scrimStrong: 'rgba(0, 0, 0, 0.85)',
  // QR codes must sit on white to stay scannable, whatever the theme.
  qrSurface: '#ffffff',
} as const

// Avatar palette for the wallet editor (fallback background when no photo is set). Decorative
// identity rather than CTAs, so a standalone palette is admissible where the design system reserves
// the primary orange for actions. The brand orange leads, followed by Radix Colors step-9 solids,
// each with enough contrast for a white monogram.
export const walletColors = [
  '#ff7a00', // brand orange
  '#e5484d', // red
  '#e93d82', // crimson
  '#d6409f', // pink
  '#8e4ec6', // purple
  '#6e56cf', // violet
  '#3e63dd', // indigo
  '#0090ff', // blue
  '#12a594', // teal
  '#30a46c', // green
  '#978365', // bronze
  '#8d8d8d', // gray
] as const

// The fill of a wallet with no colour of its own, from a hue taken from its fingerprint, so one wallet
// keeps one colour. Light and saturation are fixed so a white monogram holds on every hue.
export const hueColor = (hue: number): string => `hsl(${hue}, 55%, 45%)`

// The width of the one line the app draws. `1` and `StyleSheet.hairlineWidth` are not the same line:
// on a 3x screen `1` is three physical pixels and a hairline is one, so a divider drawn one way sits
// visibly heavier than the same divider drawn the other.
//
// Nothing here outlines a container. Surfaces separate by fill and space, and a drawn graphic (a
// spinner ring, the camera viewfinder) is a shape with a width of its own.
export const stroke = {
  // No line, for an edge a library view draws on its own (noTopEdge).
  none: 0,
  // One physical pixel at any density, for the divider between two rows of a list.
  hair: StyleSheet.hairlineWidth,
  // Outlines only HomeScreen and PinScreen still draw, gone with `outlineFiles` in .eslintrc.js.
  thin: 1,
  control: 1.5,
} as const

// Opacity by what the dimming means, since naming a value is not the same as naming an intent.
// Touch feedback is a different question and lives in `press` below.
export const alpha = {
  // A region that refuses touch, always beside `pointerEvents: 'none'`. The dimming is the *only*
  // signal that the touch will die, so it is deliberately heavier than any other state here. Raising
  // it to match the others would weaken the one thing that says why nothing happened.
  inert: 0.5,
  // A single control present, explained, and unavailable. Lighter than `inert` because a refused
  // control still has a label worth reading.
  disabled: 0.4,
  // A control that keeps its box while it cannot act, so nothing moves when it can. It is a hiding,
  // not a dimming, and always rides with leaving touch and screen readers; anything that need not hold
  // its place is not rendered at all.
  concealed: 0,
  // The rows behind one lifted for a drag, stepping back so the lifted one reads as the one moving.
  // Not `inert`, which refuses touch: these rows still slide under the drag, and the two share a value
  // only by coincidence.
  receded: 0.5,
} as const

// Touch feedback is a different question from opacity, since it is about what the finger changes
// rather than how visible something is.
//
// Two treatments exist and both are correct. Where the surface only dims, the dim carries the whole
// signal and has to be plain. Where it also shrinks, the shrink carries it and the dim stays subtle,
// which is why `scaled` (0.9), the dim that rides with `scale` (0.98), is far subtler than `dim`.
//
// Which of the two a given control should use is not settled here. That is <Touch>, where the answer
// depends on what sits underneath. This only stops the values from being invented per screen.
export const press = {
  // A list line lights up rather than fading. Dimming a row reads as the row being unavailable, which
  // is the opposite of what a press means, and it is what the platform does for a table cell.
  row: colors.surfaceVariant,
  // Text acting as a link, which has no surface to change.
  dim: 0.6,
  scaled: 0.9,
  scale: 0.98,
} as const

// The smallest a control may be under a finger, from the Apple HIG and WCAG 2.2 alike. Declared, not
// derived from padding, because a box is as tall as its line height, which few controls set and which
// scales with the device's type size; a floor never shrinks a box, so it only acts when those fail.
//
// `selector` is the height every full-width selector shares, a segmented track and a picker row alike,
// so stacked choices read as one column. 48 is a picker row's own height (12 + a 24pt line + 12), and a
// track at 48 leaves its segments 40 with 4pt of slop each way.
//
// `action` is the height of a filled button (14 + a 24pt line + 14), which the round scan control
// between Send and Receive takes too, so the three sit as one row and its skeleton matches it.
//
// `multiline` is the height of a field that holds a pasted address, three 24pt lines and their
// padding. Fixed rather than a minimum, since iOS caches the native contentSize of a multiline input.
export const touch = { min: 44, selector: 48, action: 52, multiline: 96 } as const

// How the app answers the system text size where following it in full would break a shape or a
// figure. Everything else scales without limit. See docs/design-system.md, Large text.
export const textScale = {
  // A keypad digit scales this far and no further, as the system keypads do, so at 24pt it stays
  // inside a 44pt key.
  keypadMax: 1.4,
  // An avatar's initials are drawn to the disc, which keeps its size in a list row, so they do not
  // follow the text size at all.
  badgeMax: 1,
  // Window width per unit of font scale under which a label and its figure no longer sit side by
  // side. Below it an asset row puts its figure under the name and Home stacks its actions. 300 keeps
  // them side by side up to iOS's second largest standard size (1.235) on a 375pt or 402pt iPhone,
  // which stacks them at the largest (1.353), and up to 1.3 on a 411dp phone.
  sideBySideFrom: 300,
} as const

// Stacking order, named by what sits at each level, so which of two floating things covers the other
// is a decision rather than an accident of two numbers.
//
// The gap between levels is deliberate: a future layer slots between two without renumbering either.
export const layer = {
  // A row lifted out of its list while it is dragged, over the rows it passes and nothing else.
  lifted: 10,
  // News arriving over whatever is on screen, such as the foreground notice or the incoming
  // banner.
  banner: 20,
  // Anything that takes the screen away from the app entirely, splash included.
  cover: 100,
} as const

// Transition durations, three of them, so an animation picks an intent rather than inventing a number
// that sits a few milliseconds from another one meaning the same thing.
//
// Three kinds of timing stay off this scale, and the difference is not length but purpose:
//   loops, whose number is a period rather than a duration (the spinner, the banner pulse);
//   steps inside a sequence, where the value is one beat of a shape (the PIN shake, the splash);
//   brand choreography, where the timing is the design (the splash, the received-payment overlay).
// Collapsing any of those into a transition scale would describe them wrongly.
export const motion = {
  // A control changing state under the finger.
  fast: 180,
  // Something arriving on the screen or leaving it.
  base: 260,
  // A larger move the eye has to follow to the end.
  slow: 420,
} as const

// Letter spacing, by what the spacing is for, so a screen picks an intent rather than a number that
// sits beside another one meaning the same thing.
export const tracking = {
  // Uppercase at the smallest size, whose capitals run together without a little air.
  caps: 0.5,
  // An uppercase label heading a block, wider so it reads as a heading rather than as a word.
  heading: 1,
  // An address in the monospace face, read in groups, where each glyph needs a hair more room.
  address: 0.5,
  // A short code compared between two screens, spaced so each character stands apart and the whole
  // reads as a code rather than as a word.
  code: 2,
} as const

export const gradients = {
  primary: ['#ff8a1a', '#e65c00'],
  dollar: ['#009c66', '#00875a'],
} as const

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

// How far apart a screen's title and what follows it sit, the same on every screen. `ScreenTitle` and
// `SearchField` read these and take no margin from their caller, so a screen cannot pick its own. The
// rule and where each value comes from are in docs/design-system.md, Vertical rhythm.
export const rhythm = {
  // From a native header, or the top of a step, to the first thing on the screen.
  headerToContent: space.xl,
  // From a title to the subtitle under it, one group.
  titleToSubtitle: space.sm,
  // From a title, or the subtitle closing it, to the first block.
  titleToContent: space.xl,
  // From a one-line hint under a header to the first block.
  hintToContent: space.lg,
  // From the last group of a form to its action.
  groupToAction: space.xxl,
  // From a section's muted label to the list under it.
  sectionLabelToList: space.md,
  // Between two sections.
  section: space.xxl,
  // From a search field to its list. A row's own 16 of padding makes up the 24 under a title, and a
  // list that opens on a section label adds the same 16 itself.
  searchToList: space.sm,
} as const

// Radii follow the Apple HIG component scale, 8 small controls, 12 buttons, 16 cards, 20 sheets.
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  full: 9999,
} as const

export const font = {
  size: {
    xs: 11,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    xxl: 24,
    xxxl: 28,
    display: 40,
  },
  weight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
  // Leading, paired with the size rather than chosen beside it, and on the 4pt spacing grid so a
  // block of text sits on the same rhythm as everything around it.
  //
  // Only the sizes whose text declares leading: the three that <Txt> roles carry, the price card's
  // 24pt figure, and Home's 18pt currency line and 40pt balance. Inventing a value for the others
  // would move every text at those sizes at once with nothing to check it against. That pairing
  // belongs to <Txt>, where each role gets a leading decided with the screen in view.
  //
  // xs, sm and base lead running text, so they keep a ratio of 1.35 to 1.55 to their size. lg and
  // display lead a single line of figure text, so they have bounds of their own (themeTokens.test.ts).
  // lg has the same 24 as base for a larger size, and no 4pt step falls inside that band for 18pt (24
  // is 1.33, 28 is 1.56). display's 48 is the grid step just above the line the engine gives a 40pt
  // figure.
  //
  // A leading is never the size itself. iOS draws a line into a box exactly its leading tall and cuts
  // whatever rises above it: Devanagari vowel signs, Thai tone marks and Vietnamese stacked accents
  // all sit there, and a fallback font's deeper descent lifts the baseline and cuts the Latin digits
  // on the same line too. `rules.hugLineHeight` in scripts/design-metrics.mjs holds that at zero.
  leading: {
    xs: 16,
    sm: 20,
    base: 24,
    lg: 24,
    xxl: 28,
    display: 48,
  },
  // The platform's monospace face, for text read character by character to check or copy it: a
  // bitcoin address, a passphrase, a DNS value. Proportional type puts `l`, `1` and `I` a hair apart,
  // which is the whole problem when a typo costs money or a wallet.
  //
  // Not a bundled font, which is what the rule against `fontFamily` is actually about. Both are faces
  // the operating system already ships, so nothing is redistributed and no licence is involved.
  mono: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  // Style fragments meant to be spread, as in `...font.family.bold`.
  family: {
    regular: { fontWeight: '400' },
    medium: { fontWeight: '500' },
    semibold: { fontWeight: '600' },
    bold: { fontWeight: '700' },
  },
} as const

// The white quiet zone a QR code needs to be read at all. It is a style rather than a component
// because some callers apply it to an element that already exists, a Pressable or an Animated.View,
// and a component would add a wrapper to carry what is only a style.
//
// The padding is the requirement, not the decoration: a code printed edge to edge is a code most
// scanners refuse, which is why this is not a Card variant and not the theme's surface colour.
export const qrFrame = {
  backgroundColor: colors.qrSurface,
  padding: space.md,
  borderRadius: radius.md,
  borderCurve: 'continuous',
} as const

// The same quiet zone at the size the zoom overlay draws, where the code fills most of the screen and
// the margin has to grow with it.
export const qrFrameLarge = {
  backgroundColor: colors.qrSurface,
  padding: space.xl,
  borderRadius: radius.lg,
  borderCurve: 'continuous',
} as const

// The fill that turns a surface into a warning or a chosen option. It keeps the Bitcoin accent in
// dollar mode, since a warning tinted green would read as news about the balance. Colour is never the
// only sign of the state: a warning carries its icon (components/Notice.tsx) and a choice its check.
export const primarySoftSurface = {
  backgroundColor: colors.primarySoft,
} as const

// The same for an error and for an alarm no later warning can escalate to.
export const dangerSoftSurface = {
  backgroundColor: colors.dangerSoft,
} as const

// The line between two rows of a list, the only edge the design system draws. Spread into a row's
// style, and the one place the lint rule against borders lets a side border be written.
export const dividerBottom = {
  borderBottomWidth: stroke.hair,
  borderBottomColor: colors.divider,
} as const

export const dividerTop = {
  borderTopWidth: stroke.hair,
  borderTopColor: colors.divider,
} as const

// For a library view that draws its own top edge, such as the bottom tab bar's hairline, so the
// edge is gone whatever border colour the navigation theme hands it.
export const noTopEdge = {
  borderTopWidth: stroke.none,
} as const
