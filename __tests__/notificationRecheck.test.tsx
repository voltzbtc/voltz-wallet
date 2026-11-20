import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState } from 'react-native'
import { useNotificationRecheck } from '../src/hooks/useNotificationRecheck'
import { recheckNotifications } from '../src/wallet/pushToken'
import { sendDeviceForgets } from '../src/wallet/deviceForget'

// The system settings are another app, so a return from the background is when notifications may have
// been turned off or on there, and a start and every such return are when an earlier run's forgets
// go again.

jest.mock('../src/wallet/pushToken', () => ({ recheckNotifications: jest.fn(async () => undefined) }))
jest.mock('../src/wallet/deviceForget', () => ({ sendDeviceForgets: jest.fn(async () => undefined) }))

let handler: ((state: string) => void) | null = null

function Probe(): null {
  useNotificationRecheck()
  return null
}

beforeEach(() => {
  jest.clearAllMocks()
  handler = null
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, listener: (state: string) => void) => {
    handler = listener
    return { remove: jest.fn() }
  }) as never)
})

test('a start sends the forgets an earlier run left owed', async () => {
  await ReactTestRenderer.act(async () => {
    ReactTestRenderer.create(<Probe />)
  })
  expect(sendDeviceForgets).toHaveBeenCalledTimes(1)
  expect(recheckNotifications).not.toHaveBeenCalled()
})

test('a return from the background reads the system answer again and sends the forgets, and the shade alone does neither', async () => {
  await ReactTestRenderer.act(async () => {
    ReactTestRenderer.create(<Probe />)
  })
  handler!('inactive')
  handler!('active')
  expect(recheckNotifications).not.toHaveBeenCalled()
  expect(sendDeviceForgets).toHaveBeenCalledTimes(1)
  handler!('background')
  handler!('active')
  expect(recheckNotifications).toHaveBeenCalledTimes(1)
  // The forgets go again on the return whatever the system answers, since the network may be back.
  expect(sendDeviceForgets).toHaveBeenCalledTimes(2)
  handler!('active')
  expect(recheckNotifications).toHaveBeenCalledTimes(1)
  expect(sendDeviceForgets).toHaveBeenCalledTimes(2)
})
