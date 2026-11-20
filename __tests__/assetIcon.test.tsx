import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { AssetIcon } from '../src/components/AssetIcon'
import { BITCOIN_ASSET_ID } from '../src/wallet/assets'
import { DEPIX, USDB } from '../src/wallet/tokens'

const svgMarks = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAll(n => (n.type as unknown) === 'SvgMock').length
const letters = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(n => n.props.children)

function render(assetId: string, ticker: string): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<AssetIcon assetId={assetId} ticker={ticker} />)
  })
  return tree
}

const LOOKALIKE = 'btkn1lookalike'

// A token's name proves nothing, so a mark follows the official identifier alone.
test.each([
  ['USDB', USDB.identifier, USDB.ticker],
  ['DePix', DEPIX.identifier, DEPIX.ticker],
])('%s draws its mark', (_name, assetId, ticker) => {
  const tree = render(assetId, ticker)
  expect(svgMarks(tree)).toBe(1)
  expect(letters(tree)).toEqual([])
})

test.each([
  ['USDB', USDB.ticker, 'U'],
  ['DePix', DEPIX.ticker, 'D'],
])('a lookalike of %s keeps the letter badge', (_name, ticker, letter) => {
  const tree = render(LOOKALIKE, ticker)
  expect(svgMarks(tree)).toBe(0)
  expect(letters(tree)).toEqual([letter])
})

test('Bitcoin draws its mark', () => {
  const tree = render(BITCOIN_ASSET_ID, 'BTC')
  expect(svgMarks(tree)).toBe(1)
  expect(letters(tree)).toEqual([])
})
