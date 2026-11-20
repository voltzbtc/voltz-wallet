import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import i18n from '../src/i18n'
import { AppDrawer } from '../src/navigation/AppDrawer'

// The navigator's options are what this module owns, so the drawer itself is replaced by a stand-in
// that keeps them.
const mockOptions: { current?: Record<string, unknown> } = {}
jest.mock('@react-navigation/drawer', () => ({
  createDrawerNavigator: () => ({
    Navigator: ({ screenOptions }: { screenOptions: Record<string, unknown> }) => {
      mockOptions.current = screenOptions
      return null
    },
    Screen: () => null,
  }),
}))
jest.mock('../src/navigation/HomeTabs', () => ({ HomeTabs: () => null }))
jest.mock('../src/navigation/DrawerContent', () => ({ DrawerContent: () => null }))

afterAll(async () => {
  await i18n.changeLanguage('en-US')
})

// The library names the overlay "Close drawer" in English whatever the app's language.
test('the overlay that closes the drawer is named in the app language', async () => {
  await i18n.changeLanguage('de')
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<AppDrawer />)
  })
  expect(mockOptions.current?.overlayAccessibilityLabel).toBe(i18n.t('common.close'))
  expect(i18n.t('common.close')).not.toBe('Close')
  // Inside act, so the tree is gone before afterAll changes the language back.
  ReactTestRenderer.act(() => tree.unmount())
})
