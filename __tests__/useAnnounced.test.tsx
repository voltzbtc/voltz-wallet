import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo } from 'react-native'
import { useAnnounced } from '../src/hooks/useAnnounced'

function Line({ text }: { text: string | null | undefined }): null {
  useAnnounced(text)
  return null
}

// The preset already mocks the module with a bare jest.fn, which keeps the calls of earlier tests.
let heard: jest.SpyInstance

beforeEach(() => {
  heard = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => undefined)
  heard.mockClear()
})

afterEach(() => {
  heard.mockRestore()
})

function mount(node: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(node)
  })
  return tree
}

function update(tree: ReactTestRenderer.ReactTestRenderer, node: React.JSX.Element): void {
  ReactTestRenderer.act(() => {
    tree.update(node)
  })
}

test('says a line as it appears, and nothing while there is none', () => {
  const tree = mount(<Line text={null} />)
  update(tree, <Line text={undefined} />)
  update(tree, <Line text="" />)
  expect(heard).not.toHaveBeenCalled()

  update(tree, <Line text="Wrong PIN" />)
  expect(heard.mock.calls).toEqual([['Wrong PIN']])
})

test('says a line present on the first render', () => {
  mount(<Line text="Could not load the wallets." />)
  expect(heard.mock.calls).toEqual([['Could not load the wallets.']])
})

test('says each new line, and a render that keeps the line says nothing again', () => {
  const tree = mount(<Line text="Below the minimum" />)
  update(tree, <Line text="Below the minimum" />)
  update(tree, <Line text="Above the maximum" />)
  update(tree, <Line text="Above the maximum" />)
  expect(heard.mock.calls).toEqual([['Below the minimum'], ['Above the maximum']])
})

// A second wrong PIN draws the same words after the first digit cleared them, and is a new error.
test('says the same line again after it went away', () => {
  const tree = mount(<Line text="Wrong PIN" />)
  update(tree, <Line text={null} />)
  update(tree, <Line text="Wrong PIN" />)
  expect(heard.mock.calls).toEqual([['Wrong PIN'], ['Wrong PIN']])
})
