import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { Txt, roles, tones, type Role, type Tone } from '../src/components/Txt'
import { colors, font } from '../src/theme'

// Prefixed `mock` because a jest mock factory cannot reach any other outer variable, and it answers
// both ways: fixed on the orange, the dollar-wallet case would pass against a component never asking.
let mockAccent: string = colors.primary
jest.mock('../src/wallet/dollarMode', () => ({ useAccent: () => ({ accent: mockAccent }) }))

function render(node: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(node)
  })
  return tree
}

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

// Uses findAllByType rather than findByType, because the latter throws with more than one Text in
// the tree, so nesting a Txt inside another would fail these for the wrong reason.
const drawn = (tree: ReactTestRenderer.ReactTestRenderer) =>
  flat(tree.root.findAllByType(Text)[0]!.props.style)

const ROLES = Object.keys(roles) as Role[]
const TONES = Object.keys(tones) as Tone[]

beforeEach(() => {
  mockAccent = colors.primary
})

it('renders what it was given', () => {
  expect(render(<Txt>hello</Txt>).root.findAllByType(Text)[0]!.props.children).toBe('hello')
})

it('is body in the default tone unless told otherwise', () => {
  const style = drawn(render(<Txt>hello</Txt>))
  expect(style.fontSize).toBe(font.size.base)
  expect(style.color).toBe(colors.text)
})

describe('every role, rendered through the component', () => {
  // Through the component, not by reading the exported table. Asserting on the table proves it is
  // well formed and proves nothing about which line of it the component picks, so every role is
  // rendered here.
  it.each(ROLES)('%s draws its own size and weight', role => {
    const style = drawn(render(<Txt role={role}>hello</Txt>))
    expect(style.fontSize).toBe(flat(roles[role]).fontSize)
    expect(style.fontWeight).toBe(flat(roles[role]).fontWeight)
  })

  it.each(ROLES)('%s takes its size from the scale', role => {
    expect(Object.values(font.size)).toContain(flat(roles[role]).fontSize)
  })

  it('carries no colour, since colour is the other axis', () => {
    // The whole reason for the split. A role that also set a colour would multiply roles by colours
    // again, one combination for every pairing.
    for (const role of ROLES) {
      expect(flat(roles[role]).color).toBeUndefined()
    }
  })

  // Sizes at or below body wrap into paragraphs and need a leading paired with them; anything
  // larger is a heading and takes the engine's own. It is written as a requirement rather than a
  // skip, because a case that returns early when leading is absent stays green with leading removed
  // from every role.
  it.each(ROLES)('%s pairs its leading with its size, or is too large to need one', role => {
    const style = flat(roles[role])
    const size = style.fontSize as number
    if (size > font.size.base) {
      expect(style.lineHeight).toBeUndefined()
      return
    }
    const name = Object.entries(font.size).find(([, v]) => v === size)![0] as 'sm'
    expect(style.lineHeight).toBe(font.leading[name])
  })

  it('has no two roles that draw the same thing', () => {
    // The whole shape, not size and weight alone. Two roles at 14 semibold are not redundant when
    // one is uppercase with tracking and the other is not: a caller can tell them apart on screen,
    // which is the property this guards. Keyed on size and weight only, it would refuse `section`
    // for sharing those with `labelStrong` while missing an exact duplicate that differs in
    // neither.
    const shapes = ROLES.map(r => JSON.stringify(flat(roles[r])))
    expect(new Set(shapes).size).toBe(shapes.length)
  })
})

describe('every tone, rendered through the component', () => {
  it.each(TONES.filter(t => t !== 'accent' && t !== 'inherit'))('%s draws its colour', tone => {
    expect(drawn(render(<Txt tone={tone}>hello</Txt>)).color).toBe(flat(tones[tone]).color)
  })

  it('inherit sets no colour, for text inside something already coloured', () => {
    expect(drawn(render(<Txt tone="inherit">hello</Txt>)).color).toBeUndefined()
  })

  it('carries no size or weight, since typography is the other axis', () => {
    for (const tone of TONES) {
      expect(flat(tones[tone]).fontSize).toBeUndefined()
      expect(flat(tones[tone]).fontWeight).toBeUndefined()
    }
  })
})

describe('the accent tone', () => {
  it('follows the wallet', () => {
    mockAccent = colors.dollar
    expect(drawn(render(<Txt tone="accent">pay</Txt>)).color).toBe(colors.dollar)
  })

  // Applying only the colour would leave accented text with no size and no weight at all,
  // inheriting whatever sits nearby, and a case that looks only at `.color` passes that.
  it('keeps the role size and weight, at every role', () => {
    mockAccent = colors.dollar
    for (const role of ROLES) {
      const style = drawn(
        render(
          <Txt role={role} tone="accent">
            pay
          </Txt>,
        ),
      )
      expect(style.fontSize).toBe(flat(roles[role]).fontSize)
      expect(style.fontWeight).toBe(flat(roles[role]).fontWeight)
    }
  })

  it('leaves every other tone alone, whatever the wallet is', () => {
    // Not a nicety. Subscribing every piece of text to the accent would redraw the whole tree the
    // moment the dollar wallet switches on, which is the cost the split exists to avoid.
    mockAccent = colors.dollar
    expect(drawn(render(<Txt>hello</Txt>)).color).toBe(colors.text)
    expect(drawn(render(<Txt tone="muted">hello</Txt>)).color).toBe(colors.textSecondary)
  })

  it('loses to a caller that sets its own colour', () => {
    mockAccent = colors.dollar
    const tree = render(
      <Txt tone="accent" style={{ color: 'red' }}>
        pay
      </Txt>,
    )
    expect(drawn(tree).color).toBe('red')
  })
})

describe('tabular digits', () => {
  it('are off unless asked', () => {
    expect(drawn(render(<Txt>21</Txt>)).fontVariant).toBeUndefined()
  })

  it('are on when asked, which every amount in the app needs', () => {
    // Every number that needs this is money. Without it a balance jumps sideways as its digits
    // change.
    expect(drawn(render(<Txt tabular>21</Txt>)).fontVariant).toEqual(['tabular-nums'])
  })
})

describe('the line limit', () => {
  it('is off unless asked, since truncating by default hides what nobody chose to hide', () => {
    expect(render(<Txt>hello</Txt>).root.findAllByType(Text)[0]!.props.numberOfLines).toBeUndefined()
  })

  it('is one prop, which is why 335 of 352 texts have none', () => {
    const node = render(<Txt lines={2}>hello</Txt>).root.findAllByType(Text)[0]!
    expect(node.props.numberOfLines).toBe(2)
  })
})

it('lets a caller override, since a role is a starting point and not a cage', () => {
  const style = drawn(render(<Txt style={{ textAlign: 'center' }}>hello</Txt>))
  expect(style.textAlign).toBe('center')
  expect(style.fontSize).toBe(font.size.base)
})

it('passes the rest of the Text props through', () => {
  const tree = render(
    <Txt selectable accessibilityRole="header" ellipsizeMode="middle">
      hello
    </Txt>,
  )
  const node = tree.root.findAllByType(Text)[0]!
  expect(node.props.selectable).toBe(true)
  expect(node.props.accessibilityRole).toBe('header')
  // ellipsizeMode rides the passthrough rather than being folded into `lines`.
  expect(node.props.ellipsizeMode).toBe('middle')
})
