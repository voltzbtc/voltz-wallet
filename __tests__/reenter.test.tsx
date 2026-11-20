import React, { useEffect } from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo } from 'react-native'
import { space } from '../src/theme'

// jest.setup.js stands in for this component everywhere else.
jest.unmock('../src/components/Reenter')

const mockNever = 'never'
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native')
  class Entry {
    calls: Record<string, unknown> = {}
    kind: string
    constructor(kind: string) {
      this.kind = kind
    }
    withInitialValues(values: unknown) {
      this.calls.initial = values
      return this
    }
    duration(ms: number) {
      this.calls.duration = ms
      return this
    }
    delay(ms: number) {
      this.calls.delay = ms
      return this
    }
    reduceMotion(mode: unknown) {
      this.calls.reduceMotion = mode
      return this
    }
  }
  return {
    __esModule: true,
    default: { View },
    FadeIn: class extends Entry {
      constructor() {
        super('fade')
      }
    },
    FadeInDown: class extends Entry {
      constructor() {
        super('rise')
      }
    },
    ReduceMotion: { Never: mockNever },
  }
})

const { Reenter, reentry } = require('../src/components/Reenter')

type Entry = { kind: string; calls: { initial?: unknown; duration: number; delay: number; reduceMotion: unknown } }

test('an entry is a fade with a small rise, at the part place in the stagger', () => {
  const entry: Entry = reentry(1, false)

  expect(entry.kind).toBe('rise')
  expect(entry.calls).toEqual({ initial: { translateY: space.sm }, duration: 120, delay: 40, reduceMotion: mockNever })
})

test('with reduced motion it is a plain fade on the same timing, kept from Reanimated own rule', () => {
  const entry: Entry = reentry(1, true)

  expect(entry.kind).toBe('fade')
  expect(entry.calls.initial).toBeUndefined()
  expect(entry.calls).toMatchObject({ duration: 120, delay: 40, reduceMotion: mockNever })
})

test('the whole page takes about 200 ms, however many rows a list hands it', () => {
  const last: Entry = reentry(40, false)

  expect(last.calls.delay + last.calls.duration).toBe(200)
})

describe('the component', () => {
  let mounts = 0
  function Child(): React.JSX.Element {
    useEffect(() => {
      mounts += 1
    }, [])
    return <></>
  }
  async function render(beat: number): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <Reenter beat={beat} order={0}>
          <Child />
        </Reenter>,
      )
    })
    return tree
  }

  beforeEach(() => {
    mounts = 0
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
  })

  test('the first paint enters nothing', async () => {
    const tree = await render(0)

    expect(tree.root.findByProps({ entering: undefined })).toBeTruthy()
    expect(mounts).toBe(1)
  })

  test('a new beat mounts the content again, with the entry', async () => {
    const tree = await render(0)

    await ReactTestRenderer.act(async () => {
      tree.update(
        <Reenter beat={1} order={0}>
          <Child />
        </Reenter>,
      )
    })

    expect(mounts).toBe(2)
    expect(tree.root.findAll(node => node.props.entering !== undefined).length).toBeGreaterThan(0)
  })
})
