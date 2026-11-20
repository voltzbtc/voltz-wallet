import RNFS from 'react-native-fs'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import { forgetLnAddress, lastLnAddress, rememberLnAddress } from '../src/wallet/lnAddressMemory'
import { randomUsername } from '../src/wallet/lnaddress'
import { NAME_STATE_TIMEOUT_MS, nameStateMessage, type NameState } from '../src/wallet/nameState'
import {
  connectSpark,
  sparkDeleteLnAddress,
  sparkEnsureLnAddress,
  sparkRegisterLnAddress,
} from '../src/wallet/spark'
import { getActiveWalletId } from '../src/wallet/walletRegistry'

// An empty SDK read for a wallet that remembers a name, driven through sparkEnsureLnAddress with the
// SDK mock and a gateway that answers POST /api/name/state as each case says.

jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => 'usevoltz.app',
}))
jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(async () => 'abandon '.repeat(11) + 'about'),
  loadPassphraseFor: jest.fn(async () => undefined),
  PRIMARY_ID: 'primary',
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'primary'),
  ensureRegistered: jest.fn(),
}))
jest.mock('../src/wallet/fingerprint', () => ({
  fingerprintFromMnemonic: jest.fn(() => 'fp'),
  fingerprintFromMnemonicAsync: jest.fn(async () => 'fp'),
}))
// Real unless a case says otherwise, so the loop can be handed the name a refund took back.
jest.mock('../src/wallet/lnaddress', () => {
  const actual = jest.requireActual('../src/wallet/lnaddress')
  return { ...actual, randomUsername: jest.fn(actual.randomUsername) }
})

const HOST = 'usevoltz.app'
const N = 'padaria'
const G = 'swiftotter42'
const PUB = `02${'b'.repeat(64)}`
const MNEMONIC = `${'abandon '.repeat(11)}about`

type Sdk = Record<
  | 'getInfo'
  | 'getLightningAddress'
  | 'checkLightningAddressAvailable'
  | 'registerLightningAddress'
  | 'deleteLightningAddress'
  | 'signMessage',
  jest.Mock
>
const sdk = (jest.requireMock('@breeztech/breez-sdk-spark-react-native') as { __sdkInstance: Sdk })
  .__sdkInstance
// The binding's mock has no signMessage; the statement is signed through it.
sdk.signMessage = jest.fn()

const info = (username: string) => ({
  username,
  lightningAddress: `${username}@${HOST}`,
  lnurl: { url: `https://${HOST}/lnurlp/${username}`, bech32: `lnurl1${username}` },
  description: '',
})

// What the SDK reads back is whatever was registered last, as on the device.
let sdkHolds: string | undefined

const fetchMock = jest.fn()
;(globalThis as { fetch: unknown }).fetch = fetchMock

function state(over: Partial<NameState> = {}): NameState {
  return {
    host: HOST,
    name: N,
    live: null,
    takenBack: { closedBy: 'refund', closedAt: 1_800_000_000 },
    given: G,
    givenHeldBy: 'you',
    askedHeldBy: 'you',
    serverNow: 1_800_000_000,
    ...over,
  }
}

const answering = (status: number, body: unknown) => async () => ({
  status,
  json: async () => body,
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

// One macrotask, which runs every chained promise however deep, the exit hold's plan read before every
// register included, and stops only at one nothing has settled.
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

// For a step deeper than a fixed flush reaches, such as a register behind the gateway's answer.
const until = async (reached: () => boolean) => {
  for (let i = 0; i < 50 && !reached(); i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(reached()).toBe(true)
}

beforeEach(async () => {
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  sdkHolds = undefined
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  jest.mocked(connect).mockResolvedValue(sdk as never)
  sdk.getInfo.mockResolvedValue({ identityPubkey: PUB, balanceSats: 0n, tokenBalances: new Map() })
  sdk.signMessage.mockResolvedValue({ signature: '3044sig', pubkey: PUB })
  sdk.getLightningAddress.mockImplementation(async () => (sdkHolds ? info(sdkHolds) : undefined))
  sdk.checkLightningAddressAvailable.mockResolvedValue(true)
  sdk.registerLightningAddress.mockImplementation(async ({ username }: { username: string }) => {
    sdkHolds = username
    return info(username)
  })
  sdk.deleteLightningAddress.mockImplementation(async () => {
    sdkHolds = undefined
  })
  fetchMock.mockImplementation(answering(200, state()))
  await connectSpark(MNEMONIC)
  await rememberLnAddress(`${N}@${HOST}`, 'primary')
})

const registered = () => sdk.registerLightningAddress.mock.calls.map(([req]) => req.username)

describe('a name a refund took back', () => {
  test('ends on the first name in one ensure, and the memory follows it', async () => {
    expect(await sparkEnsureLnAddress()).toMatchObject({ address: `${G}@${HOST}` })

    expect(registered()).toEqual([G])
    expect(await lastLnAddress('primary')).toBe(`${G}@${HOST}`)
  })

  test('asks about the remembered name, signed by this wallet over the bytes it sends', async () => {
    await sparkEnsureLnAddress()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://${HOST}/api/name/state`)
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ host: HOST, name: N, pubkey: PUB, signature: '3044sig' })
    expect(sdk.signMessage).toHaveBeenCalledWith({
      message: nameStateMessage(HOST, PUB, N, body.timestamp),
      compact: false,
    })
  })

  test('with no first name, a generated one, and never the name taken back', async () => {
    fetchMock.mockImplementation(answering(200, state({ given: null, givenHeldBy: null })))
    jest.mocked(randomUsername).mockReturnValueOnce(N).mockReturnValueOnce('freshotter11')

    expect(await sparkEnsureLnAddress()).toMatchObject({ address: `freshotter11@${HOST}` })
    expect(registered()).toEqual(['freshotter11'])
  })

  test('a first name that is the name taken back is not registered', async () => {
    fetchMock.mockImplementation(answering(200, state({ given: N })))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(registered()).toEqual([])
    warn.mockRestore()
  })

  test('a first name that cannot be had ends with no address, never a generated one', async () => {
    sdk.checkLightningAddressAvailable.mockResolvedValue(false)

    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(registered()).toEqual([])
    expect(sdk.checkLightningAddressAvailable.mock.calls.map(([req]) => req.username)).toEqual([G])
    expect(randomUsername).not.toHaveBeenCalled()
  })

  test('a first name held for another wallet ends with no address and says why', async () => {
    fetchMock.mockImplementation(answering(200, state({ givenHeldBy: 'another' })))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(registered()).toEqual([])
    expect(randomUsername).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('lightning address not restored:', 'given_held_by_another')
    warn.mockRestore()
  })
})

describe('a name live for this wallet', () => {
  test.each([
    ['the name remembered', N],
    ['another name', 'mercearia'],
  ])('is never replaced when it is %s, even beside a name taken back', async (_what, live) => {
    fetchMock.mockImplementation(answering(200, state({ live })))

    expect(await sparkEnsureLnAddress()).toBeNull()

    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBe(`${N}@${HOST}`)
  })

  // The real server answers a name that is already held as taken, the wallet's own included, and
  // refuses to register it, so the double does both.
  test('the first name live is asked for again, and the server refusing it replaces nothing', async () => {
    fetchMock.mockImplementation(answering(200, state({ live: G })))
    sdk.checkLightningAddressAvailable.mockImplementation(async ({ username }: { username: string }) => username !== G)
    sdk.registerLightningAddress.mockImplementation(async ({ username }: { username: string }) => {
      if (username === G) {
        throw new Error('Taken')
      }
      sdkHolds = username
      return info(username)
    })

    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(sdk.checkLightningAddressAvailable.mock.calls.map(([req]) => req.username)).toEqual([G])
    expect(registered()).toEqual([])
    expect(randomUsername).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBe(`${N}@${HOST}`)
  })
})

// Each way the gateway can fail to answer, against the two cases spark.test.ts pins for a remembered
// name: claimed back when the domain serves, nothing registered when it does not.
const NO_ANSWER: Array<[string, () => Promise<unknown>]> = [
  ['a rejected request', async () => Promise.reject(new Error('offline'))],
  ['401', answering(401, { error: 'invalid_signature' })],
  ['503', answering(503, { error: 'name_holder_unavailable' })],
  ['404 from a gateway without the route', answering(404, { error: 'not_found' })],
  ['a malformed body', answering(200, { ...state(), takenBack: 'yes' })],
  ['an answer about another name', answering(200, state({ name: G }))],
]

describe('with no answer the wallet behaves as before', () => {
  test.each(NO_ANSWER)(
    '%s: the remembered name is claimed back once the domain serves',
    async (_what, reply) => {
      fetchMock.mockImplementation(reply)

      expect(await sparkEnsureLnAddress()).toMatchObject({ address: `${N}@${HOST}` })
      expect(registered()).toEqual([N])
    },
  )

  test.each(NO_ANSWER)(
    '%s: nothing is registered while the domain does not serve',
    async (_what, reply) => {
      fetchMock.mockImplementation(reply)
      sdk.checkLightningAddressAvailable.mockResolvedValue(false)

      expect(await sparkEnsureLnAddress()).toBeNull()
      expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    },
  )

  test('nothing taken back claims the remembered name back', async () => {
    fetchMock.mockImplementation(answering(200, state({ takenBack: null })))

    expect(await sparkEnsureLnAddress()).toMatchObject({ address: `${N}@${HOST}` })
    expect(registered()).toEqual([N])
  })

  test('a gateway that hangs is given up on after the timeout, and the name is claimed back', async () => {
    jest.useFakeTimers()
    try {
      fetchMock.mockImplementation(() => new Promise(() => {}))
      let result: unknown = 'pending'
      const run = sparkEnsureLnAddress().then(value => {
        result = value
      })

      await jest.advanceTimersByTimeAsync(NAME_STATE_TIMEOUT_MS - 1)
      expect(result).toBe('pending')
      expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(1)
      await run

      expect(result).toMatchObject({ address: `${N}@${HOST}` })
      expect(registered()).toEqual([N])
    } finally {
      jest.useRealTimers()
    }
  })

  test('a name remembered on another domain is not asked about', async () => {
    await rememberLnAddress(`${N}@outro.app`, 'primary')

    await sparkEnsureLnAddress()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('one automatic register at a time, and the customer always wins', () => {
  test('two ensures at once ask once and register once', async () => {
    const [a, b] = await Promise.all([sparkEnsureLnAddress(), sparkEnsureLnAddress()])

    expect(a).toMatchObject({ address: `${G}@${HOST}` })
    expect(b).toEqual(a)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(registered()).toEqual([G])
  })

  test('a name chosen while the gateway is asked is the one kept', async () => {
    const answer = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementation(() => answer.promise)

    const ensured = sparkEnsureLnAddress()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await sparkRegisterLnAddress('chosen')
    answer.resolve({ status: 200, json: async () => state() })

    expect(await ensured).toMatchObject({ address: `chosen@${HOST}` })
    expect(registered()).toEqual(['chosen'])
    expect(await lastLnAddress('primary')).toBe(`chosen@${HOST}`)
  })

  test('an automatic register waits for the one the customer started, and then keeps it', async () => {
    const chosen = deferred<ReturnType<typeof info>>()
    sdk.registerLightningAddress.mockImplementationOnce(
      async ({ username }: { username: string }) => {
        const result = await chosen.promise
        sdkHolds = username
        return result
      },
    )

    const choosing = sparkRegisterLnAddress('chosen')
    const ensured = sparkEnsureLnAddress()
    await flush()
    // The gateway has answered and the ensure is waiting its turn behind the customer's register.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(registered()).toEqual(['chosen'])
    chosen.resolve(info('chosen'))
    await choosing

    expect(await ensured).toMatchObject({ address: `chosen@${HOST}` })
    expect(registered()).toEqual(['chosen'])
  })

  // The generated-name path reads the address again inside the turn. Without that read, a wallet
  // with nothing remembered would register a random name over the one the customer just chose,
  // which can be a paid name.
  test('a generated name waits for the one the customer started, and then keeps it', async () => {
    await forgetLnAddress('primary')
    const chosen = deferred<ReturnType<typeof info>>()
    sdk.registerLightningAddress.mockImplementationOnce(
      async ({ username }: { username: string }) => {
        const result = await chosen.promise
        sdkHolds = username
        return result
      },
    )

    const choosing = sparkRegisterLnAddress('chosen')
    const ensured = sparkEnsureLnAddress()
    await flush()
    // The ensure read no address and no memory, asked the gateway about its key alone (the answer
    // here is about a name, so it is no answer), and is waiting its turn to generate one.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect('name' in JSON.parse(String(fetchMock.mock.calls[0][1].body))).toBe(false)
    expect(registered()).toEqual(['chosen'])
    chosen.resolve(info('chosen'))
    await choosing

    expect(await ensured).toMatchObject({ address: `chosen@${HOST}` })
    expect(registered()).toEqual(['chosen'])
  })
})

// A delete forgets the memory before it gives the address up, so an automatic register that finds
// the memory changed inside its turn would be undoing it.
describe('a delete that lands while an ensure waits', () => {
  test.each([
    ['the first name', state()],
    ['a generated name', state({ given: null, givenHeldBy: null })],
    ['the name claimed back', state({ takenBack: null })],
  ])('is not undone by %s queued behind it', async (_what, answer) => {
    const reply = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementation(() => reply.promise)
    const deleting = deferred<void>()
    sdkHolds = undefined
    sdk.deleteLightningAddress.mockImplementationOnce(() => deleting.promise)

    const ensured = sparkEnsureLnAddress()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const deleted = sparkDeleteLnAddress()
    await flush()
    // The gateway answers while the delete still holds the turn, so the register queues behind it.
    reply.resolve({ status: 200, json: async () => answer })
    await flush()
    deleting.resolve()
    await deleted

    expect(await ensured).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBeNull()
  })
})

// The memory read inside the turn is what stops the register when nothing marks the wallet: a name
// forgotten while an ensure waits on the gateway is not registered again.
describe('a memory forgotten while an ensure waits, with no deletion mark', () => {
  test.each([
    ['the first name', state()],
    ['a generated name', state({ given: null, givenHeldBy: null })],
    ['the name claimed back', state({ takenBack: null })],
  ])('%s is not registered', async (_what, answer) => {
    const reply = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementation(() => reply.promise)

    const ensured = sparkEnsureLnAddress()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await forgetLnAddress('primary')
    reply.resolve({ status: 200, json: async () => answer })

    expect(await ensured).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBeNull()
  })
})

// A note written after the turn is released lands after a register queued behind it, and leaves the
// memory naming an address the wallet no longer holds.
describe('the memory is written inside the turn', () => {
  test('a name chosen right after the first name is registered is the one remembered', async () => {
    const first = deferred<void>()
    sdk.registerLightningAddress.mockImplementationOnce(
      async ({ username }: { username: string }) => {
        await first.promise
        sdkHolds = username
        return info(username)
      },
    )

    const ensured = sparkEnsureLnAddress()
    await until(() => registered().length > 0)
    expect(registered()).toEqual([G])
    const choosing = sparkRegisterLnAddress('chosen')
    first.resolve()
    await Promise.all([ensured, choosing])

    expect(registered()).toEqual([G, 'chosen'])
    expect(await lastLnAddress('primary')).toBe(`chosen@${HOST}`)
  })

  test('a name chosen right after one is claimed on the domain in use is the one remembered', async () => {
    await forgetLnAddress('primary')
    sdk.getLightningAddress.mockImplementationOnce(async () => ({
      ...info(N),
      lightningAddress: `${N}@outro.app`,
    }))
    const first = deferred<void>()
    sdk.registerLightningAddress.mockImplementationOnce(
      async ({ username }: { username: string }) => {
        await first.promise
        sdkHolds = username
        return info(username)
      },
    )

    const ensured = sparkEnsureLnAddress()
    await until(() => registered().length > 0)
    expect(registered()).toEqual([N])
    const choosing = sparkRegisterLnAddress('chosen')
    first.resolve()
    await Promise.all([ensured, choosing])

    expect(registered()).toEqual([N, 'chosen'])
    expect(await lastLnAddress('primary')).toBe(`chosen@${HOST}`)
  })
})

describe('a wallet switch while the gateway is asked', () => {
  test('to another active wallet registers and writes nothing', async () => {
    const answer = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementation(() => answer.promise)

    const ensured = sparkEnsureLnAddress()
    await flush()
    jest.mocked(getActiveWalletId).mockResolvedValue('other')
    answer.resolve({ status: 200, json: async () => state() })

    expect(await ensured).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBe(`${N}@${HOST}`)
    expect(await lastLnAddress('other')).toBeNull()
  })

  test('to another connected wallet registers and writes nothing', async () => {
    const answer = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementation(() => answer.promise)

    const ensured = sparkEnsureLnAddress()
    await flush()
    jest.mocked(getActiveWalletId).mockResolvedValue('other')
    await connectSpark(MNEMONIC, 'other')
    answer.resolve({ status: 200, json: async () => state() })

    expect(await ensured).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBe(`${N}@${HOST}`)
    expect(await lastLnAddress('other')).toBeNull()
  })
})

describe('a switch at the last moment', () => {
  test('of the active wallet inside the generated-name loop registers nothing', async () => {
    await forgetLnAddress('primary')
    sdk.checkLightningAddressAvailable.mockImplementation(async () => {
      jest.mocked(getActiveWalletId).mockResolvedValue('other')
      return true
    })

    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBeNull()
  })

  // The active wallet stays the same, so only the connection can tell the ensure it is stale.
  test('of the connection alone registers and writes nothing', async () => {
    const answer = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementation(() => answer.promise)

    const ensured = sparkEnsureLnAddress()
    await flush()
    await connectSpark(MNEMONIC, 'other')
    answer.resolve({ status: 200, json: async () => state() })

    expect(await ensured).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBe(`${N}@${HOST}`)
  })

  test('of the active wallet while the first name registers leaves the note alone', async () => {
    sdk.registerLightningAddress.mockImplementationOnce(
      async ({ username }: { username: string }) => {
        jest.mocked(getActiveWalletId).mockResolvedValue('other')
        sdkHolds = username
        return info(username)
      },
    )

    expect(await sparkEnsureLnAddress()).toMatchObject({ address: `${G}@${HOST}` })
    expect(await lastLnAddress('primary')).toBe(`${N}@${HOST}`)
    expect(await lastLnAddress('other')).toBeNull()
  })
})

describe('one ensure per connection', () => {
  // A wallet switched away and back has a new connection, and the ensure bound to the old one ends
  // with nothing. A screen asking on the new connection gets an ensure of its own.
  test('an ensure on a new connection of the same wallet is not handed the old one', async () => {
    const first = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementationOnce(() => first.promise)

    const stale = sparkEnsureLnAddress()
    await flush()
    await connectSpark(MNEMONIC, 'other')
    await connectSpark(MNEMONIC, 'primary')
    const fresh = sparkEnsureLnAddress()
    first.resolve({ status: 200, json: async () => state() })

    expect(await stale).toBeNull()
    expect(await fresh).toMatchObject({ address: `${G}@${HOST}` })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(registered()).toEqual([G])
  })
})

// An ensure that finds the address already live notes it in the turn too. Noted outside it, the note
// could land after a delete forgot the name and before it wrote its mark, and leave a deleted name
// in the memory for the next screen open to claim back.
describe('an ensure that finds its address live', () => {
  test('notes it behind a delete already holding the turn, so the delete is not undone', async () => {
    sdkHolds = N
    // The ensure has read the memory and the marks and waits on the SDK for the live address. The
    // delete then reads its mark and forgets the name, and that write of the memory is held. Answered
    // now, a note made outside the turn finds no mark yet, queues on the memory right behind the
    // forget and puts the deleted name back before the delete writes its mark; a note made in the turn
    // waits for the delete and finds the mark.
    const live = deferred<ReturnType<typeof info>>()
    sdk.getLightningAddress.mockImplementationOnce(() => live.promise)
    const ensured = sparkEnsureLnAddress()
    await until(() => sdk.getLightningAddress.mock.calls.length > 0)

    const realWrite = RNFS.writeFile.bind(RNFS)
    const forgetWrite = deferred<void>()
    let atForget = false
    jest.spyOn(RNFS, 'writeFile').mockImplementation(async (path: string, text: string, encoding?: string) => {
      if (path.includes('ln-address-last.json') && !atForget) {
        atForget = true
        await forgetWrite.promise
      }
      return realWrite(path, text, encoding)
    })
    const deleted = sparkDeleteLnAddress()
    await until(() => atForget)

    live.resolve(info(N))
    await flush()
    forgetWrite.resolve()
    await deleted
    await ensured

    expect(sdk.deleteLightningAddress).toHaveBeenCalledTimes(1)
    expect(await lastLnAddress('primary')).toBeNull()
  })
})

describe('the memory belongs to the connected wallet', () => {
  test('a chosen name is noted against the wallet that registered it, not the one active by then', async () => {
    jest.mocked(getActiveWalletId).mockResolvedValue('other')

    await sparkRegisterLnAddress('chosen')

    expect(await lastLnAddress('primary')).toBe(`chosen@${HOST}`)
    expect(await lastLnAddress('other')).toBeNull()
  })

  test('a delete forgets the connected wallet, not the one active by then', async () => {
    await rememberLnAddress(`mercearia@${HOST}`, 'other')
    jest.mocked(getActiveWalletId).mockResolvedValue('other')

    await sparkDeleteLnAddress()

    expect(await lastLnAddress('primary')).toBeNull()
    expect(await lastLnAddress('other')).toBe(`mercearia@${HOST}`)
  })
})
