import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Text } from 'react-native'
import { motionFor, useReduceMotion } from '../src/hooks/useReduceMotion'

// The double answers, and it can answer both ways. A double that only ever says "off" would let every
// case here pass against a hook that returned a constant.
const listeners: ((on: boolean) => void)[] = []
let answer: Promise<boolean>

beforeEach(() => {
  listeners.length = 0
  answer = Promise.resolve(false)
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockImplementation(() => answer)
  // Cast at the boundary, because addEventListener is an overload set keyed on the event name and
  // the reduceMotionChanged handler does not fit the first overload TypeScript picks for a spy.
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
    event: string,
    handler: (on: boolean) => void,
  ) => {
    if (event === 'reduceMotionChanged') listeners.push(handler)
    return { remove: () => listeners.splice(listeners.indexOf(handler), 1) }
  }) as unknown as typeof AccessibilityInfo.addEventListener)
})
afterEach(() => jest.restoreAllMocks())

function Probe(): React.JSX.Element {
  return <Text>{useReduceMotion() ? 'reduced' : 'full'}</Text>
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<Probe />)
  })
  return tree
}

const shown = (tree: ReactTestRenderer.ReactTestRenderer): string =>
  tree.root.findByType(Text).props.children as string

it('reports the setting the device is actually carrying', async () => {
  answer = Promise.resolve(true)
  expect(shown(await render())).toBe('reduced')
})

it('reports full motion when the setting is off', async () => {
  expect(shown(await render())).toBe('full')
})

it('follows the setting being changed while the app is open', async () => {
  // This is the case the hook exists for. The setting is toggled in Settings with the app in the
  // background, and coming back to a screen still spinning is exactly what somebody turned it on to
  // avoid.
  const tree = await render()
  expect(shown(tree)).toBe('full')

  await ReactTestRenderer.act(async () => {
    listeners.forEach(fn => fn(true))
  })
  expect(shown(tree)).toBe('reduced')
})

it('stays on full motion when the device cannot answer', async () => {
  // Failing the other way would strip motion from the whole app on any device whose answer never
  // arrived, which is a worse default than ignoring a setting nobody set.
  answer = Promise.reject(new Error('no such API'))
  expect(shown(await render())).toBe('full')
})

it('drops its listener when the screen goes, since the handler sets state on a dead tree', async () => {
  const tree = await render()
  expect(listeners).toHaveLength(1)
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
  expect(listeners).toHaveLength(0)
})

describe('motionFor', () => {
  it('collapses a duration to nothing when motion is reduced', () => {
    expect(motionFor(260, true)).toBe(0)
  })

  it('leaves it alone otherwise', () => {
    expect(motionFor(260, false)).toBe(260)
  })

  // Zero rather than skipping the animation, so the value still arrives through the same path and
  // every completion callback fires as it did. An animation that is skipped is a callback that never
  // runs, and several screens navigate from one.
  it('returns a number in both cases, so callers never branch on it', () => {
    expect(typeof motionFor(260, true)).toBe('number')
    expect(typeof motionFor(260, false)).toBe('number')
  })
})
