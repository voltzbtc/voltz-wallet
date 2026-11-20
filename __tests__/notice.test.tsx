import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, Text, View } from 'react-native'
import { ErrorBox } from '../src/components/ErrorBox'
import { Notice } from '../src/components/Notice'
import { TabIcon } from '../src/components/TabIcon'
import { colors } from '../src/theme'

function render(node: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(node)
  })
  return tree
}

const painted = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root
    .findAllByType(View)
    .map(n => StyleSheet.flatten(n.props.style) as Record<string, unknown>)
    .find(s => s?.backgroundColor != null)!

// With no outline a state rests on its fill, and a person who cannot tell the fill from a plain card
// rests on the icon, so each state is held to both.
describe.each([
  ['a warning', <Notice><Text>x</Text></Notice>, colors.primarySoft, colors.primary],
  ['an alarm', <Notice tone="danger"><Text>x</Text></Notice>, colors.dangerSoft, colors.danger],
  ['an error', <ErrorBox message="x" />, colors.dangerSoft, colors.danger],
])('%s', (_name, node, fill, mark) => {
  it('is its fill, with no outline', () => {
    const style = painted(render(node))
    expect(style.backgroundColor).toBe(fill)
    expect(style.borderWidth).toBeUndefined()
    expect(style.borderColor).toBeUndefined()
  })

  it('carries the alert icon, so colour is not the only sign', () => {
    const icon = render(node).root.findByType(TabIcon)
    expect(icon.props.name).toBe('alert')
    expect(icon.props.color).toBe(mark)
  })
})
