import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, Text, View } from 'react-native'
import '../src/i18n'
import { Row } from '../src/components/Row'
import { ScreenTitle } from '../src/components/ScreenTitle'
import { rhythm, space } from '../src/theme'

function render(element: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element)
  })
  return tree
}

const group = (tree: ReactTestRenderer.ReactTestRenderer) =>
  StyleSheet.flatten(tree.root.findAllByType(View)[0]!.props.style)

const texts = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(node => String(node.props.children))

it('holds the rule of the design system, in the values it was written with', () => {
  expect(rhythm).toEqual({
    headerToContent: 24,
    titleToSubtitle: 8,
    titleToContent: 24,
    hintToContent: 16,
    groupToAction: 32,
    sectionLabelToList: 12,
    section: 32,
    searchToList: 8,
  })
})

it('draws no title under a header that carries it, and keeps the subtitle', () => {
  const tree = render(<ScreenTitle subtitle="Under it" />)
  expect(texts(tree)).toEqual(['Under it'])
  expect(tree.root.findAllByProps({ accessibilityRole: 'header' })).toHaveLength(0)
  expect(group(tree).marginBottom).toBe(rhythm.titleToContent)
})

it('draws no empty row for a subtitle alone', () => {
  const tree = render(<ScreenTitle subtitle="Under it" />)
  expect(tree.root.findAllByType(Row)).toHaveLength(0)
})

it('spaces a title from its subtitle and from what follows, and takes no style to change that', () => {
  const style = group(render(<ScreenTitle title="Title" subtitle="Under it" />))
  expect(style.gap).toBe(rhythm.titleToSubtitle)
  expect(style.marginBottom).toBe(rhythm.titleToContent)
  // @ts-expect-error A screen cannot pick its own distance.
  const refused = group(render(<ScreenTitle title="Title" style={{ marginBottom: space.xs }} />))
  expect(refused.marginBottom).toBe(rhythm.titleToContent)
})

it('draws the title, then the subtitle when there is one', () => {
  expect(texts(render(<ScreenTitle title="Title" subtitle="Under it" />))).toEqual(['Title', 'Under it'])
  expect(texts(render(<ScreenTitle title="Title" />))).toEqual(['Title'])
})

it('says it is a heading, so a screen reader can move by it', () => {
  const tree = render(<ScreenTitle title="Title" />)
  expect(tree.root.findAllByProps({ accessibilityRole: 'header' }).length).toBeGreaterThan(0)
})

it('ends a centred group at the distance of its action', () => {
  const style = group(render(<ScreenTitle centered title="Title" />))
  expect(style.alignItems).toBe('center')
  expect(style.marginBottom).toBe(rhythm.groupToAction)
})
