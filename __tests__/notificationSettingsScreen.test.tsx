import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking } from 'react-native'
import i18n from '../src/i18n'
import { NotificationSettingsScreen } from '../src/screens/NotificationSettingsScreen'
import { MenuRow } from '../src/components/MenuRow'

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<NotificationSettingsScreen />)
  })
  return tree
}

function row(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAllByType(MenuRow).find(node => node.props.label === i18n.t('notifications.openSystem'))!
}

afterEach(() => {
  jest.restoreAllMocks()
})

test('the row opens the system settings', async () => {
  const settings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined)
  const tree = await render()
  await ReactTestRenderer.act(async () => row(tree).props.onPress())
  expect(settings).toHaveBeenCalledTimes(1)
})

test('settings that refuse to open leave no rejection behind, and the row stays', async () => {
  jest.spyOn(Linking, 'openSettings').mockRejectedValue(new Error('no settings activity'))
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    await expect(row(tree).props.onPress()).resolves.toBeUndefined()
  })
  expect(row(tree)).toBeDefined()
})
