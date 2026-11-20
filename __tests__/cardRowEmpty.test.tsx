import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, View } from 'react-native'
import { Card } from '../src/components/Card'
import { Row } from '../src/components/Row'
import { EmptyState } from '../src/components/EmptyState'
import { colors, font, radius, space, stroke } from '../src/theme'

jest.mock('../src/wallet/dollarMode', () => ({
  useAccent: () => ({ accent: '#ff7a00' }),
}))

function render(node: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(node)
  })
  return tree
}

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

// The outermost View this component rendered, rather than any View in the tree.
const box = (tree: ReactTestRenderer.ReactTestRenderer) =>
  flat(tree.root.findAllByType(View)[0]!.props.style)

const words = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(n => String(n.props.children))

const card = (props: Partial<React.ComponentProps<typeof Card>> = {}) =>
  render(
    <Card {...props}>
      <Text>inside</Text>
    </Card>,
  )

const row = (props: Partial<React.ComponentProps<typeof Row>> = {}) =>
  render(
    <Row {...props}>
      <Text>inside</Text>
    </Row>,
  )

describe('Card', () => {
  it('renders what it holds', () => {
    expect(words(card())).toContain('inside')
  })

  // What a card *is*, as opposed to what its props turn on. Asserting only the second kind lets a
  // card lose its background and become an invisible box with every case green.
  it('is a surface: a background, the card radius, and the continuous curve', () => {
    const style = box(card())
    expect(style.backgroundColor).toBe(colors.surface)
    expect(style.borderRadius).toBe(radius.lg)
    // iOS draws a squircle natively and React Native defaults to a circular corner, so a card missing
    // this one line sits visibly apart from every native surface around it.
    expect(style.borderCurve).toBe('continuous')
  })

  it('keeps being a surface at every padding, since padding is not what makes it one', () => {
    for (const padding of ['none', 'inset', 'default', 'roomy'] as const) {
      expect(box(card({ padding })).backgroundColor).toBe(colors.surface)
    }
  })

  describe('padding', () => {
    it('is 16 on every side by default', () => {
      expect(box(card()).padding).toBe(space.lg)
    })

    it('is 24 when roomy, which three of the named cards use', () => {
      expect(box(card({ padding: 'roomy' })).padding).toBe(space.xl)
    })

    // Inset and none follow, and between them they cover the most common arrangement in the app, a
    // card with no vertical padding holding rows that bring their own.
    it('is horizontal only when inset, for a card holding rows', () => {
      const style = box(card({ padding: 'inset' }))
      expect(style.paddingHorizontal).toBe(space.lg)
      expect(style.padding).toBeUndefined()
      expect(style.paddingVertical).toBeUndefined()
    })

    it('is nothing at all when none, for a card that is purely a surface', () => {
      const style = box(card({ padding: 'none' }))
      expect(style.padding).toBeUndefined()
      expect(style.paddingHorizontal).toBeUndefined()
    })
  })

  it('has no outline, since a card separates by its fill and the space around it', () => {
    expect(box(card()).borderWidth).toBeUndefined()
    expect(box(card()).borderColor).toBeUndefined()
    expect(box(card()).backgroundColor).toBe(colors.surface)
  })

  it('centres only when asked, which six of the named cards do', () => {
    expect(box(card()).alignItems).toBeUndefined()
    expect(box(card({ centered: true })).alignItems).toBe('center')
  })

  it('spaces its children only when asked', () => {
    expect(box(card()).gap).toBeUndefined()
    expect(box(card({ gap: 'md' })).gap).toBe(space.md)
  })

  it('lets the caller win, since a card is a starting point', () => {
    // With the caller's style ahead of the card's, none of this would reach the tree.
    expect(box(card({ style: { backgroundColor: 'rebeccapurple' } })).backgroundColor).toBe(
      'rebeccapurple',
    )
  })
})

describe('Row', () => {
  it('renders what it holds', () => {
    expect(words(row())).toContain('inside')
  })

  it('lays across and centres on the cross axis, which is what makes a row a row', () => {
    // Most blocks that lay out in a row agree on exactly these two and disagree on everything else,
    // which is why these are fixed and the rest are props.
    const style = box(row())
    expect(style.flexDirection).toBe('row')
    expect(style.alignItems).toBe('center')
  })

  it('keeps the physical direction, which is what React Native mirrors under RTL', () => {
    // A logical value here would break the mirroring the header, the tab bar and the drawer rely on.
    expect(box(row()).flexDirection).toBe('row')
  })

  describe('vertical padding', () => {
    // A fixed `space.md` here would silently add 12 above and below to every row that sets no
    // vertical padding at all.
    it('is nothing by default, which is what 49 of the 79 do', () => {
      expect(box(row()).paddingVertical).toBeUndefined()
    })

    it.each([
      ['tight', space.sm],
      ['default', space.md],
      ['loose', space.lg],
    ] as const)('is %s when asked', (pad, expected) => {
      expect(box(row({ pad })).paddingVertical).toBe(expected)
    })
  })

  describe('the gap', () => {
    it('is small by default, at 30 uses against 20 for medium', () => {
      expect(box(row()).gap).toBe(space.sm)
    })

    // Some rows have no gap at all, and without this a row with an icon touching its label cannot
    // be expressed.
    it('can be nothing, for an icon that touches its label', () => {
      expect(box(row({ gap: 'none' })).gap).toBeUndefined()
    })
  })

  describe('the divider', () => {
    it('is a hairline, not a 1pt border', () => {
      // On a 3x screen the difference is one physical pixel against three, which is enough to make
      // the same list read heavier on one screen than on another.
      expect(box(row({ divider: true })).borderBottomWidth).toBe(stroke.hair)
    })

    it('is drawn in the divider colour', () => {
      // A test asserting only the width passes with the line drawn in red.
      expect(box(row({ divider: true })).borderBottomColor).toBe(colors.divider)
    })

    it('is absent unless asked, so the last row of a group does not dangle one', () => {
      expect(box(row()).borderBottomWidth).toBeUndefined()
    })
  })

  it('pushes its ends apart only when asked, which twelve of the 79 do', () => {
    expect(box(row()).justifyContent).toBeUndefined()
    expect(box(row({ spread: true })).justifyContent).toBe('space-between')
  })
})

describe('EmptyState', () => {
  it('says what is not there', () => {
    expect(words(render(<EmptyState message="no contacts yet" />))).toContain('no contacts yet')
  })

  it('reads at body size, since it is the only thing on the screen when it shows', () => {
    // Every empty state reads at 16. Asserting the size is what stops the role being swapped for a
    // smaller one without anybody noticing.
    const text = flat(
      render(<EmptyState message="nothing" />).root.findAllByType(Text)[0]!.props.style,
    )
    expect(text.fontSize).toBe(font.size.base)
  })

  it('is muted and centred, which all six versions already were', () => {
    const text = flat(
      render(<EmptyState message="nothing" />).root.findAllByType(Text)[0]!.props.style,
    )
    expect(text.color).toBe(colors.textSecondary)
    expect(text.textAlign).toBe('center')
  })

  it('leaves room around itself, which two of the six had none of', () => {
    // It appears where a list would be, so with no padding it reads as a stray line at the top of the
    // screen rather than as a state.
    expect(box(render(<EmptyState message="nothing" />)).paddingVertical).toBe(space.xxl)
  })

  it('shows a way out when there is one', () => {
    // No screen passes an action, and the component says so. It exists so the first empty state
    // that should offer a next step does not grow its own arrangement for it.
    const tree = render(<EmptyState message="nothing" action={<Text>add one</Text>} />)
    expect(words(tree)).toEqual(['nothing', 'add one'])
  })

  it('shows only the message when there is no way out', () => {
    expect(words(render(<EmptyState message="nothing" />))).toEqual(['nothing'])
  })
})
