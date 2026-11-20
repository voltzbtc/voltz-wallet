import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, Text } from 'react-native'
import { SegmentedControl } from '../src/components/SegmentedControl'
import { colors } from '../src/theme'

function render(): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <SegmentedControl
        options={[
          { label: 'Spark', value: 'spark' },
          { label: 'Lightning', value: 'ln' },
        ]}
        value="spark"
        onChange={() => undefined}
      />,
    )
  })
  return tree
}

function segment(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  return tree.root
    .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.style === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === label))!
}

const fill = (node: ReturnType<typeof segment>, pressed: boolean) =>
  StyleSheet.flatten(node.props.style({ pressed })).backgroundColor

// A segment that changes nothing under the finger reads as dead until the choice lands.
test('a segment not chosen lights up while pressed, from the theme', () => {
  const tree = render()
  const other = segment(tree, 'Lightning')
  expect(fill(other, false)).toBeUndefined()
  expect(fill(other, true)).toBe(colors.pressedOverlay)
})

test('the chosen segment keeps its own fill while pressed', () => {
  const tree = render()
  const chosen = segment(tree, 'Spark')
  expect(fill(chosen, true)).toBe(colors.surface)
})
