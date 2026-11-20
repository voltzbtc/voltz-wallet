import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Animated, Dimensions, StyleSheet, Text } from 'react-native'
import i18n from '../src/i18n'
import { IncomingBanner } from '../src/components/IncomingBanner'
import { FigureRow } from '../src/components/FigureRow'
import { formatSats } from '../src/wallet/amount'
import { layer } from '../src/theme'
import { figuresHeldOut, figuresIn, hostParent, textOf } from './support/figureFit'

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}))

let tree: ReactTestRenderer.ReactTestRenderer | null = null
let announce: jest.SpyInstance

beforeEach(() => {
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
})

afterEach(() => {
  if (tree) {
    ReactTestRenderer.act(() => tree!.unmount())
    tree = null
  }
  announce.mockRestore()
})

function render(visible: boolean): ReactTestRenderer.ReactTestRenderer {
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<IncomingBanner visible={visible} amountSat={21_000} />)
  })
  return tree!
}

// The pill takes no touch and no focus, so a screen reader would never learn a payment is on its way.
it('announces the incoming payment and its amount when it shows', () => {
  render(true)
  expect(announce).toHaveBeenCalledWith(`Incoming, ${formatSats(21_000)} sats`)
})

it('with dollars it leads with them and says the same figures it shows', () => {
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<IncomingBanner visible amountSat={21_000} dollars="≈ $21.00" />)
  })
  const shown = tree!.root.findAllByType(Text).map(n => [n.props.children].flat().join(''))

  expect(shown[shown.length - 2]).toBe('≈ $21.00')
  expect(shown[shown.length - 1]).toBe(`${formatSats(21_000)} sats`)
  expect(announce).toHaveBeenCalledWith(`Incoming, ≈ $21.00, ${formatSats(21_000)} sats`)
})

// Anyone can issue a token called USDB, so a token is named only by its identifier.
it('names no unknown token, not even by the ticker it claims, and tells a screen reader why', () => {
  const asset = { assetId: 'btkn1somebodyelse', ticker: 'USDB', amount: '10' }
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<IncomingBanner visible amountSat={10_000_000} asset={asset} />)
  })
  const shown = tree!.root
    .findAllByType(Text)
    .map(n => [n.props.children].flat().join(''))
    .join(' ')

  expect(shown).toContain('10')
  expect(shown).not.toMatch(/USDB|sats/)
  expect(announce).toHaveBeenCalledWith(`Incoming, 10, ${i18n.t('notice.unknownToken')}`)
})

it('says nothing while hidden', () => {
  render(false)
  expect(announce).not.toHaveBeenCalled()
})

// Two floating banners and the screen under them, so which covers which is the banner layer's call.
it('floats on the banner layer', () => {
  const [wrap] = render(true).root.findAllByType(Animated.View)
  expect(StyleSheet.flatten(wrap!.props.style).zIndex).toBe(layer.banner)
})

it('draws the amount on one line that shrinks to fit', () => {
  const figure = render(true)
    .root.findAllByType(Text)
    .find(n => [n.props.children].flat().includes(formatSats(21_000)))!
  expect([figure.props.numberOfLines, figure.props.adjustsFontSizeToFit]).toEqual([1, true])
})

// A pill sized by its content grows past the screen at a large text size unless it is capped there.
// The pill is capped at the screen, and the figure gives way inside it.
it('keeps the figure inside a pill capped at the screen', () => {
  render(true)
  const [figure] = figuresIn(tree!.root)
  expect(textOf(figure)).toContain(formatSats(21_000))
  expect(figuresHeldOut(tree!.root)).toEqual([])
  const pill = tree!.root.findAll(
    n => typeof n.type === 'string' && StyleSheet.flatten(n.props.style)?.flexDirection === 'row',
  )[0]
  expect(StyleSheet.flatten(pill.props.style).maxWidth).toBe('100%')
})

// A label that keeps its width takes the pill at the largest text size, which in Polish leaves the
// figure about a tenth of its size, and nothing on a 375pt screen. The label and figure share the
// rule of every such row.
describe('the label and the figure', () => {
  const start = Dimensions.get('window')
  const setScale = (fontScale: number) => {
    const window = { ...start, fontScale }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  }
  afterEach(() => setScale(start.fontScale))

  it('go through FigureRow, whose label wraps between words', () => {
    const row = render(true).root.findByType(FigureRow)
    expect(row.props.label).toBe('Incoming')
    expect(figuresIn(row).map(textOf)).toEqual([`${formatSats(21_000)} sats`])
    expect(figuresHeldOut(tree!.root)).toEqual([])
  })

  // The pill sizes itself to its content, so a row that grew into free space would stretch it from
  // margin to margin at every text size.
  it('keep the pill as wide as what it says: neither the row nor the label grows', () => {
    const [figure] = figuresIn(render(true).root)
    const row = hostParent(hostParent(figure)!)!
    expect(StyleSheet.flatten(row.props.style).flexDirection).toBe('row')
    expect(StyleSheet.flatten(row.props.style).flexGrow).toBe(0)
    const labelBox = row.children.find(c => typeof c !== 'string' && c !== hostParent(figure))
    expect(labelBox).toBeDefined()
    expect(StyleSheet.flatten((labelBox as ReactTestRenderer.ReactTestInstance).props.style).flexGrow).toBe(0)
  })

  it('put the figure under the label inside the pill at the largest text size', () => {
    setScale(3.571)
    const [figure] = figuresIn(render(true).root)
    const row = hostParent(hostParent(figure)!)!
    expect(StyleSheet.flatten(row.props.style).flexDirection).toBe('column')
    expect(figuresHeldOut(tree!.root)).toEqual([])
  })
})

describe('with reduced motion', () => {
  afterEach(() => jest.restoreAllMocks())

  async function renderWith(reduced: boolean) {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced)
    // Each pulse loop with its stop recorded, so a loop still running can be told from one put away.
    const actual = Animated.loop
    const stops: jest.Mock[] = []
    jest.spyOn(Animated, 'loop').mockImplementation((...args) => {
      const loop = actual(...args)
      const stop = jest.fn(() => loop.stop())
      stops.push(stop)
      return { ...loop, stop }
    })
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<IncomingBanner visible amountSat={21_000} />)
    })
    const [wrap, dot] = tree!.root.findAllByType(Animated.View)
    const running = stops.filter(stop => stop.mock.calls.length === 0).length
    return { wrap: StyleSheet.flatten(wrap!.props.style), dot: StyleSheet.flatten(dot!.props.style), running }
  }

  it('slides in and pulses its dot with full motion', async () => {
    const { wrap, dot, running } = await renderWith(false)
    expect(wrap.transform).toBeDefined()
    expect(typeof dot.opacity).not.toBe('number')
    expect(running).toBe(1)
  })

  it('only fades in, with a still dot', async () => {
    const { wrap, dot, running } = await renderWith(true)
    expect(wrap.transform).toBeUndefined()
    expect(wrap.opacity).toBeDefined()
    expect(dot.opacity).toBe(1)
    // A loop started before the setting answered is put away once it does.
    expect(running).toBe(0)
  })
})
