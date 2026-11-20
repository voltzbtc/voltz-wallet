import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The ratchet. Every number the design system tracks is frozen here, and the suite fails if one
// moves the wrong way. A change that improves a number lowers its line in the same commit, so the
// diff carries the measurement and the git history is the audit trail rather than a document that
// ages beside it.
//
// A ratchet in place before a migration refuses what tries to get in; one installed after it only
// records whatever was left.
//
// Direction is per metric, and getting it backwards would make the guard silently useless: `atMost`
// holds the numbers that should shrink, `atLeast` the ones that should grow. Reduce-motion support and
// accessibility labels going up is progress; style blocks going up is drift.

// Shrinking. A change that improves one of these lowers its line.
//
// Duplication counts a shape repeating twice inside one file, since a primitive absorbs that just
// the same, and motion counts any `duration:` rather than only a literal, since
// `duration: T.oSpinDur` is still a decision taken outside the shared scale.
const atMost = {
  // The count of duplicated blocks, not their share. A share rises on correct work: absorbing a
  // screen removes mostly *unique* blocks, so both numbers fall and the denominator falls faster.
  //
  // Same shape as the mute metric, and the same resolution. A share is right for something to have
  // more of, where consolidation removes one from each side. Duplication is something to have less
  // of, and the count is what actually falls when a primitive absorbs a copy. A new screen built on
  // the primitives adds few *duplicated* blocks, and one that copies a shape is the case this
  // exists to catch.
  //
  // Blocks holding a single declaration do not count. `{ flex: 1 }` repeating across files is the
  // scale working, not a shape a primitive could absorb, and counting it would give this number the
  // one direction it must not have: naming a raw literal turns a one-key block into a copy of every
  // other one-key block with that value, so adopting a token would raise the duplication count. A
  // three-key block copied outright still counts.
  clonedBlocks: 79,
  textCombos: 15,
  distinctDurations: 16,
  // Icon sizes live in props, so no axis above can see them. The right value for each depends on
  // the text it sits beside, so it is decided at the call site rather than by a sweep.
  iconSizes: 13,
  // Graphics are shapes now, so this axis ends at zero.
  'raw.stroke': 0,
  'raw.alpha': 2,
  'raw.size': 62,
  'raw.lineHeight': 0,
  'raw.tracking': 0,
  'raw.motion': 83,
  'raw.layer': 0,
  // a11y.mute counts the touchables a screen reader announces nothing for, with no label and no
  // text inside. A `<Touch>` and a hand-written Pressable are asked the same question, an opening
  // tag is read to its real end rather than to the `>` inside `onPress={() => ...}`, and a
  // self-closing `<Pressable ... />` is its own content, so a later element's text never makes it
  // readable.
  //
  // The count, and this is the one metric where the count is right and the percentage is the trap:
  // consolidation removes a *labelled* target from the denominator, so the fraction climbs while
  // the numerator, which is the only thing anyone cares about, has not moved.
  //
  // role and label are things to have more of, so a percentage is right for them. Mute is a thing to
  // have none of, so an absolute ceiling is right for it: a new mute target raises it, and deleting a
  // good one never does.
  // A Figure, an Amount or a FigureRow inside a target is text a screen reader reads, and a target
  // hidden from assistive tech on both platforms is no target at all, so neither counts. One left:
  // the splash screen, whose whole surface is a Pressable that skips the animation and announces
  // nothing until it is hidden from assistive tech.
  'a11y.mute': 1,
  // Files .eslintrc.js lets keep an outline while another change frees them, read from
  // scripts/design-pending.json. A file leaves the list when it is clean, and this ends at zero.
  pendingOutlineFiles: 0,
  // A word Card's type keeps alive for one call in HomeScreen, and the outline tokens only the two
  // pending files reach. Both reach zero with them, and the type and the tokens go in that commit.
  'rules.borderedCard': 0,
  'rules.outlineToken': 6,
  // Titles drawn by hand on a screen, which then choose their own space.
  'rules.titleOutsidePiece': 0,
  // A margin, padding or gap written as a number. One `paddingVertical: 14` beside a 44pt floor, whose
  // height comes from the floor. ESLint cannot tell these from a value that is meant, so this holds
  // the count and a new one has to take a token.
  'rules.spaceOffScale': 1,
  // Rules the project already states. These are at zero and the only acceptable direction is to stay.
  'rules.inputOutsideField': 0,
  'rules.switchOutsideToggle': 0,
  'rules.searchOutsidePiece': 0,
  'rules.activityIndicator': 0,
  'rules.rawFontSize': 0,
  'rules.rawRadius': 0,
  'rules.hardcodedColour': 0,
  // `<Touch size>` calls whose drawn size plus hit slop misses the floor. The component warns about
  // this in development, and a warning only fires where somebody renders the thing, so a shrunken
  // target on an untested screen would ship with a message nobody reads. Asked statically here, of
  // every call, which is what makes it a gate.
  'rules.touchUnderFloor': 0,
  // Files that move something (a transform or a size driven by an animation, or a Modal that slides)
  // and never read useReduceMotion.
  'rules.motionUnreduced': 0,
  // Text that iOS would align by the app bundle's localization rather than by the layout direction:
  // a raw Text without leadingText(), a raw TextInput without leadingInput(), a helper placed after
  // the element's own textAlign, or a nested run that sets an alignment. With an RTL .lproj shipped,
  // any of them draws an LTR screen's text on the right on an RTL phone.
  'rules.naturalText': 0,
  // A money figure in any text other than Figure and Amount, which keep it on one line that shrinks
  // to fit and gives way in a row. Written into another text, a figure wraps into two numbers or is
  // cut past the row's edge at a large text size.
  'rules.figureOutsidePrimitive': 0,
  // A text whose line height is its font size. Home's total label and the line under the balance
  // were drawn that way, and Hindi, Thai and Vietnamese lost the top of their letters.
  'rules.hugLineHeight': 0,
} as const

// Growing. A primitive that carries accessibility with it moves these without anyone remembering to.
const atLeast = {
  'a11y.rolePercent': 100,
  'a11y.state': 17,
  // `<Txt lines={1}>` counts, since it is `numberOfLines` under another name and a migrated cap is
  // not a cap removed. Lowered by one for Convert's range line, a sentence holding amounts, which a
  // cap cut mid-figure at the largest sizes; it now wraps between words instead.
  'a11y.numberOfLines': 37,
  // Places that consult the system reduce-motion setting. Each new one moves this up.
  'a11y.reduceMotion': 2,
} as const

function read(metrics: Record<string, unknown>, path: string): number {
  const value = path.split('.').reduce<unknown>((node, key) => {
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
  }, metrics)
  if (typeof value !== 'number') {
    throw new Error(`design-metrics did not report ${path}, so this ratchet is measuring nothing`)
  }
  return value
}

// Run once for the whole file. The script walks every source file, which is too slow to repeat per case.
const metrics: Record<string, unknown> = JSON.parse(
  execFileSync('node', ['scripts/design-metrics.mjs', '--json'], { encoding: 'utf8' }),
)

describe('the design system only moves one way', () => {
  it.each(Object.entries(atMost))('%s stays at or below %d', (path, ceiling) => {
    expect(read(metrics, path)).toBeLessThanOrEqual(ceiling)
  })

  it.each(Object.entries(atLeast))('%s stays at or above %d', (path, floor) => {
    expect(read(metrics, path)).toBeGreaterThanOrEqual(floor)
  })

  // The same number as rules.naturalText, listed by element, so a failure names what to fix.
  it('every text follows the layout direction', () => {
    expect(metrics.naturalTextSites).toEqual([])
  })

  // The same number as rules.figureOutsidePrimitive, listed by element.
  it('every money figure is drawn by the figure primitive', () => {
    expect(metrics.figureSites).toEqual([])
  })

  // Without this, a metric renamed or dropped from the script turns its ratchet line into a silent
  // pass: `read` throws on a missing path, but only for paths still listed here. This checks the other
  // direction, that the script has not grown a number nobody is watching.
  it('every number the instrument reports is under a ratchet', () => {
    const watched = new Set([...Object.keys(atMost), ...Object.keys(atLeast)])
    const reported: string[] = []
    const walk = (node: unknown, prefix: string): void => {
      if (typeof node === 'number') {
        reported.push(prefix)
      } else if (node && typeof node === 'object' && !Array.isArray(node)) {
        for (const [key, value] of Object.entries(node)) {
          walk(value, prefix ? `${prefix}.${key}` : key)
        }
      }
    }
    walk(metrics, '')
    // Counts that describe the app rather than judge it, so there is no right direction for them.
    const informational = [
      'files',
      'a11y.touchables',
      'a11y.texts',
      'a11y.hitSlop',
      'styleBlocks',
      // The share behind clonedBlocks, whose count carries the direction. Reported because a reader
      // wants the share, and unwatched because the share rises when a unique block is removed.
      'clonePercent',
      // Labels are not uniformly good, which is why this is off the ratchet. A label on a target
      // that already holds text *replaces* what both platforms would read, so removing one there is
      // an improvement that this number scores as a loss, and folding a backdrop into <Sheet>
      // lowers the share while nothing loses its voice. The number that matters is the mute count
      // above, which is watched.
      'a11y.labelPercent',
      // The raw counts behind the two percentages above. Watched through those, since a count falls
      // when a primitive consolidates and rises when the app grows, and neither is the question.
      'a11y.role',
      'a11y.label',
      // The inverse of its own count, which is what carries the direction. Reported because a reader
      // wants the share, and unwatched because the share moves when the denominator does.
      'a11y.mutePercent',
      // Names where every use has a distinct shape, which says which primitives are worth building.
      // It climbs on correct work: removing one instance of a name can leave the remainder
      // all-distinct. Clone density already carries the direction, without punishing a deletion.
      'worstNameCount',
    ]
    const loose = reported.filter(path => !watched.has(path) && !informational.includes(path))
    expect(loose).toEqual([])
  })
})

// The count behind a11y.mute, on fixtures, so each way a target can be read or hidden is shown to
// leave it out, and a target that announces nothing is shown to stay in.
describe('the mute meter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mute-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function mute(name: string, source: string): number {
    const file = join(dir, `${name}.tsx`)
    writeFileSync(file, source)
    const found = JSON.parse(
      execFileSync('node', ['scripts/design-metrics.mjs', '--mute', file], { encoding: 'utf8' }),
    ) as { touchables: number; mute: number }
    // A fixture the meter did not read as a target would pass for the wrong reason.
    expect(found.touchables).toBe(1)
    return found.mute
  }

  it('still counts an icon-only target with no label, as a Touch and as a Pressable', () => {
    expect(mute('iconTouch', `<Touch onPress={go}><TabIcon name="plus" size={18} /></Touch>\n`)).toBe(1)
    expect(mute('iconPressable', `<Pressable onPress={go}><TabIcon name="plus" /></Pressable>\n`)).toBe(1)
  })

  it('reads a figure inside a target as its text', () => {
    expect(mute('figure', `<Touch onPress={go}><Figure role="bodyBold">{label}</Figure></Touch>\n`)).toBe(0)
    expect(mute('amount', `<Pressable onPress={go}><Amount value={v} unit="sats" /></Pressable>\n`)).toBe(0)
    expect(mute('figureRow', `<Touch onPress={go}><FigureRow label={name}>{v}</FigureRow></Touch>\n`)).toBe(0)
  })

  it('leaves out a target hidden from assistive tech on both platforms, and only then', () => {
    const both = `<Pressable onPress={skip} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
  <View />
</Pressable>
`
    expect(mute('hidden', both)).toBe(0)
    // One prop hides it from one platform's reader only, so the other still meets a silent target.
    expect(mute('iosOnly', `<Pressable onPress={skip} accessibilityElementsHidden><View /></Pressable>\n`)).toBe(1)
    const androidOnly = `<Pressable onPress={skip} importantForAccessibility="no-hide-descendants"><View /></Pressable>\n`
    expect(mute('androidOnly', androidOnly)).toBe(1)
    const shown = `<Pressable onPress={skip} accessibilityElementsHidden={false} importantForAccessibility="no-hide-descendants">
  <View />
</Pressable>
`
    expect(mute('shown', shown)).toBe(1)
  })
})

// The scanner behind rules.motionUnreduced, on fixtures, so each kind of movement is shown to count,
// reading the setting is shown to clear it, and a fade or a still transform is shown to be left alone.
describe('the motion scanner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'motion-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function moves(name: string, source: string): boolean {
    const file = join(dir, `${name}.tsx`)
    writeFileSync(file, source)
    const found = JSON.parse(
      execFileSync('node', ['scripts/design-metrics.mjs', '--motion', file], { encoding: 'utf8' }),
    ) as string[]
    return found.length === 1
  }
  const READS = 'const reduced = useReduceMotion()\n'

  const flight = `const zoom = useRef(new Animated.Value(0)).current
Animated.timing(zoom, { toValue: 1, duration: motion.base, useNativeDriver: true }).start()
<Animated.View style={{ transform: [{ scale: zoom.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }] }} />
`
  it('counts a timing that drives a transform, and not once the file reads the setting', () => {
    expect(moves('flight', flight)).toBe(true)
    expect(moves('flightReduced', READS + flight)).toBe(false)
  })

  it('follows a transform through a name the file declares', () => {
    const spin = `const rot = useRef(new Animated.Value(0)).current
const turn = rot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
Animated.loop(Animated.timing(rot, { toValue: 1, duration: 900, useNativeDriver: true })).start()
<Animated.View style={{ transform: [{ rotate: turn }] }} />
`
    expect(moves('spin', spin)).toBe(true)
  })

  it('counts reanimated driving a transform or a size', () => {
    const spring = `const style = useAnimatedStyle(() => ({ transform: [{ scale: withSpring(on.value ? 1.04 : 1) }] }))\n`
    const size = `const slot = useAnimatedStyle(() => ({ width: progress.value * SLOT }))
progress.value = withTiming(1)
`
    expect(moves('spring', spring)).toBe(true)
    expect(moves('size', size)).toBe(true)
  })

  it('counts a Modal that slides in, and not one that fades', () => {
    expect(moves('modalSlide', `<Modal visible={open} animationType="slide" transparent />\n`)).toBe(true)
    expect(moves('modalFade', `<Modal visible={open} animationType="fade" transparent />\n`)).toBe(false)
  })

  it('leaves a fade alone, and a still transform beside one', () => {
    const fade = `const hint = useRef(new Animated.Value(1)).current
Animated.timing(hint, { toValue: 0, duration: motion.fast, useNativeDriver: true }).start()
<Animated.View style={{ opacity: hint, transform: [{ scaleX: -1 }] }} />
`
    const pulse = `opacity.value = withRepeat(withTiming(1, { duration: 800 }), -1, true)\n`
    expect(moves('fade', fade)).toBe(false)
    expect(moves('pulse', pulse)).toBe(false)
  })
})

// The scanner behind the rules on the shared pieces, on fixtures, so each number above is one it can
// leave. A clean fixture beside each planted one shows the same pass can also say zero.
describe('the shared pieces scanner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function shared(name: string, source: string): Record<string, number> {
    const file = join(dir, `${name}.tsx`)
    writeFileSync(file, source)
    return JSON.parse(
      execFileSync('node', ['scripts/design-metrics.mjs', '--shared', file], { encoding: 'utf8' }),
    )
  }

  it('counts a margin, a padding or a gap written as a number, and leaves zero and a token', () => {
    const planted = `const styles = StyleSheet.create({ a: { marginTop: 7, padding: 3, gap: 5 } })\n`
    expect(shared('space', planted).spaceOffScale).toBe(3)
    const clean = `const styles = StyleSheet.create({ a: { marginTop: space.sm, padding: 0, gap: space.md } })\n`
    expect(shared('spaceClean', clean).spaceOffScale).toBe(0)
  })

  it('counts a number added to a token, held in a local, or in a branch, once per value', () => {
    const planted = `const PAD = 7
const styles = StyleSheet.create({ a: {
  marginTop: space.md + 2, gap: rhythm.section - 4, paddingStart: 3 + space.sm, paddingEnd: x * (2 + y),
  padding: PAD, marginBottom: wide ? 6 : space.sm, marginEnd: space.sm + 1 + 2,
} })\n`
    expect(shared('spaceLaundered', planted).spaceOffScale).toBe(7)
    // A token sum, a half size, a local holding a token, zero in any of these forms, and a factor.
    const clean = `const FINDER = 240
const NONE = 0
const CELL = space.xs
const styles = StyleSheet.create({ a: {
  marginTop: space.md + space.xs, marginBottom: FINDER / 2 + space.xl, padding: CELL, margin: NONE,
  paddingTop: (space.xxl - font.leading.sm) / 2, paddingBottom: footer ? 0 : space.xl + insets.bottom,
  marginEnd: -space.sm, gap: space.md + 2 * hair,
} })\n`
    expect(shared('spaceLaunderedClean', clean).spaceOffScale).toBe(0)
  })

  it('counts an input drawn outside Field', () => {
    expect(shared('input', `<TextInput value={v} />\n`).inputOutsideField).toBe(1)
    expect(shared('inputClean', `<Field value={v} />\n`).inputOutsideField).toBe(0)
  })

  it('counts a switch drawn outside Toggle, which a disable comment on the import would hide', () => {
    expect(shared('switch', `<Switch value={on} />\n`).switchOutsideToggle).toBe(1)
    expect(shared('switchClean', `<Toggle value={on} />\n`).switchOutsideToggle).toBe(0)
  })

  it('counts a list search spelled out by hand', () => {
    const planted = `<Field value={q} placeholder={t('currency.search')} />\n`
    expect(shared('search', planted).searchOutsidePiece).toBe(1)
    const clean = `<SearchField value={q} label={t('currency.search')} />\n`
    expect(shared('searchClean', clean).searchOutsidePiece).toBe(0)
  })

  it('counts a title drawn by hand', () => {
    expect(shared('title', `<Txt role="title">{name}</Txt>\n`).titleOutsidePiece).toBe(1)
    expect(shared('titleClean', `<ScreenTitle title={name} />\n`).titleOutsidePiece).toBe(0)
  })

  it('counts the bordered word and the outline tokens', () => {
    expect(shared('card', `<Card bordered gap="sm" />\n`).borderedCard).toBe(1)
    expect(shared('cardClean', `<Card gap="sm" />\n`).borderedCard).toBe(0)
    expect(shared('token', `const a = stroke.thin + colors.glassBorder\n`).outlineToken).toBe(2)
    expect(shared('tokenClean', `const a = stroke.hair + colors.divider\n`).outlineToken).toBe(0)
  })
})

// The scanner behind rules.hugLineHeight, on fixtures, so the zero above is a zero it can leave.
describe('the line height scanner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hug-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function hugs(name: string, source: string): number {
    const file = join(dir, `${name}.tsx`)
    writeFileSync(file, source)
    return JSON.parse(
      execFileSync('node', ['scripts/design-metrics.mjs', '--hug', file], { encoding: 'utf8' }),
    ) as number
  }

  it('counts a line height taken from a font size, scaled or not', () => {
    expect(hugs('size', `const styles = StyleSheet.create({ a: { lineHeight: font.size.base } })\n`)).toBe(1)
    expect(hugs('scaled', `const styles = StyleSheet.create({ a: { lineHeight: font.size.lg * k } })\n`)).toBe(1)
  })

  it('leaves a leading token and a comment alone', () => {
    expect(hugs('leading', `const styles = StyleSheet.create({ a: { lineHeight: font.leading.lg } })\n`)).toBe(0)
    expect(hugs('comment', `// lineHeight: font.size.base\nconst a = 1\n`)).toBe(0)
  })
})

// The scanner behind rules.naturalText, run on fixtures, since the app has no instance of these cases
// for the ratchet above to catch. Each fixture is one file; each case names what it must report.
describe('the naturalText scanner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'natural-text-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function scan(name: string, source: string): string[] {
    const file = join(dir, `${name}.tsx`)
    writeFileSync(file, source)
    return JSON.parse(
      execFileSync('node', ['scripts/design-metrics.mjs', '--natural-text', file], { encoding: 'utf8' }),
    )
  }
  const site = (line: number, what: string) => expect.stringMatching(new RegExp(`:${line} ${what}$`))

  const STYLES = `
const styles = StyleSheet.create({
  centred: { textAlign: 'center' },
  plain: { color: 'red' },
})
`

  it('passes a text whose helper always applies, before its own alignment', () => {
    expect(scan('clean', `<Text style={[leadingText(), styles.centred]}>a</Text>\n${STYLES}`)).toEqual([])
  })

  it('does not count a helper inside a conditional as applied', () => {
    const and = scan('and', `<Text style={[ready && leadingText(), styles.plain]}>a</Text>\n${STYLES}`)
    const ternary = scan('ternary', `<Text style={ready ? leadingText() : undefined}>a</Text>\n${STYLES}`)
    expect(and).toEqual([site(1, 'Text without leadingText\\(\\)')])
    expect(ternary).toEqual([site(1, 'Text without leadingText\\(\\)')])
  })

  it('reads a text made by createAnimatedComponent as the text it wraps', () => {
    const source = `const Fading = Animated.createAnimatedComponent(Text)
<Fading style={styles.plain}>a</Fading>
${STYLES}`
    expect(scan('alias', source)).toEqual([site(2, 'Fading without leadingText\\(\\)')])
  })

  it("treats the caller's style prop before the helper as an alignment the helper overrides", () => {
    expect(scan('caller', `<Text style={[style, leadingText()]}>a</Text>\n`)).toEqual([
      site(1, 'leadingText\\(\\) overrides its own textAlign'),
    ])
    expect(scan('callerAfter', `<Text style={[leadingText(), style]}>a</Text>\n`)).toEqual([])
  })

  it('reads a style const written over several lines to its end', () => {
    const source = `const label = [
  leadingText(),
  styles.plain,
]
<Text style={label}>a</Text>
${STYLES}`
    expect(scan('multiline', source)).toEqual([])
    const late = `const label = [
  styles.centred,
  leadingText(),
]
<Text style={label}>a</Text>
${STYLES}`
    expect(scan('multilineLate', late)).toEqual([site(5, 'leadingText\\(\\) overrides its own textAlign')])
  })

  it('checks a run that follows words inside a text, and still skips a generic outside one', () => {
    const run = scan('run', `<Text style={[leadingText()]}>Total<Txt>bold</Txt></Text>\n`)
    expect(run).toEqual([site(1, 'nested run sets an alignment')])
    expect(scan('generic', `const input = useRef<TextInput>(null)\n`)).toEqual([])
  })
})

// The scanner behind rules.figureOutsidePrimitive, on fixtures, so each way a figure reaches a text is
// shown to be counted and each way a sentence holds an amount is shown to be left alone.
describe('the figure scanner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'figures-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function scan(name: string, source: string): string[] {
    const file = join(dir, `${name}.tsx`)
    writeFileSync(file, source)
    return JSON.parse(
      execFileSync('node', ['scripts/design-metrics.mjs', '--figures', file], { encoding: 'utf8' }),
    )
  }
  const site = (line: number, name: string) =>
    expect.stringMatching(new RegExp(`:${line} ${name} draws a money figure$`))

  it('counts a formatter written into a text, and not one written into the primitive', () => {
    expect(scan('direct', `<Txt role="caption">{formatSats(fee)}</Txt>\n`)).toEqual([site(1, 'Txt')])
    expect(scan('raw', `<Text style={[leadingText()]}>{formatFiat(v, c)}</Text>\n`)).toEqual([site(1, 'Text')])
    expect(scan('primitive', `<Figure role="caption">{formatSats(fee)}</Figure>\n`)).toEqual([])
  })

  it('counts a unit template as a figure and a sentence as prose', () => {
    const unit = scan('unit', `<Txt>{t('home.sats', { amount: formatSats(n) })}</Txt>\n`)
    const sentence = scan('sentence', `<Txt>{t('deposits.amount', { amount: formatSats(n) })}</Txt>\n`)
    expect(unit).toEqual([site(1, 'Txt')])
    expect(sentence).toEqual([])
  })

  it('follows a figure through names declared in the file, to any depth', () => {
    const source = `function line(n: number): string {
  return t('send.sats', { amount: formatSats(n) })
}
const total = line(sum)
const shown = hidden ? '••••' : total
<Txt>{shown}</Txt>
<Txt>{label}</Txt>
`
    expect(scan('names', source)).toEqual([site(6, 'Txt')])
  })

  it('counts a run inside a paragraph once, by its paragraph', () => {
    const source = `<Txt>
  {formatSats(n)}
  <Text style={styles.unit}> sats</Text>
</Txt>
`
    expect(scan('runs', source)).toEqual([site(1, 'Txt')])
  })

  it('reads an animated text as the text it is', () => {
    const source = `<Animated.Text style={[leadingText(), fade]}>{localizeAmount(a)} USDB</Animated.Text>\n`
    expect(scan('animated', source)).toEqual([site(1, 'Animated.Text')])
  })

  it('leaves a screen reader label alone, since only a drawn figure can wrap', () => {
    expect(scan('label', `<Touch label={formatSats(n)}><Txt>{t('common.edit')}</Txt></Touch>\n`)).toEqual([])
  })
})
