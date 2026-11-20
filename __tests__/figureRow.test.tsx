import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Dimensions, StyleSheet, View, type ViewStyle } from 'react-native'
import '../src/i18n'
import { Figure } from '../src/components/Amount'
import { FigureRow } from '../src/components/FigureRow'
import { Txt } from '../src/components/Txt'
import { formatSats } from '../src/wallet/amount'
import { figuresHeldOut, figuresIn, hostChildren, hostParent } from './support/figureFit'

function render(element: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element)
  })
  return tree
}

const start = Dimensions.get('window')
const setScale = (fontScale: number) => {
  const window = { ...start, fontScale }
  ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
}
afterEach(() => setScale(start.fontScale))

const flat = (node: ReactTestRenderer.ReactTestInstance): ViewStyle =>
  StyleSheet.flatten(node.props.style) ?? {}

// The row and its two boxes, read from the figure up, as Yoga lays them out.
function boxes(tree: ReactTestRenderer.ReactTestRenderer) {
  const [figure] = figuresIn(tree.root)
  const figureSide = hostParent(figure)!
  const row = hostParent(figureSide)!
  const [first, second] = hostChildren(row)
  const labelSide = first === figureSide ? second : first
  return { row: flat(row), figureSide: flat(figureSide), labelSide: flat(labelSide), figureFirst: first === figureSide }
}

const row = (props: Partial<React.ComponentProps<typeof FigureRow>> = {}) => (
  <FigureRow label="Você recebe" {...props}>
    <Figure>{formatSats(17_920)}</Figure>
  </FigureRow>
)

describe('FigureRow side by side', () => {
  it('lets the label grow and shrink from its own width and caps the figure without shrinking it', () => {
    const { row: r, figureSide, labelSide, figureFirst } = boxes(render(row()))
    expect(figureFirst).toBe(false)
    expect(figureSide.alignItems).toBe('flex-end')
    expect(r).toMatchObject({ flexDirection: 'row', flexShrink: 1, minWidth: 0 })
    expect(labelSide).toMatchObject({ flexGrow: 1, flexShrink: 1, minWidth: 0 })
    expect(labelSide.flexBasis).toBeUndefined()
    expect(figureSide).toMatchObject({ flexShrink: 0, minWidth: 0, maxWidth: '60%' })
  })

  it('takes a cap of the caller', () => {
    expect(boxes(render(row({ cap: '70%' }))).figureSide.maxWidth).toBe('70%')
  })

  it('draws a string label whole-word, so it wraps between words and never inside one', () => {
    const tree = render(row())
    const label = tree.root.findAllByType(Txt).find(node => node.props.children === 'Você recebe')
    expect(label?.props.wholeWords).toBe(true)
  })

  it('holds the figure in its row', () => {
    expect(figuresHeldOut(render(row()).root)).toEqual([])
  })

  it('puts the figure first when asked, at the start, and the label at the end', () => {
    const tree = render(row({ figureFirst: true }))
    const { figureFirst, figureSide, labelSide } = boxes(tree)
    expect(figureFirst).toBe(true)
    expect(figureSide.alignItems).toBeUndefined()
    expect(labelSide.alignItems).toBe('flex-end')
    expect(figuresHeldOut(tree.root)).toEqual([])
  })
})

describe('FigureRow at a large text size', () => {
  it('puts the figure under the label, each with the row to itself', () => {
    setScale(3.12)
    const { row: r, figureSide, labelSide } = boxes(render(row()))
    expect(r.flexDirection).toBe('column')
    expect(labelSide).toMatchObject({ alignSelf: 'stretch' })
    expect(figureSide).toMatchObject({ alignSelf: 'flex-start', maxWidth: '100%' })
  })

  it('keeps the figure first when it leads', () => {
    setScale(3.12)
    expect(boxes(render(row({ figureFirst: true }))).figureFirst).toBe(true)
  })

  it('holds the figure there too', () => {
    setScale(3.12)
    expect(figuresHeldOut(render(row()).root)).toEqual([])
  })

  it('regroups when the text size changes while it is shown', () => {
    const tree = render(row())
    expect(boxes(tree).row.flexDirection).toBe('row')
    setScale(3.12)
    expect(boxes(tree).row.flexDirection).toBe('column')
  })
})

describe('FigureRow beside an icon', () => {
  it('gives way in the outer row', () => {
    const tree = render(
      <View style={{ flexDirection: 'row' }}>
        <View style={{ width: 40, height: 40 }} />
        {row()}
      </View>,
    )
    expect(figuresHeldOut(tree.root)).toEqual([])
    expect(StyleSheet.flatten(tree.root.findByType(FigureRow).props.style)).toBeUndefined()
  })
})
