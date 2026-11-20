import * as Keychain from 'react-native-keychain'
import RNFS from 'react-native-fs'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import {
  REFUSAL_READ_FLOOR_SECS,
  checkImportedDeletion,
  ensureLnAddressOrAdopt,
  readDeletionOnFocus,
  settleDeletion,
} from '../src/wallet/deletion'
import {
  findDeletionMark,
  importCheckDue,
  noteGatewayDeleted,
  noteImportCheck,
  writeDeletionMark,
} from '../src/wallet/deletionMark'
import { registerPushDevice } from '../src/wallet/push'
import { confirmName, quoteName } from '../src/wallet/namePurchase'
import { claimDomain, confirmDomain, quoteDomain } from '../src/wallet/domainOnboard'
import { openStoreOrder, recordSpendIntent } from '../src/wallet/storePurchase'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import {
  connectSpark,
  sparkClaimLnAddressTransfer,
  sparkEnsureLnAddress,
  sparkRegisterLnAddress,
} from '../src/wallet/spark'

// A 409 `deleted` from any gateway call, for a wallet this device holds no mark for: the status is
// read once, in the background, and the mark its answer says is written, so the local stops hold the
// wallet before the gateway refuses it again. Real deletion.ts, deletionMark.ts and spark.ts over the
// in-memory fs, with the gateway as a fetch double.
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

const MNEMONIC = `${'abandon '.repeat(11)}about`
const PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const OTHER = `03${'c'.repeat(64)}`
const GATEWAY = 'https://usevoltz.app'
const NOW = 1_800_000_000

const sdk = (
  jest.requireMock('@breeztech/breez-sdk-spark-react-native') as {
    __sdkInstance: Record<string, jest.Mock>
  }
).__sdkInstance
sdk.signMessage = jest.fn()

// The LNURL server's refusal as the binding raises it (docs/breez-sdk-binding.md).
const lnurlDeleted = () => ({
  tag: 'NetworkError',
  inner: ['network request failed with status 409: {"error":"deleted"}'],
})

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

// What the status route answers next: a body, a 503 (no answer), or a call the test answers by hand.
type StatusAnswer = { status: string; requestedAt?: number; finishBy?: number; doneAt?: number } | 'noAnswer' | 'held'
let statusAnswer: StatusAnswer = { status: 'pending', requestedAt: NOW, finishBy: NOW + 30 * 86_400 }
let releaseStatus: ((body: unknown) => void) | null = null
const statusReads = () =>
  fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/api/wallet/delete') && JSON.parse(String(init?.body)).action === 'status').length
const callsTo = (path: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(path)).length

const fetchMock = jest.fn(async (url: string, _init?: RequestInit) => {
  if (url.endsWith('/api/wallet/delete')) {
    if (statusAnswer === 'noAnswer') {
      return reply(503, {})
    }
    if (statusAnswer === 'held') {
      // Each held read is released with the ones before it, so a second read never strands the first.
      return new Promise(resolve => {
        const before = releaseStatus
        releaseStatus = body => {
          before?.(body)
          resolve(reply(200, body))
        }
      })
    }
    return reply(200, statusAnswer)
  }
  return reply(409, { error: 'deleted' })
})
;(globalThis as { fetch: unknown }).fetch = fetchMock

let clock = NOW * 1000
const settle = async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

const sign = async () => 'sig'
const purchaseDeps = { gatewayUrl: GATEWAY, domain: 'usevoltz.app', pubkey: PUBKEY, sign }
const onboardDeps = { gatewayUrl: GATEWAY, ownerPubkey: PUBKEY, sign }
const pushDeps = (pubkey = PUBKEY) => ({
  gatewayUrl: GATEWAY,
  domain: 'usevoltz.app',
  platform: 'ios' as const,
  token: 'device-token',
  identity: async () => pubkey,
  sign,
})

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.clearAllMocks()
  clock += REFUSAL_READ_FLOOR_SECS * 1000 * 10
  jest.spyOn(Date, 'now').mockImplementation(() => clock)
  statusAnswer = { status: 'pending', requestedAt: NOW, finishBy: NOW + 30 * 86_400 }
  releaseStatus = null
  sdk.getInfo.mockResolvedValue({ identityPubkey: PUBKEY, balanceSats: 0n, tokenBalances: new Map() })
  sdk.signMessage.mockResolvedValue({ signature: '3044sig', pubkey: PUBKEY })
  sdk.getLightningAddress.mockResolvedValue(undefined)
  sdk.checkLightningAddressAvailable.mockResolvedValue(true)
  sdk.registerLightningAddress.mockRejectedValue(lnurlDeleted())
  sdk.claimLightningAddressTransfer = jest.fn(async () => {
    throw lnurlDeleted()
  })
  jest.mocked(connect).mockResolvedValue(sdk as never)
  await connectSpark(MNEMONIC, 'primary')
})

afterEach(() => {
  jest.restoreAllMocks()
})

// Each site's refused call, which is expected to fail on its own terms whatever the adoption does.
const SITES: Array<[string, () => Promise<unknown>]> = [
  ['push registration', () => registerPushDevice(pushDeps())],
  ['name quote', () => quoteName(purchaseDeps, 'padaria')],
  ['name confirmation', () => confirmName(purchaseDeps, 'padaria', 'ref-1')],
  ['domain claim', () => claimDomain(onboardDeps, 'shop.example')],
  ['domain quote', () => quoteDomain(onboardDeps, 'shop.example')],
  ['domain confirmation', () => confirmDomain(onboardDeps, 'shop.example', 'ref-2')],
  ['store order', () => openStoreOrder(purchaseDeps, 'apple', 'name', 'padaria')],
  ['store spend intent', () => recordSpendIntent(purchaseDeps, 'padaria')],
  ['automatic register', () => sparkEnsureLnAddress()],
  ['customer register', () => sparkRegisterLnAddress('chosen')],
  ['transfer claim', () => sparkClaimLnAddressTransfer({ username: 'moved', pubkey: '02aa', signature: 's', domain: 'usevoltz.app', timestamp: NOW } as never)],
]

describe('a 409 deleted with no mark here', () => {
  test.each(SITES)('from the %s reads the status once and writes the mark it says', async (_site, call) => {
    await call().catch(() => undefined)
    await settle()
    expect(statusReads()).toBe(1)
    expect((await findDeletionMark({ walletId: 'primary' }))?.mark.state).toBe('pending')
  })

  test('the refused call keeps its own result, whatever the read answers later', async () => {
    statusAnswer = 'held'
    const order = await openStoreOrder(purchaseDeps, 'apple', 'name', 'padaria')
    expect(order).toEqual({ kind: 'refused', status: 409, code: 'deleted' })
    const push = await registerPushDevice(pushDeps()).catch((e: Error) => e.message)
    expect(push).toBe('device registration failed with 409')
    await settle()
    expect(statusReads()).toBe(1)
    releaseStatus?.({ status: 'pending', requestedAt: NOW })
    await settle()
  })

  test('a done answer runs the cleanup and holds the wallet as deleted', async () => {
    statusAnswer = { status: 'done', requestedAt: NOW, doneAt: NOW + 60 }
    await quoteName(purchaseDeps, 'padaria').catch(() => undefined)
    await settle()
    expect((await findDeletionMark({ walletId: 'primary' }))?.mark.state).toBe('done')
  })
})

describe('reads that do not happen', () => {
  test('a second refusal while the read is in flight starts no second read', async () => {
    statusAnswer = 'held'
    await registerPushDevice(pushDeps()).catch(() => undefined)
    await settle()
    await quoteName(purchaseDeps, 'padaria').catch(() => undefined)
    await openStoreOrder(purchaseDeps, 'apple', 'name', 'padaria')
    await settle()
    expect(statusReads()).toBe(1)
    releaseStatus?.({ status: 'pending', requestedAt: NOW })
    await settle()
    expect((await findDeletionMark({ walletId: 'primary' }))?.mark.state).toBe('pending')
  })

  test('a wallet that holds a mark is never read for', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'removed', askedAt: NOW })
    noteGatewayDeleted({ pubkey: PUBKEY })
    await settle()
    expect(statusReads()).toBe(0)
    expect((await findDeletionMark({ walletId: 'primary' }))?.mark.state).toBe('removed')
  })

  test("another wallet's key is never read for, nor marked here", async () => {
    await registerPushDevice(pushDeps(OTHER)).catch(() => undefined)
    noteGatewayDeleted({ pubkey: OTHER })
    await settle()
    expect(statusReads()).toBe(0)
    expect(await findDeletionMark({ walletId: 'primary' })).toBeNull()
  })

  test('after a read with no answer, a refusal inside the floor reads nothing and one after it reads', async () => {
    statusAnswer = 'noAnswer'
    await quoteName(purchaseDeps, 'padaria').catch(() => undefined)
    await settle()
    expect(statusReads()).toBe(1)
    expect(await findDeletionMark({ walletId: 'primary' })).toBeNull()

    statusAnswer = { status: 'pending', requestedAt: NOW }
    clock += (REFUSAL_READ_FLOOR_SECS - 1) * 1000
    await quoteName(purchaseDeps, 'padaria').catch(() => undefined)
    await settle()
    expect(statusReads()).toBe(1)

    clock += 1000
    await quoteName(purchaseDeps, 'padaria').catch(() => undefined)
    await settle()
    expect(statusReads()).toBe(2)
    expect((await findDeletionMark({ walletId: 'primary' }))?.mark.state).toBe('pending')
  })

  test('a refusal heard while another wallet is the active one reads nothing', async () => {
    // The picker moves the active wallet without reconnecting, so the session still signs as primary.
    jest.mocked(getActiveWalletId).mockResolvedValue('second')
    try {
      noteGatewayDeleted({ pubkey: PUBKEY })
      await settle()
      expect(statusReads()).toBe(0)
      expect(await findDeletionMark({ walletId: 'primary' })).toBeNull()
    } finally {
      jest.mocked(getActiveWalletId).mockResolvedValue('primary')
    }
  })

  test('an answer that lands after a switch to another wallet is dropped', async () => {
    statusAnswer = 'held'
    await quoteName(purchaseDeps, 'padaria').catch(() => undefined)
    await settle()
    expect(statusReads()).toBe(1)
    await connectSpark(MNEMONIC, 'second')
    releaseStatus?.({ status: 'pending', requestedAt: NOW })
    await settle()
    expect(await findDeletionMark({ walletId: 'primary' })).toBeNull()
    expect(await findDeletionMark({ walletId: 'second' })).toBeNull()
  })
})

describe('a read another starter has in flight', () => {
  const homeDeps = { walletId: 'primary', pubkey: PUBKEY, sign }
  const pending = { status: 'pending', requestedAt: NOW, finishBy: NOW + 30 * 86_400 }

  test("Home's import check waits for the read a refusal started", async () => {
    await noteImportCheck('primary')
    statusAnswer = 'held'
    await registerPushDevice(pushDeps()).catch(() => undefined)
    await settle()
    expect(statusReads()).toBe(1)
    const focus = readDeletionOnFocus(homeDeps)
    await settle()
    // Counted before the release, and asserted after it, so a failure strands no read for later cases.
    const inFlight = statusReads()
    releaseStatus?.(pending)
    await focus
    await settle()
    expect(inFlight).toBe(1)
    expect(statusReads()).toBe(1)
    expect((await findDeletionMark({ walletId: 'primary' }))?.mark.state).toBe('pending')
  })

  test('the import check that waited stays due, and the next open clears it without a request', async () => {
    await noteImportCheck('primary')
    statusAnswer = 'held'
    await registerPushDevice(pushDeps()).catch(() => undefined)
    await settle()
    const check = checkImportedDeletion(homeDeps)
    await settle()
    releaseStatus?.(pending)
    await check
    await settle()
    expect(statusReads()).toBe(1)
    expect(await importCheckDue('primary')).toBe(true)

    await checkImportedDeletion(homeDeps)
    expect(statusReads()).toBe(1)
    expect(await importCheckDue('primary')).toBe(false)
  })

  test('the import check that waited on a read with no answer asks again on the next open', async () => {
    await noteImportCheck('primary')
    statusAnswer = 'held'
    await registerPushDevice(pushDeps()).catch(() => undefined)
    await settle()
    const check = checkImportedDeletion(homeDeps)
    await settle()
    statusAnswer = { status: 'pending', requestedAt: NOW, finishBy: NOW + 30 * 86_400 }
    releaseStatus?.({ error: 'unavailable' })
    await check
    await settle()
    expect(statusReads()).toBe(1)
    expect(await importCheckDue('primary')).toBe(true)

    await checkImportedDeletion(homeDeps)
    expect(statusReads()).toBe(2)
    expect(await importCheckDue('primary')).toBe(false)
  })

  test("the deletion screen's read of a lost mark waits for the read a refusal started", async () => {
    // The registry lists a wallet only when its seed is on the device.
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValueOnce(true)
    await jest.requireActual<typeof import('../src/wallet/walletRegistry')>('../src/wallet/walletRegistry').ensureRegistered('primary', 'fp-primary')
    await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/deletion.json`, '{"primary":{"pubkey":"02', 'utf8')
    expect((await findDeletionMark({ walletId: 'primary' }))?.unknown).toBe(true)
    statusAnswer = 'held'
    noteGatewayDeleted({ pubkey: PUBKEY })
    await settle()
    expect(statusReads()).toBe(1)
    const screen = settleDeletion(homeDeps)
    await settle()
    const inFlight = statusReads()
    releaseStatus?.(pending)
    expect(inFlight).toBe(1)
    expect(await screen).toEqual({ kind: 'pending', requestedAt: NOW, deadline: NOW + 30 * 86_400 })
    await settle()
    expect(statusReads()).toBe(1)
  })
})

describe('once the mark is written', () => {
  test('a store order refused as deleted is not sent again', async () => {
    expect(await openStoreOrder(purchaseDeps, 'apple', 'name', 'padaria')).toMatchObject({ code: 'deleted' })
    await settle()
    expect(callsTo('/api/store/order')).toBe(1)
    expect(await openStoreOrder(purchaseDeps, 'apple', 'name', 'padaria')).toMatchObject({ code: 'deleted' })
    expect(callsTo('/api/store/order')).toBe(1)
  })

  test('push registration stops without a request', async () => {
    await registerPushDevice(pushDeps()).catch(() => undefined)
    await settle()
    expect(await registerPushDevice(pushDeps())).toBe(false)
    expect(callsTo('/api/device')).toBe(1)
  })
})

describe('the address screen on the same refusal', () => {
  test('waits for the read the refusal started rather than reading a second time', async () => {
    statusAnswer = 'held'
    const ensure = ensureLnAddressOrAdopt()
    await settle()
    expect(statusReads()).toBe(1)
    releaseStatus?.({ status: 'pending', requestedAt: NOW })
    expect(await ensure).toBeNull()
    await settle()
    expect(statusReads()).toBe(1)
    expect((await findDeletionMark({ walletId: 'primary' }))?.mark.state).toBe('pending')
  })

  test('still reads inside the floor, since someone is looking', async () => {
    statusAnswer = 'noAnswer'
    await quoteName(purchaseDeps, 'padaria').catch(() => undefined)
    await settle()
    statusAnswer = { status: 'pending', requestedAt: NOW }
    expect(await ensureLnAddressOrAdopt()).toBeNull()
    await settle()
    expect(statusReads()).toBe(2)
    expect((await findDeletionMark({ walletId: 'primary' }))?.mark.state).toBe('pending')
  })
})
