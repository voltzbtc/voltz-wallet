import { AppState } from 'react-native'
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { useForegroundSync } from '../src/hooks/useForegroundSync'
import { sparkNoteResumed, sparkSyncWallet } from '../src/wallet/spark'

jest.mock('../src/wallet/spark', () => ({
  sparkSyncWallet: jest.fn(async () => undefined),
  sparkNoteResumed: jest.fn(),
}))

function Probe(): null {
  useForegroundSync()
  return null
}

function mount(): void {
  ReactTestRenderer.act(() => {
    ReactTestRenderer.create(React.createElement(Probe))
  })
}

function fire(state: string): void {
  const handler = jest.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1] as (s: string) => void
  handler(state)
}

beforeEach(() => {
  jest.clearAllMocks()
  jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>)
})

// Without this an arrival waits out the SDK's own poll before it shows.
test('coming back to the foreground asks the SDK to sync', () => {
  mount()

  fire('active')

  expect(sparkSyncWallet).toHaveBeenCalledTimes(1)
})

test('going to the background does not', () => {
  mount()

  fire('background')
  fire('inactive')

  expect(sparkSyncWallet).not.toHaveBeenCalled()
  expect(sparkNoteResumed).not.toHaveBeenCalled()
})

// It rejects while locked or onboarding, and there is nothing to sync then.
test('a rejected sync is swallowed rather than crashing the app', async () => {
  jest.mocked(sparkSyncWallet).mockRejectedValue(new Error('not connected'))
  mount()

  expect(() => fire('active')).not.toThrow()
  await Promise.resolve()
})

describe('the balance counted as unsynced again', () => {
  test('on a return from the background, before the sync is asked for', () => {
    const order: string[] = []
    jest.mocked(sparkNoteResumed).mockImplementation(() => {
      order.push('resumed')
    })
    jest.mocked(sparkSyncWallet).mockImplementation(async () => {
      order.push('sync')
    })
    mount()

    fire('background')
    fire('active')

    expect(order).toEqual(['resumed', 'sync'])
  })

  // iOS reports 'background' again on its way back (UIApplicationWillEnterForeground); a pass through
  // 'inactive' on the way does not undo that the app was away.
  test('also when the way back passes through another state', () => {
    mount()

    fire('background')
    fire('inactive')
    fire('active')

    expect(sparkNoteResumed).toHaveBeenCalledTimes(1)
  })

  test("not after 'inactive' alone, which never left the screen", () => {
    mount()

    fire('inactive')
    fire('active')

    expect(sparkNoteResumed).not.toHaveBeenCalled()
    expect(sparkSyncWallet).toHaveBeenCalledTimes(1)
  })

  test('once per return, not on every later activation', () => {
    mount()

    fire('background')
    fire('active')
    fire('inactive')
    fire('active')

    expect(sparkNoteResumed).toHaveBeenCalledTimes(1)
    expect(sparkSyncWallet).toHaveBeenCalledTimes(2)
  })
})
