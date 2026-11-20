import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { ChunkedAddress, groupsOf4 } from '../src/components/ChunkedAddress'

test('a prefix stays whole, so spark1 never reads as spar k1pg', () => {
  expect(groupsOf4('spark1pgssxdcq')).toEqual(['spark1', 'pgss', 'xdcq'])
  expect(groupsOf4('bc1qar0srrr7')).toEqual(['bc1', 'qar0', 'srrr', '7'])
  // The upper case form a QR code carries is the same address.
  expect(groupsOf4('BC1QAR0SRRR7')).toEqual(['BC1', 'QAR0', 'SRRR', '7'])
})

test('an address with no bech32 prefix groups from its first character', () => {
  expect(groupsOf4('1A1zP1eP5')).toEqual(['1A1z', 'P1eP', '5'])
})

// Base58 has letters and a 1 near its start too, as a Tron address does, and a 1 there is no separator.
test('letters and a 1 at the start of a value that is not bech32 are not taken as its prefix', () => {
  expect(groupsOf4('TQ1nZbWhUePEs2bL')).toEqual(['TQ1n', 'ZbWh', 'UePE', 's2bL'])
  // One case, but past its last 1 it holds a b, which bech32 never does.
  expect(groupsOf4('tq1nzbwhuepes2bl')).toEqual(['tq1n', 'zbwh', 'uepe', 's2bl'])
  // Bech32 in shape up to a mixed case, which bech32 refuses.
  expect(groupsOf4('bc1QAR0srrr7')).toEqual(['bc1Q', 'AR0s', 'rrr7'])
})

test('a value too long to compare by eye is cut in the middle, on one line', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ChunkedAddress value={`spark1${'q'.repeat(200)}`} chunked />)
  })
  const [text] = tree.root.findAllByType(Text)
  expect(text!.props.numberOfLines).toBe(1)
  expect(text!.props.ellipsizeMode).toBe('middle')
})
