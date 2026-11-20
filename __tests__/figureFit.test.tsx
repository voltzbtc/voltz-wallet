import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Dimensions, StyleSheet, View, type TextStyle, type ViewStyle } from 'react-native'
import '../src/i18n'
import { Amount, Figure } from '../src/components/Amount'
import { Row } from '../src/components/Row'
import { FigureRow } from '../src/components/FigureRow'
import { Txt } from '../src/components/Txt'
import { SendBalance } from '../src/components/SendBalance'
import { TransactionDetailSheet } from '../src/components/TransactionDetailSheet'
import { formatSats } from '../src/wallet/amount'
import { touch } from '../src/theme'
import type { HistoryItem } from '../src/wallet/payment'
import { figuresHeldOut, figuresIn, hostChildren } from './support/figureFit'

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

// Checked before the callers, since a check that cannot see a figure held out of its row makes every
// pass below mean nothing.
describe('the check for a figure held out of its row', () => {
  it('passes a figure whose row is laid out by FigureRow, side by side and stacked', () => {
    const row = (
      <FigureRow label="Total">
        <Figure>{formatSats(17_920)}</Figure>
      </FigureRow>
    )
    expect(figuresHeldOut(render(row).root)).toEqual([])
    setScale(3.12)
    expect(figuresHeldOut(render(row).root)).toEqual([])
  })

  it('passes a figure beside a box of a fixed size', () => {
    const tree = render(
      <Row>
        <View style={{ width: 40, height: 40 }} />
        <Figure>{formatSats(17_920)}</Figure>
      </Row>,
    )
    expect(figuresHeldOut(tree.root)).toEqual([])
  })

  // At the largest text size a label that keeps its width leaves the figure beside it a few points.
  it('reports a figure beside a label that keeps its width', () => {
    const tree = render(
      <Row>
        <Txt>Total</Txt>
        <Figure>{formatSats(17_920)}</Figure>
      </Row>,
    )
    expect(figuresHeldOut(tree.root)).toEqual([formatSats(17_920)])
  })

  // Shrinking from its own width, a long label shrinks in step with the figure and still takes most
  // of the row.
  it('reports a figure beside a label that shrinks with it from its own width', () => {
    const tree = render(
      <Row>
        <Txt style={{ flexShrink: 1 }}>Total</Txt>
        <Figure>{formatSats(17_920)}</Figure>
      </Row>,
    )
    expect(figuresHeldOut(tree.root)).toEqual([formatSats(17_920)])
  })

  // A figure beside its copy mark is fine in that row; the label beside the pair is what holds out.
  it('reports a label beside a row that holds the figure', () => {
    const tree = render(
      <Row>
        <Txt>Exact amount to send</Txt>
        <Row style={{ flexShrink: 1, minWidth: 0 }}>
          <Figure>{formatSats(17_920)}</Figure>
          <View style={{ width: 14, height: 14 }} />
        </Row>
      </Row>,
    )
    expect(figuresHeldOut(tree.root)).toEqual([formatSats(17_920)])
  })

  it('reports a figure behind a box that keeps its width', () => {
    const tree = render(
      <Row>
        <View style={{ width: 40, height: 40 }} />
        <View>
          <Figure>{formatSats(17_920)}</Figure>
        </View>
      </Row>,
    )
    expect(figuresHeldOut(tree.root)).toEqual([formatSats(17_920)])
  })

  // Beside a figure side that is capped and never shrinks, every point the row lacks comes out of a
  // shrinking label. Beside a side that shrinks too, the two shrink in step and the label keeps most.
  it('reports a shrinking label beside a figure side that shrinks too, though capped', () => {
    const beside = (side: ViewStyle) =>
      figuresHeldOut(
        render(
          <Row>
            <Txt style={{ flexShrink: 1, minWidth: 0 }}>Total</Txt>
            <View style={[{ minWidth: 0, maxWidth: '60%' }, side]}>
              <Figure>{formatSats(17_920)}</Figure>
            </View>
          </Row>,
        ).root,
      )
    expect(beside({ flexShrink: 0 })).toEqual([])
    expect(beside({ flexShrink: 1 })).toEqual([formatSats(17_920)])
  })

  // A floor holds the label at that width however little room the row has.
  it('reports a shrinking label that has a floor', () => {
    const label = (style: TextStyle) =>
      figuresHeldOut(
        render(
          <Row>
            <Txt style={style}>Total</Txt>
            <View style={{ flexShrink: 0, minWidth: 0, maxWidth: '60%' }}>
              <Figure>{formatSats(17_920)}</Figure>
            </View>
          </Row>,
        ).root,
      )
    expect(label({ flexShrink: 1, minWidth: 0 })).toEqual([])
    expect(label({ flexShrink: 1, minWidth: 120 })).toEqual([formatSats(17_920)])
  })

  // A cap of the whole row bounds nothing beside the figure.
  it('reports a label capped at the whole row, and passes one capped at a share of it', () => {
    const capped = (maxWidth: `${number}%`) =>
      figuresHeldOut(
        render(
          <Row>
            <Txt style={{ maxWidth }}>Total</Txt>
            <Figure>{formatSats(17_920)}</Figure>
          </Row>,
        ).root,
      )
    expect(capped('40%')).toEqual([])
    expect(capped('100%')).toEqual([formatSats(17_920)])
  })

  // A box between the figure and its row gives way only down to its floor, and a floor wider than a
  // touch target can hold the figure past the row's edge.
  it('reports a figure behind a box whose floor is wider than a touch target', () => {
    const floor = (minWidth: number) =>
      figuresHeldOut(
        render(
          <Row>
            <View style={{ width: 40, height: 40 }} />
            <View style={{ flexShrink: 1, minWidth }}>
              <Figure>{formatSats(17_920)}</Figure>
            </View>
          </Row>,
        ).root,
      )
    expect(floor(touch.min)).toEqual([])
    expect(floor(touch.min + 1)).toEqual([formatSats(17_920)])
  })

  it('reports a tree with no figure in it rather than passing it', () => {
    expect(figuresHeldOut(render(<Txt>{formatSats(1)}</Txt>).root)).toEqual(['no money figure was drawn'])
  })
})

// The primitive owns the rule, so every caller gets it by drawing a figure through it.
describe('Figure', () => {
  it('is one line that shrinks to fit and gives way in a row', () => {
    const [figure] = figuresIn(render(<Figure>{formatSats(5)}</Figure>).root)
    expect(StyleSheet.flatten(figure.props.style)).toMatchObject({ flexShrink: 1, minWidth: 0 })
  })

  it('keeps the rule when a caller passes its own style', () => {
    const [figure] = figuresIn(render(<Figure style={{ marginTop: 4 }}>{formatSats(5)}</Figure>).root)
    expect([figure.props.numberOfLines, figure.props.adjustsFontSizeToFit]).toEqual([1, true])
    expect(StyleSheet.flatten(figure.props.style)).toMatchObject({ flexShrink: 1, marginTop: 4 })
  })

  it('gives way inside Amount, whose block sits in a row beside a label', () => {
    const tree = render(
      <FigureRow label="Balance">
        <Amount value={formatSats(17_920)} unit="sats" fiat="$12.00" />
      </FigureRow>,
    )
    expect(figuresIn(tree.root)).toHaveLength(2)
    expect(figuresHeldOut(tree.root)).toEqual([])
  })
})

// Each row kept the figure at flexShrink 0 beside a name or label that keeps its width, so the
// figure was laid out past the row's edge and cut rather than shrunk.
describe('the callers', () => {

  it('the Send balance gives its figure the row', () => {
    const tree = render(<SendBalance balanceSat={17_920} sync="synced" />)
    expect(figuresHeldOut(tree.root)).toEqual([])
  })

  it('the Send balance puts the figure under the name at a large text size', () => {
    setScale(3.12)
    const tree = render(<SendBalance balanceSat={17_920} sync="synced" />)
    const [row] = tree.root.findAllByType(FigureRow)
    expect(StyleSheet.flatten(hostChildren(row)[0].props.style)).toMatchObject({ flexDirection: 'column' })
    expect(figuresIn(row)).toHaveLength(1)
  })

  it('a transaction detail draws its headline, fee and total as figures', async () => {
    const sent: HistoryItem = {
      id: 's1',
      direction: 'sent',
      status: 'complete',
      amountSat: 17_920,
      feesSat: 31,
      timestamp: 1_700_000_300,
      method: 'lightning',
      asset: null,
    }
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<TransactionDetailSheet item={sent} onClose={() => undefined} />)
    })
    expect(figuresIn(tree.root)).toHaveLength(3)
    expect(figuresHeldOut(tree.root)).toEqual([])
  })

  it('a transaction detail puts the fee under its label at a large text size', async () => {
    setScale(3.12)
    const sent: HistoryItem = {
      id: 's1',
      direction: 'sent',
      status: 'complete',
      amountSat: 17_920,
      feesSat: 31,
      timestamp: 1_700_000_300,
      method: 'lightning',
      asset: null,
    }
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<TransactionDetailSheet item={sent} onClose={() => undefined} />)
    })
    const rows = tree.root.findAllByType(FigureRow).filter(row => figuresIn(row).length > 0)
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(StyleSheet.flatten(hostChildren(row)[0].props.style)).toMatchObject({ flexDirection: 'column' })
    }
    // A value other than a figure has the row to itself there, so it wraps rather than being cut.
    const date = tree.root
      .findAllByType(Txt)
      .find(node => String(node.props.children).includes('·'))
    expect(date?.props.lines).toBeUndefined()
  })
})
