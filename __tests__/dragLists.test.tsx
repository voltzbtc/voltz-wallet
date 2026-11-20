import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Dimensions, Text, View } from 'react-native'
import '../src/i18n'
import { colors, font, space, stroke } from '../src/theme'
import { formatFingerprint } from '../src/wallet/walletIdentity'
import { figuresHeldOut, figuresIn, hostChildren, textOf } from './support/figureFit'
import { FigureRow } from '../src/components/FigureRow'

// jest.setup stubs both drag lists for every other suite, since their worklets do not run here. This
// one renders them with inert stand-ins for reanimated and gesture-handler, which keep the rows
// mounting while the props they hand to the screen reader and the stylesheet stay real.
jest.unmock('../src/components/WalletList')
jest.unmock('../src/components/AssetList')
jest.mock('react-native-reanimated', () => {
  const rn = require('react-native')
  const passthrough = (Component: unknown) => Component
  return {
    __esModule: true,
    default: { View: rn.View, Text: rn.Text, createAnimatedComponent: passthrough },
    ReduceMotion: { Never: 'never' },
    runOnJS: (fn: unknown) => fn,
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: unknown) => ({ value }),
    withSpring: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  }
})
jest.mock('react-native-gesture-handler', () => {
  // Every builder method returns another builder, which is all the lists ask of a gesture here.
  const chain = (): unknown => new Proxy({}, { get: () => chain })
  return {
    Gesture: { Pan: chain, LongPress: chain, Tap: chain, Exclusive: chain },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  }
})
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return { useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }) }
})

const { WalletList } = jest.requireActual('../src/components/WalletList')
const { AssetList } = jest.requireActual('../src/components/AssetList')

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

let current: ReactTestRenderer.ReactTestRenderer | null = null
function mount(element: React.ReactElement): ReactTestRenderer.ReactTestRenderer {
  ReactTestRenderer.act(() => {
    current = ReactTestRenderer.create(element)
  })
  return current!
}
afterEach(() => {
  if (current) {
    ReactTestRenderer.act(() => current!.unmount())
    current = null
  }
})

describe('the wallet list', () => {
  const rows = [
    { id: 'primary', fingerprint: '0a1b2c3d', name: 'Savings', imagePath: null, color: '#336699', monogram: 'S', active: true },
    { id: 'w_2', fingerprint: '4e5f6a7b', name: 'Daily', imagePath: null, color: '#993366', monogram: 'D', active: false },
  ]
  const render = (editing: boolean, onPressRow = jest.fn()) =>
    mount(
      <WalletList
        rows={rows}
        editing={editing}
        onEnterEdit={jest.fn()}
        onPressRow={onPressRow}
        onReorder={jest.fn()}
        onRemove={jest.fn()}
      />,
    )
  const cards = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(
      node =>
        node.type === View &&
        rows.some(row => String(node.props.accessibilityLabel ?? '').startsWith(row.name)),
    )

  it('names each wallet card by its name and fingerprint, and marks the active one', () => {
    const shown = cards(render(false)).map(node => ({
      label: node.props.accessibilityLabel,
      role: node.props.accessibilityRole,
      accessible: node.props.accessible,
      selected: node.props.accessibilityState?.selected,
    }))
    expect(shown).toEqual([
      { label: `Savings, ${formatFingerprint('0a1b2c3d')}`, role: 'button', accessible: true, selected: true },
      { label: `Daily, ${formatFingerprint('4e5f6a7b')}`, role: 'button', accessible: true, selected: false },
    ])
  })

  it('opens the wallet when a screen reader activates its card', () => {
    const onPressRow = jest.fn()
    const daily = cards(render(false, onPressRow))[1]!
    expect(daily.props.accessibilityActions).toEqual([
      { name: 'activate' },
      { name: 'moveUp', label: 'Move up' },
      { name: 'edit', label: 'Edit' },
    ])
    ReactTestRenderer.act(() => daily.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }))
    expect(onPressRow).toHaveBeenCalledWith(rows[1])
  })

  it('stops grouping the card while editing, so its remove control can be reached', () => {
    const editing = cards(render(true))
    expect(editing).toHaveLength(2)
    for (const node of editing) {
      expect(node.props.accessible).toBe(false)
      expect(node.props.accessibilityRole).toBeUndefined()
    }
  })
})

describe('the asset list', () => {
  it('divides its rows with the hairline every other list uses', () => {
    const tree = mount(
      <AssetList
        assets={[
          { assetId: 'btc', name: 'Bitcoin', ticker: 'BTC', amount: '0.001', removable: false },
          { assetId: 'usdb', name: 'USDB', ticker: 'USDB', amount: '5', removable: true },
        ]}
        editing={false}
        hidden={false}
        onEnterEdit={jest.fn()}
        onReorder={jest.fn()}
        onRemove={jest.fn()}
        onOpen={jest.fn()}
      />,
    )
    const dividers = tree.root
      .findAll(node => node.type === View && flat(node.props.style).backgroundColor === colors.divider)
      .map(node => flat(node.props.style).height)
    expect(dividers).toEqual([stroke.hair, stroke.hair])
  })
})

// At the largest text size the name vanished beside the figure and the figure was cut at the card's
// edge. Too narrow for both, a row puts its figure under the name, each on a line of its own.
describe('the asset list at large text', () => {
  const start = Dimensions.get('window')
  const setScale = (fontScale: number) => {
    const window = { ...start, fontScale }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  }
  afterEach(() => setScale(start.fontScale))

  const render = () =>
    mount(
      <AssetList
        assets={[
          { assetId: 'btc', name: 'Bitcoin', ticker: 'BTC', amount: '17920', removable: false },
          { assetId: 'usdb', name: 'Bitcoin USD', ticker: 'USDB', amount: '0.50', removable: true },
        ]}
        editing={false}
        hidden={false}
        onEnterEdit={jest.fn()}
        onReorder={jest.fn()}
        onRemove={jest.fn()}
        onOpen={jest.fn()}
      />,
    )
  const named = (tree: ReactTestRenderer.ReactTestRenderer, name: string) =>
    tree.root.findAllByType(Text).find(node => node.props.children === name)!
  const figureOf = (tree: ReactTestRenderer.ReactTestRenderer, figure: string) =>
    tree.root.findAllByType(Text).find(node => String(node.props.children).includes(figure))!
  // The FigureRow that lays a name out with its figure.
  const rowOf = (tree: ReactTestRenderer.ReactTestRenderer, name: ReactTestRenderer.ReactTestInstance) =>
    tree.root.findAllByType(FigureRow).find(row => row.findAll(node => node === name).length > 0)!
  const slotHeights = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAll(node => node.type === View && flat(node.props.style).position === 'absolute')
      .filter(node => flat(node.props.style).backgroundColor !== colors.divider)
      .map(node => flat(node.props.style).height)
      .filter(height => height !== undefined)

  it('stacks the figure under a name of up to two lines, in rows tall enough for both', () => {
    // The test window is 750 wide, so 3.12 leaves 240 per unit of font scale, under the 300 a row
    // needs side by side.
    setScale(3.12)
    const tree = render()
    const name = named(tree, 'Bitcoin USD')
    const figure = figureOf(tree, '0.50 USDB')
    expect(name.props.numberOfLines).toBe(2)
    expect([figure.props.numberOfLines, figure.props.adjustsFontSizeToFit]).toEqual([1, true])
    // The name and the figure share one FigureRow beside the icon, which puts the figure under the
    // name, inside the box that fades it while the list is edited.
    const row = rowOf(tree, name)
    expect(figuresIn(row).map(textOf)).toContain('0.50 USDB')
    expect(flat(hostChildren(row)[0].props.style).flexDirection).toBe('column')
    const tall = 2 * space.md + space.xs + 3 * font.leading.base * 3.12
    expect(slotHeights(tree)).toEqual([tall, tall])
  })

  it('keeps the name and the figure side by side in 60pt rows at the standard sizes', () => {
    setScale(1)
    const tree = render()
    const name = named(tree, 'Bitcoin USD')
    const figure = figureOf(tree, '0.50 USDB')
    expect(name.props.numberOfLines).toBe(1)
    expect([figure.props.numberOfLines, figure.props.adjustsFontSizeToFit]).toEqual([1, true])
    const row = rowOf(tree, name)
    expect(figuresIn(row).map(textOf)).toContain('0.50 USDB')
    expect(flat(hostChildren(row)[0].props.style).flexDirection).toBe('row')
    // Most of the row, so the name gives way before a balance shrinks.
    expect(row.props.cap).toBe('65%')
    // Capped at a share of the row rather than shrinking, so the name gives way first.
    expect(figuresHeldOut(tree.root)).toEqual([])
    expect(slotHeights(tree)).toEqual([60, 60])
  })
})
