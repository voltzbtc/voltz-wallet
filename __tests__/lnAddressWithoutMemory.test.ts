import RNFS from 'react-native-fs'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import {
  lastLnAddress,
  noteNotTakenBack,
  notTakenBack,
  rememberLnAddress,
} from '../src/wallet/lnAddressMemory'
import { NAME_STATE_TIMEOUT_MS, nameStateMessage, type NameState } from '../src/wallet/nameState'
import {
  SparkReconnectBusy,
  connectActiveSpark,
  connectSpark,
  disconnectSpark,
  sparkConnectedWalletId,
  sparkClaimLnAddressTransfer,
  sparkEnsureLnAddress,
  sparkInAddressTurn,
  sparkRefreshTakenBackAddress,
  sparkRegisterLnAddress,
} from '../src/wallet/spark'
import { loadPassphraseFor } from '../src/wallet/seed'
import { getActiveWalletId } from '../src/wallet/walletRegistry'

// The neighbours of the refund path, driven through spark.ts with the SDK mock, a gateway that answers
// POST /api/name/state as each case says, and the gateway's free-name rule: a wallet that has a first
// name registers only that one free, and every other name, generated ones included, is refused.
//
// - A wallet that remembers no name and reads none asks the gateway about its key before it mints.
// - A transfer's claim remembers the name on the wallet that took it and forgets it on the one that
//   gave it, and a name remembered from before a transfer moves on to the first name.
// - A name a refund took back that the SDK's cache still shows reconnects the SDK, once.

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

const HOST = 'usevoltz.app'
const N = 'padaria'
const G = 'swiftotter42'
const M = 'oldname'
const PUB = `02${'b'.repeat(64)}`
const MNEMONIC = `${'abandon '.repeat(11)}about`
// The gateway's id for an annulled credit, the SHA-256 of its payment reference in hex.
const CREDIT = 'a1'.repeat(32)
const annulled = (domain: string, id = CREDIT) => [{ id, domain }]

type Sdk = Record<
  | 'getInfo'
  | 'getLightningAddress'
  | 'checkLightningAddressAvailable'
  | 'registerLightningAddress'
  | 'deleteLightningAddress'
  | 'signMessage'
  | 'disconnect'
  | 'claimLightningAddressTransfer',
  jest.Mock
>
const sdk = (jest.requireMock('@breeztech/breez-sdk-spark-react-native') as { __sdkInstance: Sdk })
  .__sdkInstance
// The binding's mock has neither; the statement is signed and the claim made through them.
sdk.signMessage = jest.fn()
sdk.claimLightningAddressTransfer = jest.fn()

const info = (username: string) => ({
  username,
  lightningAddress: `${username}@${HOST}`,
  lnurl: { url: `https://${HOST}/lnurlp/${username}`, bech32: `lnurl1${username}` },
  description: '',
})

// What the SDK reads back is whatever was registered last, as on the device.
let sdkHolds: string | undefined
// The gateway's free-name rule, under which a wallet with a first name gets only that one free.
let firstClaim: string | null

const fetchMock = jest.fn()
;(globalThis as { fetch: unknown }).fetch = fetchMock

// The gateway's answer about the key alone: nothing live, the first name G held for this wallet.
function keyState(over: Partial<NameState> = {}): NameState {
  return {
    host: HOST,
    name: null,
    live: null,
    takenBack: null,
    given: G,
    givenHeldBy: 'you',
    askedHeldBy: null,
    serverNow: 1_800_000_000,
    ...over,
  }
}

// The answer about a name, taken back by a refund unless the case says otherwise.
function nameState(name: string, over: Partial<NameState> = {}): NameState {
  return {
    host: HOST,
    name,
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
  firstClaim = G
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  jest.mocked(connect).mockResolvedValue(sdk as never)
  sdk.getInfo.mockResolvedValue({ identityPubkey: PUB, balanceSats: 0n, tokenBalances: new Map() })
  sdk.signMessage.mockResolvedValue({ signature: '3044sig', pubkey: PUB })
  sdk.getLightningAddress.mockImplementation(async () => (sdkHolds ? info(sdkHolds) : undefined))
  sdk.checkLightningAddressAvailable.mockResolvedValue(true)
  sdk.registerLightningAddress.mockImplementation(async ({ username }: { username: string }) => {
    if (firstClaim !== null && username !== firstClaim) {
      throw new Error('payment_required')
    }
    sdkHolds = username
    return info(username)
  })
  sdk.claimLightningAddressTransfer.mockImplementation(async () => {
    sdkHolds = N
    return info(N)
  })
  fetchMock.mockImplementation(answering(200, keyState()))
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  await connectSpark(MNEMONIC)
})

afterEach(() => {
  jest.restoreAllMocks()
})

const registered = () => sdk.registerLightningAddress.mock.calls.map(([req]) => req.username)
const sentBodies = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)))

describe('a wallet that remembers no name and reads none', () => {
  test('asks about its key once and takes its first name back, never a generated one', async () => {
    expect(await lastLnAddress('primary')).toBeNull()

    expect(await sparkEnsureLnAddress()).toMatchObject({ address: `${G}@${HOST}` })

    expect(registered()).toEqual([G])
    expect(await lastLnAddress('primary')).toBe(`${G}@${HOST}`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://${HOST}/api/name/state`)
    const sent = sentBodies()[0]
    expect('name' in sent).toBe(false)
    expect(sent).toMatchObject({ host: HOST, pubkey: PUB })
    expect(sdk.signMessage).toHaveBeenCalledWith({
      message: nameStateMessage(HOST, PUB, '', sent.timestamp),
      compact: false,
    })
    // The next open reads the address and asks nothing.
    expect(await sparkEnsureLnAddress()).toMatchObject({ address: `${G}@${HOST}` })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('takes a first name held by nobody back as well', async () => {
    fetchMock.mockImplementation(answering(200, keyState({ givenHeldBy: 'nobody' })))
    expect(await sparkEnsureLnAddress()).toMatchObject({ address: `${G}@${HOST}` })
    expect(registered()).toEqual([G])
  })

  test('registers nothing over an address the gateway says is live, and remembers it', async () => {
    fetchMock.mockImplementation(answering(200, keyState({ live: N })))

    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(registered()).toEqual([])
    expect(sdk.checkLightningAddressAvailable).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBe(`${N}@${HOST}`)

    // Later, with the gateway not answering, the remembered name is claimed back, never minted over.
    fetchMock.mockImplementation(async () => Promise.reject(new Error('offline')))
    sdk.checkLightningAddressAvailable.mockImplementation(
      async ({ username }: { username: string }) => username !== N,
    )
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(registered()).toEqual([])
  })

  test('registers nothing when the first name is held by another wallet, and says why', async () => {
    fetchMock.mockImplementation(answering(200, keyState({ givenHeldBy: 'another' })))
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(registered()).toEqual([])
    expect(console.warn).toHaveBeenCalledWith('lightning address not started:', 'given_held_by_another')
  })

  test('mints as a new wallet does when it has no first name', async () => {
    firstClaim = null
    fetchMock.mockImplementation(answering(200, keyState({ given: null, givenHeldBy: null })))
    const got = await sparkEnsureLnAddress()
    expect(got).not.toBeNull()
    expect(registered()).toHaveLength(1)
    expect(registered()[0]).not.toBe(G)
  })

  test('never mints when its first name cannot be had right now', async () => {
    sdk.checkLightningAddressAvailable.mockImplementation(
      async ({ username }: { username: string }) => username !== G,
    )
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(registered()).toEqual([])
    expect(await lastLnAddress('primary')).toBeNull()
  })

  test.each<[string, () => Promise<unknown>]>([
    ['a gateway older than the read (400)', answering(400, { error: 'missing_fields' })],
    ['a gateway without the route (404)', answering(404, { error: 'not_found' })],
    ['a 503', answering(503, { error: 'name_holder_unavailable' })],
    ['an answer about a name', answering(200, nameState(N))],
    ['a network failure', async () => Promise.reject(new Error('offline'))],
  ])('with %s mints as before, once asked', async (_what, reply) => {
    fetchMock.mockImplementation(reply)
    firstClaim = null
    expect(await sparkEnsureLnAddress()).not.toBeNull()
    expect(registered()).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('with no answer and a first name, the mint the guard refuses leaves it as before', async () => {
    fetchMock.mockImplementation(answering(400, { error: 'missing_fields' }))
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(registered()).toHaveLength(5)
    expect(registered()).not.toContain(G)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a gateway that never answers is no answer after the timeout', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    try {
      fetchMock.mockImplementation(() => new Promise(() => undefined))
      firstClaim = null
      const run = sparkEnsureLnAddress()
      await until(() => fetchMock.mock.calls.length === 1)
      jest.advanceTimersByTime(NAME_STATE_TIMEOUT_MS)
      expect(await run).not.toBeNull()
      expect(registered()).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test('screens asking at once share one ensure and one question to the gateway', async () => {
    const answer = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementation(() => answer.promise)
    const runs = [sparkEnsureLnAddress(), sparkEnsureLnAddress(), sparkEnsureLnAddress()]
    await until(() => fetchMock.mock.calls.length === 1)
    answer.resolve({ status: 200, json: async () => keyState() })
    for (const got of await Promise.all(runs)) {
      expect(got).toMatchObject({ address: `${G}@${HOST}` })
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(registered()).toEqual([G])
  })

  test('a name the customer registers while the gateway answers is the one kept', async () => {
    firstClaim = null
    const answer = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementation(() => answer.promise)
    const run = sparkEnsureLnAddress()
    await until(() => fetchMock.mock.calls.length === 1)
    expect(await sparkRegisterLnAddress('chosen')).toMatchObject({ address: `chosen@${HOST}` })
    answer.resolve({ status: 200, json: async () => keyState() })

    expect(await run).toMatchObject({ address: `chosen@${HOST}` })
    expect(registered()).toEqual(['chosen'])
    expect(await lastLnAddress('primary')).toBe(`chosen@${HOST}`)
  })

  test('a live address the gateway names is not noted over a name the customer chose meanwhile', async () => {
    firstClaim = null
    const answer = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementation(() => answer.promise)
    const run = sparkEnsureLnAddress()
    await until(() => fetchMock.mock.calls.length === 1)
    await sparkRegisterLnAddress('chosen')
    answer.resolve({ status: 200, json: async () => keyState({ live: N }) })

    expect(await run).toBeNull()
    expect(await lastLnAddress('primary')).toBe(`chosen@${HOST}`)
  })

  test('a wallet switch while the gateway answers registers and notes nothing', async () => {
    const answer = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementation(() => answer.promise)
    const run = sparkEnsureLnAddress()
    await until(() => fetchMock.mock.calls.length === 1)
    jest.mocked(getActiveWalletId).mockResolvedValue('other')
    answer.resolve({ status: 200, json: async () => keyState() })

    expect(await run).toBeNull()
    expect(registered()).toEqual([])
    expect(await lastLnAddress('primary')).toBeNull()
    expect(await lastLnAddress('other')).toBeNull()
  })

  test('a wallet that remembers a name asks about that name, never about its key alone', async () => {
    await rememberLnAddress(`${N}@${HOST}`, 'primary')
    fetchMock.mockImplementation(answering(200, nameState(N)))
    expect(await sparkEnsureLnAddress()).toMatchObject({ address: `${G}@${HOST}` })
    expect(sentBodies()).toEqual([expect.objectContaining({ name: N })])
  })
})

describe('a transfer', () => {
  const auth = { username: N, pubkey: PUB, signature: 'sig', domain: HOST, timestamp: 1n }

  test('remembers the name on the wallet that took it and forgets it on the one that gave it', async () => {
    await rememberLnAddress(`${M}@${HOST}`, 'primary')
    await rememberLnAddress(`${N}@${HOST}`, 'source')
    await rememberLnAddress(`kept@${HOST}`, 'bystander')

    const got = await sparkClaimLnAddressTransfer(auth, 'source')

    expect(got.address).toBe(`${N}@${HOST}`)
    expect(await lastLnAddress('primary')).toBe(`${N}@${HOST}`)
    expect(await lastLnAddress('source')).toBeNull()
    expect(await lastLnAddress('bystander')).toBe(`kept@${HOST}`)
  })

  test('a claim that fails changes neither memory', async () => {
    await rememberLnAddress(`${M}@${HOST}`, 'primary')
    await rememberLnAddress(`${N}@${HOST}`, 'source')
    sdk.claimLightningAddressTransfer.mockRejectedValue(new Error('transfer refused'))

    await expect(sparkClaimLnAddressTransfer(auth, 'source')).rejects.toThrow('transfer refused')

    expect(await lastLnAddress('primary')).toBe(`${M}@${HOST}`)
    expect(await lastLnAddress('source')).toBe(`${N}@${HOST}`)
  })

  test('a claim that names no source, or names the wallet itself, only remembers', async () => {
    await rememberLnAddress(`${N}@${HOST}`, 'source')
    await sparkClaimLnAddressTransfer(auth)
    expect(await lastLnAddress('primary')).toBe(`${N}@${HOST}`)
    expect(await lastLnAddress('source')).toBe(`${N}@${HOST}`)
    await sparkClaimLnAddressTransfer(auth, 'primary')
    expect(await lastLnAddress('primary')).toBe(`${N}@${HOST}`)
  })

  test('a name remembered from before a transfer, now another wallet\'s, moves on to the first name', async () => {
    await rememberLnAddress(`${N}@${HOST}`, 'primary')
    sdk.checkLightningAddressAvailable.mockImplementation(
      async ({ username }: { username: string }) => username !== N,
    )
    fetchMock.mockImplementation(
      answering(200, nameState(N, { takenBack: null, askedHeldBy: 'another' })),
    )

    expect(await sparkEnsureLnAddress()).toMatchObject({ address: `${G}@${HOST}` })
    expect(registered()).toEqual([G])
    expect(await lastLnAddress('primary')).toBe(`${G}@${HOST}`)
  })

  test('a name moved away that was the first one registers nothing', async () => {
    await rememberLnAddress(`${N}@${HOST}`, 'primary')
    firstClaim = N
    sdk.checkLightningAddressAvailable.mockImplementation(
      async ({ username }: { username: string }) => username !== N,
    )
    fetchMock.mockImplementation(
      answering(
        200,
        nameState(N, { takenBack: null, askedHeldBy: 'another', given: N, givenHeldBy: 'another' }),
      ),
    )
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(registered()).toEqual([])
  })

  test('an older gateway, which never says whose the name is, claims it back as before', async () => {
    await rememberLnAddress(`${N}@${HOST}`, 'primary')
    sdk.checkLightningAddressAvailable.mockImplementation(
      async ({ username }: { username: string }) => username !== N,
    )
    const older: Record<string, unknown> = { ...nameState(N, { takenBack: null }) }
    delete older.askedHeldBy
    fetchMock.mockImplementation(answering(200, older))
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(registered()).toEqual([])
    expect(sdk.checkLightningAddressAvailable).toHaveBeenCalledWith({ username: N })
  })
})

describe('a name a refund took back that the SDK cache still shows', () => {
  // The process keeps which wallet and name it reconnected for, so each case shows its own name.
  const reconnects = () => jest.mocked(connect).mock.calls.length

  test('reconnects the SDK once, and the next ensure lands on the first name', async () => {
    const name = 'refunded1'
    await rememberLnAddress(`${name}@${HOST}`, 'primary')
    sdkHolds = name
    fetchMock.mockImplementation(answering(200, nameState(name)))
    const before = reconnects()

    expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(true)
    expect(reconnects()).toBe(before + 1)
    expect(sdk.disconnect).toHaveBeenCalledTimes(1)
    expect(sentBodies()).toEqual([expect.objectContaining({ name })])

    // The same refund seen again, on this connection or the next, reconnects nothing and asks nothing.
    expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(false)
    expect(reconnects()).toBe(before + 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // The connect's own recovery finds no address for the key, and the cache reads empty.
    sdkHolds = undefined
    expect(await sparkEnsureLnAddress()).toMatchObject({ address: `${G}@${HOST}` })

    // The annulled credit stays listed, and the first name is asked about once, then never again.
    fetchMock.mockImplementation(answering(200, nameState(G, { takenBack: null, live: G })))
    for (let sweep = 0; sweep < 3; sweep++) {
      expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(false)
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sentBodies()[2]).toMatchObject({ name: G })
    expect(await notTakenBack('primary', [CREDIT])).toBe(`${G}@${HOST}`)
  })

  test('a name the gateway says is live, or not taken back, reconnects nothing', async () => {
    const before = reconnects()
    for (const [name, over] of [
      ['refunded2a', { live: 'refunded2a', takenBack: null }],
      ['refunded2b', { takenBack: null }],
      ['refunded2c', { live: 'refunded2c' }],
    ] as const) {
      sdkHolds = name
      fetchMock.mockImplementation(answering(200, nameState(name, over)))
      expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(false)
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(reconnects()).toBe(before)
    expect(sdk.disconnect).not.toHaveBeenCalled()
  })

  test('a name answered once is not asked about again by the sweeps that follow', async () => {
    const name = 'refunded7'
    sdkHolds = name
    fetchMock.mockImplementation(answering(200, nameState(name, { takenBack: null })))
    for (let sweep = 0; sweep < 3; sweep++) {
      expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(false)
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Not the remembered address, so nothing is kept beyond this process.
    expect(await notTakenBack('primary', [CREDIT])).toBeNull()
  })

  test('the remembered address answered as not taken back is kept, and asked about no more', async () => {
    const name = 'refunded8'
    await rememberLnAddress(`${name}@${HOST}`, 'primary')
    sdkHolds = name
    fetchMock.mockImplementation(answering(200, nameState(name, { takenBack: null })))
    expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(false)
    expect(await notTakenBack('primary', [CREDIT])).toBe(`${name}@${HOST}`)
  })

  test('a process that finds the note asks nothing about the remembered address', async () => {
    // As after a restart: the note was written by an earlier process, and this one never asked.
    const name = 'refunded9'
    await rememberLnAddress(`${name}@${HOST}`, 'primary')
    await noteNotTakenBack(`${name}@${HOST}`, 'primary', [CREDIT])
    sdkHolds = name
    fetchMock.mockImplementation(answering(200, nameState(name)))
    expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sdk.disconnect).not.toHaveBeenCalled()
  })

  // An annulled spare credit on the domain, beside the name the wallet bought there: the name is answered
  // as kept, and its own refund later annuls a credit of its own, which this answer never covered.
  describe('a later refund of the kept address', () => {
    const spare = 'b2'.repeat(32)
    const bought = 'c3'.repeat(32)

    test('in the process that asked, asks once more and reconnects', async () => {
      const name = 'refunded12'
      await rememberLnAddress(`${name}@${HOST}`, 'primary')
      sdkHolds = name
      fetchMock.mockImplementation(answering(200, nameState(name, { takenBack: null })))
      const before = reconnects()
      expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST, spare))).toBe(false)
      expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST, spare))).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      fetchMock.mockImplementation(answering(200, nameState(name)))
      expect(await sparkRefreshTakenBackAddress('primary', [...annulled(HOST, spare), ...annulled(HOST, bought)])).toBe(
        true,
      )
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(reconnects()).toBe(before + 1)
    })

    test('after a restart, asks once more and reconnects', async () => {
      const name = 'refunded13'
      await rememberLnAddress(`${name}@${HOST}`, 'primary')
      await noteNotTakenBack(`${name}@${HOST}`, 'primary', [spare])
      sdkHolds = name
      fetchMock.mockImplementation(answering(200, nameState(name)))
      const before = reconnects()
      // A credit annulled on another domain is no refund of this address.
      expect(
        await sparkRefreshTakenBackAddress('primary', [...annulled(HOST, spare), ...annulled('outro.app', bought)]),
      ).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()

      expect(await sparkRefreshTakenBackAddress('primary', [...annulled(HOST, spare), ...annulled(HOST, bought)])).toBe(
        true,
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(reconnects()).toBe(before + 1)
    })

    test('answered as kept again, is asked about no more', async () => {
      const name = 'refunded14'
      await rememberLnAddress(`${name}@${HOST}`, 'primary')
      await noteNotTakenBack(`${name}@${HOST}`, 'primary', [spare])
      sdkHolds = name
      fetchMock.mockImplementation(answering(200, nameState(name, { takenBack: null })))
      const both = [...annulled(HOST, spare), ...annulled(HOST, bought)]
      for (let sweep = 0; sweep < 3; sweep++) {
        expect(await sparkRefreshTakenBackAddress('primary', both)).toBe(false)
      }
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(await notTakenBack('primary', [spare, bought])).toBe(`${name}@${HOST}`)
    })
  })

  test('a note about another address than the cached one asks as before', async () => {
    const name = 'refunded10'
    await rememberLnAddress(`kept10@${HOST}`, 'primary')
    await noteNotTakenBack(`kept10@${HOST}`, 'primary', [CREDIT])
    sdkHolds = name
    fetchMock.mockImplementation(answering(200, nameState(name)))
    expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('no answer reconnects nothing, and a later sweep may ask again', async () => {
    const name = 'refunded3'
    sdkHolds = name
    const before = reconnects()
    fetchMock.mockImplementation(async () => Promise.reject(new Error('offline')))
    expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(false)
    fetchMock.mockImplementation(answering(200, nameState(name)))
    expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(true)
    expect(reconnects()).toBe(before + 1)
  })

  test('an address on a domain with no annulled credit, or none at all, asks nothing', async () => {
    sdkHolds = 'refunded4'
    expect(await sparkRefreshTakenBackAddress('primary', annulled('outro.app'))).toBe(false)
    sdkHolds = undefined
    expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('another wallet connected, or another active, reconnects nothing', async () => {
    const name = 'refunded5'
    sdkHolds = name
    fetchMock.mockImplementation(answering(200, nameState(name)))
    const before = reconnects()
    expect(await sparkRefreshTakenBackAddress('other', annulled(HOST))).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    jest.mocked(getActiveWalletId).mockResolvedValue('other')
    expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(false)
    expect(reconnects()).toBe(before)
    expect(sdk.disconnect).not.toHaveBeenCalled()
  })

  test('an address that changed while the gateway answered reconnects nothing', async () => {
    const name = 'refunded6'
    sdkHolds = name
    const answer = deferred<{ status: number; json: () => Promise<unknown> }>()
    fetchMock.mockImplementation(() => answer.promise)
    const before = reconnects()
    const run = sparkRefreshTakenBackAddress('primary', annulled(HOST))
    await until(() => fetchMock.mock.calls.length === 1)
    firstClaim = null
    await sparkRegisterLnAddress('chosen')
    answer.resolve({ status: 200, json: async () => nameState(name) })
    expect(await run).toBe(false)
    expect(reconnects()).toBe(before)
  })
})

describe('the refresh reconnects outside the address turn', () => {
  const reconnects = () => jest.mocked(connect).mock.calls.length
  const auth = { username: N, pubkey: PUB, signature: 'sig', domain: HOST, timestamp: 1n }

  test('an address change asked for while it connects is not held behind it', async () => {
    const name = 'turnfree1'
    sdkHolds = name
    fetchMock.mockImplementation(answering(200, nameState(name)))
    const landing = deferred<typeof sdk>()
    jest.mocked(connect).mockImplementationOnce(() => landing.promise as never)
    const before = reconnects()
    const run = sparkRefreshTakenBackAddress('primary', annulled(HOST))
    await until(() => reconnects() === before + 1)

    let ran = false
    await sparkInAddressTurn(async () => {
      ran = true
    })
    expect(ran).toBe(true)

    landing.resolve(sdk)
    expect(await run).toBe(true)
  })

  test('an address change queued once it decided skips the reconnect and says so, and the next sweep does it', async () => {
    const name = 'turnfree2'
    sdkHolds = name
    fetchMock.mockImplementation(answering(200, nameState(name)))
    const reread = deferred<ReturnType<typeof info>>()
    sdk.getLightningAddress
      .mockImplementationOnce(async () => info(name))
      .mockImplementationOnce(() => reread.promise)
    const before = reconnects()
    const run = sparkRefreshTakenBackAddress('primary', annulled(HOST))
    await until(() => sdk.getLightningAddress.mock.calls.length === 2)
    const gate = deferred<void>()
    const change = sparkInAddressTurn(() => gate.promise)
    reread.resolve(info(name))

    await expect(run).rejects.toBeInstanceOf(SparkReconnectBusy)
    expect(sdk.disconnect).not.toHaveBeenCalled()
    expect(reconnects()).toBe(before)

    gate.resolve()
    await change
    expect(await sparkRefreshTakenBackAddress('primary', annulled(HOST))).toBe(true)
    expect(reconnects()).toBe(before + 1)
  })

  test('a register asked on a connection a reconnect replaced registers nothing', async () => {
    firstClaim = null
    const gate = deferred<void>()
    const ahead = sparkInAddressTurn(() => gate.promise)
    const choosing = sparkRegisterLnAddress('chosen')
    await disconnectSpark()
    await connectSpark(MNEMONIC)
    gate.resolve()
    await ahead

    expect(await choosing).toBeNull()
    expect(registered()).toEqual([])
    expect(await lastLnAddress('primary')).toBeNull()
  })

  test('a transfer claim asked on a connection a reconnect replaced claims nothing', async () => {
    await rememberLnAddress(`${N}@${HOST}`, 'source')
    const gate = deferred<void>()
    const ahead = sparkInAddressTurn(() => gate.promise)
    const claiming = sparkClaimLnAddressTransfer(auth, 'source').catch((err: unknown) => err)
    await disconnectSpark()
    await connectSpark(MNEMONIC)
    gate.resolve()
    await ahead

    expect(await claiming).toEqual(new Error('spark connection replaced before the claim'))
    expect(sdk.claimLightningAddressTransfer).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBeNull()
    expect(await lastLnAddress('source')).toBe(`${N}@${HOST}`)
  })
})

describe('the refresh yields to a connect asked for another wallet', () => {
  const reconnects = () => jest.mocked(connect).mock.calls.length

  test('a switch that lands while it reads the active wallet is not cut, and the refresh is skipped', async () => {
    const name = 'yield1'
    sdkHolds = name
    fetchMock.mockImplementation(answering(200, nameState(name)))
    const reads = () => jest.mocked(getActiveWalletId).mock.calls.length
    const passphrases = () => jest.mocked(loadPassphraseFor).mock.calls.length
    const read = deferred<string>()
    jest.mocked(getActiveWalletId).mockImplementationOnce(() => read.promise)
    const passphrase = deferred<undefined>()
    jest.mocked(loadPassphraseFor).mockImplementationOnce(() => passphrase.promise)
    const readsBefore = reads()
    const passphrasesBefore = passphrases()
    const before = reconnects()

    const run = sparkRefreshTakenBackAddress('primary', annulled(HOST))
    await until(() => reads() === readsBefore + 1)
    // Meanwhile the registry moves to Y and Y's connect waits on its passphrase, while the refresh's
    // read of the active wallet answers what it read before the switch.
    jest.mocked(getActiveWalletId).mockResolvedValue('Y')
    const switching = connectActiveSpark().then(
      () => 'connected',
      (err: unknown) => (err as Error).name,
    )
    await until(() => passphrases() === passphrasesBefore + 1)
    read.resolve('primary')
    passphrase.resolve(undefined)

    expect(await switching).toBe('connected')
    expect(await run).toBe(false)
    expect(sparkConnectedWalletId()).toBe('Y')
    expect(reconnects()).toBe(before + 1)
  })

  test('a connect asked for a named wallet runs first and keeps its wallet, and the refresh is skipped', async () => {
    const name = 'yield2'
    sdkHolds = name
    fetchMock.mockImplementation(answering(200, nameState(name)))
    const passphrases = () => jest.mocked(loadPassphraseFor).mock.calls.length
    const passphrase = deferred<undefined>()
    jest.mocked(loadPassphraseFor).mockImplementationOnce(() => passphrase.promise)
    const passphrasesBefore = passphrases()
    const before = reconnects()

    // As an import connects its new wallet by id, with the registry still on the active one.
    const importing = connectSpark(MNEMONIC, 'Z').then(
      () => 'connected',
      (err: unknown) => (err as Error).name,
    )
    await until(() => passphrases() === passphrasesBefore + 1)
    const reads = () => jest.mocked(getActiveWalletId).mock.calls.length
    const readsBefore = reads()
    const run = sparkRefreshTakenBackAddress('primary', annulled(HOST))
    // The refresh has read the active wallet and asked for its connect turn, behind the import's.
    await until(() => reads() === readsBefore + 1)
    await new Promise(resolve => setImmediate(resolve))
    passphrase.resolve(undefined)

    expect(await importing).toBe('connected')
    expect(await run).toBe(false)
    expect(sparkConnectedWalletId()).toBe('Z')
    expect(reconnects()).toBe(before + 1)
  })

  test('a switch asked for while it connects cuts it, and it answers skipped', async () => {
    const name = 'yield3'
    sdkHolds = name
    fetchMock.mockImplementation(answering(200, nameState(name)))
    const landing = deferred<typeof sdk>()
    jest.mocked(connect).mockImplementationOnce(() => landing.promise as never)
    const before = reconnects()
    const run = sparkRefreshTakenBackAddress('primary', annulled(HOST))
    await until(() => reconnects() === before + 1)

    jest.mocked(getActiveWalletId).mockResolvedValue('Y')
    const switching = connectActiveSpark()
    expect(await run).toBe(false)
    landing.resolve(sdk)
    await switching
    expect(sparkConnectedWalletId()).toBe('Y')
  })
})
