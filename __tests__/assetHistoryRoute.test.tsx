import React from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import ReactTestRenderer from 'react-test-renderer'
import { AssetHistoryScreen } from '../src/screens/AssetHistoryScreen'
import { HistoryScreen } from '../src/screens/HistoryScreen'

jest.mock('../src/screens/HistoryScreen', () => ({ HistoryScreen: () => null }))
jest.mock('@react-navigation/native', () => ({ useRoute: () => ({ params: { assetId: 'btkn1usdb' } }) }))

test('the route narrows the same list to its asset', () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<AssetHistoryScreen />)
  })

  expect(tree.root.findByType(HistoryScreen).props.assetId).toBe('btkn1usdb')
})

// The param list typechecks without the screen, and See all would then navigate nowhere.
test('the navigator registers it', () => {
  const navigator = readFileSync(join(__dirname, '../src/navigation/RootNavigator.tsx'), 'utf8')

  expect(navigator).toContain('name="AssetHistory"')
  expect(navigator).toContain('component={AssetHistoryScreen}')
})
