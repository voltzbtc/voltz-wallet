import RNFS from 'react-native-fs'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { forgetExitPlan, saveExitPlan } from '../src/wallet/exitPlan'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { exitHoldOnSend } from '../src/wallet/exitHold'

import { planOf } from './support/exitFixtures'

jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'active'),
}))

const active = jest.mocked(getActiveWalletId)
// The wallet the SDK is connected to, which Send hands in.
let connected: string | null = 'active'

beforeEach(async () => {
  __setEmergencyExitLiveForTests(true)
  jest.clearAllMocks()
  active.mockResolvedValue('active')
  connected = 'active'
  await forgetExitPlan('active')
  await forgetExitPlan('other')
})

afterEach(() => {
  jest.restoreAllMocks()
  __setEmergencyExitLiveForTests(null)
})

test('with the exit switched off nothing is read and nothing holds', async () => {
  await saveExitPlan(planOf({ walletId: 'active' }))
  __setEmergencyExitLiveForTests(false)
  const read = jest.spyOn(RNFS, 'readFile')
  expect(await exitHoldOnSend(connected)).toBe('none')
  expect(read).not.toHaveBeenCalled()
  expect(active).not.toHaveBeenCalled()
})

test('no plan holds nothing', async () => {
  expect(await exitHoldOnSend(connected)).toBe('none')
})

test('a live plan of the wallet holds the send', async () => {
  await saveExitPlan(planOf({ walletId: 'active' }))
  expect(await exitHoldOnSend(connected)).toBe('exit')
})

test.each([
  ['done', undefined],
  ['closed', 'nothing'],
  ['closed', 'later'],
] as const)('a plan that ended (%s, %s) holds nothing', async (verdict, closure) => {
  await saveExitPlan(planOf({ walletId: 'active', verdict, closure }))
  expect(await exitHoldOnSend(connected)).toBe('none')
})

test("another wallet's live plan holds nothing", async () => {
  await saveExitPlan(planOf({ walletId: 'other' }))
  expect(await exitHoldOnSend(connected)).toBe('none')
})

// The connected wallet is the one that signs, which a switch without reconnecting leaves behind.
test('the connected wallet is asked when the active one is another', async () => {
  await saveExitPlan(planOf({ walletId: 'other' }))
  connected = 'other'
  expect(await exitHoldOnSend(connected)).toBe('exit')
})

test('the active wallet is asked when nothing is connected yet', async () => {
  await saveExitPlan(planOf({ walletId: 'active' }))
  connected = null
  expect(await exitHoldOnSend(connected)).toBe('exit')
})

test('a plan the platform will not read holds the send as unread', async () => {
  await saveExitPlan(planOf({ walletId: 'active' }))
  jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('EACCES'))
  expect(await exitHoldOnSend(connected)).toBe('unread')
})

test('a live plan outranks an unread one, whichever is asked first', async () => {
  await saveExitPlan(planOf({ walletId: 'active' }))
  await saveExitPlan(planOf({ walletId: 'other' }))
  connected = 'other'
  const real = RNFS.readFile
  jest
    .spyOn(RNFS, 'readFile')
    .mockImplementation((path: string, encoding?: string) =>
      path.includes('exit-plan-active') ? Promise.reject(new Error('EACCES')) : real(path, encoding),
    )
  expect(await exitHoldOnSend(connected)).toBe('exit')
})

test('a wallet list that cannot be read holds the send as unread', async () => {
  active.mockRejectedValue(new Error('UnreadableFile'))
  expect(await exitHoldOnSend(connected)).toBe('unread')
})

test('a read that never answers holds the send as unread once its wait is over', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
  try {
    active.mockReturnValue(new Promise(() => undefined))
    let answer: string | null = null
    exitHoldOnSend(connected).then(hold => {
      answer = hold
    })
    jest.advanceTimersByTime(4_999)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(answer).toBeNull()
    jest.advanceTimersByTime(1)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(answer).toBe('unread')
  } finally {
    jest.useRealTimers()
  }
})
