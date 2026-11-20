import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { SdkEvent_Tags, connect } from '@breeztech/breez-sdk-spark-react-native'
import { useSyncRefresh } from '../src/hooks/useSyncRefresh'
import { SYNC_WAIT_MS, connectSpark, disconnectSpark, sparkNoteResumed } from '../src/wallet/spark'

// useSyncRefresh over the real spark.ts: after a return from the background the live connection's
// wait starts over, and the hook re-arms for it, so a screen moves to the stored figure marked as not
// updated when that wait runs out, or to the synced one when the Synced comes.

jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'wallet-a'),
  ensureRegistered: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/seed', () => ({
  ...jest.requireActual('../src/wallet/seed'),
  loadSeedFor: jest.fn(async () => MNEMONIC),
  loadPassphraseFor: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/lnurlDomainPref', () => ({
  domainFor: jest.fn(async () => undefined),
}))

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

type Listener = { onEvent: (event: unknown) => Promise<void> }
let listener: Listener | null = null
const sdk = {
  getInfo: jest.fn(async () => ({ identityPubkey: '02aa', balanceSats: 0n, tokenBalances: new Map() })),
  addEventListener: jest.fn(async (l: Listener) => {
    listener = l
    return 'listener'
  }),
  disconnect: jest.fn(async () => undefined),
}
const synced = () => listener?.onEvent({ tag: SdkEvent_Tags.Synced })

function Probe({ refresh }: { refresh: () => void }): null {
  useSyncRefresh(refresh)
  return null
}

beforeEach(async () => {
  await disconnectSpark()
  jest.clearAllMocks()
  jest.useFakeTimers()
  jest.mocked(connect).mockImplementation((async () => sdk) as never)
  await connectSpark(MNEMONIC, 'wallet-a')
  await synced()
})

afterEach(() => {
  jest.useRealTimers()
})

test('runs the refresh at the end of the wait that a return from the background starts', async () => {
  const refresh = jest.fn()
  ReactTestRenderer.act(() => {
    ReactTestRenderer.create(React.createElement(Probe, { refresh }))
  })
  // Synced before the mount: nothing is armed and nothing runs.
  await jest.advanceTimersByTimeAsync(SYNC_WAIT_MS)
  expect(refresh).not.toHaveBeenCalled()

  sparkNoteResumed()
  await jest.advanceTimersByTimeAsync(SYNC_WAIT_MS - 1)
  expect(refresh).not.toHaveBeenCalled()
  await jest.advanceTimersByTimeAsync(1)
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('runs it on the Synced after the return, and not again when the wait would have run out', async () => {
  const refresh = jest.fn()
  ReactTestRenderer.act(() => {
    ReactTestRenderer.create(React.createElement(Probe, { refresh }))
  })
  sparkNoteResumed()
  await jest.advanceTimersByTimeAsync(1_000)
  await synced()
  expect(refresh).toHaveBeenCalledTimes(1)
  await jest.advanceTimersByTimeAsync(SYNC_WAIT_MS)
  expect(refresh).toHaveBeenCalledTimes(1)
})
