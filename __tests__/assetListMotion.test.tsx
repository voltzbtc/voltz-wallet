import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, StyleSheet } from 'react-native'
import '../src/i18n'
import { motion } from '../src/theme'

// jest.setup stubs the list for every other suite. Here reanimated is replaced by a stand-in that
// evaluates each animated style on every render, returns a spring as a record and logs each timing,
// and gesture-handler by one that keeps the handlers each gesture was built with, so a lift can be
// started by hand and what moves read off the styles. The stand-in keeps two behaviours of the real
// library: with the setting it read at launch on, an animation without ReduceMotion.Never ends at
// once, and a view keeps its first style's keys until a later style overwrites them.
jest.unmock('../src/components/AssetList')
const mockTimings: { to: unknown; duration: number }[] = []
const mockPans: Record<string, (...args: unknown[]) => void>[] = []
const mockReanimated = { systemReduced: false }
jest.mock('react-native-reanimated', () => {
  const react = require('react')
  const rn = require('react-native')
  const passthrough = (Component: unknown) => Component
  const jumps = (config?: { reduceMotion?: string }) =>
    mockReanimated.systemReduced && config?.reduceMotion !== 'never'
  return {
    __esModule: true,
    default: { View: rn.View, Text: rn.Text, createAnimatedComponent: passthrough },
    ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
    runOnJS: (fn: unknown) => fn,
    useAnimatedStyle: (updater: () => object) => {
      const shown = react.useRef(null)
      shown.current = { ...(shown.current ?? {}), ...updater() }
      return shown.current
    },
    useSharedValue: (value: unknown) => react.useRef({ value }).current,
    withSpring: (to: unknown, config?: { reduceMotion?: string }) => (jumps(config) ? to : { spring: to }),
    withTiming: (to: unknown, config: { duration: number; reduceMotion?: string }) => {
      mockTimings.push({ to, duration: jumps(config) ? 0 : config.duration })
      return to
    },
  }
})
jest.mock('react-native-gesture-handler', () => {
  const builder = (kind: string) => {
    const handlers: Record<string, unknown> = {}
    const self: unknown = new Proxy(
      {},
      {
        get: (_, key: string) => (fn: unknown) => {
          handlers[key] = fn
          return self
        },
      },
    )
    if (kind === 'pan') {
      mockPans.push(handlers as Record<string, (...args: unknown[]) => void>)
    }
    return self
  }
  return {
    Gesture: {
      Pan: () => builder('pan'),
      LongPress: () => builder('long'),
      Tap: () => builder('tap'),
      Exclusive: () => builder('exclusive'),
    },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  }
})
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return { useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }) }
})

const { AssetList } = jest.requireActual('../src/components/AssetList')

const assets = [
  { assetId: 'btc', name: 'Bitcoin', ticker: 'BTC', amount: '0.001', removable: false },
  { assetId: 'usdb', name: 'USDB', ticker: 'USDB', amount: '10', removable: true },
]

let current: ReactTestRenderer.ReactTestRenderer | null = null
afterEach(() => {
  if (current) {
    ReactTestRenderer.act(() => current!.unmount())
    current = null
  }
  jest.restoreAllMocks()
  mockReanimated.systemReduced = false
  mockTimings.length = 0
  mockPans.length = 0
})

const element = (editing: boolean) => (
  <AssetList
    assets={assets}
    editing={editing}
    hidden={false}
    onEnterEdit={jest.fn()}
    onReorder={jest.fn()}
    onRemove={jest.fn()}
    onOpen={jest.fn()}
  />
)

async function mount(reduced: boolean, editing: boolean) {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced)
  await ReactTestRenderer.act(async () => {
    current = ReactTestRenderer.create(element(editing))
  })
  return current!
}

// Lifts the first row as a drag would, then renders again so the styles read the lifted state.
async function lift(tree: ReactTestRenderer.ReactTestRenderer) {
  const [first] = mockPans.slice(-assets.length)
  ReactTestRenderer.act(() => first!.onStart!())
  await ReactTestRenderer.act(async () => tree.update(element(true)))
}

const styles = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root
    .findAll(n => typeof n.type === 'string')
    .map(n => StyleSheet.flatten(n.props.style) ?? {})

const scaled = (tree: ReactTestRenderer.ReactTestRenderer) => styles(tree).filter(s => s.transform !== undefined)
const scales = (tree: ReactTestRenderer.ReactTestRenderer) =>
  scaled(tree).map(s => (s.transform as { scale: unknown }[])[0]!.scale)
const springing = (tree: ReactTestRenderer.ReactTestRenderer) =>
  styles(tree).filter(s => typeof s.top === 'object' && s.top !== null)

test('with full motion a lifted row grows and the rows it passes spring to their slots', async () => {
  const tree = await mount(false, true)
  await lift(tree)
  expect(scales(tree)).toContainEqual({ spring: 1.04 })
  expect(springing(tree)).toHaveLength(1)
})

// Reanimated still holds the setting it read at launch after the person turns it off.
test('the app decides what moves, not the setting reanimated read at launch', async () => {
  mockReanimated.systemReduced = true
  const tree = await mount(false, false)
  ReactTestRenderer.act(() => tree.update(element(true)))
  expect(mockTimings.at(-1)).toEqual({ to: 1, duration: motion.fast })
  await lift(tree)
  expect(scales(tree)).toContainEqual({ spring: 1.04 })
  expect(springing(tree)).toHaveLength(1)
})

test('with reduced motion a lifted row keeps its size and the rows it passes jump', async () => {
  const tree = await mount(true, true)
  await lift(tree)
  expect(scales(tree)).toEqual([1, 1])
  expect(springing(tree)).toHaveLength(0)
})

test('a row lifted when the setting turns on goes back to its size', async () => {
  let changed: (on: boolean) => void = () => undefined
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((event: string, fn: (on: boolean) => void) => {
    if (event === 'reduceMotionChanged') {
      changed = fn
    }
    return { remove: () => undefined }
  }) as never)
  const tree = await mount(false, true)
  await lift(tree)
  expect(scales(tree)).toContainEqual({ spring: 1.04 })
  await ReactTestRenderer.act(async () => changed(true))
  expect(scales(tree)).toEqual([1, 1])
})

test('the edit controls open over the motion scale with full motion, and at once with reduced motion', async () => {
  const full = await mount(false, false)
  ReactTestRenderer.act(() => full.update(element(true)))
  expect(mockTimings.at(-1)).toEqual({ to: 1, duration: motion.fast })
  ReactTestRenderer.act(() => full.unmount())
  current = null

  const reduced = await mount(true, false)
  ReactTestRenderer.act(() => reduced.update(element(true)))
  expect(mockTimings.at(-1)).toEqual({ to: 1, duration: 0 })
})

// A screen reader reaches neither gesture, so what a tap, a drag and a long press do is offered as
// actions on the row, and a move goes through the write a drag ends in.
describe('what a screen reader can do with a row', () => {
  const handlers = () => ({ onEnterEdit: jest.fn(), onReorder: jest.fn(), onOpen: jest.fn() })
  async function rows(on: ReturnType<typeof handlers>) {
    await ReactTestRenderer.act(async () => {
      current = ReactTestRenderer.create(
        <AssetList assets={assets} editing={false} hidden={false} onRemove={jest.fn()} {...on} />,
      )
    })
    return current!.root.findAll(n => Array.isArray(n.props.accessibilityActions) && typeof n.type === 'string')
  }
  const act = (row: ReactTestRenderer.ReactTestInstance, actionName: string) =>
    row.props.onAccessibilityAction({ nativeEvent: { actionName } })
  const names = (row: ReactTestRenderer.ReactTestInstance) =>
    row.props.accessibilityActions.map((action: { name: string }) => action.name)

  test('a move never goes past either end', async () => {
    const [first, last] = await rows(handlers())
    expect(names(first!)).toEqual(['activate', 'moveDown', 'edit'])
    expect(names(last!)).toEqual(['activate', 'moveUp', 'edit'])
  })

  test('each action does what its gesture does', async () => {
    const on = handlers()
    const [first] = await rows(on)
    act(first!, 'moveDown')
    expect(on.onReorder).toHaveBeenCalledWith(['usdb', 'btc'])
    act(first!, 'activate')
    expect(on.onOpen).toHaveBeenCalledWith(assets[0])
    act(first!, 'edit')
    expect(on.onEnterEdit).toHaveBeenCalledTimes(1)
  })
})

test('a tap on hide answers at once on every row, even with a read fading them', async () => {
  const row = (hidden: boolean) => (
    <AssetList
      assets={assets}
      editing={false}
      hidden={hidden}
      fading
      onEnterEdit={jest.fn()}
      onReorder={jest.fn()}
      onRemove={jest.fn()}
      onOpen={jest.fn()}
    />
  )
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
  await ReactTestRenderer.act(async () => {
    current = ReactTestRenderer.create(row(false))
  })

  await ReactTestRenderer.act(async () => current!.update(row(true)))

  const leaving = current!.root.findAll(n => typeof n.type === 'string' && n.props.testID === 'cross-fade-leaving')
  expect(leaving).toHaveLength(0)
})
