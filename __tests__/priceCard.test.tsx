import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Dimensions, StyleSheet, Text, View } from 'react-native'
import { figuresHeldOut, figuresIn, hostParent, textOf } from './support/figureFit'
import { FigureRow } from '../src/components/FigureRow'
import { Path } from 'react-native-svg'
import '../src/i18n'
import { PriceCard } from '../src/components/PriceCard'
import type { PricePoint } from '../src/wallet/price'
import { colors } from '../src/theme'
import { getCurrencies } from 'react-native-localize'
import { setLocalCurrency } from '../src/wallet/fiat'

// Labels come from the app fallback locale (en-US) while dates follow the prefs passed in.
const prefs = { locale: 'pt-BR', use24Hour: true }

const rising: PricePoint[] = [
  { t: 1_786_000_000_000, v: 300_000 },
  { t: 1_786_050_000_000, v: 310_000 },
  { t: 1_786_100_000_000, v: 330_000 },
]
const falling: PricePoint[] = [
  { t: 1_786_000_000_000, v: 330_000 },
  { t: 1_786_050_000_000, v: 320_000 },
  { t: 1_786_100_000_000, v: 300_000 },
]

function render(props: Partial<React.ComponentProps<typeof PriceCard>> = {}) {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <PriceCard
        points={rising}
        spot={330_000}
        currency="BRL"
        name="Bitcoin"
        period="1D"
        onPeriodChange={jest.fn()}
        loading={false}
        prefs={prefs}
        {...props}
      />,
    )
  })
  return tree
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

// Nothing is measured under jest, so onLayout has to be fired by hand before any geometry exists.
function layout(tree: ReactTestRenderer.ReactTestRenderer, width = 300): void {
  const view = tree.root.findAll(
    node => node.type === View && typeof node.props.onLayout === 'function',
  )[0]
  ReactTestRenderer.act(() => view.props.onLayout({ nativeEvent: { layout: { width } } }))
}

// PanResponder derives its centroid from touchHistory, and an empty touchBank crashes inside RN
// before the component handler ever runs.
function touch(x: number) {
  const bank = {
    touchActive: true,
    startPageX: x,
    startPageY: 0,
    startTimeStamp: 1,
    currentPageX: x,
    currentPageY: 0,
    currentTimeStamp: 1,
    previousPageX: x,
    previousPageY: 0,
    previousTimeStamp: 1,
  }
  return {
    nativeEvent: {
      locationX: x,
      pageX: x,
      pageY: 0,
      identifier: 0,
      target: 1,
      timestamp: 1,
      touches: [{ identifier: 0, pageX: x, pageY: 0, locationX: x, timestamp: 1 }],
      changedTouches: [],
    },
    touchHistory: {
      touchBank: [bank],
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: 1,
    },
  }
}

// The chart view owns both the layout callback and the scrub responder.
function chartView(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    node => node.type === View && typeof node.props.onLayout === 'function',
  )[0]
}

describe('price and change', () => {
  it('shows the spot price in the display currency and the period move', () => {
    const shown = texts(render())

    expect(shown).toContain('R$330,000.00')
    expect(shown).toContain('+10.00%')
  })

  // A bare $ is the reader's own dollar, so the price and the chart's label carry it only at home.
  it('writes a USD price with a bare $ on a US device and with US$ on an Australian one', () => {
    const spoken = (tree: ReactTestRenderer.ReactTestRenderer): string => chartView(tree).props.accessibilityLabel
    try {
      setLocalCurrency(['USD'])
      const home = render({ currency: 'USD' })
      expect(texts(home)).toContain('$330,000.00')
      expect(spoken(home)).toContain('$330,000.00')
      expect(spoken(home)).not.toContain('US$')

      setLocalCurrency(['AUD'])
      const away = render({ currency: 'USD' })
      expect(texts(away)).toContain('US$330,000.00')
      expect(texts(away)).not.toContain('$330,000.00')
      expect(spoken(away)).toContain('US$330,000.00')
    } finally {
      // The same read src/i18n made when it loaded, so this puts back what the boot set.
      setLocalCurrency(getCurrencies())
    }
  })

  it('labels the asset and currency while nothing is being scrubbed', () => {
    expect(texts(render())).toContain('Bitcoin · BRL')
  })

  // U+2212, as wide as the plus; a hyphen reads as a dash beside a figure.
  it('signs a fall as negative, with the minus sign', () => {
    const shown = texts(render({ points: falling, spot: 300_000 }))
    expect(shown).toContain('\u22129.09%')
    expect(shown).not.toContain('-9.09%')
  })
})

describe('semantic colors', () => {
  it('draws the line green when the period rose', () => {
    const tree = render()
    layout(tree)

    const line = tree.root.findAllByType(Path).find(node => node.props.stroke !== undefined)
    expect(line?.props.stroke).toBe(colors.success)
  })

  it('draws it red when the period fell', () => {
    const tree = render({ points: falling, spot: 300_000 })
    layout(tree)

    const line = tree.root.findAllByType(Path).find(node => node.props.stroke !== undefined)
    expect(line?.props.stroke).toBe(colors.danger)
  })

  // 300 000 to 299 990 is a fall of 0.0033%, drawn as 0.00, so it reads as no change, never a red minus.
  it('a fall too small to draw reads as no change', () => {
    const flat: PricePoint[] = [
      { t: 1_786_000_000_000, v: 300_000 },
      { t: 1_786_100_000_000, v: 299_990 },
    ]
    const tree = render({ points: flat, spot: 299_990 })
    layout(tree)

    expect(texts(tree)).toContain('+0.00%')
    const line = tree.root.findAllByType(Path).find(node => node.props.stroke !== undefined)
    expect(line?.props.stroke).toBe(colors.success)
  })
})

describe('missing curve', () => {
  it('says the chart is unavailable when there is no series', () => {
    const tree = render({ points: [] })
    expect(texts(tree)).toContain('Chart unavailable')
  })

  it('still shows the price: the card survives its own chart', () => {
    expect(texts(render({ points: [] }))).toContain('R$330,000.00')
  })

  it('says nothing about availability while loading', () => {
    expect(texts(render({ points: [], loading: true }))).not.toContain('Chart unavailable')
  })

  it('states no variation at all when there is no curve to measure one', () => {
    // An empty series yields 0 from periodChange, which would render a green +0.00% beside the
    // unavailable message and announce that invented move to the screen reader.
    const shown = texts(render({ points: [] }))
    expect(shown.some(text => text.includes('%'))).toBe(false)
  })

  it('states no variation while the curve is still loading', () => {
    const shown = texts(render({ points: [], loading: true }))
    expect(shown.some(text => text.includes('%'))).toBe(false)
  })

  it('announces price without a change when there is no curve', () => {
    const tree = render({ points: [] })
    const chart = chartView(tree)

    expect(chart.props.accessibilityLabel).toContain('R$330,000.00')
    expect(chart.props.accessibilityLabel).not.toContain('%')
  })

  it('says nothing about availability before the layout is measured', () => {
    // Keying the message off the geometry would make it flash on the first frame of every open,
    // curve already in hand.
    expect(texts(render())).not.toContain('Chart unavailable')
  })
})

describe('scrubbing', () => {
  it('does not claim the touch on contact, so the page can still scroll', () => {
    // Claiming on touch-down would eat every vertical swipe starting over the chart, a full-width
    // 132pt band in the middle of a ScrollView.
    const tree = render()
    layout(tree)
    const chart = chartView(tree)

    expect(chart.props.onStartShouldSetResponder()).toBe(false)
  })

  it('reads the point under the finger: label becomes its timestamp, price its value', () => {
    const tree = render()
    layout(tree)
    const chart = chartView(tree)

    ReactTestRenderer.act(() => chart.props.onResponderGrant(touch(5)))

    const shown = texts(tree)
    expect(shown).toContain('R$300,000.00')
    expect(shown).not.toContain('Bitcoin \u00b7 BRL')
  })

  it('follows the finger across the curve', () => {
    const tree = render()
    layout(tree)
    const chart = chartView(tree)

    ReactTestRenderer.act(() => chart.props.onResponderGrant(touch(5)))
    ReactTestRenderer.act(() => chart.props.onResponderMove(touch(295)))

    // The last point of the series happens to equal the spot, so this only proves the drag reached it.
    expect(texts(tree)).toContain('R$330,000.00')
  })

  it('goes back to the spot price when the finger lifts', () => {
    const tree = render()
    layout(tree)
    const chart = chartView(tree)

    ReactTestRenderer.act(() => chart.props.onResponderGrant(touch(5)))
    ReactTestRenderer.act(() => chart.props.onResponderRelease(touch(5)))

    expect(texts(tree)).toContain('R$330,000.00')
    expect(texts(tree)).toContain('Bitcoin \u00b7 BRL')
  })
})

describe('periods', () => {
  it('offers every period, translated', () => {
    const shown = texts(render())
    expect(shown).toEqual(expect.arrayContaining(['1D', '1W', '1M', '3M', '1Y', 'All']))
  })

  it('reports the picked period to the caller', () => {
    const onPeriodChange = jest.fn()
    const tree = render({ onPeriodChange })

    // Pressable renders as a plain View on RN 0.86, so the button is found by its own Text.
    const button = tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node => node.findAllByType(Text).some(text => text.props.children === '1Y'))
    ReactTestRenderer.act(() => button?.props.onPress())

    expect(onPeriodChange).toHaveBeenCalledWith('1Y')
  })
})

test('draws the price on one line that shrinks to fit', () => {
  const figure = render()
    .root.findAllByType(Text)
    .find(n => n.props.children === 'R$330,000.00')!
  expect([figure.props.numberOfLines, figure.props.adjustsFontSizeToFit]).toEqual([1, true])
})

// Beside the change at the largest text size the price shrank to a quarter of its size. It gives way in
// its row while both fit, and the change goes under it once they do not.
test('keeps the price whole beside the change, and puts the change under it at a large text size', () => {
  expect(figuresHeldOut(render().root)).toEqual([])
  const start = Dimensions.get('window')
  const window = { ...start, fontScale: 3.12 }
  ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  try {
    const figure = render()
      .root.findAllByType(Text)
      .find(n => n.props.children === 'R$330,000.00')!
    const top = hostParent(hostParent(figure)!)!
    expect(StyleSheet.flatten(top.props.style)).toMatchObject({ flexDirection: 'column' })
  } finally {
    ReactTestRenderer.act(() => Dimensions.set({ window: start, screen: start }))
  }
})

// The price and its change share the rule of every label and figure, with the price leading.
test('lays the price and its change out through FigureRow, the price first', () => {
  const row = render().root.findByType(FigureRow)
  expect(row.props).toMatchObject({ figureFirst: true, cap: '70%' })
  expect(figuresIn(row).map(textOf)).toEqual(['R$330,000.00'])
})
