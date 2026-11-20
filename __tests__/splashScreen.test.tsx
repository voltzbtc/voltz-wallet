import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, StyleSheet } from 'react-native'

// jest.setup stubs the splash for every other suite. Here reanimated is replaced by a model that keeps
// its own reduce-motion rule and the way a view keeps the keys of its first style, which are the two
// things the splash has to work around (see support/reanimatedModel.ts).
jest.unmock('../src/screens/SplashScreen')
jest.mock('react-native-reanimated', () => require('./support/reanimatedModel').reanimatedModel())
jest.mock('react-native-svg', () => {
  const rn = require('react-native')
  const View = rn.View
  return { __esModule: true, default: View, Defs: View, G: View, LinearGradient: View, Mask: View, Path: View, Rect: View, Stop: View }
})

const { setSystemReduceMotion } = require('./support/reanimatedModel')
const { SplashScreen } = jest.requireActual('../src/screens/SplashScreen')

// The cycle the splash runs before it hands over, from SplashScreen's own timing table.
const TOTAL_MS = 2000

let current: ReactTestRenderer.ReactTestRenderer | null = null
beforeEach(() => jest.useFakeTimers())
afterEach(() => {
  if (current) {
    ReactTestRenderer.act(() => current!.unmount())
    current = null
  }
  setSystemReduceMotion(false)
  jest.useRealTimers()
  jest.restoreAllMocks()
})

type Style = { opacity?: number; transform?: Record<string, unknown>[] }

// `system` is what Reanimated reads from the phone, `hook` what the app's useReduceMotion answers.
// They differ after the setting changes while the app runs, since Reanimated reads it once at launch.
async function show({ system, hook }: { system: boolean; hook: boolean }, onDone = jest.fn()) {
  setSystemReduceMotion(system)
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(hook)
  const start = Date.now()
  await ReactTestRenderer.act(async () => {
    current = ReactTestRenderer.create(<SplashScreen onDone={onDone} />)
  })
  const tree = current!
  // Renders the splash as it stands `ms` after it mounted.
  const at = async (ms: number) => {
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(start + ms - Date.now())
      tree.update(<SplashScreen onDone={onDone} />)
    })
    return layers(tree)
  }
  return { tree, at, onDone }
}

function layers(tree: ReactTestRenderer.ReactTestRenderer) {
  const hosts = tree.root
    .findAll(n => typeof n.type === 'string')
    .map(n => ({ node: n, style: (StyleSheet.flatten(n.props.style) ?? {}) as Record<string, unknown> & Style }))
  const one = (label: string, match: (h: (typeof hosts)[number]) => boolean) => {
    const found = hosts.filter(match)
    if (found.length !== 1) {
      throw new Error(`${label}: found ${found.length}`)
    }
    return found[0].style
  }
  return {
    root: one('root', h => h.style.backgroundColor !== undefined),
    letters: one('letters', h => h.style.width === 232 && h.style.position === 'absolute' && h.node.props.pointerEvents !== 'none'),
    o: one('o', h => h.style.overflow === 'visible'),
    // The shine's layer is the one that takes no touch.
    shine: one('shine', h => h.node.props.pointerEvents === 'none'),
  }
}

const AT_REST = { letters: [{ scale: 1 }], o: [{ rotate: '0deg' }, { scale: 1 }] }

async function expectFullMotion(at: (ms: number) => Promise<ReturnType<typeof layers>>) {
  const spinning = await at(75)
  expect(spinning.o.opacity).toBeCloseTo(0.5)
  const half = await at(310)
  expect(half.letters.opacity).toBeCloseTo(0.5)
  expect(half.letters.transform![0].scale).toBeCloseTo(0.975)
  const o = await at(410)
  expect(o.o.transform![0].rotate).toBe('-360deg')
  expect(o.o.transform![1].scale).toBeCloseTo(0.575)
  expect((await at(1005)).shine.opacity).toBeCloseTo(0.5)
}

test('with full motion the letters grow, the O spins in and the shine crosses', async () => {
  const { at } = await show({ system: false, hook: false })
  await expectFullMotion(at)
})

// Reanimated still holds the setting it read at launch after the person turns it off.
test('the app decides what moves, not the setting reanimated read at launch', async () => {
  const { at } = await show({ system: true, hook: false })
  await expectFullMotion(at)
})

test('with reduced motion the logo stands at rest with no shine, and the screen still fades out', async () => {
  const { at } = await show({ system: true, hook: true })
  for (const ms of [0, 75, 310, 410, 1005, 1600]) {
    const now = await at(ms)
    expect([ms, now.letters.transform, now.o.transform]).toEqual([ms, AT_REST.letters, AT_REST.o])
    expect([ms, now.letters.opacity, now.o.opacity, now.shine.opacity]).toEqual([ms, 1, 1, 0])
    // Opaque until its fade begins, so the screen never turns clear while it still takes the tap.
    expect([ms, now.root.opacity]).toEqual([ms, 1])
  }
  expect((await at(1870)).root.opacity).toBeCloseTo(0.5)
  expect((await at(2000)).root.opacity).toBe(0)
})

test('with reduced motion it still hands over on its own schedule', async () => {
  const { at, onDone } = await show({ system: true, hook: true })
  await at(TOTAL_MS - 1)
  expect(onDone).not.toHaveBeenCalled()
  await at(TOTAL_MS)
  expect(onDone).toHaveBeenCalledTimes(1)
})

// Clear but still mounted, the splash would swallow the first tap meant for the PIN keypad under it.
test('hands over the moment it turns clear', async () => {
  const { at, onDone } = await show({ system: false, hook: false })
  const before = await at(TOTAL_MS - 1)
  expect(before.root.opacity).toBeGreaterThan(0)
  expect(onDone).not.toHaveBeenCalled()
  const after = await at(TOTAL_MS)
  expect(after.root.opacity).toBe(0)
  expect(onDone).toHaveBeenCalledTimes(1)
})

// One button over the whole screen with no name is worse than silence, and the splash ends by itself.
test('is kept out of the screen reader, and a tap still skips it', async () => {
  const { tree, onDone } = await show({ system: false, hook: false })
  const target = tree.root.find(n => typeof n.type !== 'string' && typeof n.props.onPress === 'function')
  // What the platform reads, on the view the target draws.
  const host = target.find(n => typeof n.type === 'string' && n.props.style !== undefined)
  for (const node of [target, host]) {
    expect(node.props.focusable).toBe(false)
    expect(node.props.accessibilityElementsHidden).toBe(true)
    expect(node.props.importantForAccessibility).toBe('no-hide-descendants')
  }

  ReactTestRenderer.act(() => target.props.onPress())
  expect(onDone).toHaveBeenCalledTimes(1)
})
