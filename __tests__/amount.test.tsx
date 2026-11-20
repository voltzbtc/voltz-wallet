import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, View } from 'react-native'
import { Amount, Figure } from '../src/components/Amount'
import { roles as txt } from '../src/components/Txt'
import { colors, font, space } from '../src/theme'

// The hex is written out rather than imported: a jest mock factory cannot reach any variable from
// the module scope, and nothing here asserts on this value.
jest.mock('../src/wallet/dollarMode', () => ({ useAccent: () => ({ accent: '#ff7a00' }) }))

function render(node: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(node)
  })
  return tree
}

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

// The strings drawn, span by span, leaving out the space that joins the value to its unit.
const words = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
  tree.root
    .findAllByType(Text)
    .flatMap(n => [n.props.children].flat())
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)

const sizeOf = (tree: ReactTestRenderer.ReactTestRenderer, text: string): number =>
  flat(tree.root.findAll(n => n.props.children === text && n.props.style).at(-1)!.props.style)
    .fontSize as number

it('shows the value and the unit', async () => {
  expect(words(render(<Amount value="1.234" unit="sats" />))).toEqual(['1.234', 'sats'])
})

it('shows the unit it was given, and never one it assumed', () => {
  // The reason this is a component. The SDK denominates a token in its own base units and bitcoin
  // in sats, so a token amount rendered as sats is off by five orders of magnitude and looks
  // entirely plausible.
  expect(words(render(<Amount value="10.000000" unit="USDB" />))).toContain('USDB')
  expect(words(render(<Amount value="10.000000" unit="USDB" />))).not.toContain('sats')
})

it('draws the unit smaller than the number, at every size', () => {
  // A bare ` sats` string beside a hero number reinvents the pairing at every call site, so the
  // pairing lives here and the unit is always the smaller of the two.
  for (const role of ['display', 'title', 'heading', 'bodyBold', 'labelStrong'] as const) {
    const tree = render(<Amount value="21" unit="sats" role={role} />)
    expect(sizeOf(tree, 'sats')).toBeLessThan(sizeOf(tree, '21'))
  }
})

it('uses the role it was given for the number', () => {
  expect(sizeOf(render(<Amount value="21" unit="sats" role="display" />), '21')).toBe(
    flat(txt.display).fontSize,
  )
})

// One paragraph puts the unit on the number's baseline and keeps the two on one line. As two boxes
// in a row, the largest text size broke "R$ 76,61" across three lines and pushed the unit off.
it('draws the value and its unit as one line of text that shrinks to fit', () => {
  for (const role of ['display', 'titleLarge', 'title', 'heading', 'bodyBold', 'labelStrong'] as const) {
    const tree = render(<Amount value="21 000" unit="sats" fiat="R$ 12,00" role={role} />)
    const line = tree.root
      .findAllByType(Text)
      .find(n => n.findAllByType(Text).filter(inner => inner !== n).length === 2)!
    const spans = line.findAllByType(Text).filter(inner => inner !== line)
    expect(spans.map(n => n.props.children)).toEqual(['21 000', 'sats'])
    expect(line.props.numberOfLines).toBe(1)
    expect(line.props.adjustsFontSizeToFit).toBe(true)
    const fiat = tree.root.findAllByType(Text).find(n => n.props.children === 'R$ 12,00')!
    expect(fiat.props.numberOfLines).toBe(1)
    expect(fiat.props.adjustsFontSizeToFit).toBe(true)
  }
})

// iOS shrinks a figure until its text rect fits the frame, and a fixed line height never lets that
// rect fall, so a frame a rounding error under the line drew the conversion line at the 4pt floor.
describe('the line of a figure on iOS', () => {
  const box = (node: React.JSX.Element) =>
    flat(render(node).root.findAllByType(Text).at(-1)!.props.style) as { lineHeight: number; minHeight: number }

  it('keeps the line under the box, so the text always fits the box in height', () => {
    const { lineHeight, minHeight } = box(<Figure role="label">≈ 99 sats</Figure>)
    expect(lineHeight).toBeLessThan(minHeight)
  })

  it('holds the height of the leading the role gives it', () => {
    expect(box(<Figure role="label">≈ 99 sats</Figure>).minHeight).toBe(font.leading.sm)
    expect(box(<Figure role="caption" style={{ lineHeight: font.leading.lg }}>1</Figure>).minHeight).toBe(
      font.leading.lg,
    )
  })

  it('leaves a role with no leading to the engine, whose line shrinks with the type', () => {
    const style = flat(render(<Figure role="display">1</Figure>).root.findAllByType(Text).at(-1)!.props.style)
    expect(style.lineHeight).toBeUndefined()
    expect(style.minHeight).toBeUndefined()
  })
})

describe('the fiat line', () => {
  it('is absent unless given, since most places show only the amount', () => {
    expect(words(render(<Amount value="21" unit="sats" />))).toHaveLength(2)
  })

  it('appears under the amount when given', () => {
    expect(words(render(<Amount value="21" unit="sats" fiat="R$ 12,00" />))).toEqual([
      '21',
      'sats',
      'R$ 12,00',
    ])
  })

  it('is quieter than the amount, being the secondary reading', () => {
    const tree = render(<Amount value="21" unit="sats" fiat="R$ 12,00" />)
    expect(sizeOf(tree, 'R$ 12,00')).toBeLessThanOrEqual(sizeOf(tree, '21'))
  })
})

describe('the hero, measured against the two blocks it replaces', () => {
  // RedeemSpark and SendSpark draw the largest number in the app: 40pt bold, a 24pt semibold unit
  // in the secondary colour, and an 18pt fiat line in the same colour. The relative assertions
  // above also pass with the unit at 20 and the fiat at 14, so these pin the sizes those two
  // screens actually use.
  const hero = () =>
    render(<Amount value="21 000" unit="sats" fiat="R$ 12.345,67" role="display" />)

  const styleOf = (tree: ReactTestRenderer.ReactTestRenderer, text: string) =>
    flat(tree.root.findAllByType(Text).find(n => String(n.props.children) === text)!.props.style)

  it('draws the unit at 24, which is what both screens draw', () => {
    expect(styleOf(hero(), 'sats').fontSize).toBe(font.size.xxl)
  })

  it('draws the fiat line at 18, not at caption size', () => {
    expect(styleOf(hero(), 'R$ 12.345,67').fontSize).toBe(font.size.lg)
  })

  it('mutes both, since the figure is the value and the rest says what it is measured in', () => {
    expect(styleOf(hero(), 'sats').color).toBe(colors.textSecondary)
    expect(styleOf(hero(), 'R$ 12.345,67').color).toBe(colors.textSecondary)
    expect(styleOf(hero(), '21 000').color).toBe(colors.text)
  })

  it('scales the fiat line down with the value, so a list row is not topped by a larger currency', () => {
    const row = render(<Amount value="21" unit="sats" fiat="R$ 12,00" role="bodyBold" />)
    expect(styleOf(row, 'R$ 12,00').fontSize).toBeLessThan(styleOf(row, '21').fontSize as number)
  })

  it('spaces the two lines with the scale, which the blocks it replaces do at space.sm', () => {
    const wrap = flat(hero().root.findAllByType(View)[0]!.props.style)
    expect(wrap.gap).toBe(space.sm)
  })
})

describe('the tone, and the four hero blocks it has to cover', () => {
  // Two review screens draw a white value with a grey unit; two balance screens draw both in the
  // wallet accent. Fixing the unit to muted would grey the accent on the two largest numbers in the
  // app, and fixing it to follow the value would whiten the unit on the two review screens.
  const styleOf = (tree: ReactTestRenderer.ReactTestRenderer, text: string) =>
    flat(tree.root.findAllByType(Text).find(n => String(n.props.children) === text)!.props.style)

  it('draws a neutral figure white with a muted unit, which is the review screens', () => {
    const tree = render(<Amount value="21" unit="sats" role="display" />)
    expect(styleOf(tree, '21').color).toBe(colors.text)
    expect(styleOf(tree, 'sats').color).toBe(colors.textSecondary)
  })

  it('carries the unit into the accent, which is the two balance screens', () => {
    const tree = render(<Amount value="21" unit="sats" role="display" tone="accent" />)
    expect(styleOf(tree, '21').color).toBe(colors.primary)
    expect(styleOf(tree, 'sats').color).toBe(colors.primary)
  })

  it('leaves the currency line muted either way, since no block colours it', () => {
    for (const tone of ['default', 'accent'] as const) {
      const tree = render(
        <Amount value="21" unit="sats" fiat="R$ 1,00" role="display" tone={tone} />,
      )
      expect(styleOf(tree, 'R$ 1,00').color).toBe(colors.textSecondary)
    }
  })
})

it('has a role at every size step, so a balance never has to pick the wrong one', () => {
  // The asset balance draws at 28, and without a role there it would be forced to 24 or to 40 with
  // nobody deciding.
  expect(flat(txt.titleLarge).fontSize).toBe(font.size.xxxl)
})

it('has a unit and a currency role for every size it accepts', () => {
  // A role that exists in Txt but not in these tables leaves the asset balance screen with no unit
  // or currency entry waiting for it.
  const roles = ['display', 'titleLarge', 'title', 'heading', 'bodyBold', 'labelStrong'] as const
  for (const role of roles) {
    const tree = render(<Amount value="21" unit="sats" fiat="R$ 1,00" role={role} />)
    // The value, the unit and the currency line; the paragraph holding the first two has a size too.
    const sizes = tree.root
      .findAllByType(Text)
      .filter(n => typeof n.props.children === 'string')
      .map(n => flat(n.props.style).fontSize)
    expect(sizes).toHaveLength(3)
    expect(sizes.every(size => typeof size === 'number')).toBe(true)
  }
})

it('draws the asset balance at its own size, between the two the ladder had', () => {
  const tree = render(<Amount value="21" unit="USDB" fiat="R$ 1,00" role="titleLarge" />)
  const sizeOf = (text: string) =>
    flat(tree.root.findAllByType(Text).find(n => String(n.props.children) === text)!.props.style)
      .fontSize
  expect(sizeOf('21')).toBe(font.size.xxxl)
  expect(sizeOf('USDB')).toBe(font.size.xl)
  expect(sizeOf('R$ 1,00')).toBe(font.size.lg)
})

it('draws the currency line one weight heavier than the blocks it replaces, on purpose', () => {
  // The four hero blocks are 18pt medium and this is 18pt semibold. Written down as a decision so it
  // cannot drift back, and so the next person finds a reason rather than a discrepancy.
  const tree = render(<Amount value="21" unit="sats" fiat="R$ 1,00" role="display" />)
  const style = flat(
    tree.root.findAllByType(Text).find(n => String(n.props.children) === 'R$ 1,00')!.props.style,
  )
  expect(style.fontSize).toBe(font.size.lg)
  expect(style.fontWeight).toBe(font.family.semibold.fontWeight)
})
