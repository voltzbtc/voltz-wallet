# UI audit (design tokens and Apple HIG)

A complete, systematic audit of the app's UI against the design tokens in `src/theme.ts` and the
Apple Human Interface Guidelines. Run it after a UI change, or across the whole app before a release.

## Before starting

1. Read `src/theme.ts`, the single source of the tokens (`space`, `radius`, `font`, `colors`,
   `touch`, `stroke`, `motion` and the shared style fragments). Take the current values from the
   file rather than from memory or from this command.
2. Read `docs/design-system.md`, which states the rules the tokens encode and the patterns for
   composing screens. Where this command and that document disagree, the document wins.

## Scope

Every screen in `src/screens/` and every component in `src/components/`, plus `App.tsx` and
`src/navigation/`. Audit file by file rather than by sampling, and state how many files were read out
of how many exist.

## Dimensions

For each file, check the following.

1. **Spacing.** Every `margin*`, `padding*` and `gap` comes from `space.*`, and control heights come
   from `touch.*`. A literal number is a finding unless `docs/design-system.md` names it as an
   allowed exception. Lint does not enforce spacing, so this dimension depends entirely on the
   audit.
2. **Corner radius.** Every corner radius comes from `radius.*`, chosen by component type as the
   design system's radius table assigns it (a button and a card do not share a radius). A nested
   corner is concentric with its container. Every rounded rectangle also sets
   `borderCurve: 'continuous'`. Lint rejects a literal radius, so confirm that it passes and look for
   the wrong token rather than a raw number.
3. **Typography.** Every `fontSize` comes from `font.size.*`, picked by semantic role rather than by
   pixel size. Weight comes from spreading `font.family.*`; a hardcoded `fontFamily` is a finding,
   with `font.mono` as the one token for text read character by character, such as an address.
4. **Icons and touch targets.** An icon is sized close to the text beside it. Every tappable element
   offers at least 44 by 44 points, through its own size or `hitSlop`.
5. **Colour.** No literal colour outside `src/theme.ts`. The accent colour is reserved for calls to
   action and emphasis, never for labels or secondary text, and accent-coloured elements read it from
   the accent hook the design system describes rather than from `colors.primary` directly.
6. **Glass.** A glass surface uses `LiquidGlassView` and keeps the fallback to `colors.glass` and
   `colors.glassBorder` when `isLiquidGlassSupported` is false. It never ends up with no background.
   The native material renders only on iOS 26 and later, so mark it as unverified without a run
   there.
7. **Loading.** A loading state uses `components/Skeleton.tsx`, shaped like the content it stands in
   for. An `ActivityIndicator` or a "Loading" string is a finding.
8. **i18n.** Every user-facing string goes through `t(...)`, and numbers, currency and dates use the
   locale-aware helpers described in `docs/i18n.md`. Layout that must not mirror in right-to-left
   languages, and layout that must, follows the rules in that document.
9. **Vocabulary.** UI copy in every locale avoids words that name custody or brokerage (bank, deposit
   and withdraw as financial acts, trade, exchange, broker), as `docs/principles.md` requires.
10. **Accessibility.** A control whose visible content does not describe it carries an
    `accessibilityLabel`, and motion respects the reduce-motion setting (`useReduceMotion`).

## Method

1. Search broadly for candidates first, covering literal numbers next to spacing, radius, size and colour
   properties, `ActivityIndicator`, `fontFamily:`, literal `#` colours, and the vocabulary list
   across `src/i18n/locales/`.
2. Open each file and check all ten dimensions in context. A search alone misses the wrong radius
   token, a font chosen by pixel instead of role, and a touch target that is small only after layout.
3. Run `node scripts/design-metrics.mjs` for the tracked design numbers; `__tests__/designRatchet.test.ts`
   fails when one of them moves the wrong way.
4. Run `npx eslint .` and `./scripts/typecheck.sh`.

## Output

A table of findings, most severe first:

| # | File:line | Dimension | Problem | Fix |
|---|-----------|-----------|---------|-----|

Every dimension with no finding is reported as clean explicitly rather than omitted. After applying
fixes, run `npx eslint .`, `./scripts/typecheck.sh` and `npx jest`, and report their results.
