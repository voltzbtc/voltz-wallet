import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { View } from 'react-native'
import '../src/i18n'
import { DiceScreen } from '../src/screens/DiceScreen'
import { ImportScreen } from '../src/screens/ImportScreen'
import { colors } from '../src/theme'

// Add wallet draws these steps inside the navigator, where the accent is green while the dollar
// wallet is on.
jest.mock('../src/wallet/dollarMode', () => {
  const theme = jest.requireActual('../src/theme')
  return { useAccent: () => ({ accent: theme.colors.dollar, gradient: theme.gradients.dollar }) }
})

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

function create(element: React.ReactElement): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element)
  })
  return tree
}

const painted = (tree: ReactTestRenderer.ReactTestRenderer, colour: string) =>
  tree.root.findAllByType(View).filter(node => flat(node.props.style).backgroundColor === colour)

test('the dice progress fills in the accent, not a fixed orange', () => {
  const tree = create(<DiceScreen onGenerated={() => undefined} />)
  const face = tree.root.find(n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === '3')
  ReactTestRenderer.act(() => {
    face.props.onPress()
  })
  const fill = tree.root
    .findAllByType(View)
    .find(node => typeof flat(node.props.style).width === 'string' && flat(node.props.style).height === 6)!
  expect(flat(fill.props.style).backgroundColor).toBe(colors.dollar)
  expect(painted(tree, colors.primary)).toHaveLength(0)
})

test('the restore passphrase switch checks in the accent, not a fixed orange', () => {
  const tree = create(<ImportScreen onImported={() => undefined} />)
  const toggle = tree.root.find(n => typeof n.props.onPress === 'function' && n.props.role === 'switch')
  ReactTestRenderer.act(() => {
    toggle.props.onPress()
  })
  expect(painted(tree, colors.dollar)).toHaveLength(1)
  expect(painted(tree, colors.primary)).toHaveLength(0)
})
