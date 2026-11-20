import { SdkEvent_Tags, connect } from '@breeztech/breez-sdk-spark-react-native'
import {
  SYNC_WAIT_MS,
  connectSpark,
  disconnectSpark,
  disconnectSparkWhenIdle,
  onSparkSynced,
  sparkGetWalletInfo,
  sparkNoteResumed,
  sparkRefreshWallet,
  sparkSyncState,
  sparkSyncWallet,
  sparkSyncWaitLeftMs,
  sparkSyncedBalanceSat,
} from '../src/wallet/spark'

// A pull through the real spark.ts over a binding that answers as the SDK does: syncWallet can resolve
// with no Synced, since the SDK returns Ok over a failed wallet sync with the failure in its answer, so
// only the event proves a sync and only lastSyncError disproves one.

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

type Instance = {
  listener: Listener | null
  getInfo: jest.Mock
  addEventListener: jest.Mock
  syncWallet: jest.Mock
  disconnect: jest.Mock
  synced: () => Promise<void>
}

function instance(): Instance {
  const sdk: Instance = {
    listener: null,
    getInfo: jest.fn(async () => ({ identityPubkey: '02aa', balanceSats: 700n, tokenBalances: new Map() })),
    addEventListener: jest.fn(async (listener: Listener) => {
      sdk.listener = listener
      return 'listener'
    }),
    syncWallet: jest.fn(async () => ({})),
    disconnect: jest.fn(async () => undefined),
    async synced() {
      await sdk.listener?.onEvent({ tag: SdkEvent_Tags.Synced })
    },
  }
  return sdk
}

async function connectWith(walletId = 'wallet-a'): Promise<Instance> {
  const sdk = instance()
  jest.mocked(connect).mockImplementationOnce((async () => sdk) as never)
  await connectSpark(MNEMONIC, walletId)
  return sdk
}

async function syncedConnection(): Promise<Instance> {
  const sdk = await connectWith()
  await sdk.synced()
  expect(sparkSyncState()).toBe('synced')
  return sdk
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

function hanging<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  await disconnectSpark()
  jest.clearAllMocks()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('what a pull proves', () => {
  test('a Synced before syncWallet answers keeps the connection synced', async () => {
    const sdk = await syncedConnection()
    sdk.syncWallet.mockImplementation(async () => {
      await sdk.synced()
      return {}
    })

    await sparkRefreshWallet()

    expect(sparkSyncState()).toBe('synced')
    expect((await sparkGetWalletInfo()).sync).toBe('synced')
  })

  test('a Synced ends the pull while the exit data collection is still out', async () => {
    const sdk = await syncedConnection()
    sdk.syncWallet.mockImplementation(() => hanging<object>().promise)
    let done = false
    sparkRefreshWallet().then(() => {
      done = true
    })
    await flush()
    expect(done).toBe(false)

    await sdk.synced()
    await flush()

    expect(done).toBe(true)
    expect(sparkSyncState()).toBe('synced')
  })

  // The SDK's own path when the wallet sync fails: the error is logged, nothing is emitted, Ok returns.
  test('Ok with no Synced leaves the figure not updated, at once', async () => {
    await syncedConnection()

    await sparkRefreshWallet()

    expect(sparkSyncState()).toBe('stale')
    expect((await sparkGetWalletInfo()).sync).toBe('stale')
    expect(sparkSyncWaitLeftMs()).toBe(0)
  })

  test('a rejection with no Synced does the same', async () => {
    const sdk = await syncedConnection()
    sdk.syncWallet.mockRejectedValue(new Error('network unreachable'))

    await expect(sparkRefreshWallet()).resolves.toBeUndefined()

    expect(sparkSyncState()).toBe('stale')
  })

  test('a call that throws does the same', async () => {
    const sdk = await syncedConnection()
    sdk.syncWallet.mockImplementation(() => {
      throw new Error('binding error')
    })

    await expect(sparkRefreshWallet()).resolves.toBeUndefined()

    expect(sparkSyncState()).toBe('stale')
  })

  test('a connection whose listener never registered has no evidence, so every pull marks it', async () => {
    const sdk = instance()
    sdk.addEventListener.mockRejectedValue(new Error('no listener'))
    jest.mocked(connect).mockImplementationOnce((async () => sdk) as never)
    await connectSpark(MNEMONIC, 'wallet-a')

    await sparkRefreshWallet()

    expect(sparkSyncState()).toBe('stale')
  })

  test('the wait runs out at SYNC_WAIT_MS, and a Synced after it heals the connection', async () => {
    const sdk = await syncedConnection()
    jest.useFakeTimers()
    sdk.syncWallet.mockImplementation(() => hanging<object>().promise)
    const heard = jest.fn()
    const off = onSparkSynced(heard)
    let done = false
    sparkRefreshWallet().then(() => {
      done = true
    })

    await jest.advanceTimersByTimeAsync(SYNC_WAIT_MS - 1)
    expect(done).toBe(false)
    expect(sparkSyncState()).toBe('synced')

    await jest.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(sparkSyncState()).toBe('stale')
    expect(heard).not.toHaveBeenCalled()

    await sdk.synced()
    expect(sparkSyncState()).toBe('synced')
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })

  test('a balance a payment is decided on answers null after a pull that heard no sync', async () => {
    const sdk = await syncedConnection()
    await sparkRefreshWallet()

    await expect(sparkSyncedBalanceSat()).resolves.toBeNull()

    await sdk.synced()
    await expect(sparkSyncedBalanceSat()).resolves.toBe(700)
  })
})

describe('a failure the SDK reports', () => {
  const FAILED = { tag: 'Network', inner: { message: 'dns error: operators.example at 10.0.0.1' } }
  const failing = (sdk: Instance) =>
    sdk.getInfo.mockImplementation(async () => ({
      identityPubkey: '02aa',
      balanceSats: 700n,
      tokenBalances: new Map(),
      lastSyncError: FAILED,
      lastSyncedAt: 1_700_000_000n,
    }))
  const healed = (sdk: Instance) =>
    sdk.getInfo.mockImplementation(async () => ({
      identityPubkey: '02aa',
      balanceSats: 800n,
      tokenBalances: new Map(),
      lastSyncError: undefined,
      lastSyncedAt: 1_700_000_100n,
    }))

  test('a read inside the wait is not updated at once, with no time passing', async () => {
    jest.useFakeTimers()
    const sdk = await connectWith()
    failing(sdk)

    expect((await sparkGetWalletInfo()).sync).toBe('stale')
    expect(sparkSyncState()).toBe('stale')
    expect(sparkSyncWaitLeftMs()).toBe(0)
  })

  test('a read on a synced connection takes the mark off', async () => {
    const sdk = await syncedConnection()
    failing(sdk)

    expect((await sparkGetWalletInfo()).sync).toBe('stale')
    expect(sparkSyncState()).toBe('stale')
  })

  test('the reason never leaves the boundary', async () => {
    const sdk = await connectWith()
    failing(sdk)

    const info = await sparkGetWalletInfo()

    const shown = JSON.stringify(info, (_key, value) => (typeof value === 'bigint' ? `${value}` : value))
    expect(shown).not.toContain('operators.example')
    expect(Object.keys(info).sort()).toEqual(['balanceSat', 'recoverableSat', 'sync', 'tokens'])
    expect(info.sync).toBe('stale')
  })

  test('a Synced for another part of a failed sync does not vouch for the figure', async () => {
    const sdk = await connectWith()
    failing(sdk)
    const notice = jest.fn()
    const off = onSparkSynced(notice)

    await sdk.synced()
    off()

    expect(notice).not.toHaveBeenCalled()
    expect(sparkSyncState()).toBe('stale')
  })

  test('the next Synced with no failure marks it again and brings the re-read', async () => {
    const sdk = await connectWith()
    failing(sdk)
    await sparkGetWalletInfo()
    healed(sdk)
    const notice = jest.fn()
    const off = onSparkSynced(notice)

    await sdk.synced()
    off()

    expect(notice).toHaveBeenCalledTimes(1)
    expect((await sparkGetWalletInfo()).sync).toBe('synced')
  })

  test('a Synced whose read fails proves nothing', async () => {
    const sdk = await connectWith()
    sdk.getInfo.mockRejectedValue(new Error('storage closed'))

    await sdk.synced()

    expect(sparkSyncState()).toBe('waiting')
  })

  test('a Synced held across a resume does not mark the wait that follows it', async () => {
    jest.useFakeTimers()
    const sdk = await connectWith()
    const read = hanging<object>()
    sdk.getInfo.mockReturnValueOnce(read.promise)

    const heard = sdk.synced()
    jest.advanceTimersByTime(1)
    sparkNoteResumed()
    read.resolve({ identityPubkey: '02aa', balanceSats: 700n, tokenBalances: new Map() })
    await heard

    expect(sparkSyncState()).toBe('waiting')
  })

  test('a pull answered with a failure is not updated at once, even past a Synced', async () => {
    const sdk = await syncedConnection()
    sdk.syncWallet.mockImplementation(async () => {
      await sdk.synced()
      return { lastSyncError: FAILED, lastSyncedAt: 1_700_000_000n }
    })

    await sparkRefreshWallet()

    expect(sparkSyncState()).toBe('stale')
    expect(sparkSyncWaitLeftMs()).toBe(0)
  })

  test('an answer landing after the Synced that ended the pull still counts', async () => {
    const sdk = await syncedConnection()
    const answer = hanging<object>()
    sdk.syncWallet.mockReturnValue(answer.promise)
    const pull = sparkRefreshWallet()
    await flush()
    await sdk.synced()
    await pull
    expect(sparkSyncState()).toBe('synced')

    answer.resolve({ lastSyncError: FAILED, lastSyncedAt: 1_700_000_000n })
    await flush()

    expect(sparkSyncState()).toBe('stale')
  })

  // sync.rs sets the failure before it sends the Synced for the part that worked, and the answer lands
  // only after collect_exit_chains, so the read is what tells this Synced from a good one.
  test('a pull ended by a Synced that follows a failure is not updated, with the answer still out', async () => {
    const sdk = await syncedConnection()
    failing(sdk)
    sdk.syncWallet.mockReturnValue(hanging<object>().promise)
    const pull = sparkRefreshWallet()
    await flush()

    await sdk.synced()
    await pull

    expect(sparkSyncState()).toBe('stale')
    expect(sparkSyncWaitLeftMs()).toBe(0)
  })

  test('the pull reads the failure itself, whatever the read the Synced started is doing', async () => {
    const sdk = await syncedConnection()
    sdk.syncWallet.mockReturnValue(hanging<object>().promise)
    failing(sdk)
    sdk.getInfo.mockReturnValueOnce(hanging<object>().promise)
    const pull = sparkRefreshWallet()
    await flush()

    sdk.synced().catch(() => undefined)
    await pull

    expect(sparkSyncState()).toBe('stale')
  })

  test('a pull whose read fails proves nothing, past a Synced', async () => {
    const sdk = await syncedConnection()
    sdk.syncWallet.mockReturnValue(hanging<object>().promise)
    sdk.getInfo.mockRejectedValue(new Error('storage closed'))
    const pull = sparkRefreshWallet()
    await flush()

    await sdk.synced()
    await pull

    expect(sparkSyncState()).toBe('stale')
  })

  test('a read that never answers ends the pull at the same limit, as no proof', async () => {
    jest.useFakeTimers()
    const sdk = await syncedConnection()
    sdk.syncWallet.mockReturnValue(hanging<object>().promise)
    sdk.getInfo.mockReturnValue(hanging<object>().promise)
    const pull = sparkRefreshWallet()
    await jest.advanceTimersByTimeAsync(0)
    sdk.synced().catch(() => undefined)

    await jest.advanceTimersByTimeAsync(SYNC_WAIT_MS)
    await pull

    expect(sparkSyncState()).toBe('stale')
  })

  test('a Synced outside any pull that follows a failure takes the mark off a synced connection', async () => {
    const sdk = await syncedConnection()
    failing(sdk)

    await sdk.synced()

    expect(sparkSyncState()).toBe('stale')
    expect(sparkSyncWaitLeftMs()).toBe(0)
  })

  test('the Synced that follows the failure healing marks the connection again', async () => {
    const sdk = await syncedConnection()
    failing(sdk)
    await sdk.synced()
    const heard = jest.fn()
    onSparkSynced(heard)
    healed(sdk)

    await sdk.synced()

    expect(sparkSyncState()).toBe('synced')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  test('a foreground sync answered with a failure is not updated at once either', async () => {
    const sdk = await syncedConnection()
    sdk.syncWallet.mockResolvedValue({ lastSyncError: FAILED, lastSyncedAt: 1_700_000_000n })

    await sparkSyncWallet()

    expect(sparkSyncState()).toBe('stale')
  })

  test('a balance a payment is decided on answers null when the read reports a failure', async () => {
    const sdk = await syncedConnection()
    failing(sdk)

    await expect(sparkSyncedBalanceSat()).resolves.toBeNull()
    expect(sparkSyncState()).toBe('stale')
  })

  // sync.rs writes last_synced_at to storage and the connect keeps it, so it speaks of an earlier one.
  test('a stored lastSyncedAt counts for nothing on a new connection', async () => {
    jest.useFakeTimers()
    jest.setSystemTime(1_700_000_001_000)
    const sdk = await connectWith()
    sdk.getInfo.mockImplementation(async () => ({
      identityPubkey: '02aa',
      balanceSats: 700n,
      tokenBalances: new Map(),
      lastSyncError: undefined,
      lastSyncedAt: 1_700_000_000n,
    }))

    expect((await sparkGetWalletInfo()).sync).toBe('waiting')
    await jest.advanceTimersByTimeAsync(SYNC_WAIT_MS)
    expect((await sparkGetWalletInfo()).sync).toBe('stale')
  })
})

describe('what a pull leaves alone', () => {
  test('two pulls share one sync', async () => {
    const sdk = await syncedConnection()
    const out = hanging<object>()
    sdk.syncWallet.mockReturnValue(out.promise)

    const first = sparkRefreshWallet()
    const second = sparkRefreshWallet()
    expect(sdk.syncWallet).toHaveBeenCalledTimes(1)

    await sdk.synced()
    out.resolve({})
    await Promise.all([first, second])

    await sparkRefreshWallet()
    expect(sdk.syncWallet).toHaveBeenCalledTimes(2)
  })

  test('a connection replaced mid-pull keeps its own standing', async () => {
    const before = await syncedConnection()
    const out = hanging<object>()
    before.syncWallet.mockReturnValue(out.promise)
    const pull = sparkRefreshWallet()

    const after = await connectWith('wallet-b')
    await after.synced()
    out.resolve({})
    await pull

    expect(sparkSyncState()).toBe('synced')
  })

  test('a pull on the replaced connection does not hold back the new one', async () => {
    const before = await syncedConnection()
    jest.useFakeTimers()
    before.syncWallet.mockReturnValue(hanging<object>().promise)
    sparkRefreshWallet()

    const after = await connectWith('wallet-b')
    await after.synced()
    after.syncWallet.mockImplementation(async () => {
      await after.synced()
      return {}
    })

    await sparkRefreshWallet()

    expect(after.syncWallet).toHaveBeenCalledTimes(1)
  })

  test('a pull in flight neither reconnects nor counts as a send', async () => {
    const sdk = await syncedConnection()
    jest.useFakeTimers()
    sdk.syncWallet.mockReturnValue(hanging<object>().promise)
    const connects = jest.mocked(connect).mock.calls.length

    sparkRefreshWallet()
    await flush()

    expect(jest.mocked(connect).mock.calls.length).toBe(connects)
    expect(sdk.disconnect).not.toHaveBeenCalled()
    await expect(disconnectSparkWhenIdle()).resolves.toBeUndefined()
  })

  test('with nothing connected a pull does nothing', async () => {
    await expect(sparkRefreshWallet()).resolves.toBeUndefined()
    expect(sparkSyncState()).toBe('waiting')
  })
})
