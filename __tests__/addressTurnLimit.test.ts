import RNFS from 'react-native-fs'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import {
  ADDRESS_TURN_LIMIT_MS,
  connectSpark,
  sparkDeleteLnAddress,
  sparkEnsureLnAddress,
  sparkRegisterLnAddress,
} from '../src/wallet/spark'
import { lastLnAddress, rememberLnAddress } from '../src/wallet/lnAddressMemory'

// The address turn's time limit: an automatic work stops starting SDK calls once
// ADDRESS_TURN_LIMIT_MS has passed since its turn began, never abandons the call in flight, and lets
// the work queued behind it run once that call settles.
jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => 'usevoltz.app',
}))
jest.mock('../src/wallet/seed', () => ({
  ...jest.requireActual('../src/wallet/seed'),
  loadSeedFor: jest.fn(async () => 'abandon '.repeat(11) + 'about'),
  loadPassphraseFor: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
  ensureRegistered: jest.fn(),
}))

const sdk = (
  jest.requireMock('@breeztech/breez-sdk-spark-react-native') as {
    __sdkInstance: Record<string, jest.Mock>
  }
).__sdkInstance

const PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

const addressOf = (username: string, host = 'usevoltz.app') => ({
  username,
  lightningAddress: `${username}@${host}`,
  lnurl: { url: `https://${host}/lnurlp`, bech32: 'lnurl1x' },
  description: '',
})

// A call the test answers by hand, at the moment it chooses.
function held<T>(): { promise: Promise<T>; answer: (value: T) => void; fail: (err: unknown) => void } {
  let answer!: (value: T) => void
  let fail!: (err: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    answer = resolve
    fail = reject
  })
  return { promise, answer, fail }
}

let clock = 0
// Lets every chained promise and file read settle, on real timers, since only Date.now is faked.
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.clearAllMocks()
  clock = 1_800_000_000_000
  jest.spyOn(Date, 'now').mockImplementation(() => clock)
  sdk.getInfo.mockResolvedValue({ identityPubkey: PUBKEY, balanceSats: 0n, tokenBalances: new Map() })
  sdk.getLightningAddress.mockResolvedValue(undefined)
  sdk.checkLightningAddressAvailable.mockResolvedValue(true)
  sdk.registerLightningAddress.mockImplementation(async ({ username }: { username: string }) => addressOf(username))
  sdk.deleteLightningAddress.mockResolvedValue(undefined)
  jest.mocked(connect).mockResolvedValue(sdk as never)
  await connectSpark('abandon '.repeat(11) + 'about')
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('a mint loop whose calls stop answering', () => {
  test('starts no call past the limit once the call in flight settles, and the queued register then runs', async () => {
    const check = held<boolean>()
    sdk.checkLightningAddressAvailable.mockReturnValueOnce(check.promise)
    const ensure = sparkEnsureLnAddress()
    await flush()
    expect(sdk.checkLightningAddressAvailable).toHaveBeenCalledTimes(1)

    const chosen = sparkRegisterLnAddress('chosen')
    clock += ADDRESS_TURN_LIMIT_MS + 1
    await flush()
    // The turn is still held by the call in flight: nothing registers beside it.
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()

    // It answers unavailable, which would send the loop to its next name; the limit ends it instead.
    check.answer(false)
    expect(await ensure).toBeNull()
    expect((await chosen)?.address).toBe('chosen@usevoltz.app')
    expect(sdk.checkLightningAddressAvailable).toHaveBeenCalledTimes(1)
    expect(sdk.registerLightningAddress).toHaveBeenCalledTimes(1)
    expect(sdk.registerLightningAddress).toHaveBeenCalledWith({
      username: 'chosen',
      description: 'Pay to chosen@usevoltz.app',
    })
    expect(await lastLnAddress('primary')).toBe('chosen@usevoltz.app')
  })

  test('registers nothing and remembers nothing when the check answers available past the limit', async () => {
    const check = held<boolean>()
    sdk.checkLightningAddressAvailable.mockReturnValueOnce(check.promise)
    const ensure = sparkEnsureLnAddress()
    await flush()
    clock += ADDRESS_TURN_LIMIT_MS
    check.answer(true)
    expect(await ensure).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBeNull()
  })

  test('reads nothing after a register that fails past the limit', async () => {
    const register = held<never>()
    sdk.registerLightningAddress.mockReturnValueOnce(register.promise)
    const ensure = sparkEnsureLnAddress()
    await flush()
    expect(sdk.registerLightningAddress).toHaveBeenCalledTimes(1)
    clock += ADDRESS_TURN_LIMIT_MS + 1
    register.fail(new Error('timed out'))
    expect(await ensure).toBeNull()
    // The ensure's read and the loop's own; the read after a failed register is a call it no longer starts.
    expect(sdk.getLightningAddress).toHaveBeenCalledTimes(2)
    expect(sdk.checkLightningAddressAvailable).toHaveBeenCalledTimes(1)
    expect(await lastLnAddress('primary')).toBeNull()
  })

  test('keeps and notes a register that lands past the limit, since the name was registered', async () => {
    const register = held<ReturnType<typeof addressOf>>()
    sdk.registerLightningAddress.mockReturnValueOnce(register.promise)
    const ensure = sparkEnsureLnAddress()
    await flush()
    clock += ADDRESS_TURN_LIMIT_MS + 1
    register.answer(addressOf('late'))
    expect((await ensure)?.address).toBe('late@usevoltz.app')
    expect(await lastLnAddress('primary')).toBe('late@usevoltz.app')
  })

  test('runs as before inside the limit', async () => {
    sdk.checkLightningAddressAvailable.mockResolvedValueOnce(false)
    const check = held<boolean>()
    sdk.checkLightningAddressAvailable.mockReturnValueOnce(check.promise)
    const ensure = sparkEnsureLnAddress()
    await flush()
    clock += ADDRESS_TURN_LIMIT_MS - 1
    check.answer(true)
    const made = await ensure
    expect(made).not.toBeNull()
    expect(sdk.checkLightningAddressAvailable).toHaveBeenCalledTimes(2)
    expect(sdk.registerLightningAddress).toHaveBeenCalledTimes(1)
    expect(await lastLnAddress('primary')).toBe(made?.address)
  })
})

describe('the limit of a work queued behind another', () => {
  test('counts from when its own turn begins, not from when it was queued', async () => {
    const register = held<never>()
    sdk.registerLightningAddress.mockReturnValueOnce(register.promise)
    const chosen = sparkRegisterLnAddress('chosen').catch((e: unknown) => e)
    await flush()
    const ensure = sparkEnsureLnAddress()
    await flush()
    clock += ADDRESS_TURN_LIMIT_MS - 5_000
    register.fail(new Error('timed out'))
    await chosen
    const check = held<boolean>()
    sdk.checkLightningAddressAvailable.mockReturnValueOnce(check.promise)
    await flush()
    clock += 10_000
    check.answer(true)
    expect(await ensure).not.toBeNull()
    expect(sdk.registerLightningAddress).toHaveBeenCalledTimes(2)
  })
})

describe('the ensure single flight', () => {
  test('hands every screen null after the cut, and the next ensure starts anew', async () => {
    const check = held<boolean>()
    sdk.checkLightningAddressAvailable.mockReturnValueOnce(check.promise)
    const first = sparkEnsureLnAddress()
    const second = sparkEnsureLnAddress()
    await flush()
    clock += ADDRESS_TURN_LIMIT_MS + 1
    check.answer(true)
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    // One ensure ran for both screens: its read and the loop's.
    expect(sdk.getLightningAddress).toHaveBeenCalledTimes(2)

    const next = await sparkEnsureLnAddress()
    expect(next).not.toBeNull()
    expect(sdk.getLightningAddress).toHaveBeenCalledTimes(4)
  })
})

describe('the claim of a name left on another domain', () => {
  test('ends the ensure when cut, rather than falling through to a mint', async () => {
    sdk.getLightningAddress.mockResolvedValue(addressOf('padaria', 'old.example'))
    const check = held<boolean>()
    sdk.checkLightningAddressAvailable.mockReturnValueOnce(check.promise)
    const ensure = sparkEnsureLnAddress()
    await flush()
    clock += ADDRESS_TURN_LIMIT_MS + 1
    check.answer(true)
    expect(await ensure).toBeNull()
    expect(sdk.checkLightningAddressAvailable).toHaveBeenCalledTimes(1)
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBeNull()
  })

  test('starts no availability check once the limit passed during its own read of the address', async () => {
    const theirs = addressOf('padaria', 'old.example')
    const read = held<ReturnType<typeof addressOf>>()
    sdk.getLightningAddress.mockResolvedValueOnce(theirs).mockReturnValueOnce(read.promise)
    const ensure = sparkEnsureLnAddress()
    await flush()
    expect(sdk.getLightningAddress).toHaveBeenCalledTimes(2)
    clock += ADDRESS_TURN_LIMIT_MS + 1
    read.answer(theirs)
    expect(await ensure).toBeNull()
    expect(sdk.checkLightningAddressAvailable).not.toHaveBeenCalled()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })
})

describe('a delete queued behind a cut work', () => {
  test('still runs, and nothing puts the name back', async () => {
    await rememberLnAddress('kept@usevoltz.app', 'primary')
    sdk.getLightningAddress.mockResolvedValue(addressOf('kept', 'old.example'))
    const check = held<boolean>()
    sdk.checkLightningAddressAvailable.mockReturnValueOnce(check.promise)
    const ensure = sparkEnsureLnAddress()
    await flush()
    const removal = sparkDeleteLnAddress()
    clock += ADDRESS_TURN_LIMIT_MS + 1
    check.answer(true)
    expect(await ensure).toBeNull()
    await removal
    expect(sdk.deleteLightningAddress).toHaveBeenCalledTimes(1)
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBeNull()
  })
})
