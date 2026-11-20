import { colors } from '../src/theme'

// The two soft fills sit behind a warning and an error, and each is the same design idea: a colour
// at low strength over the ground. Equal alpha is not equal appearance, since hues differ in how
// dark they read at the same strength, so this compares what the eye gets, which is the composited
// luminance.
const channel = (c: number): number => {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

// Over pure black, so the composite is just the colour scaled by its alpha.
function luminanceOverGround(rgba: string): number {
  const [r, g, b, a] = rgba.match(/[\d.]+/g)!.map(Number) as [number, number, number, number]
  return 0.2126 * channel(r * a) + 0.7152 * channel(g * a) + 0.0722 * channel(b * a)
}

type Rgb = [number, number, number]
const hex = (value: string): Rgb => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) as Rgb
function fill(rgba: string, under: Rgb): Rgb {
  const [r, g, b, a] = rgba.match(/[\d.]+/g)!.map(Number) as [number, number, number, number]
  return [r, g, b].map((c, i) => c * a + under[i]! * (1 - a)) as Rgb
}
const luminance = ([r, g, b]: Rgb): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

// With no outline the fill is all a warning or an error has. These are the figures that say it holds
// the state: it stands off the ground, off a sheet, off the card it may sit on and off a neutral card
// beside it, and what is written on it stays readable. A device can still overrule them, since the
// fill is translucent and a phone's panel is not this arithmetic.
describe.each([
  ['warning', colors.primarySoft],
  ['danger', colors.dangerSoft],
])('the %s fill', (_name, soft) => {
  const ground = hex(colors.background)
  const card = hex(colors.surface)
  const sheet = hex(colors.sheet)

  it('reads against what it sits on', () => {
    expect(contrast(fill(soft, ground), ground)).toBeGreaterThan(1.3)
    expect(contrast(fill(soft, sheet), sheet)).toBeGreaterThan(1.3)
    expect(contrast(fill(soft, card), card)).toBeGreaterThan(1.3)
  })

  it('does not pass for a neutral card beside it', () => {
    expect(contrast(fill(soft, ground), card)).toBeGreaterThan(1.09)
  })

  it('keeps the text on it readable', () => {
    for (const under of [ground, sheet, card]) {
      expect(contrast(hex(colors.text), fill(soft, under))).toBeGreaterThan(4.5)
      expect(contrast(hex(colors.textSecondary), fill(soft, under))).toBeGreaterThan(4.4)
    }
  })
})

// An error box is drawn on a page or a sheet. On a card its red caption would fall to about 4:1.
it('keeps red text readable on the error fill, on a page and on a sheet', () => {
  for (const under of [hex(colors.background), hex(colors.sheet)]) {
    expect(contrast(hex(colors.danger), fill(colors.dangerSoft, under))).toBeGreaterThan(4.5)
  }
})

it('steps a focused field by a visible amount, and the caret stays readable on it', () => {
  const rest = hex(colors.surfaceVariant)
  const focus = hex(colors.surfaceRaised)
  expect(contrast(focus, rest)).toBeGreaterThan(1.15)
  expect(contrast(hex(colors.primary), focus)).toBeGreaterThan(4.5)
  expect(contrast(hex(colors.dollar), focus)).toBeGreaterThan(1.5)
})

it('paints the ground with the same strength behind a warning and an error', () => {
  expect(colors.background).toBe('#000000')
  const soft = [colors.primarySoft, colors.dangerSoft].map(luminanceOverGround)
  const spread = Math.max(...soft) - Math.min(...soft)
  // Within a fifth of the dimmer one, which the two sit inside.
  expect(spread).toBeLessThan(Math.min(...soft) * 0.2)
})
