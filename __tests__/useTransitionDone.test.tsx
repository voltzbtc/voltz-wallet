import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { TRANSITION_BOUND_MS, useTransitionDone } from '../src/hooks/useTransitionDone'

type Listener = (event: { data: { closing: boolean } }) => void
const mockListeners = new Set<Listener>()
const mockNavigation = {
  addListener: (name: string, listener: Listener) => {
    if (name !== 'transitionEnd') {
      throw new Error(`unexpected event ${name}`)
    }
    mockListeners.add(listener)
    return () => mockListeners.delete(listener)
  },
}

jest.mock('@react-navigation/native', () => ({ useNavigation: () => mockNavigation }))

function Probe(): React.JSX.Element {
  return <Text>{String(useTransitionDone())}</Text>
}

function mount(): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<Probe />)
  })
  return tree
}

const done = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(Text).props.children === 'true'
const end = (closing: boolean) =>
  ReactTestRenderer.act(() => mockListeners.forEach(listener => listener({ data: { closing } })))

beforeEach(() => {
  jest.useFakeTimers()
  mockListeners.clear()
})

afterEach(() => {
  jest.useRealTimers()
})

test('starts false and turns true at the end of the opening push', () => {
  const tree = mount()
  expect(done(tree)).toBe(false)

  end(false)

  expect(done(tree)).toBe(true)
})

test('the screen leaving is not the end of its push', () => {
  const tree = mount()

  end(true)

  expect(done(tree)).toBe(false)
})

test('a missed event never leaves it false past the bound', () => {
  const tree = mount()

  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(TRANSITION_BOUND_MS - 1)
  })
  expect(done(tree)).toBe(false)

  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(1)
  })
  expect(done(tree)).toBe(true)
})

test('leaving stops listening and stops the timer', () => {
  const tree = mount()
  expect(mockListeners.size).toBe(1)

  ReactTestRenderer.act(() => tree.unmount())

  expect(mockListeners.size).toBe(0)
  expect(jest.getTimerCount()).toBe(0)
})
