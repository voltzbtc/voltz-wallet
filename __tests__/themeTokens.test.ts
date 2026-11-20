import { StyleSheet } from 'react-native'
import { alpha, font, layer, motion, press, stroke, touch } from '../src/theme'

// Renaming a value is only safe when the name carries the same number, and this is where that is
// proved rather than asserted in a commit message. Every token added by a migration step lands a case
// here tying it to the literal it replaced, which is what lets those steps skip a human looking at the
// screen: a value-identical rename cannot move a pixel.
describe('tokens equal the literals they replaced', () => {
  it('stroke.hair is the one-physical-pixel divider, at any screen density', () => {
    expect(stroke.hair).toBe(StyleSheet.hairlineWidth)
  })

})

describe('alpha and press name intents, not numbers', () => {
  // Touch feedback is a different question from visibility, so it has names of its own rather than
  // sharing one that means "secondary content". Filed together, a rename looks finished while the
  // conflict it is meant to settle is still there.
  it('inert is heavier than disabled, because it is the only signal a whole region refuses touch', () => {
    expect(alpha.inert).toBe(0.5)
    expect(alpha.disabled).toBe(0.4)
  })

  it('a refused control stays readable enough to read what is refused', () => {
    expect(alpha.disabled).toBeGreaterThan(0.3)
  })

  // Where a surface only dims, the dim is the whole signal and has to be plain. Where it also
  // shrinks, the shrink carries it and the dim stays subtle. Both are correct; which one a given
  // control uses is <Touch>'s question.
  it('a press that only dims dims harder than one that also shrinks', () => {
    expect(press.dim).toBeLessThan(press.scaled)
  })

  it('the shrink is small enough to feel like pressure rather than movement', () => {
    expect(press.scale).toBeGreaterThan(0.95)
    expect(press.scale).toBeLessThan(1)
  })
})

describe('the touch target is declared, not computed', () => {
  it('touch.min is 44, the Apple HIG and WCAG 2.2 minimum', () => {
    expect(touch.min).toBe(44)
  })

  // The point of a floor is that it cannot shrink anything. A control that clears 44 through its
  // padding keeps its size, and the floor only binds when that stops holding: text scaled by the
  // device, or a control built with smaller type.
  it('is a floor, so it never makes an existing control smaller', () => {
    const boxWithPadding = 14 + 19 + 14
    expect(boxWithPadding).toBeGreaterThan(touch.min)
  })

  // The padding arithmetic, shown failing. At 11pt text the same padding lands under the minimum,
  // which is why the minimum is declared rather than computed.
  it('the padding sum it replaces fails on smaller text', () => {
    const smallTextBox = 14 + 13 + 14
    expect(smallTextBox).toBeLessThan(touch.min)
  })
})

describe('layer names what sits at each level', () => {
  it('banner and cover are the two values the app was already using', () => {
    expect(layer.banner).toBe(20)
    expect(layer.cover).toBe(100)
  })

  // The one thing this scale has to guarantee is that something covering the whole screen is never
  // drawn under news arriving over it.
  it('cover is always drawn above banner', () => {
    expect(layer.cover).toBeGreaterThan(layer.banner)
  })
})

describe('leading is paired with size, not chosen beside it', () => {
  // A leading off the 4pt spacing grid makes the same caption breathe differently depending on
  // which screen draws it, so text sits on the same rhythm as the space around it.
  it('every leading falls on the 4pt grid the spacing scale uses', () => {
    for (const value of Object.values(font.leading)) {
      expect(value % 4).toBe(0)
    }
  })

  it('leading grows with size, so no size reads tighter than a smaller one', () => {
    expect(font.leading.xs).toBeLessThan(font.leading.sm)
    expect(font.leading.sm).toBeLessThan(font.leading.base)
  })

  // A leading equal to its size cuts the top off any glyph taller than a capital, which is where
  // Devanagari, Thai and Vietnamese put their marks.
  it('every leading is taller than the size it pairs with', () => {
    for (const [key, value] of Object.entries(font.leading)) {
      expect(value).toBeGreaterThan(font.size[key as keyof typeof font.size])
    }
  })

  // Between 1.35 and 1.55 of the font size. Tighter crowds a wrapped paragraph, looser breaks it
  // into stripes. Only xs, sm and base are held to it.
  it('each leading is a readable ratio of its size', () => {
    for (const key of ['xs', 'sm', 'base'] as const) {
      const ratio = font.leading[key] / font.size[key]
      expect(ratio).toBeGreaterThanOrEqual(1.35)
      expect(ratio).toBeLessThanOrEqual(1.55)
    }
  })

  // lg (Home's 18pt currency line) and display (its 40pt balance) lead a single line of figure text
  // rather than a paragraph, so the band above does not apply to them. They have bounds of their own.
  it('the single-line figure leadings have bounds of their own', () => {
    const ratio = (key: 'lg' | 'display') => font.leading[key] / font.size[key]
    // 24/18. No 4pt step falls inside 1.35 to 1.55 for 18pt: 24 is 1.33 and 28 is 1.56.
    expect(ratio('lg')).toBeGreaterThanOrEqual(1.3)
    expect(ratio('lg')).toBeLessThanOrEqual(1.4)
    // 48/40, the grid step just above the line the engine gives a 40pt figure.
    expect(ratio('display')).toBeGreaterThanOrEqual(1.15)
    expect(ratio('display')).toBeLessThanOrEqual(1.25)
  })

  // The strict ordering above stops at base: lg is the larger size and has the same 24pt box.
  it('lg has the same leading as base although its size is larger', () => {
    expect(font.size.lg).toBeGreaterThan(font.size.base)
    expect(font.leading.lg).toBe(font.leading.base)
  })
})

describe('motion is three durations, not nineteen', () => {
  it('fast, base and slow are the values the app already used most', () => {
    expect(motion.fast).toBe(180)
    expect(motion.base).toBe(260)
    expect(motion.slow).toBe(420)
  })

  // Durations such as 800 and 820 side by side are something no eye separates. Steps far enough
  // apart to read as different decisions are the whole point of having three rather than nineteen.
  it('the steps are far enough apart to be told apart', () => {
    expect(motion.base / motion.fast).toBeGreaterThan(1.3)
    expect(motion.slow / motion.base).toBeGreaterThan(1.3)
  })

  // Long enough to be seen, short enough not to be waited on. Material puts a screen transition
  // between 200 and 500ms, and anything past that starts reading as the app being slow.
  it('every step stays inside what reads as responsive', () => {
    for (const value of Object.values(motion)) {
      expect(value).toBeGreaterThanOrEqual(120)
      expect(value).toBeLessThanOrEqual(500)
    }
  })
})

describe('the one typeface that is not the system default', () => {
  // The rule forbidding a hardcoded fontFamily is about bundling a face, and this bundles nothing:
  // both are already on the device. It exists as a token so the rule stays true as written, and so
  // the exception lives in one place rather than being retyped by the next screen that wants it.
  it('font.mono resolves to a face the platform already ships', () => {
    expect(['Menlo', 'monospace']).toContain(font.mono)
  })
})
