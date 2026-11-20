import { connect } from '@breeztech/breez-sdk-spark-react-native'
import {
  LANDING_WAIT_MS,
  SparkConnectBusy,
  SparkConnectSuperseded,
  connectActiveSpark,
  connectSpark,
  connectedLnurlDomain,
  disconnectSpark,
  sparkConnectedWalletId,
  sparkGetBalanceSat,
} from '../src/wallet/spark'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { domainFor } from '../src/wallet/lnurlDomainPref'
import { classifyWalletError } from '../src/wallet/errors'

// Connects and disconnects take turns through the real spark.ts, over a binding that hands out a new
// instance per connect and answers only when the test says. At most one instance is live, it is the
// one the newest request wanted, and an instance no request wants is disconnected.

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
  domainFor: jest.fn(async (walletId: string) => `${walletId}.example`),
}))

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

type Instance = {
  id: number
  getInfo: jest.Mock
  addEventListener: jest.Mock
  disconnect: jest.Mock
}

// Every instance the binding handed out, in connect order, and the release of each held connect.
let made: Instance[]
let pending: Array<() => void>

function instance(id: number): Instance {
  return {
    id,
    getInfo: jest.fn(async () => ({ identityPubkey: '02aa', balanceSats: BigInt(id), tokenBalances: new Map() })),
    addEventListener: jest.fn(async () => `listener_${id}`),
    disconnect: jest.fn(async () => undefined),
  }
}

// Each connect makes its instance at once and answers when the test releases it, oldest first.
function holdConnects(): void {
  jest.mocked(connect).mockImplementation(
    () =>
      new Promise(resolve => {
        const sdk = instance(made.length + 1)
        made.push(sdk)
        pending.push(() => resolve(sdk as never))
      }) as never,
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

async function release(index: number): Promise<void> {
  pending[index]()
  await flush()
}

// Marks a request whose rejection the test reads later, so it never counts as unhandled meanwhile.
function track<T>(request: Promise<T>): Promise<T> {
  request.catch(() => undefined)
  return request
}

const active = (walletId: string) => jest.mocked(getActiveWalletId).mockResolvedValue(walletId)

// What the live connection answers: each instance reports its own number as the balance.
const liveInstance = async () => sparkGetBalanceSat()

beforeEach(async () => {
  jest.mocked(connect).mockImplementation((async () => instance(0)) as never)
  await disconnectSpark()
  jest.clearAllMocks()
  made = []
  pending = []
  active('wallet-a')
  holdConnects()
})

describe('a switch while the previous wallet is still connecting', () => {
  // The new wallet connects first and the previous one lands after it.
  test('the previous connect landing late is disconnected and never replaces the new wallet', async () => {
    const first = track(connectActiveSpark())
    await flush()
    expect(made).toHaveLength(1)

    active('wallet-b')
    const second = connectActiveSpark()
    await flush()
    expect(made).toHaveLength(2)
    await release(1)
    await expect(second).resolves.toBeUndefined()
    expect(sparkConnectedWalletId()).toBe('wallet-b')

    await release(0)
    await expect(first).rejects.toBeInstanceOf(SparkConnectSuperseded)
    expect(sparkConnectedWalletId()).toBe('wallet-b')
    expect(connectedLnurlDomain()).toBe('wallet-b.example')
    expect(await liveInstance()).toBe(2)
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
    expect(made[1].disconnect).not.toHaveBeenCalled()
  })

  test('a connect landing after its wallet was switched away from is not published, even with nothing newer asked', async () => {
    const first = track(connectActiveSpark())
    await flush()

    active('wallet-b')
    await release(0)
    await expect(first).rejects.toBeInstanceOf(SparkConnectSuperseded)
    expect(sparkConnectedWalletId()).toBeNull()
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
  })

  test('explicit connects of two wallets end on the second, with the first disconnected', async () => {
    const first = track(connectSpark(MNEMONIC, 'wallet-a'))
    await flush()
    const second = connectSpark(MNEMONIC, 'wallet-b')
    await flush()
    await release(1)
    await release(0)

    await expect(first).rejects.toBeInstanceOf(SparkConnectSuperseded)
    await expect(second).resolves.toBe(made[1])
    expect(sparkConnectedWalletId()).toBe('wallet-b')
    expect(connectedLnurlDomain()).toBe('wallet-b.example')
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
    expect(made[1].disconnect).not.toHaveBeenCalled()
  })
})

describe('a disconnect while a connect is in flight (removing the active wallet)', () => {
  test('the connect is never published and its instance is disconnected', async () => {
    const first = track(connectActiveSpark())
    await flush()

    const gone = disconnectSpark()
    await flush()
    await expect(gone).resolves.toBeUndefined()

    await release(0)
    await expect(first).rejects.toBeInstanceOf(SparkConnectSuperseded)
    expect(sparkConnectedWalletId()).toBeNull()
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('one request at a time', () => {
  test('a connect asked while a disconnect is still running waits for it, so the SDK is told once', async () => {
    jest.mocked(connect).mockImplementationOnce((async () => {
      const sdk = instance(made.length + 1)
      made.push(sdk)
      return sdk
    }) as never)
    await connectActiveSpark()
    let disconnected!: () => void
    made[0].disconnect.mockImplementationOnce(() => new Promise<void>(resolve => (disconnected = resolve)))

    const gone = disconnectSpark()
    await flush()
    active('wallet-b')
    const next = connectActiveSpark()
    await flush()
    expect(made).toHaveLength(1)

    disconnected()
    await flush()
    await expect(gone).resolves.toBeUndefined()
    expect(made).toHaveLength(2)
    await release(0)
    await expect(next).resolves.toBeUndefined()
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
    expect(sparkConnectedWalletId()).toBe('wallet-b')
  })
})

describe('the same wallet asked for twice', () => {
  test('two requests while the first connects make one instance, and both resolve on it', async () => {
    const first = track(connectActiveSpark())
    await flush()
    const second = connectActiveSpark()
    await flush()
    expect(made).toHaveLength(1)

    await release(0)
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(made).toHaveLength(1)
    expect(sparkConnectedWalletId()).toBe('wallet-a')
    expect(made[0].disconnect).not.toHaveBeenCalled()
  })

  test('a reconnect waits for the earlier connect of the same wallet to land before it connects again', async () => {
    const first = track(connectActiveSpark())
    await flush()

    // What reconnectActiveWallet does, dropping the session and connecting the same wallet afresh.
    const again = disconnectSpark().then(() => connectSpark(MNEMONIC, 'wallet-a'))
    await flush()
    expect(made).toHaveLength(1)

    await release(0)
    await expect(first).rejects.toBeInstanceOf(SparkConnectSuperseded)
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
    expect(made).toHaveLength(2)

    await release(1)
    await expect(again).resolves.toBe(made[1])
    expect(sparkConnectedWalletId()).toBe('wallet-a')
    expect(await liveInstance()).toBe(2)
  })
})

describe('a connect that never answers', () => {
  test('does not stall the next wallet, and is disconnected if it ever lands', async () => {
    track(connectActiveSpark())
    await flush()

    active('wallet-b')
    const next = connectActiveSpark()
    await flush()
    await release(1)
    await expect(next).resolves.toBeUndefined()
    expect(sparkConnectedWalletId()).toBe('wallet-b')

    await release(0)
    expect(sparkConnectedWalletId()).toBe('wallet-b')
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('the connected fast path', () => {
  test('never answers for the live wallet while a request for another one is still being served', async () => {
    jest.mocked(connect).mockImplementation((async () => {
      const sdk = instance(made.length + 1)
      made.push(sdk)
      return sdk
    }) as never)
    await connectActiveSpark()
    expect(sparkConnectedWalletId()).toBe('wallet-a')

    // A connect of another wallet, held while it reads that wallet's domain.
    let domainRead!: () => void
    jest.mocked(domainFor).mockImplementationOnce(
      walletId => new Promise(resolve => (domainRead = () => resolve(`${walletId}.example`))),
    )
    const other = track(connectSpark(MNEMONIC, 'wallet-b'))
    await flush()

    const back = connectActiveSpark()
    await flush()
    domainRead()
    await flush()

    await expect(back).resolves.toBeUndefined()
    await expect(other).rejects.toBeInstanceOf(SparkConnectSuperseded)
    expect(sparkConnectedWalletId()).toBe('wallet-a')
    expect(connectedLnurlDomain()).toBe('wallet-a.example')
    expect(made).toHaveLength(1)
    expect(made[0].disconnect).not.toHaveBeenCalled()
  })
})

// How a request stands, read without waiting on it, so a request that hangs fails the assertion
// instead of the test's timeout. Reading it also marks the rejection as handled.
type Outcome = { state: 'pending' | 'resolved' | 'rejected'; error?: unknown }
function outcome<T>(request: Promise<T>): Outcome {
  const seen: Outcome = { state: 'pending' }
  request.then(
    () => {
      seen.state = 'resolved'
    },
    (error: unknown) => {
      seen.state = 'rejected'
      seen.error = error
    },
  )
  return seen
}

// The instances opened for a wallet that nothing has disconnected, landed or still landing. Each
// connect's config names its wallet through the domain the mock hands out.
const runningOf = (walletId: string) =>
  made.filter(
    (sdk, i) =>
      (jest.mocked(connect).mock.calls[i][0] as { config: { lnurlDomain?: string } }).config.lnurlDomain ===
        `${walletId}.example` && sdk.disconnect.mock.calls.length === 0,
  )

describe('a wallet asked for again while its cut connect is still landing', () => {
  // A is slow, B lands, the person goes back to A, and only then A's first connect lands.
  test('the cut connect never publishes, and the wallet opens again only after it disconnected itself', async () => {
    const first = outcome(connectActiveSpark())
    await flush()

    active('wallet-b')
    const second = connectActiveSpark()
    await flush()
    expect(first.state).toBe('rejected')
    expect(first.error).toBeInstanceOf(SparkConnectSuperseded)
    await release(1)
    await expect(second).resolves.toBeUndefined()

    active('wallet-a')
    const third = outcome(connectActiveSpark())
    await flush()
    expect(made).toHaveLength(2)
    expect(sparkConnectedWalletId()).toBe('wallet-b')

    await release(0)
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
    expect(made[1].disconnect).toHaveBeenCalledTimes(1)
    expect(made).toHaveLength(3)
    expect(runningOf('wallet-a')).toEqual([made[2]])
    expect(sparkConnectedWalletId()).toBeNull()

    await release(2)
    expect(third.state).toBe('resolved')
    expect(sparkConnectedWalletId()).toBe('wallet-a')
    expect(connectedLnurlDomain()).toBe('wallet-a.example')
    expect(await liveInstance()).toBe(3)

    // Back to B, whose earlier instance is gone, so B never runs twice.
    active('wallet-b')
    const fourth = outcome(connectActiveSpark())
    await flush()
    expect(made).toHaveLength(4)
    expect(runningOf('wallet-b')).toEqual([made[3]])
    await release(3)
    expect(fourth.state).toBe('resolved')
    expect(sparkConnectedWalletId()).toBe('wallet-b')
    expect(await liveInstance()).toBe(4)
    expect(made[2].disconnect).toHaveBeenCalledTimes(1)
    expect(made[3].disconnect).not.toHaveBeenCalled()
  })

  // A's first connect never answers while the person goes to B, back to A, and to B again.
  test('a request waiting on its wallet is cut loose at once by a newer one, and a disconnect waits for neither', async () => {
    track(connectActiveSpark())
    await flush()
    active('wallet-b')
    const b1 = connectActiveSpark()
    await flush()
    await release(1)
    await expect(b1).resolves.toBeUndefined()

    active('wallet-a')
    const a2 = outcome(connectActiveSpark())
    await flush()
    expect(a2.state).toBe('pending')

    active('wallet-b')
    const b2 = outcome(connectActiveSpark())
    await flush()
    expect(a2.state).toBe('rejected')
    expect(a2.error).toBeInstanceOf(SparkConnectSuperseded)
    expect(b2.state).toBe('resolved')
    expect(sparkConnectedWalletId()).toBe('wallet-b')
    expect(made).toHaveLength(2)

    const gone = outcome(disconnectSpark())
    await flush()
    expect(gone.state).toBe('resolved')
    expect(sparkConnectedWalletId()).toBeNull()
    expect(made[1].disconnect).toHaveBeenCalledTimes(1)

    await release(0)
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
    expect(sparkConnectedWalletId()).toBeNull()
  })

  test('a disconnect cuts loose a request waiting on its wallet, and returns at once', async () => {
    track(connectActiveSpark())
    await flush()
    active('wallet-b')
    const b1 = connectActiveSpark()
    await flush()
    await release(1)
    await expect(b1).resolves.toBeUndefined()

    active('wallet-a')
    const a2 = outcome(connectActiveSpark())
    await flush()
    expect(a2.state).toBe('pending')

    const gone = outcome(disconnectSpark())
    await flush()
    expect(gone.state).toBe('resolved')
    expect(a2.state).toBe('rejected')
    expect(a2.error).toBeInstanceOf(SparkConnectSuperseded)
    expect(made[1].disconnect).toHaveBeenCalledTimes(1)
    expect(made).toHaveLength(2)

    await release(0)
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
    expect(sparkConnectedWalletId()).toBeNull()
  })

  // What reconnectActiveWallet does, with the first connect hanging for longer than the bound.
  test('a request still waiting when the bound runs out fails as a connection error, without a second instance', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    try {
      track(connectActiveSpark())
      await flush()
      await disconnectSpark()
      const again = outcome(connectSpark(MNEMONIC, 'wallet-a'))
      await flush()

      jest.advanceTimersByTime(LANDING_WAIT_MS - 1)
      await flush()
      expect(again.state).toBe('pending')
      jest.advanceTimersByTime(1)
      await flush()
      expect(again.state).toBe('rejected')
      expect(again.error).toBeInstanceOf(SparkConnectBusy)
      expect(classifyWalletError(again.error)).toBe('offline')
      expect(made).toHaveLength(1)
      expect(sparkConnectedWalletId()).toBeNull()

      // Once the late instance has disconnected itself, trying again opens the wallet.
      await release(0)
      expect(made[0].disconnect).toHaveBeenCalledTimes(1)
      const retry = outcome(connectSpark(MNEMONIC, 'wallet-a'))
      await flush()
      expect(made).toHaveLength(2)
      await release(1)
      expect(retry.state).toBe('resolved')
      expect(sparkConnectedWalletId()).toBe('wallet-a')
    } finally {
      jest.useRealTimers()
    }
  })

  // A disconnect that was called but not yet answered leaves the instance running, so the wallet's
  // next connect waits for the answer, not for the call.
  test('the wallet opens again only once the SDK has answered the disconnect of its cut instance', async () => {
    const first = outcome(connectActiveSpark())
    await flush()
    const answers: Array<() => void> = []
    made[0].disconnect.mockImplementationOnce(() => new Promise<void>(resolve => answers.push(resolve)))

    try {
      // What reconnectActiveWallet does, dropping the session and connecting the same wallet afresh.
      const again = outcome(disconnectSpark().then(() => connectSpark(MNEMONIC, 'wallet-a')))
      await flush()
      await release(0)
      expect(first.state).toBe('rejected')
      expect(first.error).toBeInstanceOf(SparkConnectSuperseded)
      expect(answers).toHaveLength(1)
      expect(made).toHaveLength(1)
      expect(again.state).toBe('pending')
      expect(sparkConnectedWalletId()).toBeNull()

      answers[0]()
      await flush()
      expect(made).toHaveLength(2)
      expect(runningOf('wallet-a')).toEqual([made[1]])
      await release(1)
      expect(again.state).toBe('resolved')
      expect(sparkConnectedWalletId()).toBe('wallet-a')
      expect(connectedLnurlDomain()).toBe('wallet-a.example')
      expect(await liveInstance()).toBe(2)
    } finally {
      // A failure above leaves a connect of wallet-a landing, which would hold the next tests'
      // connects of it, so every held answer is given before the test ends.
      answers.forEach(answer => answer())
      pending.forEach(open => open())
      await flush()
    }
  })
})

describe('a request queued behind a connect of another wallet', () => {
  // A reconnect of A and two focus loads of A are queued, the person moves to B without a reconnect,
  // and the next focus load asks for B while B's connect is still landing.
  test('is cut loose at once by a newer request, without waiting for the connect ahead of it', async () => {
    const reconnect = outcome(connectSpark(MNEMONIC, 'wallet-a'))
    await flush()
    const focus = outcome(connectActiveSpark())
    const later = outcome(connectActiveSpark())
    await flush()
    expect(made).toHaveLength(1)

    active('wallet-b')
    await release(0)
    expect(reconnect.state).toBe('rejected')
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
    expect(made).toHaveLength(2)
    expect(focus.state).toBe('pending')

    const next = outcome(connectActiveSpark())
    await flush()
    expect(later.state).toBe('rejected')
    expect(later.error).toBeInstanceOf(SparkConnectSuperseded)
    expect(focus.state).toBe('pending')

    await release(1)
    expect(focus.state).toBe('resolved')
    expect(next.state).toBe('resolved')
    expect(sparkConnectedWalletId()).toBe('wallet-b')
    expect(made).toHaveLength(2)
  })
})

describe('a landing check that cannot read the registry', () => {
  // Rejected with the read's own error, not as superseded: nothing newer is asked, so a screen that
  // ignores a superseded connect would wait on its skeleton until the next focus.
  test('disconnects the instance it got, is never published, and fails with the read error', async () => {
    const first = outcome(connectActiveSpark())
    await flush()
    expect(made).toHaveLength(1)

    const unreadable = new Error('registry unreadable')
    jest.mocked(getActiveWalletId).mockRejectedValueOnce(unreadable)
    await release(0)
    expect(first.state).toBe('rejected')
    expect(first.error).toBe(unreadable)
    expect(first.error).not.toBeInstanceOf(SparkConnectSuperseded)
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
    expect(sparkConnectedWalletId()).toBeNull()

    const again = outcome(connectActiveSpark())
    await flush()
    expect(made).toHaveLength(2)
    await release(1)
    expect(again.state).toBe('resolved')
    expect(sparkConnectedWalletId()).toBe('wallet-a')
  })
})

describe('a disconnect with a wallet live', () => {
  // The domain is the one the live instance serves, so with nothing live it names no domain at all,
  // never the closed wallet's.
  test('leaves no wallet and no domain named as connected', async () => {
    const first = outcome(connectSpark(MNEMONIC, 'wallet-a'))
    await flush()
    await release(0)
    expect(first.state).toBe('resolved')
    expect(connectedLnurlDomain()).toBe('wallet-a.example')

    await disconnectSpark()
    expect(sparkConnectedWalletId()).toBeNull()
    expect(connectedLnurlDomain()).toBeUndefined()
    expect(made[0].disconnect).toHaveBeenCalledTimes(1)
  })
})
