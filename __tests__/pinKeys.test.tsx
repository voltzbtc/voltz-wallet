import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, View } from 'react-native'
import { LiquidGlassView } from '@callstack/liquid-glass'
import '../src/i18n'
import { PinScreen } from '../src/screens/PinScreen'
import { DollarModeProvider } from '../src/wallet/dollarMode'
import { colors } from '../src/theme'

// As on iOS 26, where the native glass is available and draws a light rim the theme cannot reach.
jest.mock('@callstack/liquid-glass', () => ({
  ...jest.requireActual('../__mocks__/@callstack/liquid-glass'),
  isLiquidGlassSupported: true,
}))

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <DollarModeProvider>
        <PinScreen mode="enter" onDone={async () => undefined} />
      </DollarModeProvider>,
    )
  })
  return tree
}

test('the keys are the same solid fill where the native glass exists, with no outline', async () => {
  const tree = await render()
  const faces = tree.root
    .findAllByType(View)
    .map(node => StyleSheet.flatten(node.props.style) ?? {})
    .filter(style => style.width === 72 && style.overflow === 'hidden')

  expect(tree.root.findAllByType(LiquidGlassView)).toHaveLength(0)
  // Ten digits, and the slot of the key that is not there.
  expect(faces.filter(style => style.backgroundColor === colors.surface)).toHaveLength(10)
  expect(faces.every(style => style.borderWidth === undefined)).toBe(true)
})
