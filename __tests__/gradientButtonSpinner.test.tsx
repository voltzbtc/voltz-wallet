import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { GradientButton } from '../src/components/GradientButton'
import { Ring } from '../src/components/Ring'
import { DollarModeProvider } from '../src/wallet/dollarMode'
import { colors } from '../src/theme'

// The secondary button's spinner turns its head with the wallet's accent, so its track cannot carry
// the bitcoin orange: in the dollar wallet that is a green head on an orange ring.
it('draws the secondary spinner on a neutral track under the accent head', () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <DollarModeProvider initial>
        <GradientButton label="Retry" variant="secondary" loading onPress={() => undefined} />
      </DollarModeProvider>,
    )
  })
  const rings = tree.root.findAllByType(Ring)
  expect(rings.map(ring => ring.props.color)).toEqual([colors.onPrimaryTrack, colors.dollar])
  // Under a quarter arc the head reads as turning; a whole ring would read as stopped.
  expect(rings[1]!.props.arc).toBeLessThan(1)
  ReactTestRenderer.act(() => tree.unmount())
})
