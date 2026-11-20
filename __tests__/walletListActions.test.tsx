import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, StyleSheet, View } from 'react-native'
import RNFS from 'react-native-fs'
import '../src/i18n'
import i18n from '../src/i18n'
import { motion } from '../src/theme'
import { loadRegistry } from '../src/wallet/walletRegistry'

// jest.setup stubs the list for every other suite. Here reanimated is replaced by a stand-in that
// evaluates each animated style on every render, returns a spring as a record and logs each timing,
// and gesture-handler by one that keeps the handlers each pan was built with, so a lift can be started
// by hand and what moves read off the styles. The accessibility actions are the real props.
jest.unmock('../src/components/WalletList')
const mockTimings: { to: unknown; duration: number }[] = []
const mockPans: Record<string, (...args: unknown[]) => void>[] = []
jest.mock('react-native-reanimated', () => {
  const react = require('react')
  const rn = require('react-native')
  const passthrough = (Component: unknown) => Component
  return {
    __esModule: true,
    default: { View: rn.View, Text: rn.Text, createAnimatedComponent: passthrough },
    runOnJS: (fn: unknown) => fn,
    useAnimatedStyle: (updater: () => unknown) => updater(),
    useSharedValue: (value: unknown) => react.useRef({ value }).current,
    withSpring: (to: unknown) => ({ spring: to }),
    withTiming: (to: unknown, config: { duration: number }) => {
      mockTimings.push({ to, duration: config.duration })
      return to
    },
  }
})
jest.mock('react-native-gesture-handler', () => {
  const builder = (kind: string) => {
    const kept: Record<string, unknown> = {}
    const self: unknown = new Proxy(
      {},
      {
        get: (_, key: string) => (fn: unknown) => {
          kept[key] = fn
          return self
        },
      },
    )
    if (kind === 'pan') {
      mockPans.push(kept as Record<string, (...args: unknown[]) => void>)
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
const mockSetOptions = jest.fn()
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => ({ navigate: jest.fn(), setOptions: mockSetOptions }),
    useFocusEffect: (cb: () => void) => {
      react.useEffect(cb, [])
    },
  }
})
jest.mock('../src/wallet/wallet', () => ({
  isWalletSeedAbsent: () => false,
  removeWalletById: jest.fn(async () => undefined),
  switchWalletWithoutReconnecting: jest.fn(async () => undefined),
}))

const { WalletList } = jest.requireActual('../src/components/WalletList')
const { WalletsScreen } = jest.requireActual('../src/screens/WalletsScreen')

const row = (id: string, name: string, active = false) => ({
  id,
  fingerprint: `${id}fp`.padEnd(8, '0'),
  name,
  imagePath: null,
  color: '#336699',
  monogram: name[0],
  active,
})
const THREE = [row('w_a', 'Savings', true), row('w_b', 'Daily'), row('w_c', 'Travel')]

let current: ReactTestRenderer.ReactTestRenderer | null = null
beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
})
afterEach(() => {
  if (current) {
    ReactTestRenderer.act(() => current!.unmount())
    current = null
  }
  jest.restoreAllMocks()
  mockTimings.length = 0
  mockPans.length = 0
})
afterAll(async () => {
  await i18n.changeLanguage('pt-BR')
})

type Handlers = { onEnterEdit: jest.Mock; onPressRow: jest.Mock; onReorder: jest.Mock; onRemove: jest.Mock }

function handlers(): Handlers {
  return { onEnterEdit: jest.fn(), onPressRow: jest.fn(), onReorder: jest.fn(), onRemove: jest.fn() }
}

async function mount(rows: typeof THREE, h: Handlers, editing = false, reduced = false) {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced)
  await ReactTestRenderer.act(async () => {
    current = ReactTestRenderer.create(<WalletList rows={rows} editing={editing} {...h} />)
  })
  return current!
}

const cards = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAll(
    node => node.type === View && THREE.some(r => String(node.props.accessibilityLabel ?? '').startsWith(r.name)),
  )
const actionNames = (card: ReactTestRenderer.ReactTestInstance): string[] =>
  (card.props.accessibilityActions ?? []).map((a: { name: string }) => a.name)
function act(card: ReactTestRenderer.ReactTestInstance, actionName: string): void {
  ReactTestRenderer.act(() => card.props.onAccessibilityAction({ nativeEvent: { actionName } }))
}

describe('the actions a screen reader finds on a wallet card', () => {
  test('moves are offered only where a card can go, edit on every card, and nothing removes', async () => {
    const tree = await mount(THREE, handlers())
    expect(cards(tree).map(actionNames)).toEqual([
      ['activate', 'moveDown', 'edit'],
      ['activate', 'moveUp', 'moveDown', 'edit'],
      ['activate', 'moveUp', 'edit'],
    ])
    const labels = cards(tree)[1]!.props.accessibilityActions.map((a: { label?: string }) => a.label)
    expect(labels).toEqual([undefined, 'Move up', 'Move down', 'Edit'])
  })

  test('move down on the first card swaps it with the second and says where it went', async () => {
    const h = handlers()
    const tree = await mount(THREE, h)
    act(cards(tree)[0]!, 'moveDown')
    expect(h.onReorder).toHaveBeenCalledWith(['w_b', 'w_a', 'w_c'])
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Moved to position 2 of 3.')
  })

  test('move up on the last card swaps it with the one above', async () => {
    const h = handlers()
    const tree = await mount(THREE, h)
    act(cards(tree)[2]!, 'moveUp')
    expect(h.onReorder).toHaveBeenCalledWith(['w_a', 'w_c', 'w_b'])
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Moved to position 2 of 3.')
  })

  test('edit opens edit mode, as the long press does, and activate still opens the wallet', async () => {
    const h = handlers()
    const tree = await mount(THREE, h)
    act(cards(tree)[1]!, 'edit')
    expect(h.onEnterEdit).toHaveBeenCalledTimes(1)
    act(cards(tree)[1]!, 'activate')
    expect(h.onPressRow).toHaveBeenCalledWith(THREE[1])
    expect(h.onReorder).not.toHaveBeenCalled()
    expect(h.onRemove).not.toHaveBeenCalled()
  })

  test('a single wallet offers only activate', async () => {
    const tree = await mount([THREE[0]!], handlers())
    expect(cards(tree).map(actionNames)).toEqual([['activate']])
  })

  test('the active wallet is still announced as selected beside the new actions', async () => {
    const tree = await mount(THREE, handlers())
    expect(cards(tree).map(c => c.props.accessibilityState?.selected)).toEqual([true, false, false])
  })
})

describe('reduced motion on the wallet list', () => {
  const styles = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(n => typeof n.type === 'string').map(n => StyleSheet.flatten(n.props.style) ?? {})
  const scaled = (tree: ReactTestRenderer.ReactTestRenderer) => styles(tree).filter(s => s.transform !== undefined)
  const springing = (tree: ReactTestRenderer.ReactTestRenderer) =>
    styles(tree).filter(s => typeof s.top === 'object' && s.top !== null)

  async function lift(tree: ReactTestRenderer.ReactTestRenderer, h: Handlers) {
    const [first] = mockPans.slice(-THREE.length)
    ReactTestRenderer.act(() => first!.onStart!())
    await ReactTestRenderer.act(async () => tree.update(<WalletList rows={THREE} editing {...h} />))
  }

  test('with full motion a lifted card grows and the cards it passes spring to their slots', async () => {
    const h = handlers()
    const tree = await mount(THREE, h, true, false)
    await lift(tree, h)
    const lifted = scaled(tree).map(s => (s.transform as { scale: { spring: number } }[])[0]!.scale.spring)
    expect(lifted).toContain(1.04)
    expect(springing(tree)).toHaveLength(2)
  })

  test('with reduced motion a lifted card keeps its size and the cards it passes jump', async () => {
    const h = handlers()
    const tree = await mount(THREE, h, true, true)
    await lift(tree, h)
    expect(scaled(tree)).toHaveLength(0)
    expect(springing(tree)).toHaveLength(0)
  })

  test('the edit controls slide in over the motion scale, and at once with reduced motion', async () => {
    const h = handlers()
    const full = await mount(THREE, h, false, false)
    ReactTestRenderer.act(() => full.update(<WalletList rows={THREE} editing {...h} />))
    expect(mockTimings.at(-1)).toEqual({ to: 1, duration: motion.fast })
    ReactTestRenderer.act(() => full.unmount())
    current = null

    const reduced = await mount(THREE, h, false, true)
    ReactTestRenderer.act(() => reduced.update(<WalletList rows={THREE} editing {...h} />))
    expect(mockTimings.at(-1)).toEqual({ to: 1, duration: 0 })
  })
})

// The move goes through the screen's reorder, the one the drag uses, into the registry on the
// in-memory fs, so the stored order is what changes and the active wallet stays where it was.
describe('a move on the wallets screen', () => {
  const FILE = `${RNFS.DocumentDirectoryPath}/wallets.json`

  beforeEach(async () => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    await RNFS.writeFile(
      FILE,
      JSON.stringify({
        wallets: [
          { id: 'w_a', fingerprint: 'aaaa1111' },
          { id: 'w_b', fingerprint: 'bbbb2222' },
          { id: 'w_c', fingerprint: 'cccc3333' },
        ],
        active: 'w_b',
      }),
      'utf8',
    )
  })

  async function renderScreen() {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
    await ReactTestRenderer.act(async () => {
      current = ReactTestRenderer.create(<WalletsScreen />)
    })
    for (let i = 0; i < 6; i++) {
      await ReactTestRenderer.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
    return current!
  }
  const screenCards = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.type === View && n.props.accessibilityRole === 'button' && n.props.accessibilityActions)

  test('stores the new order and keeps the active wallet', async () => {
    const tree = await renderScreen()
    expect(screenCards(tree)).toHaveLength(3)

    act(screenCards(tree)[0]!, 'moveDown')
    for (let i = 0; i < 3; i++) {
      await ReactTestRenderer.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }

    const reg = await loadRegistry()
    expect(reg.wallets.map(w => w.id)).toEqual(['w_b', 'w_a', 'w_c'])
    expect(reg.active).toBe('w_b')
    expect(screenCards(tree).map(c => c.props.accessibilityState?.selected)).toEqual([true, false, false])
  })

  test('edit on a card opens edit mode, where Done takes the place of Edit', async () => {
    const tree = await renderScreen()
    const header = () => mockSetOptions.mock.calls.at(-1)?.[0].headerRight?.().props.children.props.children
    expect(header()).toBe('Edit')

    act(screenCards(tree)[1]!, 'edit')

    expect(header()).toBe('Done')
    expect(screenCards(tree)).toHaveLength(0)
  })
})
