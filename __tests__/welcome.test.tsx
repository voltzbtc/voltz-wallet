import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import RNFS from 'react-native-fs'
import App from '../App'
import { Touch } from '../src/components/Touch'

jest.mock('../src/navigation/RootNavigator', () => {
  const react = require('react')
  const { Text: RNText } = require('react-native')
  return { RootNavigator: () => react.createElement(RNText, null, 'NAVIGATOR') }
})

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

async function welcome(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />)
  })
  for (let i = 0; i < 4; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
  return tree
}

// The way in besides Create is a Touch link, as on Add wallet, so it takes its floor and dims under a
// finger.
test('Import on the welcome is a link that answers a press', async () => {
  const tree = await welcome()
  const link = tree.root
    .findAllByType(Touch)
    .find(node => node.findAllByType(Text).some(text => text.props.children === 'I already have a wallet'))
  expect(link?.props.feedback).toBe('link')
})
