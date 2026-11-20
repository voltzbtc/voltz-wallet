import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { usePendingDeposits } from '../src/hooks/usePendingDeposits'
import { sparkListUnclaimedDeposits, type SparkDeposit } from '../src/wallet/spark'
import { depositsRereadLimitMs } from '../src/components/UnclaimedDepositsCard'

jest.mock('../src/wallet/spark', () => ({
  SYNC_WAIT_MS: 12_000,
  sparkListUnclaimedDeposits: jest.fn(),
  sparkClaimDeposit: jest.fn(),
}))

const mockSwitch: { fire?: () => void } = {}
jest.mock('../src/wallet/wallet', () => ({
  onActiveWalletChanged: (cb: () => void) => {
    mockSwitch.fire = cb
    return () => undefined
  },
}))

const row: SparkDeposit = { txid: 'tx', vout: 0, amountSat: 42_000, claimable: false, stage: 'arriving', refundable: false }

let hook: ReturnType<typeof usePendingDeposits>
function Harness(): null {
  hook = usePendingDeposits()
  return null
}

async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<Harness />)
  })
  return tree
}

async function read(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    hook.read()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  jest.mocked(sparkListUnclaimedDeposits).mockReset()
})

afterEach(() => {
  jest.useRealTimers()
})

test('a read in flight keeps the rows on screen, so a refresh does not blink', async () => {
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([row])
  await mount()
  await read()
  expect(hook.deposits).toEqual([row])

  jest.mocked(sparkListUnclaimedDeposits).mockReturnValueOnce(new Promise(() => undefined))
  await read()
  expect(hook.deposits).toEqual([row])
})

test('a read that fails clears the rows rather than keeping an old claim of money on its way', async () => {
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([row])
  await mount()
  await read()

  jest.mocked(sparkListUnclaimedDeposits).mockRejectedValueOnce(new Error('offline'))
  await read()
  expect(hook.deposits).toEqual([])
})

test('a read past the limit counts as failed', async () => {
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([row])
  await mount()
  await read()

  jest.useFakeTimers()
  jest.mocked(sparkListUnclaimedDeposits).mockReturnValueOnce(new Promise(() => undefined))
  await read()
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(depositsRereadLimitMs())
  })
  expect(hook.deposits).toEqual([])
})

test('an older read answering after a newer one lands nothing', async () => {
  await mount()
  let older!: (list: SparkDeposit[]) => void
  jest.mocked(sparkListUnclaimedDeposits).mockReturnValueOnce(new Promise(r => (older = r)))
  await read()
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([])
  await read()

  await ReactTestRenderer.act(async () => older([row]))
  expect(hook.deposits).toEqual([])
})

test('a wallet switch clears the rows and drops the read still out', async () => {
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([row])
  await mount()
  await read()

  let answer!: (list: SparkDeposit[]) => void
  jest.mocked(sparkListUnclaimedDeposits).mockReturnValueOnce(new Promise(r => (answer = r)))
  await read()

  await ReactTestRenderer.act(async () => mockSwitch.fire?.())
  expect(hook.deposits).toEqual([])

  await ReactTestRenderer.act(async () => answer([row]))
  expect(hook.deposits).toEqual([])
})
