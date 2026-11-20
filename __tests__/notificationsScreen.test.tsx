import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import '../src/i18n'
import { NotificationsScreen } from '../src/screens/NotificationsScreen'
import { Screen } from '../src/components/Screen'
import { EmptyState } from '../src/components/EmptyState'

// The empty state is centred by the screen's own centre layout, as every other empty screen is, so it
// scrolls at a large text size and takes the screen's padding rather than a copy of it.
test('the empty state sits in the screen centre layout, with no hand-made centring', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<NotificationsScreen />)
  })
  const screen = tree.root.findByType(Screen)
  expect(screen.props.layout).toBe('center')
  expect(screen.props.contentStyle).toBeUndefined()
  expect(screen.findAllByType(EmptyState)).toHaveLength(1)
  tree.unmount()
})
