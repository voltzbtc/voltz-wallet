import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { DollarModeProvider, useAccent, useDollarMode } from '../src/wallet/dollarMode'
import {
  sparkConnectedWalletId,
  sparkGetStableBalance,
  sparkSubscribeToPayments,
} from '../src/wallet/spark'
import { loadDollarMode, saveDollarMode } from '../src/wallet/settings'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { colors } from '../src/theme'

// The callbacks are captured so each test drives reconnect and wallet switch. A connect callback
// fires on registration when a wallet is connected, as the real onSparkConnected does.
const connectCbs: (() => void)[] = []
const stableCbs: ((on: boolean) => void)[] = []
const walletCbs: ((id: string) => void)[] = []

jest.mock('../src/wallet/spark', () => ({
  sparkGetStableBalance: jest.fn(),
  sparkConnectedWalletId: jest.fn(),
  onSparkConnected: (cb: () => void) => {
    connectCbs.push(cb)
    if (jest.requireMock('../src/wallet/spark').sparkConnectedWalletId() !== null) {
      cb()
    }
    return () => undefined
  },
  sparkSubscribeToPayments: jest.fn().mockResolvedValue(() => undefined),
  onStableBalanceChanged: (cb: (on: boolean) => void) => {
    stableCbs.push(cb)
    return () => undefined
  },
}))
jest.mock('../src/wallet/wallet', () => ({
  onActiveWalletChanged: (cb: (id: string) => void) => {
    walletCbs.push(cb)
    return () => undefined
  },
}))
jest.mock('../src/wallet/settings', () => ({
  loadDollarMode: jest.fn(),
  saveDollarMode: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(),
}))

// The probe paints the accent a screen would use, so assertions read the color, not the flag.
function Probe(): React.JSX.Element {
  const { accent } = useAccent()
  const on = useDollarMode()
  return <Text>{`${accent}|${on}`}</Text>
}

async function render(initial = false): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <DollarModeProvider initial={initial}>
        <Probe />
      </DollarModeProvider>,
    )
  })
  await settle()
  return tree
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

function shown(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root.findByType(Text).props.children as string
}

beforeEach(() => {
  jest.clearAllMocks()
  connectCbs.length = 0
  stableCbs.length = 0
  walletCbs.length = 0
  jest.mocked(sparkGetStableBalance).mockReset().mockResolvedValue(false)
  jest.mocked(sparkConnectedWalletId).mockReturnValue('w1')
  jest.mocked(loadDollarMode).mockResolvedValue(false)
  jest.mocked(getActiveWalletId).mockResolvedValue('w1')
})

afterEach(() => {
  jest.useRealTimers()
})

test('the accent is the bitcoin orange while the dollar wallet is off', async () => {
  const tree = await render()
  expect(shown(tree)).toBe(`${colors.primary}|false`)
})

test('the accent turns green once the SDK reports the dollar wallet on', async () => {
  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  const tree = await render()
  expect(shown(tree)).toBe(`${colors.dollar}|true`)
})

test('a wallet switch repaints from that wallet cache, without waiting for the reconnect', async () => {
  // The SDK reports the previous wallet for the seconds a reconnect takes, so the incoming wallet's
  // own cached mode is what keeps a bitcoin wallet from opening green.
  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  const tree = await render()
  expect(shown(tree)).toBe(`${colors.dollar}|true`)

  jest.mocked(loadDollarMode).mockResolvedValue(false)
  await ReactTestRenderer.act(async () => {
    walletCbs.forEach(cb => cb('w2'))
  })
  await settle()

  expect(loadDollarMode).toHaveBeenCalledWith('w2')
  expect(shown(tree)).toBe(`${colors.primary}|false`)
})

test('a cache saying on gives way to the SDK answering off', async () => {
  jest.mocked(sparkGetStableBalance).mockResolvedValue(false)

  const tree = await render(true)

  expect(shown(tree)).toBe(`${colors.primary}|false`)
  expect(saveDollarMode).toHaveBeenCalledWith('w1', false)
})

test('the SDK answer is cached under the active wallet, so the next launch opens correct', async () => {
  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  jest.mocked(getActiveWalletId).mockResolvedValue('w9')
  jest.mocked(sparkConnectedWalletId).mockReturnValue('w9')

  await render()

  expect(saveDollarMode).toHaveBeenCalledWith('w9', true)
})

test('the seeded mode paints before the SDK answers, which is what removes the launch flash', async () => {
  // The boot cache decides the first frame, so a slow connect never paints the wrong accent.
  let resolveSdk: (v: boolean) => void = () => undefined
  jest.mocked(sparkGetStableBalance).mockReturnValue(
    new Promise<boolean>(resolve => {
      resolveSdk = resolve
    }),
  )

  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <DollarModeProvider initial>
        <Probe />
      </DollarModeProvider>,
    )
  })

  expect(shown(tree)).toBe(`${colors.dollar}|true`)

  await ReactTestRenderer.act(async () => {
    resolveSdk(true)
  })
  await settle()
  expect(shown(tree)).toBe(`${colors.dollar}|true`)
})

test('a reconnect re-reads the mode, since switching wallets swaps the SDK instance', async () => {
  const tree = await render()
  expect(shown(tree)).toBe(`${colors.primary}|false`)

  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  await ReactTestRenderer.act(async () => {
    connectCbs.forEach(cb => cb())
  })
  await settle()

  expect(shown(tree)).toBe(`${colors.dollar}|true`)
})

test('flipping the switch repaints at once, without waiting for a payment or a reconnect', async () => {
  // Nothing else reports this change, so without the announcement the accent stays on the old mode
  // until something unrelated happens.
  const tree = await render()
  expect(shown(tree)).toBe(`${colors.primary}|false`)

  await ReactTestRenderer.act(async () => {
    stableCbs.forEach(cb => cb(true))
  })

  expect(shown(tree)).toBe(`${colors.dollar}|true`)

  await ReactTestRenderer.act(async () => {
    stableCbs.forEach(cb => cb(false))
  })

  expect(shown(tree)).toBe(`${colors.primary}|false`)
})

function heldRead(): { read: Promise<boolean>; answer: (on: boolean) => void; fail: () => void } {
  let answer: (on: boolean) => void = () => undefined
  let fail: () => void = () => undefined
  const read = new Promise<boolean>((resolve, reject) => {
    answer = resolve
    fail = () => reject(new Error('network'))
  })
  return { read, answer, fail }
}

test('nothing is read before a wallet is connected, and the connect brings the first read', async () => {
  jest.mocked(sparkConnectedWalletId).mockReturnValue(null)
  const tree = await render()
  expect(sparkGetStableBalance).not.toHaveBeenCalled()
  expect(sparkSubscribeToPayments).not.toHaveBeenCalled()

  jest.mocked(sparkConnectedWalletId).mockReturnValue('w1')
  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  await ReactTestRenderer.act(async () => {
    connectCbs.forEach(cb => cb())
  })
  await settle()

  expect(sparkSubscribeToPayments).toHaveBeenCalledTimes(1)
  expect(shown(tree)).toBe(`${colors.dollar}|true`)
})

test('each connect subscribes on its own instance and drops the previous subscription', async () => {
  const offFirst = jest.fn()
  jest.mocked(sparkSubscribeToPayments).mockResolvedValueOnce(offFirst)
  await render()
  expect(sparkSubscribeToPayments).toHaveBeenCalledTimes(1)
  expect(offFirst).not.toHaveBeenCalled()

  await ReactTestRenderer.act(async () => {
    connectCbs.forEach(cb => cb())
  })
  await settle()

  expect(offFirst).toHaveBeenCalledTimes(1)
  expect(sparkSubscribeToPayments).toHaveBeenCalledTimes(2)
})

test('an SDK event reads the mode again', async () => {
  jest.useFakeTimers()
  const tree = await render()
  expect(shown(tree)).toBe(`${colors.primary}|false`)

  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  const onEvent = jest.mocked(sparkSubscribeToPayments).mock.calls[0][0]
  await ReactTestRenderer.act(async () => {
    onEvent()
    await jest.advanceTimersByTimeAsync(600)
  })
  await settle()

  expect(shown(tree)).toBe(`${colors.dollar}|true`)
})

test('a burst of events is one read', async () => {
  jest.useFakeTimers()
  await render()
  jest.mocked(sparkGetStableBalance).mockClear()
  const onEvent = jest.mocked(sparkSubscribeToPayments).mock.calls[0][0]

  await ReactTestRenderer.act(async () => {
    onEvent()
    onEvent()
    await jest.advanceTimersByTimeAsync(300)
    onEvent()
    await jest.advanceTimersByTimeAsync(300)
  })
  await settle()

  expect(sparkGetStableBalance).toHaveBeenCalledTimes(1)
})

test('a failed read is tried again with no SDK event to ask for it, as offline after a restart', async () => {
  jest.useFakeTimers()
  jest.mocked(sparkGetStableBalance).mockRejectedValue(new Error('network'))
  const tree = await render()
  // The last mode known stays up while nothing can be read, and nothing overwrites the cache.
  expect(shown(tree)).toBe(`${colors.primary}|false`)
  expect(saveDollarMode).not.toHaveBeenCalled()
  expect(sparkGetStableBalance).toHaveBeenCalledTimes(1)

  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(15_000)
  })
  await settle()
  expect(sparkGetStableBalance).toHaveBeenCalledTimes(2)
  expect(shown(tree)).toBe(`${colors.primary}|false`)

  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(15_000)
  })
  await settle()

  expect(sparkGetStableBalance).toHaveBeenCalledTimes(3)
  expect(shown(tree)).toBe(`${colors.dollar}|true`)
  expect(saveDollarMode).toHaveBeenCalledWith('w1', true)

  // An answer ends the retries.
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(60_000)
  })
  expect(sparkGetStableBalance).toHaveBeenCalledTimes(3)
})

test('a seeded mode survives a failed read', async () => {
  jest.useFakeTimers()
  jest.mocked(sparkGetStableBalance).mockRejectedValue(new Error('network'))
  const tree = await render(true)

  expect(shown(tree)).toBe(`${colors.dollar}|true`)
  expect(saveDollarMode).not.toHaveBeenCalled()
})

test('an unmounted provider stops retrying', async () => {
  jest.useFakeTimers()
  jest.mocked(sparkGetStableBalance).mockRejectedValue(new Error('network'))
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })

  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(60_000)
  })

  expect(sparkGetStableBalance).toHaveBeenCalledTimes(1)
})

test('a read that fails after unmount starts no retry', async () => {
  jest.useFakeTimers()
  const held = heldRead()
  jest.mocked(sparkGetStableBalance).mockReturnValueOnce(held.read)
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })

  await ReactTestRenderer.act(async () => {
    held.fail()
  })
  await settle()
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(60_000)
  })

  expect(sparkGetStableBalance).toHaveBeenCalledTimes(1)
})

test('retries end when the wallet disconnects', async () => {
  jest.useFakeTimers()
  jest.mocked(sparkGetStableBalance).mockRejectedValue(new Error('network'))
  await render()
  expect(sparkGetStableBalance).toHaveBeenCalledTimes(1)

  jest.mocked(sparkConnectedWalletId).mockReturnValue(null)
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(60_000)
  })

  expect(sparkGetStableBalance).toHaveBeenCalledTimes(1)
})

test('a failed read behind a newer one leaves the retry to the newer one', async () => {
  jest.useFakeTimers()
  const older = heldRead()
  jest.mocked(sparkGetStableBalance).mockReturnValueOnce(older.read)
  const tree = await render()

  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  await ReactTestRenderer.act(async () => {
    jest.mocked(sparkSubscribeToPayments).mock.calls[0][0]()
    await jest.advanceTimersByTimeAsync(600)
  })
  await settle()
  await ReactTestRenderer.act(async () => {
    older.fail()
  })
  await settle()
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(60_000)
  })

  expect(sparkGetStableBalance).toHaveBeenCalledTimes(2)
  expect(shown(tree)).toBe(`${colors.dollar}|true`)
})

test('a slow read does not overwrite a newer answer', async () => {
  jest.useFakeTimers()
  const older = heldRead()
  jest.mocked(sparkGetStableBalance).mockReturnValueOnce(older.read)
  const tree = await render()

  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  await ReactTestRenderer.act(async () => {
    jest.mocked(sparkSubscribeToPayments).mock.calls[0][0]()
    await jest.advanceTimersByTimeAsync(600)
  })
  await settle()
  expect(shown(tree)).toBe(`${colors.dollar}|true`)

  await ReactTestRenderer.act(async () => {
    older.answer(false)
  })
  await settle()

  expect(shown(tree)).toBe(`${colors.dollar}|true`)
  expect(saveDollarMode).not.toHaveBeenCalledWith('w1', false)
})

test('a read asked before the switch does not undo it', async () => {
  const older = heldRead()
  jest.mocked(sparkGetStableBalance).mockReturnValueOnce(older.read)
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    stableCbs.forEach(cb => cb(true))
  })
  await ReactTestRenderer.act(async () => {
    older.answer(false)
  })
  await settle()

  expect(shown(tree)).toBe(`${colors.dollar}|true`)
  expect(saveDollarMode).not.toHaveBeenCalled()
})

test('an event of the previous wallet, heard before the reconnect, leaves the new wallet alone', async () => {
  // Every SDK event reads now, so the window between a switch and its reconnect is open to them.
  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  const tree = await render()
  expect(shown(tree)).toBe(`${colors.dollar}|true`)
  jest.mocked(saveDollarMode).mockClear()

  jest.mocked(getActiveWalletId).mockResolvedValue('w2')
  await ReactTestRenderer.act(async () => {
    walletCbs.forEach(cb => cb('w2'))
  })
  await settle()
  expect(shown(tree)).toBe(`${colors.primary}|false`)

  await ReactTestRenderer.act(async () => {
    jest.mocked(sparkSubscribeToPayments).mock.calls[0][0]()
  })
  await settle()

  expect(shown(tree)).toBe(`${colors.primary}|false`)
  expect(saveDollarMode).not.toHaveBeenCalled()
})
