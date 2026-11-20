import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The lint rules the design system rests on, run through the config CI runs. Each mistake is planted
// and has to come back red, and each control beside it has to come back clean, since a rule that never
// reports and a rule that reports everything pass a single case alike.

const ROOT = join(__dirname, '..')
const SCREEN = 'src/screens/Planted.tsx'

type Case = { code: string; file: string }

// ESLint runs in a process of its own, once for the file, since loading the config takes seconds.
const LINTER = `
const { ESLint } = require('eslint')
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'))
const eslint = new ESLint({ cwd: process.cwd() })
;(async () => {
  const out = []
  for (const c of cases) {
    const [result] = await eslint.lintText(c.code, { filePath: c.file })
    out.push(result.messages.map(m => ({ rule: m.ruleId, text: m.message })))
  }
  process.stdout.write(JSON.stringify(out))
})()
`

function lintAll(cases: Case[]): { rule: string | null; text: string }[][] {
  return JSON.parse(
    execFileSync('node', ['-e', LINTER], { cwd: ROOT, input: JSON.stringify(cases), encoding: 'utf8' }),
  )
}

const style = (body: string) => `export const s = { a: { ${body} } }\n`

const OUTLINES = [
  'borderWidth: 1',
  'borderColor: colors.surface',
  'borderTopWidth: 1',
  'borderBottomWidth: 2',
  'borderLeftWidth: 1',
  'borderRightColor: colors.surface',
  'borderStartWidth: 1',
  'borderEndColor: colors.surface',
  'borderHorizontalWidth: 1',
  'borderStyle: "dashed"',
  'outlineWidth: 1',
  'outlineColor: colors.surface',
  "outlineStyle: 'solid'",
  'borderBlockColor: colors.surface',
  'borderBlockStartColor: colors.surface',
  'borderBlockEndColor: colors.surface',
  'borderBlockWidth: 1',
  'borderBlockStartWidth: 1',
  "borderBlockEndStyle: 'solid'",
  'borderInlineColor: colors.surface',
  'borderInlineStartColor: colors.surface',
  'borderInlineEndColor: colors.surface',
  'borderInlineWidth: 1',
  'borderInlineStartWidth: 1',
  "borderInlineEndStyle: 'solid'",
  "boxShadow: '0 0 0 1px black'",
  // A quoted key and a computed one draw the same line.
  "'borderWidth': 1",
  "['borderWidth']: 1",
  '[borderWidth]: 1',
  '[`borderWidth`]: 1',
  '[`borderTopColor`]: colors.surface',
  '[`outlineWidth`]: 1',
  '[`boxShadow`]: shadow',
  '[`border${side}Width`]: 1',
  '[`border${side}Color`]: colors.surface',
]
// Names beside an outline's, which each draw nothing around a surface.
const OUTLINE_CONTROLS = [
  'borderRadius: radius.md',
  "borderCurve: 'continuous'",
  'borderWidthish: 1',
  '[`borderRadius`]: radius.md',
  '[`border${side}Radius`]: radius.md',
  '[`width${side}`]: 1',
]
const COLOURS = [
  style("backgroundColor: '#123456'"),
  style("color: '#fff'"),
  style("backgroundColor: 'rgba(0, 0, 0, 0.5)'"),
  style("color: 'red'"),
  'export const g = [`#123456`]\n',
  "export const g = ['#123456', '#654321']\n",
  'export const a = <Svg fill="#123456" />\n',
  'export const a = <Svg stroke="teal" />\n',
  'export const a = (hue: number) => `hsl(${hue}, 55%, 45%)`\n',
  // A name a step or a few down from where the colour goes.
  style("color: dark ? 'red' : colors.text"),
  style("color: dark ? colors.text : 'white'"),
  style("backgroundColor: dark && 'black'"),
  style("color: tint ?? 'red'"),
  style("colors: [dark ? 'red' : colors.text]"),
  'export const a = <Svg fill={dark ? colors.text : "red"} />\n',
  'export const a = <Svg fill={"red"} />\n',
  "export const a = <LinearGradient colors={['red', colors.text]} />\n",
  "export const a = <LinearGradient colors={dark ? ['red'] : stops} />\n",
  // The left side of `||`, and a template with nothing in it, write the same colour.
  style("color: 'red' || tint"),
  style('color: dark ? `red` : colors.text'),
]
const COLOUR_CONTROLS = [
  style('backgroundColor: colors.surface'),
  style("backgroundColor: 'transparent'"),
  'export const a = <Svg fill="none" />\n',
  'export const a = <Svg fill="url(#shine)" />\n',
  "export const id = 'abc'\n",
  // Strings on the way to a colour that are not one.
  style("color: mode === 'dark' ? colors.text : colors.surface"),
  style("color: tone(warn ? 'warning' : 'muted')"),
  style("color: picked ?? ''"),
  'export const a = <Svg fill={dark ? "none" : colors.text} />\n',
  // A template that places a value is a colour kept elsewhere, and one that names none is no colour.
  style('color: dark ? `${tint}` : colors.text'),
  style('color: dark ? `none` : colors.text'),
]
const IMPORTS = ['ActivityIndicator', 'Alert', 'Text', 'TextInput', 'Switch']

const toggle = readFileSync(join(ROOT, 'src/components/Toggle.tsx'), 'utf8')
const pending: string[] = JSON.parse(
  readFileSync(join(ROOT, 'scripts/design-pending.json'), 'utf8'),
).outlineFiles

const cases: Record<string, Case> = {}
const put = (key: string, code: string, file = SCREEN) => {
  cases[key] = { code, file }
}
OUTLINES.forEach(o => put(`outline ${o}`, style(o)))
OUTLINES.forEach(o => put(`theme ${o}`, style(o), 'src/theme.ts'))
OUTLINES.forEach(o => put(`test ${o}`, style(o), '__tests__/planted.test.tsx'))
OUTLINE_CONTROLS.forEach(o => put(`not an outline ${o}`, style(o)))
COLOURS.forEach(c => put(`colour ${c}`, c))
COLOURS.forEach(c => put(`app ${c}`, c, 'App.tsx'))
COLOURS.forEach(c => put(`theme ${c}`, c, 'src/theme.ts'))
COLOUR_CONTROLS.forEach(c => put(`control ${c}`, c))
IMPORTS.forEach(name => put(`import ${name}`, `import { ${name} } from 'react-native'\nexport const a = ${name}\n`))
put('divider', style('...dividerBottom, borderRadius: radius.lg'))
put('other imports', `import { View } from 'react-native'\nexport const a = View\n`)
put('toggle', toggle, 'src/components/Toggle.tsx')
if (pending[0]) {
  put('pending outline', style('borderWidth: 1'), pending[0])
  put('pending colour', style("color: '#123456'"), pending[0])
}

const results = new Map<string, { rule: string | null; text: string }[]>()

beforeAll(() => {
  const keys = Object.keys(cases)
  lintAll(keys.map(key => cases[key]!)).forEach((messages, index) => results.set(keys[index]!, messages))
}, 120000)

const said = (key: string, rule: string, words: RegExp): boolean => {
  const messages = results.get(key)
  if (!messages) {
    throw new Error(`nothing linted for ${key}`)
  }
  return messages.some(m => m.rule === rule && words.test(m.text))
}
const syntax = 'no-restricted-syntax'

describe('an outline', () => {
  it.each(OUTLINES)('is refused in the app: %s', outline => {
    expect(said(`outline ${outline}`, syntax, /No outlines/)).toBe(true)
  })

  it.each(OUTLINES)('is left to theme.ts, where the divider is defined: %s', outline => {
    expect(said(`theme ${outline}`, syntax, /No outlines/)).toBe(false)
  })

  it.each(OUTLINES)('is left to a test, which plants one on purpose: %s', outline => {
    expect(said(`test ${outline}`, syntax, /No outlines/)).toBe(false)
  })

  it.each(OUTLINE_CONTROLS)('is not what this is: %s', control => {
    expect(said(`not an outline ${control}`, syntax, /No outlines/)).toBe(false)
  })

  it('lets a row take the divider fragment and a corner radius', () => {
    expect(results.get('divider')!.filter(m => m.rule === syntax)).toEqual([])
  })
})

describe('a raw colour', () => {
  it.each(COLOURS)('is refused in src: %s', code => {
    expect(said(`colour ${code}`, syntax, /colour from theme/)).toBe(true)
  })

  it.each(COLOURS)('is refused in App.tsx: %s', code => {
    expect(said(`app ${code}`, syntax, /colour from theme/)).toBe(true)
  })

  it.each(COLOURS)('is what theme.ts is for: %s', code => {
    expect(said(`theme ${code}`, syntax, /colour from theme/)).toBe(false)
  })

  it.each(COLOUR_CONTROLS)('is not what this is: %s', code => {
    expect(said(`control ${code}`, syntax, /colour from theme/)).toBe(false)
  })
})

describe('a piece of React Native the app replaces', () => {
  // ESLint keeps only the last of several entries naming a package, so before these were one entry a
  // new line at the end silently turned off every line above it.
  it.each(IMPORTS)('is refused: %s', name => {
    expect(said(`import ${name}`, 'no-restricted-imports', /app's own/)).toBe(true)
  })

  it('leaves the rest of the package alone', () => {
    expect(said('other imports', 'no-restricted-imports', /app's own/)).toBe(false)
  })

  it('lets Toggle draw the one Switch, and its comment is what lets it', () => {
    expect(results.get('toggle')!.filter(m => m.rule?.includes('restricted'))).toEqual([])
    expect(toggle).toContain('eslint-disable-next-line no-restricted-imports')
    expect(toggle.replace(/.*eslint-disable-next-line.*\n/, '')).toMatch(/import \{ Switch \} from 'react-native'/)
  })
})

describe('the list of files that still draw an outline', () => {
  it('names only files that exist and are not yet free of outlines', () => {
    for (const file of pending) {
      expect(existsSync(join(ROOT, file))).toBe(true)
      const source = readFileSync(join(ROOT, file), 'utf8')
      expect(source).toMatch(/\bborder(Top|Bottom|Left|Right)?(Width|Color):/)
    }
  })

  // A pending file is spared the outline rule and nothing else.
  it('spares a pending file the outline and not the colour', () => {
    if (pending[0]) {
      expect(said('pending outline', syntax, /No outlines/)).toBe(false)
      expect(said('pending colour', syntax, /colour from theme/)).toBe(true)
    }
  })
})
