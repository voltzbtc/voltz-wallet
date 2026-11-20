import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, StyleSheet } from 'react-native'
import '../src/i18n'
import { formatSats } from '../src/wallet/amount'
import { space } from '../src/theme'

// jest.setup stubs this component out for every other suite. Here reanimated is replaced by a model
// that keeps its own reduce-motion rule and the way a view keeps the keys of its first style, which
// are the two things the overlay has to work around (see support/reanimatedModel.ts).
jest.unmock('../src/components/ReceivedOverlay')
jest.mock('react-native-reanimated', () => require('./support/reanimatedModel').reanimatedModel())
jest.mock('react-native-svg', () => {
  const rn = require('react-native')
  return { __esModule: true, default: rn.View, Svg: rn.View, G: rn.View, Path: rn.View, Circle: rn.View }
})
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return { useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }) }
})

const { setSystemReduceMotion } = require('./support/reanimatedModel')
const { ReceivedOverlay } = require('../src/components/ReceivedOverlay')

const HOLD_MS = 3600

beforeEach(() => {
  jest.useFakeTimers()
  jest.spyOn(global, 'requestAnimationFrame').mockImplementation(() => 0 as unknown as number)
})

afterEach(() => {
  setSystemReduceMotion(false)
  jest.useRealTimers()
  jest.restoreAllMocks()
})

type Tree = ReactTestRenderer.ReactTestRenderer

// `system` is what Reanimated reads from the phone, `hook` what the app's useReduceMotion answers.
// They differ after the setting changes while the app runs, since Reanimated reads it once at launch.
async function show({ system, hook }: { system: boolean; hook: boolean }, onDone = jest.fn()) {
  setSystemReduceMotion(system)
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(hook)
  const start = Date.now()
  const element = () => (
    <ReceivedOverlay
      visible
      amount={{ value: 21, unit: 'sats', format: formatSats }}
      fiat="0.01 EUR"
      onDone={onDone}
    />
  )
  let tree!: Tree
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(element())
  })
  // Renders the overlay as it stands `ms` after it appeared.
  const at = async (ms: number) => {
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(start + ms - Date.now())
      tree.update(element())
    })
    return pieces(tree)
  }
  return { tree, at, onDone }
}

const hostStyles = (tree: Tree) =>
  tree.root
    .findAll(n => typeof n.type === 'string')
    .map(n => ({ node: n, style: StyleSheet.flatten(n.props.style) ?? {} }))

const scaleOf = (style: { transform?: Record<string, unknown>[] }) => style.transform?.[0]?.scale
const translateYOf = (style: { transform?: Record<string, unknown>[] }) =>
  style.transform?.[0]?.translateY

function pieces(tree: Tree) {
  const hosts = hostStyles(tree)
  const one = (label: string, match: (s: Record<string, unknown>) => boolean) => {
    const found = hosts.filter(h => match(h.style))
    if (found.length !== 1) {
      throw new Error(`${label}: found ${found.length}`)
    }
    return found[0].style
  }
  const rings = hosts.filter(h => h.style.width === 120).map(h => h.style)
  const prop = (key: string) =>
    tree.root.find(n => typeof n.type === 'string' && n.props.animatedProps?.[key] !== undefined && n.props.strokeDasharray !== 38)
      .props.animatedProps[key]
  return {
    scrim: one('scrim', s => s.position === 'absolute' && s.top === 0 && s.alignItems === undefined),
    bolt: one('bolt', s => s.width === 96 && s.position === 'absolute' && s.backgroundColor === undefined),
    badge: one('badge', s => s.width === 96 && s.backgroundColor !== undefined),
    label: one('label', s => typeof s.opacity === 'number' && s.fontSize !== undefined),
    amount: one('amount', s => s.alignSelf === 'stretch'),
    fiat: one('fiat', s => s.gap === space.xs),
    ring: rings[0],
    ring2: rings[1],
    boltFill: prop('fillOpacity') as number,
    boltDash: prop('strokeDashoffset') as number,
    checkDash: tree.root.find(n => typeof n.type === 'string' && n.props.strokeDasharray === 38).props
      .animatedProps.strokeDashoffset as number,
  }
}

// Each fade at the middle of its own timing, from the overlay's timeline.
const FADES: [number, (p: ReturnType<typeof pieces>) => unknown, number][] = [
  [50, p => p.bolt.opacity, 0],
  [120, p => p.scrim.opacity, 0.5],
  [160, p => p.bolt.opacity, 0.5],
  [870, p => p.boltFill, 0.5],
  [1131, p => p.ring.opacity, 0.25],
  [1131, p => p.ring2.opacity, 0.2],
  [1430, p => p.bolt.opacity, 0.5],
  [1570, p => p.badge.opacity, 0.5],
  [1570, p => p.label.opacity, 0.5],
  [1670, p => p.amount.opacity, 0.5],
  [1900, p => p.fiat.opacity, 0.5],
]

async function expectMovement(at: (ms: number) => Promise<ReturnType<typeof pieces>>) {
  expect((await at(400)).boltDash).toBeCloseTo(811)
  const growing = await at(1130)
  expect(scaleOf(growing.ring)).toBeCloseTo(1.25)
  expect(scaleOf(growing.ring2)).toBeCloseTo(1)
  const popping = await at(1570)
  expect(scaleOf(popping.badge)).toBeCloseTo(0.5)
  expect(popping.badge.opacity).toBe(1)
  expect(translateYOf((await at(1720)).amount)).toBeCloseTo(9)
  expect((await at(1780)).checkDash).toBeCloseTo(19)
}

test('with full motion the ring grows, the badge pops, the amount rises and the bolt is drawn', async () => {
  const { at } = await show({ system: false, hook: false })
  await expectMovement(at)
})

// Reanimated still holds the setting it read at launch after the person turns it off.
test('the app decides what moves, not the setting reanimated read at launch', async () => {
  const { at } = await show({ system: true, hook: false })
  await expectMovement(at)
})

test('with reduced motion every fade keeps its timing', async () => {
  const { at } = await show({ system: true, hook: true })
  for (const [ms, read, expected] of FADES) {
    expect([ms, read(await at(ms))]).toEqual([ms, expect.closeTo(expected)])
  }
})

test('with reduced motion nothing moves at any point, the bolt and the check drawn whole', async () => {
  const { at } = await show({ system: true, hook: true })
  for (const ms of [0, 400, 1130, 1570, 1720, 1780, 2400]) {
    const p = await at(ms)
    expect([ms, scaleOf(p.ring), scaleOf(p.ring2), scaleOf(p.badge), translateYOf(p.amount)]).toEqual([
      ms,
      1,
      1,
      1,
      0,
    ])
    expect([ms, p.boltDash, p.checkDash]).toEqual([ms, 0, 0])
  }
  // The badge ends whole and shown.
  const end = await at(2400)
  expect(end.badge.opacity).toBe(1)
})

test('with reduced motion the overlay still closes on its timer', async () => {
  const { at, onDone } = await show({ system: true, hook: true })
  await at(HOLD_MS - 1)
  expect(onDone).not.toHaveBeenCalled()
  await at(HOLD_MS)
  expect(onDone).toHaveBeenCalledTimes(1)
})
