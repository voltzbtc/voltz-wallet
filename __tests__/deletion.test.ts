import React from 'react'
import ReactTestRenderer, { act, type ReactTestInstance, type ReactTestRenderer as Renderer } from 'react-test-renderer'
import { Linking, Text } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import {
  loadRetiring,
  loadWebhookState,
  noteGatewayWebhookId,
  loadDeviceForgets,
  noteSdkWebhook,
  webhookStateFor,
} from '../src/wallet/webhookSecret'
import { deviceForgetSettled } from '../src/wallet/deviceForget'
import { forgetProof } from '../src/wallet/webhook'
import { createHash } from 'crypto'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import i18n from '../src/i18n'
import {
  adoptDeletionStatus,
  checkImportedDeletion,
  deletionMessage,
  dropLocalRecords,
  liveDeletionDeps,
  previewDeletion,
  readDeletionOnFocus,
  PENDING_FOCUS_FLOOR_SECS,
  requestDeletion,
  returnFromDeletion,
  settleDeletion,
  type DeletionDeps,
} from '../src/wallet/deletion'
import { refusalKey, storeNameRefusalKey } from '../src/wallet/lnRefusal'
import {
  answerDeletionMark,
  clearDeletionMark,
  deletionHolds,
  deletionMarkFor,
  findDeletionMark,
  importCheckDue,
  noteImportCheck,
  writeDeletionMark,
} from '../src/wallet/deletionMark'
import { addAndActivateWallet, removeWallet } from '../src/wallet/wallet'
import { hasSeedFor } from '../src/wallet/seed'
import { loadRegistry } from '../src/wallet/walletRegistry'
import {
  connectSpark,
  connectedLnurlDomain,
  disconnectSpark,
  sparkDeleteLnAddress,
  sparkEnsureLnAddress,
  sparkInAddressTurn,
  sparkConnectedWalletId,
  sparkRegisterLnAddress,
} from '../src/wallet/spark'
import { registerPushDevice } from '../src/wallet/push'
import { lastLnAddress, rememberLnAddress } from '../src/wallet/lnAddressMemory'
import { openStoreOrder, recordSpendIntent } from '../src/wallet/storePurchase'
import { quoteName } from '../src/wallet/namePurchase'
import { claimDomain, quoteDomain } from '../src/wallet/domainOnboard'
import { classifyWalletError } from '../src/wallet/errors'
import { BLOCKER_KEYS, DeleteDataScreen, OWED_KEYS, STAY_KEYS } from '../src/screens/DeleteDataScreen'
import fs from 'fs'
import path from 'path'
import { LnAddressScreen } from '../src/screens/LnAddressScreen'
import { ReceiveSpark } from '../src/screens/ReceiveSpark'
import { AuthorizationStatus, hasPermission, requestPermission } from '@react-native-firebase/messaging'
import { MenuRow } from '../src/components/MenuRow'
import { confirmQuestion, question } from './support/question'

jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => 'usevoltz.app',
}))
jest.mock('../src/wallet/seed', () => ({
  ...jest.requireActual('../src/wallet/seed'),
  loadSeedFor: jest.fn(async () => 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  loadPassphraseFor: jest.fn(async () => undefined),
}))
let mockActive = 'primary'
jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => mockActive),
  ensureRegistered: jest.fn(),
}))
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() }),
  useRoute: () => ({ params: undefined }),
  // The real hook needs a navigation container; mounting stands for gaining focus.
  useFocusEffect: (cb: () => void | (() => void)) => {
    jest.requireActual('react').useEffect(cb, [])
  },
}))
jest.mock('../src/components/WalletPickerSheet', () => ({ WalletPickerSheet: () => null }))

const sdk = (
  jest.requireMock('@breeztech/breez-sdk-spark-react-native') as {
    __sdkInstance: Record<string, jest.Mock>
  }
).__sdkInstance

const PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const OTHER = `03${'b'.repeat(64)}`
const NOW = 1_800_000_000
const DOCS = RNFS.DocumentDirectoryPath

type Call = { url: string; body: Record<string, unknown> }
let calls: Call[] = []
// What the fake gateway answers per action, as [status, body], or 'none' for no answer at all.
type Answer = [number, Record<string, unknown>] | 'none'
let answers: Partial<Record<string, Answer>> = {}

// Records every request, and the deletion mark as it stood when each one left the device.
const marksAtSend: (string | null)[] = []
const fakeFetch = jest.fn(async (url: string, init?: { body?: string }) => {
  const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  calls.push({ url, body })
  if (url.endsWith('/api/wallet/delete')) {
    marksAtSend.push((await deletionMarkFor(mockActive))?.state ?? null)
    const answer = answers[String(body.action)]
    if (!answer || answer === 'none') {
      throw new Error('network down')
    }
    return { ok: answer[0] < 300, status: answer[0], json: async () => answer[1] }
  }
  if (url.endsWith('/api/device/forget')) {
    return { ok: true, status: 200, json: async () => ({ forgotten: true }) }
  }
  return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
})

function deps(over: Partial<DeletionDeps> = {}): DeletionDeps {
  return {
    walletId: 'primary',
    pubkey: PUBKEY,
    sign: async () => 'sig',
    now: () => NOW * 1000,
    request: fakeFetch as unknown as typeof fetch,
    ...over,
  }
}

// The deletion preview in the shape the gateway writes it, with the request's status merged in.
const PREVIEW = {
  names: [
    { domain: 'usevoltz.app', name: 'alice' },
    { domain: 'usevoltz.app', name: 'alice2' },
  ],
  recentPurchases: [{ rail: 'google', kind: 'name', domain: 'usevoltz.app', subject: 'alice', reference: 'GPA.1234', at: NOW - 86_400 }],
  ownDomains: [],
  blockers: [],
  stays: ['purchases', 'mark', 'name_hold', 'request_record'],
  status: 'none',
}
const PENDING = { status: 'pending', requestedAt: NOW, finishBy: NOW + 15 * 86_400 }

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.clearAllMocks()
  calls = []
  answers = {}
  marksAtSend.length = 0
  mockActive = 'primary'
  global.fetch = fakeFetch as unknown as typeof fetch
  sdk.getInfo.mockResolvedValue({ identityPubkey: PUBKEY, balanceSats: 0n, tokenBalances: new Map() })
  sdk.signMessage = jest.fn(async () => ({ signature: 'sig' }))
  sdk.getLightningAddress.mockResolvedValue(undefined)
  sdk.checkLightningAddressAvailable.mockResolvedValue(true)
  sdk.registerLightningAddress.mockImplementation(async ({ username }: { username: string }) => ({
    username,
    lightningAddress: `${username}@usevoltz.app`,
    lnurl: { url: 'https://usevoltz.app/lnurlp', bech32: 'lnurl1x' },
    description: '',
  }))
  // The mock module's own instance is not the one requireMock hands back here, so the connection is
  // pointed at the instance this file drives, as spark.test.ts does.
  jest.mocked(connect).mockResolvedValue(sdk as never)
  await connectSpark('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
})

describe('the statement', () => {
  // The gateway rebuilds these exact bytes to verify the signature, and its suite pins the same
  // vectors. A drift on either side turns every deletion into a 401 while both suites stay green.
  test.each([
    ['preview', 'e4de9f81d510beb58a46bdb85df0e2646832f21b9b206c919bcdd34b0d6cb35b'],
    ['request', '3545220e5c452ef5caa1d5c99371ade15a194b8274f5885e2f45df3aa42520ec'],
    ['status', 'e6516288157541b684049104c6c59365e25b3a14c59812db370412a074edf270'],
    ['return', 'bcaf0042e4a029ecfb558f3b8f528a247e49c3138d0787213b55d1713d90496c'],
  ] as const)('%s matches the golden vector', (action, sha) => {
    const message = deletionMessage(action, PUBKEY, NOW)
    expect(message).toBe(`voltz-delete:v1\n${action}\n${PUBKEY}\n1800000000`)
    expect(createHash('sha256').update(message, 'utf8').digest('hex')).toBe(sha)
  })

  test('the request carries the statement it signed, at the build domain', async () => {
    const signed: string[] = []
    answers.preview = [200, PREVIEW]
    const sign = async (message: string) => {
      signed.push(message)
      return 'sig'
    }
    await previewDeletion(deps({ gatewayUrl: undefined, sign }))
    expect(calls[0].url).toBe('https://usevoltz.app/api/wallet/delete')
    expect(calls[0].body).toEqual({ action: 'preview', pubkey: PUBKEY, signature: 'sig', timestamp: NOW })
    expect(signed).toEqual([deletionMessage('preview', PUBKEY, NOW)])
  })
})

// Copied from the gateway's deletion map, what stays after a deletion and what blocks one. The gateway
// sends these codes and the app owns their words, so a code added there without a line here fails
// this test instead of reaching a screen as "something else".
const GATEWAY_STAYS = ['purchases', 'mark', 'name_hold', 'request_record']
const GATEWAY_BLOCKERS = ['sats_charge_open', 'store_order_open', 'credit_unresolved', 'epoch_closing', 'domain_payment_in_progress']

describe('every code the gateway sends has words in every locale', () => {
  const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales')
  const locales = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  const lookup = (tree: Record<string, unknown>, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree)

  test('the locales are all there', () => {
    expect(locales).toHaveLength(24)
  })

  test.each(GATEWAY_STAYS)('what stays: %s', code => {
    const key = STAY_KEYS[code]
    expect(key).toBeDefined()
    for (const file of locales) {
      const text = lookup(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), key)
      expect([file, typeof text === 'string' && text.length > 0]).toEqual([file, true])
    }
  })

  test.each(GATEWAY_BLOCKERS)('what blocks: %s', code => {
    const key = BLOCKER_KEYS[code]
    expect(key).toBeDefined()
    for (const file of locales) {
      const text = lookup(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), key)
      expect([file, typeof text === 'string' && text.length > 0]).toEqual([file, true])
    }
  })

  // Every locale names the charge, its sats and its date, so no language drops the line that lets
  // support find the payment.
  test.each(['refused', 'not_granted', 'unchecked'] as const)('what is owed: %s', state => {
    const key = OWED_KEYS[state]
    expect(key).toBeDefined()
    for (const file of locales) {
      const text = lookup(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), key)
      expect([file, typeof text === 'string' && text.length > 0]).toEqual([file, true])
      const slots = [...new Set(String(text).match(/\{\{\w+\}\}/g) ?? [])].sort()
      expect([file, slots]).toEqual([file, ['{{date}}', '{{sats}}', '{{subject}}']])
    }
  })

  test('a preview with a field of the wrong type is no preview', async () => {
    answers.preview = [200, { ...PREVIEW, ownDomains: [{ host: 'pay.a.com', guests: '3' }] }]
    expect(await previewDeletion(deps())).toEqual({ kind: 'failed' })
    answers.preview = [200, { ...PREVIEW, stays: 'purchases' }]
    expect(await previewDeletion(deps())).toEqual({ kind: 'failed' })
  })
})

describe('the request', () => {
  test('signs as the active wallet even when a switch left the SDK on the previous one', async () => {
    // A switch repoints the registry without reconnecting. Signing on the old connection would ask
    // the gateway to delete the previous wallet's data under this wallet's mark.
    expect(sparkConnectedWalletId()).toBe('primary')
    mockActive = 'other'
    const live = await liveDeletionDeps()
    expect(live.walletId).toBe('other')
    expect(sparkConnectedWalletId()).toBe('other')
  })

  test('the mark is written as asked before the request leaves the device', async () => {
    answers.request = [202, PENDING]
    expect(await requestDeletion(deps())).toEqual({ kind: 'pending', requestedAt: NOW, deadline: NOW + 15 * 86_400 })
    expect(marksAtSend).toEqual(['asked'])
    expect((await deletionMarkFor('primary'))?.state).toBe('pending')
  })

  test("takes the wallet's webhook off the provider before the request leaves the device", async () => {
    await withKeychain(async () => {
      const GID = 'AbCdEfGhIjKlMnOpQrStUv'
      const url = `https://usevoltz.app/api/push/spark/${GID}`
      const { secret } = await webhookStateFor('primary', PUBKEY)
      await noteGatewayWebhookId('primary', secret, GID, PUBKEY)
      await noteSdkWebhook('primary', secret, { id: 'h1', url })
      const order: string[] = []
      sdk.listWebhooks.mockResolvedValueOnce([
        { id: 'h1', url, eventTypes: [] },
        { id: 'tablet', url: 'https://usevoltz.app/api/push/spark/TabletIdTabletIdTablet', eventTypes: [] },
      ])
      sdk.unregisterWebhook.mockImplementationOnce(async ({ webhookId }: { webhookId: string }) => {
        order.push(`unregister ${webhookId}`)
      })
      answers.request = [202, PENDING]
      const real = fakeFetch.getMockImplementation()!
      fakeFetch.mockImplementation(async (to, init) => {
        if (to.endsWith('/api/wallet/delete')) {
          order.push('request')
        }
        return real(to, init)
      })

      try {
        expect(await requestDeletion(deps())).toMatchObject({ kind: 'pending' })
        await deviceForgetSettled()
      } finally {
        fakeFetch.mockImplementation(real)
      }

      expect(order).toEqual(['unregister h1', 'request'])
      expect(await loadWebhookState('primary')).toBeNull()
      expect(await loadRetiring(PUBKEY)).toBeNull()
    })
  })

  test('queues the forget of the secret before the request leaves the device, and never waits on it', async () => {
    await withKeychain(async () => {
      const { secret } = await webhookStateFor('primary', PUBKEY)
      answers.request = [202, PENDING]
      const queuedAtRequest: unknown[] = []
      const real = fakeFetch.getMockImplementation()!
      fakeFetch.mockImplementation(async (url, init) => {
        if (url.endsWith('/api/device/forget')) {
          throw new Error('network down')
        }
        if (url.endsWith('/api/wallet/delete') && JSON.parse(init?.body ?? '{}').action === 'request') {
          queuedAtRequest.push(...(await loadDeviceForgets()))
        }
        return real(url, init)
      })
      try {
        expect(await requestDeletion(deps())).toMatchObject({ kind: 'pending' })
        await deviceForgetSettled()
      } finally {
        fakeFetch.mockImplementation(real)
      }
      const forget = { pubkey: PUBKEY, proof: forgetProof('usevoltz.app', PUBKEY, secret) }
      expect(queuedAtRequest).toEqual([forget])
      expect(await loadDeviceForgets()).toEqual([forget])
    })
  })

  test('sends the forget with the key and the proof only, and drops it once answered', async () => {
    await withKeychain(async () => {
      const { secret } = await webhookStateFor('primary', PUBKEY)
      await noteGatewayWebhookId('primary', secret, 'AbCdEfGhIjKlMnOpQrStUv', PUBKEY)
      answers.request = [202, PENDING]

      expect(await requestDeletion(deps())).toMatchObject({ kind: 'pending' })
      await deviceForgetSettled()

      expect(calls.filter(call => call.url.endsWith('/api/device/forget')).map(call => call.body)).toEqual([
        { pubkey: PUBKEY, proof: forgetProof('usevoltz.app', PUBKEY, secret) },
      ])
      expect(await loadDeviceForgets()).toEqual([])
    })
  })

  test('a provider that refuses the removal keeps the marker and still sends the request', async () => {
    await withKeychain(async () => {
      const { secret } = await webhookStateFor('primary', PUBKEY)
      await noteGatewayWebhookId('primary', secret, 'AbCdEfGhIjKlMnOpQrStUv', PUBKEY)
      sdk.listWebhooks.mockRejectedValueOnce(new Error('provider down'))
      answers.request = [202, PENDING]

      expect(await requestDeletion(deps())).toMatchObject({ kind: 'pending' })

      expect(marksAtSend).toEqual(['asked'])
      expect(await loadRetiring(PUBKEY)).toMatchObject({ webhookIds: ['AbCdEfGhIjKlMnOpQrStUv'] })
    })
  })

  test('a mark that cannot be written sends nothing', async () => {
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
    await expect(requestDeletion(deps())).rejects.toThrow('disk full')
    expect(calls).toEqual([])
    write.mockRestore()
  })

  test('no answer keeps the wallet held as asked and deletes nothing here', async () => {
    const cleanup = jest.fn()
    await RNFS.writeFile(`${DOCS}/ln-address-last.json`, JSON.stringify({ primary: 'alice@usevoltz.app' }), 'utf8')
    expect(await requestDeletion(deps())).toEqual({ kind: 'noAnswer' })
    expect((await deletionMarkFor('primary'))?.state).toBe('asked')
    expect(await RNFS.readFile(`${DOCS}/ln-address-last.json`, 'utf8')).toContain('alice')
    expect(cleanup).not.toHaveBeenCalled()
  })

  test('a 5xx is no answer, never a refusal', async () => {
    answers.request = [503, {}]
    expect(await requestDeletion(deps())).toEqual({ kind: 'noAnswer' })
    expect((await deletionMarkFor('primary'))?.state).toBe('asked')
  })

  test('a 202 without its dates leaves the mark as asked for the status read to settle', async () => {
    answers.request = [202, {}]
    expect(await requestDeletion(deps())).toEqual({ kind: 'noAnswer' })
    expect((await deletionMarkFor('primary'))?.state).toBe('asked')
  })

  test('a refusal with blockers lets the wallet go, with the codes', async () => {
    answers.request = [409, { error: 'blocked', blockers: ['sats_charge_open', 'domain_payment_in_progress'] }]
    expect(await requestDeletion(deps())).toEqual({ kind: 'blocked', blockers: ['sats_charge_open', 'domain_payment_in_progress'] })
    expect(await deletionMarkFor('primary')).toBeNull()
  })

  test('a refusal puts back the removed mark the wallet had', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'removed', askedAt: 1 })
    answers.request = [401, { error: 'invalid_signature' }]
    expect(await requestDeletion(deps())).toEqual({ kind: 'failed' })
    expect(await deletionMarkFor('primary')).toEqual({ pubkey: PUBKEY, state: 'removed', askedAt: 1 })
  })

  test('a 200 is a request already finished, and the status read runs the cleanup before deleted', async () => {
    answers.request = [200, { status: 'done', requestedAt: NOW - 900, doneAt: NOW - 60 }]
    expect(await requestDeletion(deps())).toEqual({ kind: 'noAnswer' })
    expect((await deletionMarkFor('primary'))?.state).toBe('asked')
  })

  test('a 202 that is not pending is no answer', async () => {
    answers.request = [202, { status: 'done', requestedAt: NOW, finishBy: NOW + 900 }]
    expect(await requestDeletion(deps())).toEqual({ kind: 'noAnswer' })
  })

  test('409 deleted means a request is already held, and the status decides', async () => {
    answers.request = [409, { error: 'deleted' }]
    expect(await requestDeletion(deps())).toEqual({ kind: 'noAnswer' })
    expect((await deletionMarkFor('primary'))?.state).toBe('asked')
  })
})

describe('what the screen may say', () => {
  beforeEach(async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'asked', askedAt: NOW })
  })

  // Every answer except done, and none of them may say deleted or touch a local record.
  test.each([
    ['no answer', 'none' as const, 'asked'],
    ['5xx', [500, {}] as Answer, 'asked'],
    ['pending', [200, PENDING] as Answer, 'pending'],
    ['done without its date', [200, { status: 'done' }] as Answer, 'asked'],
    ['an unknown status', [200, { status: 'finished' }] as Answer, 'asked'],
  ])('%s is never deleted', async (_, answer, kind) => {
    answers.status = answer
    const cleanup = jest.fn(async () => undefined)
    const view = await settleDeletion({ ...deps(), cleanup })
    expect(view.kind).toBe(kind)
    expect(cleanup).not.toHaveBeenCalled()
  })

  test('done runs the local cleanup first, and only then says deleted', async () => {
    answers.status = [200, { status: 'done', doneAt: NOW + 600 }]
    const order: string[] = []
    const cleanup = jest.fn(async () => {
      order.push(`cleanup with mark ${(await deletionMarkFor('primary'))?.state}`)
    })
    expect(await settleDeletion({ ...deps(), cleanup })).toEqual({ kind: 'done', doneAt: NOW + 600 })
    expect(order).toEqual(['cleanup with mark asked'])
    expect((await deletionMarkFor('primary'))?.state).toBe('done')
  })

  test('a cleanup that fails keeps the wallet pending, not deleted', async () => {
    answers.status = [200, { status: 'done', doneAt: NOW + 600 }]
    const view = await settleDeletion({ ...deps(), cleanup: async () => Promise.reject(new Error('io')) })
    expect(view.kind).toBe('pending')
    expect((await deletionMarkFor('primary'))?.state).toBe('asked')
  })

  test('none drops the mark and says the request never arrived', async () => {
    answers.status = [200, { status: 'none' }]
    expect(await settleDeletion(deps())).toEqual({ kind: 'notArrived' })
    expect(await deletionMarkFor('primary')).toBeNull()
  })

  test('returned for a request made with the address still there drops the mark and shows the page', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'pending', askedAt: NOW, requestedAt: NOW, deadline: NOW + 10 })
    answers.status = [200, { status: 'returned' }]
    expect(await settleDeletion(deps())).toEqual({ kind: 'none' })
    expect(await deletionMarkFor('primary')).toBeNull()
  })

  test('a done mark never reads the gateway again', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'done', askedAt: NOW, doneAt: NOW + 5 })
    expect(await settleDeletion(deps())).toEqual({ kind: 'done', doneAt: NOW + 5 })
    expect(calls).toEqual([])
  })
})

describe('a removed address survives a request the gateway never recorded', () => {
  beforeEach(async () => {
    // "Remove address" first, then a deletion request that gets no answer.
    await sparkDeleteLnAddress()
    expect((await deletionMarkFor('primary'))?.state).toBe('removed')
    expect(await requestDeletion(deps())).toEqual({ kind: 'noAnswer' })
    expect((await deletionMarkFor('primary'))?.state).toBe('asked')
  })

  test('none puts the removed mark back, and the next open mints nothing', async () => {
    answers.status = [200, { status: 'none' }]
    expect(await settleDeletion(deps())).toEqual({ kind: 'notArrived', removed: true })
    expect((await deletionMarkFor('primary'))?.state).toBe('removed')
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })

  test('returned puts the removed mark back as well', async () => {
    answers.status = [200, { status: 'returned', returnedAt: NOW }]
    expect(await settleDeletion(deps())).toEqual({ kind: 'removed' })
    expect((await deletionMarkFor('primary'))?.state).toBe('removed')
  })

  test('a later refusal of a second request keeps it removed too', async () => {
    answers.request = [409, { error: 'blocked', blockers: ['store_order_open'] }]
    expect(await requestDeletion(deps())).toEqual({ kind: 'blocked', blockers: ['store_order_open'] })
    expect((await deletionMarkFor('primary'))?.state).toBe('removed')
  })
})

describe('the local cleanup on the device touches only this wallet', () => {
  const seed: Record<string, unknown> = {
    'ln-address-last.json': { primary: 'alice@usevoltz.app', other: 'bob@usevoltz.app' },
    'purchases.json': { primary: { name: { kind: 'name', subject: 'a', reference: 'r1', amountSats: 1 } }, other: { name: { kind: 'name', subject: 'b', reference: 'r2', amountSats: 2 } } },
    'purchase-asked.json': { primary: { at: 1, open: false }, other: { at: 2, open: true } },
    'domain-tier.json': { primary: { host: 'pay.a.com', readAt: 1, state: { role: 'owner' } }, other: { host: 'pay.b.com', readAt: 2, state: { role: 'member' } } },
    'domain-mine.json': { primary: 1, other: 2 },
    'domain-purchase.json': { primary: { host: 'pay.a.com', reference: 'd1', amountSats: 1 }, other: { host: 'pay.b.com', reference: 'd2', amountSats: 2 } },
    'lnurl-domain.json': { primary: 'pay.a.com', other: 'pay.b.com' },
    'released-lines.json': { primary: [{ kind: 'name', reference: 'ra', answer: 'repaid', subject: 'alice@usevoltz.app' }, { reference: 'rs', shown: true }], other: [{ kind: 'tier', reference: 'rb', answer: 'boughtBefore', subject: 'pay.b.com' }] },
    'domain-wallet-labels.json': { [OTHER]: 'Mom' },
    'store-orders.json': {
      orders: { o1: 'primary', o2: 'other' },
      bought: { o1: 'pending', o2: 'purchased' },
      waits: { 'x:o1': { attempts: 1, nextAt: 1 }, 'x:o2': { attempts: 1, nextAt: 2 } },
      unknown: { o3: ['primary', 'other'] },
      about: { o1: { kind: 'name', place: 'usevoltz.app', subject: 'a' }, o2: { kind: 'name', place: 'usevoltz.app', subject: 'b' } },
      outcomes: {},
      checks: { 'primary|d|a': { wallet: 'primary', domain: 'd', name: 'a', after: 'pending', attempt: [] }, 'other|d|b': { wallet: 'other', domain: 'd', name: 'b', after: 'pending', attempt: [] } },
    },
  }

  async function write(registrationOf: string) {
    for (const [file, value] of Object.entries(seed)) {
      await RNFS.writeFile(`${DOCS}/${file}`, JSON.stringify(value), 'utf8')
    }
    await RNFS.writeFile(`${DOCS}/push-registration.json`, JSON.stringify({ pubkey: registrationOf, platform: 'ios', token: 't', domain: 'usevoltz.app' }), 'utf8')
  }

  const read = async (file: string) =>
    (await RNFS.exists(`${DOCS}/${file}`)) ? JSON.parse(await RNFS.readFile(`${DOCS}/${file}`, 'utf8')) : null

  test("every file keeps the other wallet's entry as it was, and loses this one's", async () => {
    await write(PUBKEY)
    await dropLocalRecords('primary', PUBKEY)
    for (const file of ['ln-address-last.json', 'purchases.json', 'purchase-asked.json', 'domain-tier.json', 'domain-mine.json', 'domain-purchase.json', 'lnurl-domain.json', 'released-lines.json']) {
      expect([file, await read(file)]).toEqual([file, { other: (seed[file] as Record<string, unknown>).other }])
    }
    expect(await read('store-orders.json')).toEqual({
      orders: { o2: 'other' },
      bought: { o2: 'purchased' },
      waits: { 'x:o2': { attempts: 1, nextAt: 2 } },
      unknown: { o3: ['other'] },
      about: { o2: { kind: 'name', place: 'usevoltz.app', subject: 'b' } },
      outcomes: {},
      checks: { 'other|d|b': { wallet: 'other', domain: 'd', name: 'b', after: 'pending', attempt: [] } },
    })
    // This wallet owned its domain and no other wallet here owns one, so the labels it gave go too.
    expect(await read('domain-wallet-labels.json')).toBeNull()
    expect(await read('push-registration.json')).toBeNull()
  })

  // A cleanup that failed on a file it cannot read would stay pending for good, since every status
  // read runs it again from the start; one that wrote over the file would lose another wallet's proof.
  test('goes past a proof file or store book it cannot read, leaving each byte of it', async () => {
    await write(PUBKEY)
    const torn: Record<string, string> = {
      'store-orders.json': '{"orders": {"o1": "primary"',
      'purchases.json': '{"primary": {"name": {"reference": "n',
      'domain-purchase.json': '[1',
      'released-lines.json': '{"primary": [{"kind": "na',
    }
    for (const [file, text] of Object.entries(torn)) {
      await RNFS.writeFile(`${DOCS}/${file}`, text, 'utf8')
    }
    await dropLocalRecords('primary', PUBKEY)
    for (const [file, text] of Object.entries(torn)) {
      expect([file, await RNFS.readFile(`${DOCS}/${file}`, 'utf8')]).toEqual([file, text])
      expect([file, await RNFS.exists(`${DOCS}/${file}.unreadable`)]).toEqual([file, false])
    }
    for (const file of ['purchase-asked.json', 'domain-tier.json', 'domain-mine.json', 'lnurl-domain.json']) {
      expect([file, await read(file)]).toEqual([file, { other: (seed[file] as Record<string, unknown>).other }])
    }
  })

  test("another wallet's push registration and an owner's labels survive", async () => {
    await write(OTHER)
    const tier = seed['domain-tier.json'] as Record<string, { state: { role: string } }>
    await RNFS.writeFile(`${DOCS}/domain-tier.json`, JSON.stringify({ ...tier, other: { ...tier.other, state: { role: 'owner' } } }), 'utf8')
    await dropLocalRecords('primary', PUBKEY)
    expect((await read('push-registration.json'))?.pubkey).toBe(OTHER)
    expect(await read('domain-wallet-labels.json')).toEqual({ [OTHER]: 'Mom' })
  })

  test("forgets this wallet's payment webhook secret and id, and keeps another wallet's", async () => {
    await withKeychain(async () => {
      await write(PUBKEY)
      const mine = await webhookStateFor('primary', PUBKEY)
      await noteGatewayWebhookId('primary', mine.secret, 'AbCdEfGhIjKlMnOpQrStUv', PUBKEY)
      const OTHER_KEY = '03'.padEnd(66, 'c')
      const other = await webhookStateFor('other', OTHER_KEY)
      const real = fakeFetch.getMockImplementation()!
      fakeFetch.mockImplementation(async (url, init) => {
        if (url.endsWith('/api/device/forget')) {
          throw new Error('network down')
        }
        return real(url, init)
      })

      try {
        await dropLocalRecords('primary', PUBKEY)
        await deviceForgetSettled()
      } finally {
        fakeFetch.mockImplementation(real)
      }

      expect(await loadWebhookState('primary')).toBeNull()
      expect((await loadWebhookState('other'))?.secret).toBe(other.secret)
      // The provider can still hold the webhook, so what the next pass needs to take it off stays.
      expect(await loadRetiring(PUBKEY)).toEqual({ webhookIds: ['AbCdEfGhIjKlMnOpQrStUv'], sdkIds: [], urls: [] })
      // The secret's forget is queued with its drop, and only this wallet's.
      expect(await loadDeviceForgets()).toEqual([{ pubkey: PUBKEY, proof: forgetProof('usevoltz.app', PUBKEY, mine.secret) }])
    })
  })

  test('a guest keeps the domain it was pointed at, since the domain was not its own', async () => {
    await write(PUBKEY)
    const tier = seed['domain-tier.json'] as Record<string, { state: { role: string } }>
    await RNFS.writeFile(`${DOCS}/domain-tier.json`, JSON.stringify({ ...tier, primary: { ...tier.primary, state: { role: 'member' } } }), 'utf8')
    await dropLocalRecords('primary', PUBKEY)
    expect(await read('lnurl-domain.json')).toEqual({ primary: 'pay.a.com', other: 'pay.b.com' })
  })
})

describe('nothing on the device recreates the account while held', () => {
  test('ensure reads nothing and registers nothing for a held wallet', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'pending', askedAt: NOW })
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(sdk.getLightningAddress).not.toHaveBeenCalled()
  })

  test("another wallet's mark does not hold this one", async () => {
    await writeDeletionMark('other', { pubkey: OTHER, state: 'done', askedAt: NOW })
    expect(await sparkEnsureLnAddress()).not.toBeNull()
    expect(sdk.registerLightningAddress).toHaveBeenCalledTimes(1)
  })

  test('a mint queued behind a request finds the mark and stops', async () => {
    // The turn is held so the order is fixed: the request queues first, the ensure then passes its
    // own check with no mark yet and queues its mint behind the request, and only then does the
    // request run. The mint must see the mark the request wrote.
    answers.request = [202, PENDING]
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const held = sparkInAddressTurn(() => gate)
    const requested = requestDeletion(deps({ turn: sparkInAddressTurn }))
    const ensured = sparkEnsureLnAddress()
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(await deletionMarkFor('primary')).toBeNull()
    release()
    await held
    expect(await ensured).toBeNull()
    expect((await requested).kind).toBe('pending')
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })

  test('a register the customer asks for is refused with the deleted code', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'done', askedAt: NOW })
    const refusal = await sparkRegisterLnAddress('alice').catch((e: unknown) => e)
    expect(classifyWalletError(refusal)).toBe('deleted')
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })

  test('push, store orders, sats quotes and domain claims are not sent for a held key', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'asked', askedAt: NOW })
    const sign = jest.fn(async () => 'sig')
    const request = fakeFetch as unknown as typeof fetch
    expect(await registerPushDevice({ gatewayUrl: 'https://usevoltz.app', domain: 'usevoltz.app', platform: 'ios', token: 't', identity: async () => PUBKEY, sign, request })).toBe(false)
    const store = { gatewayUrl: 'https://usevoltz.app', domain: 'usevoltz.app', pubkey: PUBKEY, sign, request }
    expect(await openStoreOrder(store, 'apple', 'name', 'alice')).toEqual({ kind: 'refused', status: 409, code: 'deleted' })
    expect(await recordSpendIntent(store, 'alice')).toEqual({ kind: 'refused', status: 409, code: 'deleted' })
    await expect(quoteName(store, 'alice')).rejects.toThrow('deleted')
    const onboard = { gatewayUrl: 'https://usevoltz.app', ownerPubkey: PUBKEY, sign, request }
    await expect(quoteDomain(onboard, 'pay.a.com')).rejects.toThrow('deleted')
    await expect(claimDomain(onboard, 'pay.a.com')).rejects.toThrow('deleted')
    expect(calls).toEqual([])
    expect(sign).not.toHaveBeenCalled()
  })

  test('giving the address up holds the wallet, so the next open mints nothing', async () => {
    await sparkDeleteLnAddress()
    expect((await deletionMarkFor('primary'))?.state).toBe('removed')
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })

  test('a give-up the SDK refuses leaves the wallet unheld', async () => {
    sdk.deleteLightningAddress.mockRejectedValueOnce(new Error('server said no'))
    await expect(sparkDeleteLnAddress()).rejects.toThrow('server said no')
    expect(await deletionHolds({ walletId: 'primary' })).toBe(false)
  })

  test('return asks the gateway for a deletion, and only a 200 lets the wallet go', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'done', askedAt: NOW })
    answers.return = [429, {}]
    expect(await returnFromDeletion(deps())).toEqual({ kind: 'failed' })
    expect(await deletionHolds({ walletId: 'primary' })).toBe(true)
    answers.return = [200, { status: 'returned' }]
    expect(await returnFromDeletion(deps())).toEqual({ kind: 'returned' })
    expect(await deletionHolds({ walletId: 'primary' })).toBe(false)
  })

  test('return from a give-up asks nobody', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'removed', askedAt: NOW })
    expect(await returnFromDeletion(deps())).toEqual({ kind: 'returned' })
    expect(calls).toEqual([])
  })
})

describe('an address is never given up without a removed mark on disk', () => {
  const MARKS = `${DOCS}/deletion.json`

  beforeEach(async () => {
    // A torn file is rebuilt around the wallets the registry lists, so this one is listed, its seed
    // read as present for the one check the registry makes.
    const real = jest.requireActual('../src/wallet/walletRegistry') as typeof import('../src/wallet/walletRegistry')
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValueOnce(true)
    await real.ensureRegistered('primary', 'fp')
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['primary'])
  })

  // A wallet whose deletion state is not known keeps its address and its memory until the gateway's
  // answer for it is read back; a 'removed' written over that state would end the read-back.
  test('over a torn marks file, the removal is refused and nothing changes, until the answer is read back', async () => {
    await rememberLnAddress(`old@${'usevoltz.app'}`, 'primary')
    await RNFS.writeFile(MARKS, '{"primary":{"pubkey":', 'utf8')
    await expect(sparkDeleteLnAddress()).rejects.toThrow('deletion state not known yet')
    expect(sdk.deleteLightningAddress).not.toHaveBeenCalled()
    expect(await RNFS.readFile(MARKS, 'utf8')).toBe('{"primary":{"pubkey":')
    expect(await lastLnAddress('primary')).toBe('old@usevoltz.app')
    // The read-back answers that nothing holds the wallet: the file is rebuilt with that answer.
    expect(await answerDeletionMark('primary', PUBKEY, null, null)).toBe(true)
    await sparkDeleteLnAddress()
    expect(sdk.deleteLightningAddress).toHaveBeenCalledTimes(1)
    expect(await deletionMarkFor('primary')).toEqual(expect.objectContaining({ pubkey: PUBKEY, state: 'removed' }))
  })

  test('a wallet a rebuild still waits on keeps its address, and no removed mark ends its read-back', async () => {
    await RNFS.writeFile(MARKS, '{"primary":{"pubkey":', 'utf8')
    // A write for another wallet rebuilds the file around every listed wallet, this one unread.
    await writeDeletionMark('ghost', { pubkey: OTHER, state: 'asked', askedAt: NOW })
    expect((await findDeletionMark({ walletId: 'primary' }))?.unknown).toBe(true)
    const before = await RNFS.readFile(MARKS, 'utf8')
    await expect(sparkDeleteLnAddress()).rejects.toThrow('deletion state not known yet')
    expect(sdk.deleteLightningAddress).not.toHaveBeenCalled()
    expect(await RNFS.readFile(MARKS, 'utf8')).toBe(before)
    expect((await findDeletionMark({ walletId: 'primary' }))?.unknown).toBe(true)
  })

  test('over a marks read the platform refuses, the call rejects and the address and memory stay', async () => {
    await rememberLnAddress('old@usevoltz.app', 'primary')
    const intact = JSON.stringify({ other: { pubkey: OTHER, state: 'done', askedAt: NOW } })
    await RNFS.writeFile(MARKS, intact, 'utf8')
    const read = RNFS.readFile
    const refused = jest.spyOn(RNFS, 'readFile').mockImplementation(async (file: string, ...rest: unknown[]) => {
      if (file === MARKS) {
        throw new Error('EACCES: permission denied')
      }
      return (read as (...args: unknown[]) => Promise<string>)(file, ...rest)
    })
    try {
      await expect(sparkDeleteLnAddress()).rejects.toThrow('deletion state not known yet')
    } finally {
      refused.mockRestore()
    }
    expect(sdk.deleteLightningAddress).not.toHaveBeenCalled()
    expect(await RNFS.readFile(MARKS, 'utf8')).toBe(intact)
    expect(await lastLnAddress('primary')).toBe('old@usevoltz.app')
  })

  // Only a status read or the wallet's removal can write between the removal's first read and its own
  // write. A status read that adopts a pending request there is kept, and the removal is recorded on
  // it, so a later answer that the request never arrived puts the wallet back as removed.
  test('a pending request a status read adopts after the removal read the state keeps the removal', async () => {
    const marks = jest.requireActual('../src/wallet/deletionMark') as typeof import('../src/wallet/deletionMark')
    const real = marks.findDeletionMark
    let adopted: unknown = null
    const spy = jest.spyOn(marks, 'findDeletionMark').mockImplementationOnce(async by => {
      const found = await real(by)
      answers.status = [200, { status: 'pending', requestedAt: NOW, finishBy: NOW + 10 }]
      adopted = await adoptDeletionStatus(deps())
      return found
    })
    try {
      await sparkDeleteLnAddress()
    } finally {
      spy.mockRestore()
    }
    expect(adopted).toEqual({ kind: 'pending', requestedAt: NOW, deadline: NOW + 10 })
    expect(sdk.deleteLightningAddress).toHaveBeenCalledTimes(1)
    expect(await deletionMarkFor('primary')).toEqual(
      expect.objectContaining({ state: 'pending', requestedAt: NOW, removedAt: expect.any(Number) }),
    )
    answers.status = [200, { status: 'none' }]
    expect(await settleDeletion(deps())).toEqual({ kind: 'notArrived', removed: true })
    expect((await deletionMarkFor('primary'))?.state).toBe('removed')
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })

  // A status read sent before the removal and answered after it was asked from the mark without the
  // removal, so its answer is not applied, and the next read lets the wallet go back to removed.
  test('a status read in flight when the address is given up never lets the removal go', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'pending', askedAt: NOW })
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let sent = false
    fakeFetch.mockImplementationOnce(async () => {
      sent = true
      await held
      return { ok: true, status: 200, json: async () => ({ status: 'none' }) }
    })
    const settling = settleDeletion(deps())
    for (let tick = 0; tick < 20 && !sent; tick += 1) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(sent).toBe(true)
    await sparkDeleteLnAddress()
    release()
    expect(await settling).toEqual({ kind: 'pending' })
    expect(await deletionMarkFor('primary')).toEqual(
      expect.objectContaining({ state: 'pending', removedAt: expect.any(Number) }),
    )
    answers.status = [200, { status: 'none' }]
    expect(await settleDeletion(deps())).toEqual({ kind: 'notArrived', removed: true })
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })

  // Taking the removal back after the SDK refused it drops only the mark the removal wrote.
  test('a give-up the SDK refuses keeps a mark written while it was out', async () => {
    const pending = { pubkey: PUBKEY, state: 'pending' as const, askedAt: NOW }
    sdk.deleteLightningAddress.mockImplementationOnce(async () => {
      expect((await deletionMarkFor('primary'))?.state).toBe('removed')
      await answerDeletionMark('primary', PUBKEY, pending, 'any')
      throw new Error('server said no')
    })
    await expect(sparkDeleteLnAddress()).rejects.toThrow('server said no')
    expect(await deletionMarkFor('primary')).toEqual(pending)
  })

  test('with a pending mark already held, the removal is recorded on it and a later none keeps it', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'pending', askedAt: NOW })
    await sparkDeleteLnAddress()
    expect(sdk.deleteLightningAddress).toHaveBeenCalledTimes(1)
    const mark = await deletionMarkFor('primary')
    expect(mark).toEqual({ pubkey: PUBKEY, state: 'pending', askedAt: NOW, removedAt: expect.any(Number) })
    answers.status = [200, { status: 'returned' }]
    expect(await settleDeletion(deps())).toEqual({ kind: 'removed' })
    expect(await deletionMarkFor('primary')).toEqual({ pubkey: PUBKEY, state: 'removed', askedAt: mark?.removedAt })
  })

  test('with a removed mark already held, nothing is written and the address is given up', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'removed', askedAt: NOW })
    const before = await RNFS.readFile(MARKS, 'utf8')
    await sparkDeleteLnAddress()
    expect(sdk.deleteLightningAddress).toHaveBeenCalledTimes(1)
    expect(await RNFS.readFile(MARKS, 'utf8')).toBe(before)
  })

  // The removal is recorded on the pending mark, and the SDK's refusal takes back only that record.
  test('a give-up the SDK refuses beside a pending mark leaves the mark as it was', async () => {
    const pending = { pubkey: PUBKEY, state: 'pending' as const, askedAt: NOW }
    await writeDeletionMark('primary', pending)
    sdk.deleteLightningAddress.mockImplementationOnce(async () => {
      expect((await deletionMarkFor('primary'))?.removedAt).toEqual(expect.any(Number))
      throw new Error('server said no')
    })
    await expect(sparkDeleteLnAddress()).rejects.toThrow('server said no')
    expect(await deletionMarkFor('primary')).toEqual(pending)
  })

  // Nothing is forgotten before every refusal is known: a write of the mark that fails, or a give-up
  // the SDK refuses, leaves the address and the name it is remembered by.
  test('a mark the removal cannot write leaves the address and its name', async () => {
    await rememberLnAddress('old@usevoltz.app', 'primary')
    const intact = JSON.stringify({ other: { pubkey: OTHER, state: 'done', askedAt: NOW } })
    await RNFS.writeFile(MARKS, intact, 'utf8')
    const write = RNFS.writeFile
    const refused = jest.spyOn(RNFS, 'writeFile').mockImplementation(async (file: string, ...rest: unknown[]) => {
      if (file.startsWith(MARKS)) {
        throw new Error('ENOSPC: no space left on device')
      }
      return (write as (...args: unknown[]) => Promise<void>)(file, ...rest)
    })
    try {
      await expect(sparkDeleteLnAddress()).rejects.toThrow('ENOSPC')
    } finally {
      refused.mockRestore()
    }
    expect(sdk.deleteLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('primary')).toBe('old@usevoltz.app')
  })

  test('a give-up the SDK refuses keeps the name remembered', async () => {
    await rememberLnAddress('old@usevoltz.app', 'primary')
    sdk.deleteLightningAddress.mockRejectedValueOnce(new Error('server said no'))
    await expect(sparkDeleteLnAddress()).rejects.toThrow('server said no')
    expect(await lastLnAddress('primary')).toBe('old@usevoltz.app')
    await sparkDeleteLnAddress()
    expect(await lastLnAddress('primary')).toBeNull()
  })
})

// --- the flow through the real screens ---------------------------------------------------------

function textOf(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => [node.props.children].flat().filter(c => typeof c === 'string').join(''))
    .join('\n')
}

function pressable(renderer: Renderer, label: string): ReactTestInstance {
  const node = renderer.root.findAllByType(Text).find(n => [n.props.children].flat().join('') === label)
  let target: ReactTestInstance | null = node ?? null
  while (target && typeof target.props.onPress !== 'function') {
    target = target.parent
  }
  if (!target) {
    throw new Error(`nothing to press for ${label}`)
  }
  return target
}

function pressText(renderer: Renderer, label: string): void {
  const target = pressable(renderer, label)
  if (target.props.disabled) {
    throw new Error(`${label} is disabled`)
  }
  target.props.onPress()
}

function disabled(renderer: Renderer, label: string): boolean {
  return pressable(renderer, label).props.disabled === true
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise(resolve => setImmediate(resolve))
    })
  }
}

async function mount(element: React.ReactElement): Promise<Renderer> {
  let renderer!: Renderer
  await act(async () => {
    renderer = ReactTestRenderer.create(element)
  })
  await settle()
  return renderer
}

test('the flow: preview, confirm, in progress, deleted on the next open, and back', async () => {
  await i18n.changeLanguage('en-US')
  answers.preview = [200, PREVIEW]
  answers.request = [202, PENDING]
  answers.status = [200, PENDING]
  await RNFS.writeFile(`${DOCS}/ln-address-last.json`, JSON.stringify({ primary: 'alice@usevoltz.app', other: 'bob@usevoltz.app' }), 'utf8')

  // The preview says what goes, with the address.
  const screen = await mount(React.createElement(DeleteDataScreen))
  expect(textOf(screen)).toContain(i18n.t('deleteData.whatGoes', { address: 'alice@usevoltz.app' }))
  // What stays comes from the gateway's list, one line per code.
  for (const key of ['deleteData.staysPurchases', 'deleteData.staysMark', 'deleteData.nameAfter', 'deleteData.staysRequest']) {
    expect(textOf(screen)).toContain(i18n.t(key))
  }

  // Confirmed, the gateway records it: in progress, never deleted, and nothing local is gone yet.
  await act(async () => pressText(screen, i18n.t('deleteData.button')))
  await settle()
  expect(question(screen)?.title).toBe(i18n.t('deleteData.confirmTitle'))
  await confirmQuestion(screen)
  await settle()
  expect(screen.root.findByProps({ testID: 'deletion-state' }).props.children).toMatch(/^Requested on /)
  expect(JSON.parse(await RNFS.readFile(`${DOCS}/ln-address-last.json`, 'utf8')).primary).toBe('alice@usevoltz.app')
  act(() => screen.unmount())

  // Opening the address screen while it runs: no register, and no way back offered yet.
  calls = []
  const address = await mount(React.createElement(LnAddressScreen))
  expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  expect(address.root.findByProps({ testID: 'ln-held' }).props.children).toBe(i18n.t('receive.lnDeleting'))
  act(() => address.unmount())

  // Receive is the screen that asks for push registration. With the permission granted, a held
  // wallet is still not asked for it and registers no device.
  const notifications = jest.requireMock('../specs/NativeVoltzNotifications')
  notifications.device.answer = 'authorized'
  jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)
  const receive = await mount(React.createElement(ReceiveSpark))
  expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  expect(notifications.default.requestAuthorization).not.toHaveBeenCalled()
  expect(requestPermission).not.toHaveBeenCalled()
  expect(calls.filter(c => c.url.endsWith('/api/device'))).toEqual([])
  act(() => receive.unmount())
  notifications.device.answer = 'denied'
  jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.NOT_DETERMINED)

  // The next open of the screen reads done: the local copies go, then it says deleted.
  answers.status = [200, { status: 'done', doneAt: NOW + 1200 }]
  const again = await mount(React.createElement(DeleteDataScreen))
  expect(again.root.findByProps({ testID: 'deletion-state' }).props.children).toMatch(/^Data deleted on /)
  expect(JSON.parse(await RNFS.readFile(`${DOCS}/ln-address-last.json`, 'utf8'))).toEqual({ other: 'bob@usevoltz.app' })
  act(() => again.unmount())

  // Back on the address screen, the way back is offered, and only after the gateway's 200 is an
  // address made.
  answers.return = [200, { status: 'returned' }]
  const back = await mount(React.createElement(LnAddressScreen))
  expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  await act(async () => pressText(back, i18n.t('receive.lnRecreate')))
  await settle()
  expect(calls.some(c => c.body.action === 'return')).toBe(true)
  expect(sdk.registerLightningAddress).toHaveBeenCalledTimes(1)
  expect(await deletionMarkFor('primary')).toBeNull()
  act(() => back.unmount())
})

test('a stay code this build does not know is still said, never left out', async () => {
  await i18n.changeLanguage('en-US')
  answers.preview = [200, { ...PREVIEW, stays: ['purchases', 'something_new'] }]
  const screen = await mount(React.createElement(DeleteDataScreen))
  expect(textOf(screen)).toContain(i18n.t('deleteData.staysOther'))
  expect(textOf(screen)).toContain(i18n.t('deleteData.staysPurchases'))
  act(() => screen.unmount())
})

test('a blocked preview keeps the button off and names the reason', async () => {
  await i18n.changeLanguage('en-US')
  answers.preview = [200, { ...PREVIEW, blockers: ['store_order_open', 'something_new'] }]
  const screen = await mount(React.createElement(DeleteDataScreen))
  const text = textOf(screen)
  expect(text).toContain(i18n.t('deleteData.blockerStoreOrder'))
  expect(text).toContain(i18n.t('deleteData.blockerOther'))
  expect(disabled(screen, i18n.t('deleteData.button'))).toBe(true)
  act(() => screen.unmount())
})

test('no answer to the preview says nothing was deleted and offers nothing to press', async () => {
  await i18n.changeLanguage('en-US')
  const screen = await mount(React.createElement(DeleteDataScreen))
  expect(textOf(screen)).toContain(i18n.t('deleteData.offline'))
  expect(disabled(screen, i18n.t('deleteData.button'))).toBe(true)
  expect(await deletionMarkFor('primary')).toBeNull()
  act(() => screen.unmount())
})

describe('one lookup of the mark, and a seed deleted from another device', () => {
  const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  // The gateway refusing the key, as SDK 0.27.2 hands an LNURL server answer back (lnRefusal.ts).
  const refusedDeleted = () =>
    Object.assign(new Error('NetworkError'), {
      tag: 'NetworkError',
      inner: ['network request failed with status 409: {"error":"deleted"}'],
    })
  const DONE = { status: 'done', requestedAt: NOW - 900, doneAt: NOW - 60 }

  // A Keychain that keeps what it is given, as the device's does: adding a wallet reads its seed's
  // presence back before making it active, and removing one is checked against what is left.
  const keychain = new Set<string>()
  beforeEach(() => {
    keychain.clear()
    jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, _password, options) => {
      keychain.add(options?.service ?? '')
      return false
    })
    jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => keychain.has(options?.service ?? ''))
    jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
  })
  afterEach(() => {
    jest.mocked(Keychain.setGenericPassword).mockImplementation(async () => false)
    jest.mocked(Keychain.hasGenericPassword).mockImplementation(async () => false)
    jest.mocked(Keychain.resetGenericPassword).mockImplementation(async () => true)
  })

  // ensureRegistered is a stub in this file, so the entry a removal must take away is listed by the
  // real one, and checked present before the removal runs.
  async function listed(id: string): Promise<boolean> {
    return (await loadRegistry()).wallets.some(w => w.id === id)
  }
  async function register(id: string): Promise<void> {
    const real = jest.requireActual('../src/wallet/walletRegistry') as typeof import('../src/wallet/walletRegistry')
    await real.ensureRegistered(id, 'fp')
    expect(await listed(id)).toBe(true)
  }

  test("removing a wallet takes its mark and its import check with it", async () => {
    await writeDeletionMark('gone', { pubkey: PUBKEY, state: 'done', askedAt: NOW, doneAt: NOW })
    await noteImportCheck('gone')
    await removeWallet('gone', 'fp')
    expect(await deletionMarkFor('gone')).toBeNull()
    expect(await deletionHolds({ pubkey: PUBKEY })).toBe(false)
    expect(await importCheckDue('gone')).toBe(false)
  })

  test('an unreadable mark file never stops a wallet from being removed', async () => {
    const id = await addAndActivateWallet(MNEMONIC, undefined, 'typed')
    await RNFS.writeFile(`${DOCS}/deletion.json`, '{"gone":{"pubkey":', 'utf8')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(removeWallet(id, 'fp')).resolves.toBeUndefined()
    expect(await hasSeedFor(id)).toBe(false)
    // The file stays unreadable, so its readers keep holding: the safe side.
    expect(await deletionHolds({ pubkey: PUBKEY })).toBe(true)
    warn.mockRestore()
  })

  test('an import check list that cannot be written never stops a wallet from being removed', async () => {
    const id = await addAndActivateWallet(MNEMONIC, undefined, 'typed')
    await register(id)
    await noteImportCheck('other')
    const write = RNFS.writeFile
    const full = jest.spyOn(RNFS, 'writeFile').mockImplementation(async (file: string, ...rest: unknown[]) => {
      if (file.includes('deletion-check')) {
        throw new Error('ENOSPC')
      }
      return (write as (...args: unknown[]) => Promise<void>)(file, ...rest)
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(removeWallet(id, 'fp')).resolves.toBeUndefined()
    expect(await hasSeedFor(id)).toBe(false)
    expect(await listed(id)).toBe(false)
    full.mockRestore()
    warn.mockRestore()
  })

  test('a mark stored under another id for the same key holds the ensure and shows on the address screen', async () => {
    await i18n.changeLanguage('en-US')
    await writeDeletionMark('twin', { pubkey: PUBKEY, state: 'done', askedAt: NOW, doneAt: NOW })
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    const screen = await mount(React.createElement(LnAddressScreen))
    expect(screen.root.findByProps({ testID: 'ln-held' }).props.children).toBe(i18n.t('receive.lnOff'))
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    act(() => screen.unmount())
  })

  test('the flow: deleted on one device, removed, imported again, and shown as deleted with the way back', async () => {
    await i18n.changeLanguage('en-US')
    // The first wallet of this seed asked, got done, and was removed from this device.
    await writeDeletionMark('gone', { pubkey: PUBKEY, state: 'done', askedAt: NOW, doneAt: NOW - 60 })
    await removeWallet('gone', 'fp')
    // The same seed imported again, under a new id, and Home's first sweep reads the status once.
    const id = await addAndActivateWallet(MNEMONIC, undefined, 'typed')
    mockActive = id
    expect(await importCheckDue(id)).toBe(true)
    answers.status = [200, DONE]
    await checkImportedDeletion(await liveDeletionDeps())
    expect(await importCheckDue(id)).toBe(false)
    expect((await deletionMarkFor(id))?.state).toBe('done')

    // Nothing registered on the address screen, and the way back offered, as on the first device.
    const address = await mount(React.createElement(LnAddressScreen))
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(address.root.findByProps({ testID: 'ln-held' }).props.children).toBe(i18n.t('receive.lnOff'))
    expect(textOf(address)).toContain(i18n.t('receive.lnRecreate'))
    act(() => address.unmount())

    // The deletion screen says deleted, from the mark, without asking again.
    calls = []
    const deletion = await mount(React.createElement(DeleteDataScreen))
    expect(deletion.root.findByProps({ testID: 'deletion-state' }).props.children).toMatch(/^Data deleted on /)
    expect(calls).toEqual([])
    act(() => deletion.unmount())

    // Push is not sent for the key either.
    const push = await registerPushDevice({
      gatewayUrl: 'https://usevoltz.app',
      domain: 'usevoltz.app',
      platform: 'android',
      token: 'tok',
      identity: async () => PUBKEY,
      sign: async () => 'sig',
      request: fakeFetch as unknown as typeof fetch,
    })
    expect(push).toBe(false)
    expect(calls.filter(c => c.url.endsWith('/api/device'))).toEqual([])
  })

  test('an import read with no answer stays due, and a pending answer holds as in progress', async () => {
    await i18n.changeLanguage('en-US')
    const id = await addAndActivateWallet(MNEMONIC, undefined, 'typed')
    mockActive = id
    await checkImportedDeletion(await liveDeletionDeps())
    expect(await importCheckDue(id)).toBe(true)
    expect(await deletionMarkFor(id)).toBeNull()
    answers.status = [200, PENDING]
    await checkImportedDeletion(await liveDeletionDeps())
    expect(await importCheckDue(id)).toBe(false)
    const address = await mount(React.createElement(LnAddressScreen))
    expect(address.root.findByProps({ testID: 'ln-held' }).props.children).toBe(i18n.t('receive.lnDeleting'))
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    act(() => address.unmount())
  })

  test('with no read at import, the gateway refusing the key makes the address screen read it once', async () => {
    await i18n.changeLanguage('en-US')
    sdk.checkLightningAddressAvailable.mockRejectedValue(refusedDeleted())
    sdk.registerLightningAddress.mockRejectedValue(refusedDeleted())
    answers.status = [200, DONE]
    const address = await mount(React.createElement(LnAddressScreen))
    expect(calls.filter(c => c.body.action === 'status')).toHaveLength(1)
    expect((await deletionMarkFor('primary'))?.state).toBe('done')
    expect(address.root.findByProps({ testID: 'ln-held' }).props.children).toBe(i18n.t('receive.lnOff'))
    expect(textOf(address)).toContain(i18n.t('receive.lnRecreate'))
    act(() => address.unmount())
  })

  test('a register refused as deleted is passed up, never retried as a taken name', async () => {
    sdk.registerLightningAddress.mockRejectedValue(refusedDeleted())
    await expect(sparkEnsureLnAddress()).rejects.toMatchObject({ tag: 'NetworkError' })
    expect(sdk.registerLightningAddress).toHaveBeenCalledTimes(1)
  })
})

describe("an owner's way back lands on the domain in use", () => {
  const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const lastConfigDomain = () =>
    (jest.mocked(connect).mock.calls.at(-1)?.[0] as { config: { lnurlDomain?: string } }).config.lnurlDomain

  // Connected on the wallet's own domain, as an owner is.
  beforeEach(async () => {
    await RNFS.writeFile(`${DOCS}/lnurl-domain.json`, JSON.stringify({ primary: 'pay.a.com' }), 'utf8')
    await disconnectSpark()
    await connectSpark(MNEMONIC)
    expect(connectedLnurlDomain()).toBe('pay.a.com')
  })

  test("the cleanup of done reconnects, so the session no longer serves the owner's domain", async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'pending', askedAt: NOW, ownedHosts: ['pay.a.com'] })
    answers.status = [200, { status: 'done', doneAt: NOW + 600 }]
    expect(await settleDeletion(deps())).toEqual({ kind: 'done', doneAt: NOW + 600 })
    expect(connectedLnurlDomain()).toBe('usevoltz.app')
    expect(lastConfigDomain()).toBe('usevoltz.app')
  })

  test('the way back reconnects before it registers, when the domain moved under the session', async () => {
    await i18n.changeLanguage('en-US')
    // The cleanup ran and pointed the wallet back, and the session was never rebuilt.
    await RNFS.writeFile(`${DOCS}/lnurl-domain.json`, JSON.stringify({}), 'utf8')
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'done', askedAt: NOW, doneAt: NOW + 600 })
    answers.return = [200, { status: 'returned' }]
    const servedAtRegister: (string | undefined)[] = []
    sdk.registerLightningAddress.mockImplementation(async ({ username }: { username: string }) => {
      servedAtRegister.push(connectedLnurlDomain())
      return { username, lightningAddress: `${username}@usevoltz.app`, lnurl: { url: 'https://usevoltz.app/lnurlp', bech32: 'lnurl1x' }, description: '' }
    })
    const screen = await mount(React.createElement(LnAddressScreen))
    await act(async () => pressText(screen, i18n.t('receive.lnRecreate')))
    await settle()
    expect(servedAtRegister).toEqual(['usevoltz.app'])
    expect(lastConfigDomain()).toBe('usevoltz.app')
    act(() => screen.unmount())
  })
})

// The preview's `owed` as the gateway writes it lists every charge in sats Voltz may owe the wallet
// (listed as owed) or has not checked, with no time window.
const OWED = [
  { reference: 'chg_refused', kind: 'name', domain: 'usevoltz.app', subject: 'alice', sats: 21000, state: 'refused', at: NOW - 40 * 86_400 },
  { reference: 'chg_kept', kind: 'tier', domain: 'pay.a.com', subject: 'pay.a.com', sats: 150000, state: 'not_granted', at: NOW - 3 * 86_400 },
  { reference: 'chg_unknown', kind: 'name', domain: 'usevoltz.app', subject: 'bob', sats: 5000, state: 'unchecked', at: NOW - 86_400 },
]

describe('what Voltz may owe, from the preview', () => {
  test('a gateway without the field is read as nothing owed', async () => {
    answers.preview = [200, PREVIEW]
    const read = await previewDeletion(deps())
    expect(read.kind === 'preview' && read.preview.owed).toEqual([])
  })

  test('each row is read as sent', async () => {
    answers.preview = [200, { ...PREVIEW, owed: OWED }]
    const read = await previewDeletion(deps())
    expect(read.kind === 'preview' && read.preview.owed).toEqual(OWED)
  })

  test.each([
    ['not a list', { owed: { reference: 'x' } }],
    ['a state this build does not know', { owed: [{ ...OWED[0], state: 'paid' }] }],
    ['no reference', { owed: [{ ...OWED[0], reference: '' }] }],
    ['sats that are not a whole positive number', { owed: [{ ...OWED[0], sats: 0 }] }],
    ['sats as text', { owed: [{ ...OWED[0], sats: '21000' }] }],
    ['an unknown kind', { owed: [{ ...OWED[0], kind: 'credit' }] }],
    ['no date', { owed: [{ ...OWED[0], at: undefined }] }],
    ['no domain', { owed: [{ ...OWED[0], domain: undefined }] }],
  ])('%s makes the whole reply no preview', async (_, field) => {
    answers.preview = [200, { ...PREVIEW, ...field }]
    expect(await previewDeletion(deps())).toEqual({ kind: 'failed' })
  })

  test('the screen shows each before the button, with the reference on its own and the words for its state', async () => {
    await i18n.changeLanguage('en-US')
    answers.preview = [200, { ...PREVIEW, owed: OWED }]
    const screen = await mount(React.createElement(DeleteDataScreen))
    const text = textOf(screen)
    expect(text).toContain(i18n.t('deleteData.owedTitle'))
    for (const charge of OWED) {
      const ref = screen.root.findByProps({ testID: `owed-reference-${charge.reference}` })
      expect(ref.props.selectable).toBe(true)
      expect(ref.props.children).toBe(charge.reference)
    }
    const lines = text.split('\n')
    const refused = lines.find(l => l.startsWith('alice@usevoltz.app, 21\u00a0000 sats'))
    const kept = lines.find(l => l.startsWith('pay.a.com, 150\u00a0000 sats'))
    const unknown = lines.find(l => l.startsWith('bob@usevoltz.app, 5\u00a0000 sats'))
    expect(refused).toContain('paid, and the purchase was refused')
    expect(kept).toContain('paid, and not delivered')
    // Never said to be paid.
    expect(unknown).toContain('has not confirmed whether this charge was paid')
    expect(unknown).not.toContain('paid, and')
    // Before the confirm button.
    const all = screen.root.findAllByType(Text).map(n => [n.props.children].flat().join(''))
    const button = all.indexOf(i18n.t('deleteData.button'))
    expect(all.indexOf('chg_unknown')).toBeGreaterThan(-1)
    expect(all.indexOf('chg_unknown')).toBeLessThan(button)
    act(() => screen.unmount())
  })

  // Nothing records a repayment, so a refused or held-back charge may already be paid back when the
  // screen shows it. Its words hold either way, and they lead to the one row that reaches support.
  test('a charge that may be owed is never said to be owed, and support is one row away with every reference', async () => {
    await i18n.changeLanguage('en-US')
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    const sats = { rail: 'sats', kind: 'name', domain: 'usevoltz.app', subject: 'alice2', reference: 'chg_settled', at: NOW - 86_400 }
    answers.preview = [200, { ...PREVIEW, recentPurchases: [...PREVIEW.recentPurchases, sats], owed: OWED }]
    const screen = await mount(React.createElement(DeleteDataScreen))
    const text = textOf(screen)
    expect(text).not.toMatch(/owes/i)
    const lines = text.split('\n')
    for (const subject of ['alice@usevoltz.app, 21 000 sats', 'pay.a.com, 150 000 sats']) {
      expect(lines.find(l => l.startsWith(subject))).toContain('If these sats have not come back to this wallet')
    }
    const rows = screen.root.findAllByType(MenuRow).filter(n => n.props.label === i18n.t('deleteData.refundSupport'))
    expect(rows).toHaveLength(1)
    await act(async () => {
      rows[0].props.onPress()
    })
    const body = decodeURIComponent(String(open.mock.calls[0][0]).split('body=')[1])
    expect(body.split(', ').sort()).toEqual(['chg_kept', 'chg_refused', 'chg_settled', 'chg_unknown'])
    act(() => screen.unmount())

    // With nothing owed the row stays with the sats purchase, still once.
    answers.preview = [200, { ...PREVIEW, recentPurchases: [...PREVIEW.recentPurchases, sats] }]
    const plain = await mount(React.createElement(DeleteDataScreen))
    expect(plain.root.findAllByType(MenuRow).filter(n => n.props.label === i18n.t('deleteData.refundSupport'))).toHaveLength(1)
    act(() => plain.unmount())
    open.mockRestore()
  })
})

describe('with no answer to be had, the screen says what the mark says', () => {
  // The wallet the app is on cannot be connected, so nothing can be signed or asked.
  beforeEach(() => {
    mockActive = 'second'
    jest.mocked(connect).mockRejectedValue(new Error('offline'))
  })

  test('a pending request reads as in progress, never as nothing deleted', async () => {
    await i18n.changeLanguage('en-US')
    await writeDeletionMark('second', { pubkey: PUBKEY, state: 'pending', askedAt: NOW, requestedAt: NOW, deadline: NOW + 900 })
    const screen = await mount(React.createElement(DeleteDataScreen))
    expect(screen.root.findByProps({ testID: 'deletion-state' }).props.children).toMatch(/^Requested on /)
    expect(textOf(screen)).not.toContain('Nothing was deleted')
    act(() => screen.unmount())
  })

  test('a finished deletion reads as deleted', async () => {
    await i18n.changeLanguage('en-US')
    await writeDeletionMark('second', { pubkey: PUBKEY, state: 'done', askedAt: NOW, doneAt: NOW + 600 })
    const screen = await mount(React.createElement(DeleteDataScreen))
    expect(screen.root.findByProps({ testID: 'deletion-state' }).props.children).toMatch(/^Data deleted on /)
    act(() => screen.unmount())
  })

  test('a removed address is not called nothing deleted', async () => {
    await i18n.changeLanguage('en-US')
    await writeDeletionMark('second', { pubkey: PUBKEY, state: 'removed', askedAt: NOW })
    const screen = await mount(React.createElement(DeleteDataScreen))
    expect(textOf(screen)).toContain(i18n.t('deleteData.noAnswer'))
    expect(textOf(screen)).not.toContain('Nothing was deleted')
    expect(disabled(screen, i18n.t('deleteData.button'))).toBe(true)
    act(() => screen.unmount())
  })

  test('only an empty mark says nothing was deleted', async () => {
    await i18n.changeLanguage('en-US')
    const screen = await mount(React.createElement(DeleteDataScreen))
    expect(textOf(screen)).toContain(i18n.t('deleteData.failed'))
    act(() => screen.unmount())
  })
})

test('after the mark is dropped, the wallet is free again', async () => {
  await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'asked', askedAt: NOW })
  await clearDeletionMark('primary')
  expect(await RNFS.exists(`${DOCS}/deletion.json`)).toBe(false)
})

// --- a mark file this device could not read ------------------------------------------------------

describe('a mark file that cannot be read is read back from the gateway, wallet by wallet', () => {
  const REGISTRY = {
    wallets: [
      { id: 'primary', fingerprint: 'fp' },
      { id: 'other', fingerprint: 'fp2' },
    ],
    active: 'primary',
  }
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
    await RNFS.writeFile(`${DOCS}/wallets.json`, JSON.stringify(REGISTRY), 'utf8')
    await RNFS.writeFile(`${DOCS}/deletion.json`, '{"primary":{"pubkey":"02', 'utf8')
  })

  test('the address screen holds with the held line, never that data is being deleted', async () => {
    const screen = await mount(React.createElement(LnAddressScreen))
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(screen.root.findByProps({ testID: 'ln-held' }).props.children).toBe(i18n.t('receive.lnHeldChecking'))
    expect(textOf(screen)).not.toContain(i18n.t('receive.lnRecreate'))
    act(() => screen.unmount())
  })

  // A lost mark is most often a wallet whose address is still live, and the line also shows offline
  // or after a failed read. The read may then answer none, returned, pending or done, and only the first
  // two bring the address back, so the line states a condition and promises no outcome.
  test('the held line states only that an address waits for Voltz, true for every answer', () => {
    expect(i18n.t('receive.lnHeldChecking', { lng: 'en-US' })).toBe('An address can show here only once Voltz answers.')
  })

  test('with no answer the deletion screen says it could not check, and offers nothing to press', async () => {
    const screen = await mount(React.createElement(DeleteDataScreen))
    expect(calls.filter(c => c.body.action === 'status')).toHaveLength(1)
    expect(screen.root.findByProps({ testID: 'deletion-state' }).props.children).toBe(i18n.t('deleteData.checking'))
    expect(textOf(screen)).not.toContain(i18n.t('deleteData.offline'))
    expect(textOf(screen)).not.toContain(i18n.t('deleteData.inProgress'))
    expect(textOf(screen)).not.toContain(i18n.t('deleteData.button'))
    expect(await deletionHolds({ walletId: 'primary', pubkey: PUBKEY })).toBe(true)
    act(() => screen.unmount())
  })

  test('the deletion screen reads it back and, on none, shows the page as for any wallet', async () => {
    answers.status = [200, { status: 'none' }]
    answers.preview = [200, PREVIEW]
    const screen = await mount(React.createElement(DeleteDataScreen))
    expect(screen.root.findByProps({ testID: 'deletion-goes' })).toBeTruthy()
    expect(await deletionHolds({ walletId: 'primary', pubkey: PUBKEY })).toBe(false)
    expect(await deletionHolds({ walletId: 'other' })).toBe(true)
    act(() => screen.unmount())
  })

  test("Home's read lets this wallet go on none, and the other stays held until its own read", async () => {
    answers.status = [200, { status: 'none' }]
    await readDeletionOnFocus(deps())
    expect(await deletionHolds({ walletId: 'primary', pubkey: PUBKEY })).toBe(false)
    expect(await deletionHolds({ walletId: 'other' })).toBe(true)
    expect(await deletionHolds({ pubkey: OTHER })).toBe(true)
    expect(await sparkEnsureLnAddress()).not.toBeNull()
    expect(sdk.registerLightningAddress).toHaveBeenCalledTimes(1)

    answers.status = [200, PENDING]
    await readDeletionOnFocus(deps({ walletId: 'other', pubkey: OTHER }))
    expect((await deletionMarkFor('other', OTHER))?.state).toBe('pending')
    expect(JSON.parse(await RNFS.readFile(`${DOCS}/deletion.json`, 'utf8'))).not.toHaveProperty('~repair')
  })

  test('a pending answer holds the wallet as in progress within the same open', async () => {
    answers.status = [200, PENDING]
    await readDeletionOnFocus(deps())
    expect((await deletionMarkFor('primary', PUBKEY))?.state).toBe('pending')
    const screen = await mount(React.createElement(LnAddressScreen))
    expect(screen.root.findByProps({ testID: 'ln-held' }).props.children).toBe(i18n.t('receive.lnDeleting'))
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    act(() => screen.unmount())
  })

  test('a done answer says deleted only after the local cleanup ran', async () => {
    answers.status = [200, { status: 'done', requestedAt: NOW - 900, doneAt: NOW - 60 }]
    const failing = jest.fn(async () => {
      throw new Error('disk full')
    })
    expect((await settleDeletion({ ...deps(), cleanup: failing })).kind).toBe('pending')
    expect((await deletionMarkFor('primary', PUBKEY))?.state).toBe('pending')
    const cleanup = jest.fn(async () => undefined)
    expect((await settleDeletion({ ...deps(), cleanup })).kind).toBe('done')
    expect(cleanup).toHaveBeenCalledWith('primary', PUBKEY, undefined)
  })

  test('no answer leaves the wallet held and the read due', async () => {
    await readDeletionOnFocus(deps())
    expect(calls.filter(c => c.body.action === 'status')).toHaveLength(1)
    expect((await findDeletionMark({ walletId: 'primary', pubkey: PUBKEY }))?.unknown).toBe(true)
    await readDeletionOnFocus(deps())
    expect(calls.filter(c => c.body.action === 'status')).toHaveLength(2)
  })
})

// --- the status read on every Home focus -----------------------------------------------------------

describe('a request in flight is read on every Home focus, not only on the deletion screen', () => {
  const DONE_LATER = { status: 'done', requestedAt: NOW, doneAt: NOW + 60 }

  test('a request that finished elsewhere ends in done with its local cleanup', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'pending', askedAt: NOW, requestedAt: NOW, deadline: NOW + 10 })
    answers.status = [200, DONE_LATER]
    const cleanup = jest.fn(async () => undefined)
    await readDeletionOnFocus({ ...deps(), cleanup })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(await deletionMarkFor('primary')).toMatchObject({ state: 'done', doneAt: NOW + 60 })
  })

  // Each case on its own wallet, since the floor is kept in memory for the whole run.
  test('a pending answer is read again only after the floor, and the same answer writes nothing', async () => {
    const id = 'floor-a'
    await writeDeletionMark(id, { pubkey: PUBKEY, state: 'pending', askedAt: NOW, requestedAt: NOW, deadline: NOW + 10 })
    answers.status = [200, { status: 'pending', requestedAt: NOW, finishBy: NOW + 10 }]
    const write = jest.spyOn(RNFS, 'writeFile')
    let clock = NOW * 1000
    const focus = () => readDeletionOnFocus(deps({ walletId: id, now: () => clock }))
    await focus()
    expect(calls.filter(c => c.body.action === 'status')).toHaveLength(1)
    expect(write.mock.calls.filter(([file]) => String(file).includes('deletion.json'))).toEqual([])
    clock += (PENDING_FOCUS_FLOOR_SECS - 1) * 1000
    await focus()
    expect(calls.filter(c => c.body.action === 'status')).toHaveLength(1)
    clock += 1000
    await focus()
    expect(calls.filter(c => c.body.action === 'status')).toHaveLength(2)
    write.mockRestore()
  })

  test('the same pending answer over a mark another change replaced shows the mark as it is now', async () => {
    const id = 'floor-c'
    await writeDeletionMark(id, { pubkey: PUBKEY, state: 'pending', askedAt: NOW, requestedAt: NOW, deadline: NOW + 10 })
    const request = jest.fn(async () => {
      await writeDeletionMark(id, { pubkey: PUBKEY, state: 'done', askedAt: NOW, doneAt: NOW + 5 })
      return { ok: true, status: 200, json: async () => ({ status: 'pending', requestedAt: NOW, finishBy: NOW + 10 }) }
    })
    expect(await settleDeletion(deps({ walletId: id, request: request as unknown as typeof fetch }))).toEqual({
      kind: 'done',
      doneAt: NOW + 5,
    })
  })

  test('a pending answer with a new deadline is still written', async () => {
    const id = 'floor-b'
    await writeDeletionMark(id, { pubkey: PUBKEY, state: 'pending', askedAt: NOW, requestedAt: NOW, deadline: NOW + 10 })
    answers.status = [200, { status: 'pending', requestedAt: NOW, finishBy: NOW + 20 }]
    await readDeletionOnFocus(deps({ walletId: id }))
    expect(await deletionMarkFor(id)).toMatchObject({ state: 'pending', deadline: NOW + 20 })
  })

  test("Home's read and the deletion screen's hearing done at once run one local cleanup", async () => {
    const id = 'both-done'
    await writeDeletionMark(id, { pubkey: PUBKEY, state: 'pending', askedAt: NOW, requestedAt: NOW, deadline: NOW + 10 })
    answers.status = [200, DONE_LATER]
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const cleanup = jest.fn(() => gate)
    const home = readDeletionOnFocus({ ...deps({ walletId: id }), cleanup })
    const screen = settleDeletion({ ...deps({ walletId: id }), cleanup })
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setImmediate(resolve))
    }
    release()
    await home
    expect(await screen).toEqual({ kind: 'done', doneAt: NOW + 60 })
    expect(calls.filter(c => c.body.action === 'status')).toHaveLength(2)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(await deletionMarkFor(id)).toMatchObject({ state: 'done', doneAt: NOW + 60 })
  })

  test('an asked request with no answer stays asked after one read, and the next focus reads again', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'asked', askedAt: NOW })
    await readDeletionOnFocus(deps())
    await readDeletionOnFocus(deps())
    expect(calls.filter(c => c.body.action === 'status')).toHaveLength(2)
    expect((await deletionMarkFor('primary'))?.state).toBe('asked')
  })

  test('an asked request the gateway never recorded lets the wallet go', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'asked', askedAt: NOW })
    answers.status = [200, { status: 'none' }]
    await readDeletionOnFocus(deps())
    expect(await deletionMarkFor('primary')).toBeNull()
  })

  test.each(['removed', 'done'] as const)('a %s mark reads nothing', async state => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state, askedAt: NOW, doneAt: NOW })
    await readDeletionOnFocus(deps())
    expect(calls).toEqual([])
  })

  test('a wallet with no mark and nothing due reads nothing', async () => {
    await readDeletionOnFocus(deps())
    expect(calls).toEqual([])
  })

  // The Home read starts from the mark it found, and a request can be made and recorded while its
  // answer is on the way. That answer is older than the request and must not let it go.
  test("a status of none sent before a request was recorded never drops that request's mark", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const slow = jest.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { action?: string }
      if (body.action === 'status') {
        await gate
        return { ok: true, status: 200, json: async () => ({ status: 'none' }) }
      }
      return { ok: true, status: 202, json: async () => PENDING }
    })
    const request = slow as unknown as typeof fetch
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'asked', askedAt: NOW - 100 })
    const settling = settleDeletion(deps({ request }))
    await settle()
    expect(slow).toHaveBeenCalledTimes(1)
    expect((await requestDeletion(deps({ request }))).kind).toBe('pending')
    release()
    expect((await settling).kind).toBe('pending')
    expect((await deletionMarkFor('primary'))?.state).toBe('pending')
  })
})

// --- the preview's status, for a seed deleted from another device -----------------------------------

describe("the preview's merged status writes the mark of a wallet that holds none here", () => {
  test('pending: the screen shows the request, and nothing automatic runs for the wallet', async () => {
    await i18n.changeLanguage('en-US')
    answers.preview = [200, { ...PREVIEW, ...PENDING }]
    const screen = await mount(React.createElement(DeleteDataScreen))
    expect(screen.root.findByProps({ testID: 'deletion-state' }).props.children).toMatch(/^Requested on /)
    expect(textOf(screen)).not.toContain(i18n.t('deleteData.button'))
    expect((await deletionMarkFor('primary', PUBKEY))?.state).toBe('pending')
    act(() => screen.unmount())
    expect(await sparkEnsureLnAddress()).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })

  test('done: the local cleanup runs and only then the screen says deleted', async () => {
    await i18n.changeLanguage('en-US')
    answers.preview = [200, { ...PREVIEW, status: 'done', requestedAt: NOW - 900, doneAt: NOW - 60 }]
    const screen = await mount(React.createElement(DeleteDataScreen))
    expect(screen.root.findByProps({ testID: 'deletion-state' }).props.children).toMatch(/^Data deleted on /)
    expect((await deletionMarkFor('primary', PUBKEY))?.state).toBe('done')
    act(() => screen.unmount())
  })

  test.each([
    ['none', { status: 'none' }],
    ['returned', { status: 'returned', returnedAt: NOW }],
  ])('%s writes nothing, and the page asks as before', async (_, status) => {
    await i18n.changeLanguage('en-US')
    answers.preview = [200, { ...PREVIEW, ...status }]
    const screen = await mount(React.createElement(DeleteDataScreen))
    expect(screen.root.findByProps({ testID: 'deletion-goes' })).toBeTruthy()
    expect(await deletionMarkFor('primary', PUBKEY)).toBeNull()
    act(() => screen.unmount())
  })

  test('a removed address is kept as it is and shown the page', async () => {
    await i18n.changeLanguage('en-US')
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'removed', askedAt: NOW })
    answers.preview = [200, { ...PREVIEW, ...PENDING }]
    const screen = await mount(React.createElement(DeleteDataScreen))
    expect(screen.root.findByProps({ testID: 'deletion-goes' })).toBeTruthy()
    expect((await deletionMarkFor('primary'))?.state).toBe('removed')
    act(() => screen.unmount())
  })
})

// --- an explicit purchase refused for an address given up here --------------------------------------

describe('a removed address refuses an explicit purchase with words that point to the way back', () => {
  test('every purchase stop answers address_removed for a removed mark, and nothing is sent', async () => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'removed', askedAt: NOW })
    const sign = jest.fn(async () => 'sig')
    const request = fakeFetch as unknown as typeof fetch
    const store = { gatewayUrl: 'https://usevoltz.app', domain: 'usevoltz.app', pubkey: PUBKEY, sign, request }
    expect(await openStoreOrder(store, 'apple', 'name', 'alice')).toEqual({ kind: 'refused', status: 409, code: 'address_removed' })
    expect(await recordSpendIntent(store, 'alice')).toEqual({ kind: 'refused', status: 409, code: 'address_removed' })
    await expect(quoteName(store, 'alice')).rejects.toThrow('address_removed')
    const onboard = { gatewayUrl: 'https://usevoltz.app', ownerPubkey: PUBKEY, sign, request }
    await expect(quoteDomain(onboard, 'pay.a.com')).rejects.toThrow('address_removed')
    await expect(claimDomain(onboard, 'pay.a.com')).rejects.toThrow('address_removed')
    expect(calls).toEqual([])
    expect(sign).not.toHaveBeenCalled()
  })

  test('the code has its words on the name and store screens', () => {
    expect(refusalKey('address_removed')).toBe('receive.lnOffBuy')
    expect(storeNameRefusalKey('address_removed')).toBe('receive.lnOffBuy')
  })

  // The words name the row that lifts the hold, so each locale carries its own label of that row and
  // of the screen it is on, as those strings read.
  // The deleted code is thrown for every mark, removed and lost ones included, and by the gateway's
  // refusal of the key, so its words state only the hold and send the person to the screen that says
  // which one it is.
  test("every locale's words for the deleted code name the address screen, and en-US claims no deletion", () => {
    const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales')
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const locale = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      expect([file, (locale.errors.deleted as string).includes(locale.settings.lnAddress)]).toEqual([file, true])
    }
    const en = JSON.parse(fs.readFileSync(path.join(dir, 'en-US.json'), 'utf8'))
    expect(en.errors.deleted).not.toMatch(/delet/i)
  })

  test("every locale's words name its own Create the address again and its address screen", () => {
    const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales')
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const locale = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      const words: string = locale.receive.lnOffBuy
      expect([file, words.includes(locale.receive.lnRecreate)]).toEqual([file, true])
      expect([file, words.includes(locale.settings.lnAddress)]).toEqual([file, true])
    }
  })
})

// A Keychain that keeps what it is given for the length of `run`, then the default double again.
async function withKeychain(run: () => Promise<void>): Promise<void> {
  const store = new Map<string, string>()
  const set = jest.mocked(Keychain.setGenericPassword)
  const get = jest.mocked(Keychain.getGenericPassword)
  const reset = jest.mocked(Keychain.resetGenericPassword)
  const before = [set.getMockImplementation(), get.getMockImplementation(), reset.getMockImplementation()] as const
  set.mockImplementation(async (_user, password, options) => {
    store.set(options?.service ?? '', password)
    return false
  })
  get.mockImplementation(async options =>
    store.has(options?.service ?? '') ? ({ username: 'u', password: store.get(options?.service ?? '')! } as never) : false,
  )
  reset.mockImplementation(async options => store.delete(options?.service ?? ''))
  try {
    await run()
  } finally {
    set.mockImplementation(before[0]!)
    get.mockImplementation(before[1]!)
    reset.mockImplementation(before[2]!)
  }
}
