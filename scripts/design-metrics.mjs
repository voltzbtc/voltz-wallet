// Counts what the design system migration tracks (docs/design-system-migration.md), straight from
// the source, so a claim that a step improved something is a measurement rather than an opinion.
//
// Read by two callers with different needs, hence --json. A person runs it bare and reads the table;
// __tests__/designRatchet.test.ts runs it with --json and fails when any number climbs.
//
// Parses rather than greps. `grep -o` drops the filename so a path filter silently matches nothing,
// macOS grep has no \s, and a JSX text child is not a quoted string. The brace walker below skips
// strings and comments.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

// Names come from source identifiers, where only `$` is special to a RegExp, but every metacharacter
// is escaped so the pattern stays literal whatever text reaches it.
const escapeRegExp = text => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

// App.tsx lives at the root, outside src/, so it is named explicitly rather than found by walking
// src/. A walk that misses it reports a confident zero for the app's entry point.
function sourceFiles() {
  const out = []
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) {
        out.push(full)
      }
    }
  }
  walk(join(ROOT, 'src'))
  out.push(join(ROOT, 'App.tsx'))
  return out
}

// Index of the brace closing the one at `open`, ignoring braces inside strings, template literals and
// comments. A naive depth counter closes early on a `}` inside a string and truncates the block.
function closeAt(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i += 1
      while (i < src.length && src[i] !== quote) {
        i += src[i] === '\\' ? 2 : 1
      }
    } else if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      if (nl === -1) return src.length - 1
      i = nl
    } else if (c === '/' && src[i + 1] === '*') {
      // An unterminated block comment makes indexOf return -1, and without this guard `i` becomes 0
      // and the scan restarts for ever. A gate that hangs is not a gate that fails: on CI it reads
      // as slow.
      const close = src.indexOf('*/', i + 2)
      if (close === -1) return src.length - 1
      i = close + 1
    } else if (c === '{') {
      depth += 1
    } else if (c === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return src.length - 1
}

// Brace depth at an offset, so a block is recognised by nesting rather than by how far it is indented.
function depthAt(body, at) {
  let depth = 0
  for (let i = 0; i < at; i += 1) {
    const c = body[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i += 1
      while (i < body.length && body[i] !== quote) i += body[i] === '\\' ? 2 : 1
    } else if (c === '{' || c === '[') depth += 1
    else if (c === '}' || c === ']') depth -= 1
  }
  return depth
}

// Named blocks at the top level of a StyleSheet.create call. Nested objects (shadowOffset, transform)
// are not blocks.
function styleBlocks(src) {
  const blocks = []
  let from = 0
  for (;;) {
    const call = src.indexOf('StyleSheet.create', from)
    if (call === -1) break
    const open = src.indexOf('{', call)
    const close = closeAt(src, open)
    const body = src.slice(open + 1, close)
    // Depth-tracked instead of indentation-matched, so a StyleSheet.create nested inside a function
    // is read like any other.
    for (const m of body.matchAll(/([A-Za-z][\w$]*): \{/g)) {
      if (depthAt(body, m.index) !== 0) continue
      const start = m.index + m[0].length - 1
      const end = closeAt(body, start)
      const props = body
        .slice(start + 1, end)
        .split(/,(?![^{[]*[}\]])/)
        .map(p => p.trim().replace(/,$/, ''))
        .filter(Boolean)
        .sort()
      blocks.push({ name: m[1], shape: props.join('|'), props, keys: props.length })
    }
    from = close
  }
  return blocks
}

// Source with comments blanked out, preserving length and line structure so nothing else shifts.
// Without this the axis and rule regexes match their own documentation: a comment explaining why
// `opacity: 0` is off the scale would count as a raw opacity. A metric that counts the text describing
// it is worse than no metric, since it moves when nobody changed code.
function withoutComments(src) {
  let out = ''
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      const start = i
      i += 1
      while (i < src.length && src[i] !== quote) {
        i += src[i] === '\\' ? 2 : 1
      }
      out += src.slice(start, i + 1)
    } else if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      const end = nl === -1 ? src.length : nl
      out += ' '.repeat(end - i)
      i = end - 1
    } else if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close === -1 ? src.length : close + 2
      out += src.slice(i, end).replace(/[^\n]/g, ' ')
      i = end - 1
    } else {
      out += c
    }
  }
  return out
}

// `--natural-text <file>...` reads only the files named and prints the naturalText sites found in
// them, so the scanner's own cases are checked against fixtures in __tests__/designRatchet.test.ts.
// `--figures <file>...` does the same for the figure sites, and `--mute <file>...` prints the
// touchables found and how many of them announce nothing, `--motion <file>...` the files that
// rules.motionUnreduced counts, `--hug <file>...` the count rules.hugLineHeight takes, and
// `--shared <file>...` the counts of the rules on the shared pieces, as one object.
const fixtureFlag = ['--natural-text', '--figures', '--mute', '--motion', '--hug', '--shared'].find(flag =>
  process.argv.includes(flag),
)
const fixtures = fixtureFlag
  ? process.argv.slice(process.argv.indexOf(fixtureFlag) + 1).map(p => resolve(p))
  : null
const files = fixtures ?? sourceFiles()
const parsed = files.map(path => {
  const src = readFileSync(path, 'utf8')
  const bare = withoutComments(src)
  // Blocks are read from `bare`, so a comment written inside a style block does not change its shape
  // and adding a sentence does not read as a refactor.
  return { path: relative(ROOT, path), src, bare, blocks: styleBlocks(bare), fixture: fixtures !== null }
})

const all = parsed.flatMap(f => f.blocks.map(b => ({ ...b, path: f.path })))

// How many blocks are byte-identical to a block in some other file. The sharper question than
// "how many forms does the name `card` have", because it ignores what each author happened to name it.
// Counted wherever the shape repeats, including twice inside one file, because a primitive absorbs
// a repeat within a file just the same, and the point of the number is how much duplication exists
// rather than how far apart it sits.
const byShape = new Map()
for (const b of all) {
  byShape.set(b.shape, (byShape.get(b.shape) ?? 0) + 1)
}
// Two declarations minimum. A block holding one, `{ flex: 1 }` or `{ gap: space.sm }`, is not a shape
// anybody would build a primitive for: it is the vocabulary working, and every screen writing it is
// the point of having a scale. Counting them would also give this number a direction it must not
// have, because naming a raw literal turns a one-key block into a copy of every other one-key block
// with that value, so adopting a token would raise the duplication count.
const cloned = all.filter(b => b.keys > 1 && byShape.get(b.shape) > 1).length

// Names used in three or more files, with how many distinct shapes hide under each. A name with as
// many shapes as uses means every screen reinvented it.
const byName = new Map()
for (const b of all) {
  const rec = byName.get(b.name) ?? { files: new Set(), shapes: new Set() }
  rec.files.add(b.path)
  rec.shapes.add(b.shape)
  byName.set(b.name, rec)
}
const repeated = [...byName]
  .filter(([, r]) => r.files.size >= 3)
  .map(([name, r]) => ({ name, files: r.files.size, shapes: r.shapes.size }))
  .sort((a, b) => b.files - a.files)

// Distinct text styles, as size + weight + colour. lineHeight is left out on purpose: it is a
// property of a text style rather than a style of its own.
// Counted in the code that *uses* text styles, never in the table that defines them, for the same
// reason `theme.ts` is exempt from the raw-colour count: Txt.tsx is the answer, not an instance of the
// problem. It also splits size and weight from colour on purpose, so its rows would each read as a
// combination with no colour and inflate the very number they exist to shrink.
const combos = new Map()
for (const b of all) {
  if (b.path === 'src/components/Txt.tsx') continue
  const size = b.props.find(p => p.startsWith('fontSize:'))
  if (!size) continue
  // Normalised rather than taken raw, because `...font.family.regular` and no weight at all render
  // identically, and keying on the literal would split one style into two combos that look the same
  // on screen.
  const declared = b.props.find(p => p.startsWith('...font.family.'))
  const weight = declared ? declared.replace('...font.family.', '') : 'regular'
  const colour = b.props.find(p => p.startsWith('color:')) ?? 'inherited'
  const key = `${size}|${weight}|${colour}`
  combos.set(key, (combos.get(key) ?? 0) + 1)
}

// Raw literals per axis. An axis with no token has nowhere to drift from, which is why these are the
// numbers the token steps drive to zero.
const AXES = {
  // hairlineWidth counts too, since it is a third convention for the same intent.
  stroke: /\b(borderWidth|borderTopWidth|borderBottomWidth|borderLeftWidth|borderRightWidth): ([0-9.]+|StyleSheet\.hairlineWidth)/g,
  alpha: /\bopacity: [0-9.]+/g,
  size: /\b(width|height|minWidth|minHeight|maxWidth|maxHeight): [0-9]+/g,
  lineHeight: /\blineHeight: [0-9]+/g,
  tracking: /\bletterSpacing: [0-9.]+/g,
  // Call sites count, not just explicit durations, because a withTiming that relies on the library
  // default is a motion decision nobody wrote down, which is the same gap.
  // Any `duration:`, not only a literal one. A `duration: T.oSpinDur` is still a motion decision
  // outside the shared scale, and counting literals alone hides every duration read from a constant.
  // A TypeScript annotation is left out, since `motionFor(duration: number, ...)` is a signature
  // rather than a timing decision, and counting it would charge a file for declaring a parameter.
  motion: /\bduration: (?!number\b|string\b)|\bwithTiming\(|\bwithSpring\(|Animated\.(timing|spring)\(/g,
  layer: /\bzIndex: [0-9]+/g,
}
// Props assigned a name that resolves, in the same file, to a plain number. A local `const BOX = 22`
// used as `width: BOX` is still a value chosen in one file and shared with nobody, which is exactly
// what these axes measure, and naming it locally hid it from every count.
//
// Narrow on purpose. An animated value, a prop, a computed expression and anything reaching into the
// theme are all names too, and none of them is a literal in disguise. Counting those would report a
// parameterised component as drift.
const LAUNDERED = {
  stroke: /\b(?:border(?:Top|Bottom|Left|Right)?Width): ([A-Z_][A-Z0-9_]*)\b/g,
  alpha: /\bopacity: ([A-Z_][A-Z0-9_]*)\b/g,
  size: /\b(?:width|height|minWidth|minHeight|maxWidth|maxHeight): ([A-Z_][A-Z0-9_]*)\b/g,
  lineHeight: /\blineHeight: ([A-Z_][A-Z0-9_]*)\b/g,
  tracking: /\bletterSpacing: ([A-Z_][A-Z0-9_]*)\b/g,
  layer: /\bzIndex: ([A-Z_][A-Z0-9_]*)\b/g,
}
const raw = {}
for (const [axis, re] of Object.entries(AXES)) {
  raw[axis] = parsed.reduce((n, f) => n + (f.bare.match(re)?.length ?? 0), 0)
  const launder = LAUNDERED[axis]
  if (!launder) continue
  for (const f of parsed) {
    // Only names this file declares as a bare number. Anything else is a parameter, not a literal.
    const local = new Set()
    for (const d of f.bare.matchAll(/\bconst ([A-Z_][A-Z0-9_]*) = [0-9.]+\b/g)) local.add(d[1])
    if (local.size === 0) continue
    for (const m of f.bare.matchAll(launder)) {
      if (local.has(m[1])) raw[axis] += 1
    }
  }
}

// Distinct animation durations, which is the number that says whether a scale exists at all.
const durations = new Set()
for (const f of parsed) {
  for (const m of f.bare.matchAll(/\bduration: (\d+)/g)) durations.add(m[1])
}

// Icon sizes, which live in props rather than styles and are therefore invisible to every axis above.
// An icon of 22 can sit next to one of 24 on the same row with nothing in the codebase saying which
// was meant, which is a scale gap the style-level numbers cannot see.
//
// Not given a token scale on purpose. Apple sizes an icon against the text beside it rather than from
// a free scale, so the right value depends on the type role next to it and is decided at the call
// site.
const iconSites = []
for (const f of parsed) {
  for (const m of f.bare.matchAll(/\bsize=\{(\d+)\}/g)) iconSites.push(Number(m[1]))
}

// Rules the project already states. Each is expected to be zero, and a zero is only trustworthy when
// the same pass can produce a non-zero, so these count occurrences rather than asserting absence.
const rules = {
  // Counted in `bare`, because a mention in a comment is not a use.
  activityIndicator: parsed.reduce(
    (n, f) => n + (f.bare.match(/<ActivityIndicator\b/g)?.length ?? 0),
    0,
  ),
  rawFontSize: parsed.reduce((n, f) => n + (f.bare.match(/\bfontSize: [0-9]/g)?.length ?? 0), 0),
  rawRadius: parsed.reduce(
    (n, f) => n + (f.bare.match(/\bborder[A-Za-z]*Radius: [0-9]/g)?.length ?? 0),
    0,
  ),
  // theme.ts is the one file allowed to hold literals.
  hardcodedColour: parsed
    .filter(f => f.path !== 'src/theme.ts')
    // Any string literal holding a hex colour, in either quote and in any position, so an array (a
    // gradient), a double-quoted value and either half of a ternary all count, not only `: '#...'`.
    .reduce((n, f) => n + (f.bare.match(/['"]#[0-9a-fA-F]{3,8}['"]/g)?.length ?? 0), 0),
  // A line height taken from a font size, scaled or not. iOS draws a line into a box exactly its
  // line height tall and cuts what rises above it, which is where Devanagari vowel signs, Thai tone
  // marks and Vietnamese stacked accents sit, so a line height comes from `font.leading` or from the
  // engine.
  //
  // It sees only the literal form: a `lineHeight:` whose value, up to the next comma, closing brace
  // or line end, spells `font.size.`. A size reached through an alias or a local, a value broken over
  // several lines, a `lineHeight=` prop and a call whose arguments hold a comma all pass unseen, so a
  // zero here means no literal case, not no case.
  hugLineHeight: parsed.reduce(
    (n, f) => n + (f.bare.match(/\blineHeight: [^,\n}]*\bfont\.size\./g)?.length ?? 0),
    0,
  ),
}

const tsx = parsed.filter(f => f.path.endsWith('.tsx'))
const count = re => tsx.reduce((n, f) => n + (f.bare.match(re)?.length ?? 0), 0)

// The rules on the shared pieces that a lint rule cannot state, since each is about where a piece is
// used rather than how a line is written: the same text is right in one file and wrong in another, or
// the wrong thing is a number and not a name. ESLint holds outlines, raw colours and the switch.
const outside = (re, exempt) =>
  parsed.filter(f => !exempt.includes(f.path)).reduce((n, f) => n + (f.bare.match(re)?.length ?? 0), 0)
// A margin, a padding or a gap written as a number, which a token cannot catch by its name: a literal,
// a name this file declares as a bare number, a branch of a ternary, or a literal added to or taken
// from another value, since `space.md + 2` leaves the scale as surely as `18`. Zero is no space at
// all, and the few values that sit off the scale on purpose are counted with the rest, so the number
// only says how many are left. Each value counts once, however many of these it holds.
//
// It reads a value up to the next comma, closing brace or line end. A bare-number name inside a sum, a
// literal that multiplies or divides (`FINDER / 2 + space.xl` is half a size, not a space), a name
// declared in another file and a value broken over several lines pass unseen, so a zero here means no
// written case, not no case.
const SPACE_VALUE = /\b(?:(?:margin|padding)[A-Za-z]*|gap|rowGap|columnGap): ([^,\n}]+)/g
const NUMBER = '([0-9][0-9.]*)'
const SPACE_NUMBERS = [
  new RegExp(`^-?${NUMBER}(?![\\w.])`, 'g'),
  new RegExp(`\\?\\s*-?${NUMBER}\\s*:|:\\s*-?${NUMBER}$`, 'g'),
  // Only a summand counts, since a literal that a `*` or `/` binds first is a factor of something else.
  new RegExp(`[\\w.)\\]]\\s*[+-]\\s*${NUMBER}(?![\\w.])(?!\\s*[*/])|\\(\\s*${NUMBER}\\s*[+-]`, 'g'),
]
function writtenSpace(value, local) {
  const v = value.trim()
  const named = v.match(/^-?([A-Z_][A-Z0-9_]*)$/)
  if (named && local.has(named[1])) {
    return Number(local.get(named[1])) !== 0
  }
  return SPACE_NUMBERS.some(re =>
    [...v.matchAll(re)].some(m => m.slice(1).some(d => d !== undefined && Number(d) !== 0)),
  )
}
rules.spaceOffScale = parsed
  .filter(f => f.path !== 'src/theme.ts')
  .reduce((n, f) => {
    const local = new Map()
    for (const d of f.bare.matchAll(/\bconst ([A-Z_][A-Z0-9_]*) = ([0-9.]+)\b/g)) local.set(d[1], d[2])
    return n + [...f.bare.matchAll(SPACE_VALUE)].filter(m => writtenSpace(m[1], local)).length
  }, 0)
// Every input goes through Field, which draws the one TextInput the app has.
rules.inputOutsideField = outside(/<TextInput\b/g, ['src/components/Field.tsx', 'src/components/Text.tsx'])
// A disable comment gets past the lint rule on the import, and it does not get past this.
rules.switchOutsideToggle = outside(/<Switch\b/g, ['src/components/Toggle.tsx'])
// A list's search is SearchField, so no screen spells one out with a Field of its own.
rules.searchOutsidePiece = outside(/\bplaceholder=\{t\('[^']*[sS]earch[^']*'\)\}/g, [])
// A screen's title is ScreenTitle, which owns the space around it.
rules.titleOutsidePiece = parsed
  .filter(f => f.path.startsWith('src/screens/') || f.fixture)
  .reduce((n, f) => n + (f.bare.match(/<Txt\s+role="title"/g)?.length ?? 0), 0)
// A word the type system keeps alive for one call, and the tokens only the pending files reach.
rules.borderedCard = count(/<Card\b[^>]*\sbordered\b/g)
rules.outlineToken = outside(/\bstroke\.(?:thin|control)\b|\bcolors\.(?:glassBorder|pressedOverlayBorder)\b/g, [
  'src/theme.ts',
])

// Counted per element, not per occurrence. Counting the word `accessibilityLabel` would count a
// comment that mentions it, and an element declaring it twice would count twice. The number that
// matters is how many touchables a screen reader can name.
// The index just past the opening tag, tracking brace depth so a `>` inside a prop expression (an
// arrow function, a comparison) does not end the tag early, and skipping string literals so a `>`
// inside one (`testID="a > b"`) does not either.
function endOfOpeningTag(tag, from) {
  let depth = 0
  let quote = null
  for (let i = from; i < tag.length; i += 1) {
    const c = tag[i]
    if (quote) {
      if (c === '\\') i += 1
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    else if (c === '>' && depth === 0) return i
  }
  return tag.length
}

// The opening tag and the content between it and its own closing tag, matched by depth rather than
// by the first `</name>` after it. A self-closing `<Pressable ... />` has no closing tag of its own,
// and a search for the next one would land on a later element's and read its JSX as this one's
// content, making an unlabelled backdrop readable on the strength of a title further down the file.
function span(src, index, name) {
  const rest = src.slice(index)
  const open = endOfOpeningTag(rest, name.length + 1)
  const tag = rest.slice(0, open)
  // A self-closing element is its own content, and holds nothing readable unless the tag says so.
  if (rest[open - 1] === '/') return { tag, body: tag }
  const close = `</${name}>`
  let depth = 0
  let i = 0
  while (i < rest.length) {
    if (rest.startsWith(close, i)) {
      depth -= 1
      if (depth === 0) return { tag, body: rest.slice(0, i) }
      i += close.length
    } else if (rest.startsWith(`<${name}`, i) && !/[A-Za-z0-9]/.test(rest[i + name.length + 1] ?? '')) {
      const end = endOfOpeningTag(rest.slice(i), name.length + 1)
      if (rest[i + end - 1] !== '/') depth += 1
      i += end
    } else {
      i += 1
    }
  }
  return { tag, body: rest }
}

// What a screen reader reads inside a target. A money figure is drawn by Figure or Amount, and a row
// that pairs a label with one by FigureRow, each a text underneath, so a target holding one of them is
// read as surely as one holding a Txt.
const READABLE = /<Text|<Txt|<Figure\b|<FigureRow\b|<Amount\b/

// A target hidden from assistive tech on both platforms is not there for a screen reader at all, so
// it is not a silent target; it is no target. Read from its own opening tag.
function hiddenFromAssistiveTech(tag) {
  return (
    /\baccessibilityElementsHidden(?!\s*=\s*\{\s*false\s*\})/.test(tag) &&
    /\bimportantForAccessibility=["'{]+no-hide-descendants/.test(tag)
  )
}

function touchableProps(src) {
  const found = []
  // `<Touch` counts alongside the hand-written touchables. Leaving it out would drop every migrated
  // target from the numerator and the denominator at once, and while coverage is under 100% removing
  // one from each side lowers the fraction: migrating a well-formed target would make the number
  // worse and migrating a mute one would make it better, which is the opposite of the work.
  //
  // A Touch always carries a role, because the component defaults it to `button`. It carries a label
  // when the call passes one, and it announces nothing when it passes neither a label nor any text
  // inside, which is the same question asked of a hand-written Pressable.
  for (const m of src.matchAll(/<Touch\b/g)) {
    const { tag, body } = span(src, m.index, 'Touch')
    // The end of the opening tag by brace depth, not by the first `>`. A call that opens with
    // `onPress={() => ...}` holds a `>` in the arrow, and reading to it would stop before any prop
    // written on a later line, counting a labelled Touch as mute.
    const label = /\blabel=/.test(tag)
    found.push(
      [
        'accessibilityRole',
        label ? 'accessibilityLabel' : '',
        /\bstate=/.test(body) ? 'accessibilityState' : '',
        /\bhitSlop=/.test(body) ? 'hitSlop' : '',
        label || READABLE.test(body) ? 'readable' : '',
        hiddenFromAssistiveTech(tag) ? 'a11yHidden' : '',
      ].join(' '),
    )
  }
  for (const m of src.matchAll(/<(Pressable|TouchableOpacity|TouchableHighlight)\b/g)) {
    // The same question asked of a Touch. Reading only the opening tag, an icon-only button would
    // count as announced because it declares `accessibilityRole`, while the identical control would
    // count as mute once it becomes a Touch, and migration would look like a regression.
    const { tag, body } = span(src, m.index, m[1])
    found.push(
      [tag, READABLE.test(body) ? 'readable' : '', hiddenFromAssistiveTech(tag) ? 'a11yHidden' : ''].join(
        ' ',
      ),
    )
  }
  return found
}

// Read from the theme rather than repeated here, so a scale step changing does not leave this
// arithmetic quietly measuring the old numbers.
const theme = readFileSync(join(ROOT, 'src/theme.ts'), 'utf8')
const SPACE = Object.fromEntries(
  [...theme.slice(theme.indexOf('export const space')).matchAll(/(\w+): (\d+)/g)]
    .slice(0, 6)
    .map(m => [m[1], Number(m[2])]),
)
const TOUCH_MIN = Number(theme.match(/export const touch = \{ min: (\d+)/)[1])

// `<Touch size>` sites whose drawn size plus hit slop does not reach the floor. The component warns
// about this in development, and a warning only fires where somebody renders the thing: a shrunken
// target on a screen with no test ships with a message nobody reads. This asks the same question
// statically, of every call, which is what makes it a gate rather than a note.
function underFloor(src) {
  let n = 0
  for (const m of src.matchAll(/<Touch\b/g)) {
    const { tag } = span(src, m.index, 'Touch')
    const size = tag.match(/\bsize=\{(\d+)\}/)
    if (!size) continue
    const slop = tag.match(/\bhitSlop=\{(?:space\.(\w+)|(\d+))\}/)
    const pad = slop ? (slop[1] ? (SPACE[slop[1]] ?? 0) : Number(slop[2])) : 0
    if (Number(size[1]) + 2 * pad < TOUCH_MIN) n += 1
  }
  return n
}

rules.touchUnderFloor = tsx.reduce((n, f) => n + underFloor(f.bare), 0)

// Files that move something on screen and never ask whether the phone wants less motion. Movement is
// an animation started (Animated timing, spring, decay or loop, or reanimated's withTiming,
// withSpring, withRepeat or withDecay) where the file also drives a transform or a size from an
// animated value, or a Modal that slides in. A fade alone is not movement, which is what the setting
// is about, so a file that only animates opacity is left alone. Asked per file, because the hook is
// read once per component and a file that reads it is where its animations can be gated.
const MOVEMENT = /\bAnimated\.(?:timing|spring|decay|loop)\(|\bwith(?:Timing|Spring|Repeat|Decay)\(/
const SLIDE = /\banimationType=\{?["'`]slide["'`]/
const ANIMATED_DECLARATION =
  /\bconst\s+(\w+)\s*=\s*(?:useRef\(\s*new Animated\.Value\b|new Animated\.Value\b|[\w.]+\.interpolate\(|useSharedValue\(|useDerivedValue\()/g

// The text of a value from its start to the comma at depth zero, or the bracket that closes it.
function valueAt(src, start) {
  let depth = 0
  for (let i = start; i < src.length; i += 1) {
    const c = src[i]
    if ('([{'.includes(c)) depth += 1
    else if (')]}'.includes(c)) {
      if (depth === 0) return src.slice(start, i)
      depth -= 1
    } else if (depth === 0 && c === ',') return src.slice(start, i)
  }
  return src.slice(start)
}

function drivesMovement(src) {
  const names = [...src.matchAll(ANIMATED_DECLARATION)].map(m => m[1])
  const animated = text =>
    /\.interpolate\(|\.value\b|\bwith(?:Timing|Spring|Repeat|Decay|Sequence|Delay)\(/.test(text) ||
    names.some(name => new RegExp(`\\b${name}\\b`).test(text))
  for (const m of src.matchAll(/\btransform:\s*/g)) {
    if (animated(valueAt(src, m.index + m[0].length))) return true
  }
  for (const m of src.matchAll(/\b(?:width|height):\s*/g)) {
    if (animated(valueAt(src, m.index + m[0].length))) return true
  }
  return false
}

const motionUnreducedFiles = tsx
  .filter(f => (MOVEMENT.test(f.bare) && drivesMovement(f.bare)) || SLIDE.test(f.bare))
  .filter(f => !/\buseReduceMotion\(/.test(f.bare))
  .map(f => f.path)
rules.motionUnreduced = motionUnreducedFiles.length

// Text that iOS would align by the app bundle's localization instead of by the layout direction. A
// paragraph with no textAlign follows the bundle, so with an RTL .lproj shipped, an RTL phone draws
// an app running in an LTR language with its text on the right. Every raw paragraph therefore takes
// leadingText(), and every raw TextInput leadingInput(), since iOS swaps the edges of one and not of
// the other (src/i18n/direction.ts). The helper comes before any alignment the element sets itself,
// so a centred text stays centred. A run nested inside another text sets no alignment at all, since
// an alignment on a run can replace the outer paragraph's, and `<Txt>` always sets one, so it is
// never nested either.
const TEXT_NAMES = ['Animated.Text', 'TextInput', 'Text', 'Txt', 'Figure']
// Txt and the money figure built on it set the alignment themselves.
const SETS_ALIGNMENT = new Set(['Txt', 'Figure'])
const LEADING = { 'Animated.Text': 'leadingText()', Text: 'leadingText()', TextInput: 'leadingInput()' }

// A text component made by Animated.createAnimatedComponent is the same paragraph under another
// name, so each alias is read with the helper its base takes.
function textAliases(src) {
  const aliases = {}
  const decl = /\bconst ([A-Z][\w$]*) = Animated\.createAnimatedComponent\((Text|TextInput)\)/g
  for (const m of src.matchAll(decl)) aliases[m[1]] = m[2]
  return aliases
}

// A const's initializer read to its end, across lines while a bracket is open, so a style array
// written over several lines is read whole rather than as its first line.
function initializer(src, from) {
  let depth = 0
  for (let i = from; i < src.length; i += 1) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i += 1
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1
    } else if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if ((c === '\n' || c === ';') && depth <= 0) return src.slice(from, i)
  }
  return src.slice(from)
}

// The style expression of an opening tag, with each local `const` it names written out in place, so
// `style={labelStyle}` is read as the array `labelStyle` holds.
function styleExpression(src, tag) {
  const at = tag.search(/\bstyle=\{/)
  if (at === -1) return ''
  const open = tag.indexOf('{', at)
  const expr = tag.slice(open + 1, closeAt(tag, open))
  return expr.replace(/(?<![\w$.])[a-z][\w$]*(?![\w$.(:])/g, name => {
    const decl = new RegExp(`\\bconst ${name}(?:: [^=]+)? = `).exec(src)
    return decl ? `(${initializer(src, decl.index + decl[0].length).trim()})` : name
  })
}

// The parts of a style that always apply, in order: an array's elements, flattened through nested
// arrays and parentheses the way React Native flattens them. A conditional (`a && b`, `a ? b : c`)
// stays one part, so a helper inside one never counts as applied.
function styleParts(expr) {
  let e = expr.trim()
  while (e.startsWith('(') && closeParen(e, 0) === e.length - 1) e = e.slice(1, -1).trim()
  if (!(e.startsWith('[') && closeParen(e, 0) === e.length - 1)) return e ? [e] : []
  const parts = []
  let depth = 0
  let start = 1
  for (let i = 1; i < e.length - 1; i += 1) {
    const c = e[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i += 1
      while (i < e.length && e[i] !== quote) i += e[i] === '\\' ? 2 : 1
    } else if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (c === ',' && depth === 0) {
      parts.push(e.slice(start, i))
      start = i + 1
    }
  }
  parts.push(e.slice(start, e.length - 1))
  return parts.flatMap(styleParts)
}

// Index of the bracket closing the one at `open`, skipping strings.
function closeParen(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i += 1
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1
    } else if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

// Nesting is read inside one file. A component whose root is a text, drawn inside a text in another
// file, is a run nested across files, and that depth is not carried from one file to the next, so
// such a run is not checked.
function naturalText(f) {
  const sites = []
  const aligned = new Set(f.blocks.filter(b => b.props.some(p => p.startsWith('textAlign:'))).map(b => b.name))
  const src = f.bare
  const aliases = textAliases(src)
  const helperFor = name => LEADING[name] ?? LEADING[aliases[name]]
  const names = [...TEXT_NAMES, ...Object.keys(aliases)].map(n => n.replace('.', '\\.'))
  const tagRe = new RegExp(`<(\\/?)(${names.join('|')})(?![\\w.])`, 'g')
  const isInput = name => name === 'TextInput' || aliases[name] === 'TextInput'
  let depth = 0
  const at = index => `${f.path}:${src.slice(0, index).split('\n').length}`
  for (const m of src.matchAll(tagRe)) {
    const [, closing, name] = m
    if (closing) {
      if (!isInput(name)) depth -= 1
      if (depth < 0) {
        sites.push(`${at(m.index)} closes a text that never opened`)
        depth = 0
      }
      continue
    }
    // A generic such as useRef<TextInput> follows a name with no space, and outside a text that is
    // the only thing a word right before the tag can be. Inside a text it is a run right after the
    // words before it, which is read like any other.
    if (depth === 0 && /[\w$.]/.test(src[m.index - 1] ?? '')) continue
    const end = endOfOpeningTag(src.slice(m.index), name.length + 1)
    const tag = src.slice(m.index, m.index + end + 1)
    const parts = styleParts(styleExpression(src, tag))
    const helper = helperFor(name)
    const leading = parts.findIndex(p => /^leading(Text|Input)\(\)$/.test(p.trim()))
    if (depth > 0) {
      if (SETS_ALIGNMENT.has(name) || parts.some(p => /\bleading(Text|Input)\(\)/.test(p))) {
        sites.push(`${at(m.index)} nested run sets an alignment`)
      }
    } else if (!SETS_ALIGNMENT.has(name)) {
      // An alignment the element sets itself: an inline textAlign, a style block that holds one, or
      // the caller's own `style` prop, which may carry any alignment at all.
      const sets = p =>
        /\btextAlign:/.test(p) ||
        /^style$/.test(p.trim()) ||
        [...p.matchAll(/\b\w+\.(\w+)\b/g)].some(o => aligned.has(o[1]))
      const own = parts.findIndex(sets)
      if (leading === -1 || parts[leading].trim() !== helper) sites.push(`${at(m.index)} ${name} without ${helper}`)
      else if (own !== -1 && own < leading) sites.push(`${at(m.index)} ${helper} overrides its own textAlign`)
    }
    if (tag[tag.length - 2] !== '/' && !isInput(name)) depth += 1
  }
  if (depth !== 0) sites.push(`${f.path} leaves ${depth} text open, so its nesting cannot be read`)
  return sites
}

const naturalTextSites = tsx.flatMap(naturalText)
rules.naturalText = naturalTextSites.length

// Money figures drawn outside the figure primitive. One line at every text size, shrunk to fit and
// giving way in a row, is a rule of `Figure` and `Amount` (src/components/Amount.tsx), and a figure
// written into any other text wraps or is cut at a large text size.
//
// Counted per text element whose children hold a formatter's output, or a name declared in the same
// file whose value holds it, however many steps of names away. A formatter inside a sentence, a
// template that says more around its amounts than a unit or a sign, is prose: it wraps between words
// like any sentence, and its amount cannot break, since the formatters group digits with a no-break
// space. So is a template whose key is chosen at run time, which the scan cannot read. A figure handed
// to another component as a prop is read in that component's file, if at all.
const FORMATTER = /\b(?:formatSats|formatBtc|formatBtcTrim|formatBrl|formatUsd|formatFiat|formatFiatGeneric|formatAssetAmount|formatAssetDisplay|formatRowAmount|formatTokenBalance|formatBaseUnitsExact|localizeAmount)\(/g
const PRIMITIVES = new Set(['Figure', 'Amount'])
const PRIMITIVE_FILE = join(ROOT, 'src/components/Amount.tsx')
const enUS = JSON.parse(readFileSync(join(ROOT, 'src/i18n/locales/en-US.json'), 'utf8'))

// Where a declaration's value ends: its first line, continued while a line ends on an operator or
// the next one starts with one, so a ternary or an arrow body written under its name is read whole.
function valueEnd(src, from) {
  let end = from + initializer(src, from).length
  while (end < src.length) {
    const before = src.slice(from, end).trimEnd()
    const after = src.slice(end + 1).trimStart()
    if (!/(=>|[=?:(,]|&&|\|\|)$/.test(before) && !/^(\?|:|\.|&&|\|\|)/.test(after)) break
    const next = src.length - after.length
    end = next + initializer(src, next).length
  }
  return end
}

// A template with any word, its placeholders taken out, other than a bitcoin unit. Signs, the
// approximation mark and a ticker placeholder leave a figure a figure.
const UNIT_WORDS = new Set(['sat', 'sats', 'BTC'])
function isSentence(key) {
  const at = path =>
    path.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), enUS)
  const template = at(key) ?? at(`${key}_other`)
  if (typeof template !== 'string') return false
  const words = template.replace(/\{\{[^}]*\}\}/g, ' ').split(/\s+/).filter(w => /\p{L}/u.test(w))
  return words.some(word => !UNIT_WORDS.has(word))
}

function figureSites(f) {
  if (f.path === PRIMITIVE_FILE) return []
  const src = f.bare
  // Spans of t() calls that make a sentence, by key, or whose key is not a literal.
  const prose = []
  for (const m of src.matchAll(/\bt\(\s*/g)) {
    const open = m.index + 1
    const close = closeParen(src, open)
    if (close === -1) continue
    const key = src.slice(open + 1).match(/^\s*(['"])([\w.-]+)\1/)
    if (!key || isSentence(key[2])) prose.push([open, close])
  }
  const inProse = at => prose.some(([a, b]) => at > a && at < b)
  const figureIn = (from, to) => [...src.slice(from, to).matchAll(FORMATTER)].some(m => !inProse(from + m.index))
  // Names whose value holds a figure, read to a fixed point so a name built from a name counts.
  const decls = []
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/g)) {
    decls.push({ name: m[1], from: m.index, to: valueEnd(src, m.index) })
  }
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = src.indexOf('{', closeParen(src, m.index + m[0].length - 1))
    if (open !== -1) decls.push({ name: m[1], from: m.index, to: closeAt(src, open) })
  }
  // A name passes its figure on to another declaration only as a whole value or a call. One read
  // for a field (`hero.kind`) is usually a question about the figure rather than the figure, while a
  // text drawing any field of it (`hero.figure`) still counts.
  const tainted = new Set()
  const refersTo = (from, to, whole = false) =>
    [...tainted].some(name =>
      [
        ...src
          .slice(from, to)
          .matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\b${whole ? '(?!\\s*\\??\\.)(?!\\s*\\[)' : ''}`, 'g')),
      ].some(m => !inProse(from + m.index)),
    )
  for (let grew = true; grew; ) {
    grew = false
    for (const d of decls) {
      if (!tainted.has(d.name) && (figureIn(d.from, d.to) || refersTo(d.from, d.to, true))) {
        tainted.add(d.name)
        grew = true
      }
    }
  }
  // Outermost text elements other than the primitives, and what is between their tags.
  const aliases = textAliases(src)
  const names = [...TEXT_NAMES, ...Object.keys(aliases)].filter(n => !PRIMITIVES.has(n))
  const tagRe = new RegExp(`<(${names.map(n => n.replace('.', '\\.')).join('|')})(?![\\w.])`, 'g')
  const sites = []
  let reach = -1
  for (const m of src.matchAll(tagRe)) {
    if (m.index < reach || /[\w$.]/.test(src[m.index - 1] ?? '')) continue
    const found = span(src, m.index, m[1])
    if (!found) continue
    // The body runs from the element's start to its closing tag, so the opening tag is skipped.
    const from = m.index + found.tag.length
    const to = m.index + found.body.length
    reach = to
    if (figureIn(from, to) || refersTo(from, to)) {
      sites.push(`${f.path}:${src.slice(0, m.index).split('\n').length} ${m[1]} draws a money figure`)
    }
  }
  return sites
}

const figureSitesAll = tsx.flatMap(figureSites)
rules.figureOutsidePrimitive = figureSitesAll.length

const touchables = tsx.flatMap(f => touchableProps(f.bare))
// Presence is not function. `accessibilityRole="none"` and `accessibilityLabel=""` are both declared
// and both announce less, and counting them as progress would make the metric reward the opposite of
// its purpose: a mute touchable given role="none" would move two lines the good way.
const EMPTY = /=\{?["'`]\s*["'`]\}?/
const carries = prop => touchables.filter(tag => meaningful(tag, prop)).length
function meaningful(tag, prop) {
  const at = tag.indexOf(prop)
  if (at === -1) return false
  const value = tag.slice(at + prop.length, at + prop.length + 12)
  if (EMPTY.test(value)) return false
  if (prop === 'accessibilityRole' && /=["'`]none["'`]/.test(value)) return false
  return true
}
const a11y = {
  touchables: touchables.length,
  role: carries('accessibilityRole'),
  label: carries('accessibilityLabel'),
  state: carries('accessibilityState'),
  hitSlop: carries('hitSlop'),
  // A mute target announces nothing usable, with no label and no text inside it. A missing role is
  // a separate defect on a separate axis, already counted above, and a control with visible text
  // does announce that text even without one, so folding the two together would report a chip
  // showing its own word as silent.
  mute: touchables.filter(
    t => !meaningful(t, 'accessibilityLabel') && !t.includes('readable') && !t.includes('a11yHidden'),
  ).length,
  // Animations with no reading of the system setting, which is a WCAG requirement rather than taste.
  // Counted over every file rather than only .tsx, because the hook that reads it is a .ts.
  reduceMotion: parsed.reduce(
    (n, f) => n + (f.bare.match(/isReduceMotionEnabled|reduceMotionChanged/g)?.length ?? 0),
    0,
  ),
  // Both spellings. `<Txt lines={1}>` is `numberOfLines` by another name, so counting only the long
  // one would read every migrated cap as a cap removed.
  numberOfLines: count(/numberOfLines|\blines=\{/g),
  texts: count(/<Text\b/g),
}
// Coverage rather than count, for the same reason block density replaced block count. A primitive
// that consolidates three labelled backdrops into one lowers the absolute number of labels while
// leaving nothing less announced, so ratcheting the count punishes the consolidation for working.
a11y.rolePercent = Math.round((100 * a11y.role) / a11y.touchables)
a11y.labelPercent = Math.round((100 * a11y.label) / a11y.touchables)
a11y.mutePercent = Math.round((100 * a11y.mute) / a11y.touchables)

const metrics = {
  files: files.length,
  iconSizes: new Set(iconSites).size,
  styleBlocks: all.length,
  clonedBlocks: cloned,
  // The number with a direction. Counting blocks punishes an app for growing: a new screen written
  // perfectly, every value a token and every touchable labelled, still raises the block count.
  // Density does not care how many screens exist, only how much of what they contain is a copy of
  // something else, which is what the primitives are for.
  clonePercent: Math.round((100 * cloned) / all.length),
  textCombos: combos.size,
  distinctDurations: durations.size,
  // Files .eslintrc.js lets keep an outline for now. The list ends empty.
  pendingOutlineFiles: JSON.parse(readFileSync(join(ROOT, 'scripts/design-pending.json'), 'utf8')).outlineFiles
    .length,
  raw,
  rules,
  a11y,
  // Reported as a count as well as a list, because the completeness case walks numbers, so a metric
  // shipped only as an array is born with no guard on it.
  worstNameCount: repeated.filter(r => r.shapes === r.files).length,
  worstNames: repeated.filter(r => r.shapes === r.files).map(r => `${r.name} ${r.files}/${r.shapes}`),
  // Where rules.naturalText comes from, so a failing ratchet names the element to fix.
  naturalTextSites,
  // The same for rules.figureOutsidePrimitive.
  figureSites: figureSitesAll,
}

if (fixtureFlag === '--shared') {
  const names = [
    'spaceOffScale',
    'inputOutsideField',
    'switchOutsideToggle',
    'searchOutsidePiece',
    'titleOutsidePiece',
    'borderedCard',
    'outlineToken',
  ]
  process.stdout.write(`${JSON.stringify(Object.fromEntries(names.map(name => [name, rules[name]])))}\n`)
} else if (fixtureFlag === '--hug') {
  process.stdout.write(`${rules.hugLineHeight}\n`)
} else if (fixtureFlag === '--motion') {
  process.stdout.write(`${JSON.stringify(motionUnreducedFiles)}\n`)
} else if (fixtureFlag === '--mute') {
  process.stdout.write(`${JSON.stringify({ touchables: a11y.touchables, mute: a11y.mute })}\n`)
} else if (fixtures) {
  process.stdout.write(`${JSON.stringify(fixtureFlag === '--figures' ? figureSitesAll : naturalTextSites)}\n`)
} else if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`)
} else {
  const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`)
  console.log(`\nDESIGN METRICS  ${metrics.files} files\n`)
  line('style blocks', metrics.styleBlocks)
  line('blocks that are a copy elsewhere', `${metrics.clonedBlocks} (${metrics.clonePercent}%)`)
  line('distinct text styles', metrics.textCombos)
  line('distinct animation durations', metrics.distinctDurations)
  line('distinct icon sizes (in props)', `${metrics.iconSizes} across ${iconSites.length} call sites`)
  console.log('\n  raw values per axis (a token step drives its axis toward its floor)')
  for (const [axis, n] of Object.entries(raw)) line(`  ${axis}`, n)
  console.log('\n  rules the project already states (all expected at zero)')
  for (const [rule, n] of Object.entries(rules)) line(`  ${rule}`, n)
  for (const site of [...naturalTextSites, ...figureSitesAll]) console.log(`      ${site}`)
  console.log('\n  accessibility')
  line('  touchables', a11y.touchables)
  line('  with role / label / state', `${a11y.role} / ${a11y.label} / ${a11y.state}`)
  line('  announces nothing at all', a11y.mute)
  line('  reduce motion consulted', a11y.reduceMotion)
  line('  Text with numberOfLines', `${a11y.numberOfLines} of ${a11y.texts}`)
  console.log('\n  names every file reinvents (uses === distinct shapes)')
  console.log(`    ${metrics.worstNames.join(' · ') || 'none'}\n`)
}
