import { PermissionsAndroid, Platform } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import { createHmac } from 'crypto'
import { AuthorizationStatus, getToken, hasPermission } from '@react-native-firebase/messaging'
import { ensurePushRegistered, recheckNotifications } from '../src/wallet/pushToken'
import { deviceForgetSettled } from '../src/wallet/deviceForget'
import { ensureRegistered } from '../src/wallet/walletRegistry'
import {
  PASS_WAIT_MS,
  paymentWebhookSettled,
  retirePaymentWebhook,
  syncPaymentWebhook,
} from '../src/wallet/paymentWebhook'
import {
  loadDeviceForgets,
  loadRetiring,
  loadWebhookState,
  retireWebhookState,
} from '../src/wallet/webhookSecret'
import { clearDeletionMark, writeDeletionMark } from '../src/wallet/deletionMark'
import i18n from '../src/i18n'
import { consoleLines } from './support/consoleLines'

// The connect path end to end: the push registration a connect runs, the gateway's answer, and the
// pass that brings the provider's webhooks in line, against a mockProvider that keeps what it is given.

jest.mock('../src/config', () => ({
  getBreezLnurlDomain: jest.fn(() => 'lnurl.usevoltz.app'),
  getBreezSparkApiKey: jest.fn(() => 'key'),
  getBreezApiKey: jest.fn(() => 'key'),
}))

type Hook = { id: string; url: string; events: string[]; secret: string }

// A Spark provider with one list of webhooks per wallet, shared by whatever registers on that wallet.
const mockProvider = {
  hooks: new Map<string, Hook[]>(),
  seq: 0,
  // Calls that reject, as a mockProvider that cannot be reached does, counted down per call.
  failing: { list: 0, register: 0, unregister: 0 },
  // A list that never answers.
  hang: false,
  calls: [] as string[],
}

const wallets = {
  w1: { walletId: 'w1', pubkey: '02'.padEnd(66, 'a') },
  w2: { walletId: 'w2', pubkey: '03'.padEnd(66, 'b') },
  // The words of w1 added again under a new id: the provider knows the key, not the id.
  w3: { walletId: 'w3', pubkey: '02'.padEnd(66, 'a') },
}
let mockConnected = wallets.w1

jest.mock('../src/wallet/spark', () => {
  const failOnce = (kind: 'list' | 'register' | 'unregister') => {
    if (mockProvider.failing[kind] > 0) {
      mockProvider.failing[kind] -= 1
      throw new Error(`mockProvider ${kind} failed`)
    }
  }
  return {
    sparkGetIdentityPubkey: jest.fn(async () => mockConnected.pubkey),
    sparkConnectedIdentity: jest.fn(async () => mockConnected),
    sparkSignMessage: jest.fn(async () => 'deadbeef'),
    sparkWebhookSession: jest.fn((walletId: string, pubkey: string) => {
      if (walletId !== mockConnected.walletId) {
        throw new Error('spark connected as another wallet')
      }
      // One list per key, as the provider keeps it: w3 holds w1's words.
      const key = mockConnected.pubkey
      const list = () => mockProvider.hooks.get(key) ?? []
      // Each call refuses a connection whose identity is not the session's key, as spark.ts does.
      const own = () => {
        if (pubkey !== key) {
          throw new Error('spark connected as another identity')
        }
      }
      return {
        list: async () => {
          own()
          mockProvider.calls.push('list')
          if (mockProvider.hang) {
            return new Promise(() => undefined)
          }
          failOnce('list')
          return list().map(({ id, url, events }) => ({ id, url, events: [...events] }))
        },
        register: async (url: string, secret: string) => {
          own()
          mockProvider.calls.push('register')
          failOnce('register')
          const id = `h${++mockProvider.seq}`
          const events = ['LightningReceiveFinished', 'LightningSendFinished', 'CoopExitFinished', 'StaticDepositFinished']
          mockProvider.hooks.set(key, [...list(), { id, url, events, secret }])
          return id
        },
        unregister: async (id: string) => {
          own()
          mockProvider.calls.push('unregister')
          failOnce('unregister')
          mockProvider.hooks.set(
            key,
            list().filter(hook => hook.id !== id),
          )
        },
      }
    }),
  }
})

// A gateway with one webhook id per wallet and device token, kept when only the secret moves, as
// registerSparkDevice does. `rotate` hands out a new id for the next registration of a pair.
const gateway = {
  ids: new Map<string, string>(),
  secrets: new Map<string, string>(),
  seq: 0,
  rotate: false,
  down: false,
  // A registration the gateway records and whose answer never reaches the device.
  loseAnswer: false,
  // Whether a forget reaches the gateway, apart from registration. 'hang' never answers.
  forgetDown: false as boolean | 'hang',
  bodies: [] as Record<string, unknown>[],
  forgets: [] as Record<string, unknown>[],
}

// The forget as the gateway checks it, built here by hand: every row of the key whose stored secret
// makes the proof goes, under any token, and the answer is the same whatever matched.
function gatewayForget(body: Record<string, string>): void {
  const statement = `voltz-push-forget:v1\nlnurl.usevoltz.app\n${body.pubkey}`
  for (const [key, id] of [...gateway.ids]) {
    const secret = gateway.secrets.get(id)
    const proof = secret ? createHmac('sha256', Buffer.from(secret, 'utf8')).update(statement, 'utf8').digest('hex') : null
    if (key.startsWith(`${body.pubkey}|`) && proof === body.proof) {
      gateway.ids.delete(key)
    }
  }
}

function newId(): string {
  gateway.seq += 1
  return `Id${String(gateway.seq).padStart(20, '0')}`
}

const fetchMock = jest.fn(async (_url: string, init: { body: string }) => {
  if (gateway.down) {
    throw new Error('network down')
  }
  const body = JSON.parse(init.body) as Record<string, string>
  const key = `${body.pubkey}|${body.token}`
  if (_url.endsWith('/api/device/forget')) {
    if (gateway.forgetDown === 'hang') {
      return new Promise(() => undefined)
    }
    if (gateway.forgetDown) {
      throw new Error('network down')
    }
    gateway.forgets.push(body)
    gatewayForget(body)
    return { ok: true, status: 200, json: async () => ({}) }
  }
  gateway.bodies.push(body)
  if (!gateway.ids.has(key) || gateway.rotate) {
    gateway.ids.set(key, newId())
  }
  const webhookId = gateway.ids.get(key)!
  gateway.secrets.set(webhookId, body.webhookSecret)
  if (gateway.loseAnswer) {
    throw new Error('connection reset')
  }
  return { ok: true, status: 200, json: async () => ({ registered: true, webhookId }) }
})

const keychain = new Map<string, string>()
let token = 'fcm-token-one'

const BASE = 'https://lnurl.usevoltz.app/api/push/spark/'
const hooksOf = (walletId: keyof typeof wallets) => mockProvider.hooks.get(wallets[walletId].pubkey) ?? []

// What App.tsx does on every connect, then waits for the pass it queued.
async function connect(wallet = wallets.w1): Promise<boolean> {
  mockConnected = wallet
  const sent = await ensurePushRegistered(false)
  await paymentWebhookSettled()
  await deviceForgetSettled()
  return sent
}

beforeEach(async () => {
  jest.clearAllMocks()
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true })
  Object.defineProperty(Platform, 'Version', { value: 34, configurable: true })
  ;(PermissionsAndroid.check as unknown as jest.Mock) = jest.fn(async () => true)
  jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)
  token = 'fcm-token-one'
  jest.mocked(getToken).mockImplementation(async () => token)
  global.fetch = fetchMock as unknown as typeof fetch
  mockProvider.hooks.clear()
  mockProvider.seq = 0
  mockProvider.failing = { list: 0, register: 0, unregister: 0 }
  mockProvider.hang = false
  mockProvider.calls = []
  gateway.ids.clear()
  gateway.secrets.clear()
  gateway.rotate = false
  gateway.down = false
  gateway.loseAnswer = false
  gateway.forgetDown = false
  gateway.bodies = []
  gateway.forgets = []
  mockConnected = wallets.w1
  keychain.clear()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest
    .mocked(Keychain.getGenericPassword)
    .mockImplementation(async options =>
      keychain.has(options?.service ?? '')
        ? ({ username: 'webhook', password: keychain.get(options?.service ?? '')! } as never)
        : false,
    )
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
  const file = `${RNFS.DocumentDirectoryPath}/push-registration.json`
  if (await RNFS.exists(file)) {
    await RNFS.unlink(file)
  }
  await clearDeletionMark('w1')
  await clearDeletionMark('w2')
})

// The single webhook this device should hold for a wallet, checked against what the gateway has.
async function expectOneHook(walletId: keyof typeof wallets, others: string[] = []): Promise<Hook> {
  const hooks = hooksOf(walletId).filter(hook => hook.url.startsWith(BASE) && !others.includes(hook.id))
  expect(hooks).toHaveLength(1)
  const [hook] = hooks
  const state = await loadWebhookState(walletId)
  expect(hook!.url).toBe(`${BASE}${state!.webhookId}`)
  expect([...hook!.events].sort()).toEqual(
    ['CoopExitFinished', 'LightningReceiveFinished', 'LightningSendFinished', 'StaticDepositFinished'],
  )
  // The mockProvider signs with what the gateway verifies against.
  expect(hook!.secret).toBe(gateway.secrets.get(state!.webhookId!))
  expect(hook!.secret).toBe(state!.secret)
  return hook!
}

function expectNoTokenInAnyUrl(...tokens: string[]): void {
  for (const hooks of mockProvider.hooks.values()) {
    for (const hook of hooks.filter(h => h.url.startsWith(BASE))) {
      for (const t of tokens) {
        expect(hook.url).not.toContain(t)
        expect(hook.url).not.toContain(encodeURIComponent(t))
      }
    }
  }
}

describe('one webhook of this device per wallet', () => {
  it('registers the wallet with the four events at the gateway id, after the first connect', async () => {
    expect(await connect()).toBe(true)
    await expectOneHook('w1')
    expect(gateway.bodies[0]).toMatchObject({ webhookSecret: (await loadWebhookState('w1'))!.secret })
  })

  it('stays one across reconnects, and spends no registration on a webhook already right', async () => {
    await connect()
    const first = await expectOneHook('w1')
    await connect()
    await connect()
    expect((await expectOneHook('w1')).id).toBe(first.id)
    expect(mockProvider.calls.filter(call => call === 'register')).toHaveLength(1)
    expect(mockProvider.calls).not.toContain('unregister')
  })

  it('follows a token change to the new id, and removes the old webhook', async () => {
    await connect()
    const before = await expectOneHook('w1')
    token = 'fcm-token-two'
    await connect()
    const after = await expectOneHook('w1')
    expect(after.url).not.toBe(before.url)
    expect(hooksOf('w1').map(hook => hook.id)).toEqual([after.id])
  })

  it('follows an id the gateway replaced for the same token', async () => {
    await connect()
    const before = await expectOneHook('w1')
    gateway.rotate = true
    // A change of language sends the registration again, and this gateway answers a new id.
    await i18n.changeLanguage('pt-BR')
    try {
      await connect()
    } finally {
      await i18n.changeLanguage('en-US')
    }
    const after = await expectOneHook('w1')
    expect(after.url).not.toBe(before.url)
    expect(hooksOf('w1').map(hook => hook.id)).toEqual([after.id])
  })

  it('replaces the webhook when the secret was drawn again and the gateway kept its id', async () => {
    // A wallet removed and added again draws a new secret; the gateway keeps the id for the same
    // wallet and token and moves only the secret, so the URL is the same and the old webhook would
    // sign every notice with a secret the gateway no longer has.
    await connect()
    const before = await expectOneHook('w1')
    // An entry that does not parse is drawn over, which leaves no marker.
    keychain.set('com.voltz.wallet.pushwebhook.w1', '{')
    await connect()
    const after = await expectOneHook('w1')
    expect(after.url).toBe(before.url)
    expect(after.id).not.toBe(before.id)
    expect(after.secret).not.toBe(before.secret)
  })

  it('removes the old notify route of this device and leaves another app and another device alone', async () => {
    mockProvider.hooks.set(wallets.w1.pubkey, [
      {
        id: 'old-notify',
        url: `https://nds.example.com/api/v1/notify?platform=android&token=${encodeURIComponent(token)}`,
        events: ['LightningReceiveFinished', 'StaticDepositFinished'],
        secret: 'x',
      },
      { id: 'glow', url: 'https://glow.example.com/hook', events: ['LightningReceiveFinished'], secret: 'y' },
      { id: 'tablet', url: `${BASE}TabletIdTabletIdTablet`, events: [], secret: 'z' },
    ])
    await connect()
    await expectOneHook('w1', ['tablet'])
    const ids = hooksOf('w1').map(hook => hook.id)
    expect(ids).not.toContain('old-notify')
    expect(ids).toEqual(expect.arrayContaining(['glow', 'tablet']))
  })

  it('keeps each wallet to its own webhook and secret across switches', async () => {
    await connect(wallets.w1)
    await connect(wallets.w2)
    await connect(wallets.w1)
    await connect(wallets.w2)
    const one = await expectOneHook('w1')
    const two = await expectOneHook('w2')
    expect(one.secret).not.toBe(two.secret)
  })
})

describe('the push token stays out of every webhook URL', () => {
  it('across registration, token changes and switches', async () => {
    await connect()
    token = 'fcm:tok/en+two='
    await connect()
    await connect(wallets.w2)
    expectNoTokenInAnyUrl('fcm-token-one', 'fcm:tok/en+two=')
    for (const hooks of mockProvider.hooks.values()) {
      for (const hook of hooks) {
        expect(hook.url).not.toMatch(/token=|fcm/)
      }
    }
  })
})

describe('a provider that fails never blocks the connect, and the next connect repairs', () => {
  it('a list that fails', async () => {
    mockProvider.failing.list = 1
    await expect(connect()).resolves.toBe(true)
    expect(hooksOf('w1')).toEqual([])
    await connect()
    await expectOneHook('w1')
  })

  it('a register that fails', async () => {
    mockProvider.failing.register = 1
    await expect(connect()).resolves.toBe(true)
    expect(hooksOf('w1')).toEqual([])
    await connect()
    await expectOneHook('w1')
  })

  it('an unregister that fails stops before registering, and nothing is forgotten', async () => {
    await connect()
    token = 'fcm-token-two'
    mockProvider.failing.unregister = 1
    await expect(connect()).resolves.toBe(true)
    // The old webhook stays until it can be removed, and no second one joins it.
    expect(hooksOf('w1')).toHaveLength(1)
    await connect()
    await expectOneHook('w1')
  })

  it('a provider that never answers holds neither the connect nor, past the wait, the next one', async () => {
    jest.useFakeTimers()
    try {
      mockProvider.hang = true
      await expect(ensurePushRegistered(false)).resolves.toBe(true)
      mockProvider.hang = false
      await jest.advanceTimersByTimeAsync(PASS_WAIT_MS)
      await connect()
    } finally {
      jest.useRealTimers()
    }
    await expectOneHook('w1')
  })

  it('each pass holds the queue for its own wait, counted from its start, not from its call', async () => {
    await connect()
    const target = { walletId: 'w1', pubkey: wallets.w1.pubkey, gatewayBase: 'https://lnurl.usevoltz.app' }
    const lists = () => mockProvider.calls.filter(call => call === 'list').length
    const before = lists()
    jest.useFakeTimers()
    try {
      mockProvider.hang = true
      syncPaymentWebhook(target).catch(() => undefined)
      await jest.advanceTimersByTimeAsync(PASS_WAIT_MS - 5_000)
      // Called while the first pass holds the queue, so it starts once the first is released.
      syncPaymentWebhook(target).catch(() => undefined)
      await jest.advanceTimersByTimeAsync(5_000)
      expect(lists()).toBe(before + 2)
      // Called once the second has started, so it waits out the second's whole wait.
      syncPaymentWebhook(target).catch(() => undefined)
      await jest.advanceTimersByTimeAsync(PASS_WAIT_MS - 1)
      expect(lists()).toBe(before + 2)
      await jest.advanceTimersByTimeAsync(1)
      expect(lists()).toBe(before + 3)
    } finally {
      // Every wait runs out, so the queue is free for the next test whatever failed above.
      mockProvider.hang = false
      await jest.advanceTimersByTimeAsync(3 * PASS_WAIT_MS)
      await paymentWebhookSettled()
      jest.useRealTimers()
    }
  })

  it('a gateway that cannot be reached keeps the webhook already right', async () => {
    await connect()
    const before = await expectOneHook('w1')
    gateway.down = true
    token = 'fcm-token-two'
    await expect(ensurePushRegistered(false)).rejects.toThrow('network down')
    await paymentWebhookSettled()
    expect((await expectOneHook('w1')).id).toBe(before.id)
  })
})

describe('a wallet held by a deletion keeps no webhook', () => {
  it('removes this device webhook and registers nothing', async () => {
    await connect()
    await writeDeletionMark('w1', { pubkey: wallets.w1.pubkey, state: 'asked', askedAt: 1_800_000_000 })
    expect(await connect()).toBe(false)
    expect(hooksOf('w1')).toEqual([])
    await connect()
    expect(mockProvider.calls.filter(call => call === 'register')).toHaveLength(1)
  })
})

describe('the webhook comes off the provider, and is named until it does', () => {
  const PK1 = wallets.w1.pubkey
  const permission = (granted: boolean) => {
    jest.mocked(hasPermission).mockResolvedValue(granted ? AuthorizationStatus.AUTHORIZED : AuthorizationStatus.DENIED)
  }

  it('when notifications are turned off, and a new one with a new secret when they are on again', async () => {
    await connect()
    const before = await expectOneHook('w1')
    permission(false)
    expect(await connect()).toBe(false)
    expect(hooksOf('w1')).toEqual([])
    expect(await loadWebhookState('w1')).toBeNull()
    expect(await loadRetiring(PK1)).toBeNull()
    permission(true)
    await connect()
    const after = await expectOneHook('w1')
    expect(after.secret).not.toBe(before.secret)
  })

  it('keeps the marker through a removal the provider refuses, and the next connect finishes it', async () => {
    await connect()
    permission(false)
    mockProvider.failing.unregister = 1
    await connect()
    expect(hooksOf('w1')).toHaveLength(1)
    expect(await loadRetiring(PK1)).not.toBeNull()
    await connect()
    expect(hooksOf('w1')).toEqual([])
    expect(await loadRetiring(PK1)).toBeNull()
  })

  it("removes a held wallet's webhook after the deletion's cleanup dropped its state", async () => {
    // The `done` read ran the local cleanup before any held pass did, in the same session.
    await connect()
    await writeDeletionMark('w1', { pubkey: PK1, state: 'asked', askedAt: 1_800_000_000 })
    await retireWebhookState('w1', PK1)
    expect(await connect()).toBe(false)
    expect(hooksOf('w1')).toEqual([])
    expect(await loadRetiring(PK1)).toBeNull()
  })

  it("removes the connected wallet's webhook before it answers", async () => {
    await connect()
    await retirePaymentWebhook('w1')
    expect(hooksOf('w1')).toEqual([])
    expect(await loadWebhookState('w1')).toBeNull()
    expect(await loadRetiring(PK1)).toBeNull()
  })

  it('keeps the marker of a wallet removed while another is connected, until its key connects again', async () => {
    await connect(wallets.w1)
    const old = await expectOneHook('w1')
    await connect(wallets.w2)
    await retirePaymentWebhook('w1')
    expect(hooksOf('w1').map(hook => hook.id)).toEqual([old.id])
    // Another key's passes leave it alone.
    await connect(wallets.w2)
    expect(await loadRetiring(PK1)).not.toBeNull()
    // The same words back under a new id: the old webhook goes and the new one is the only one.
    await connect(wallets.w3)
    const now = await expectOneHook('w3')
    expect(now.id).not.toBe(old.id)
    expect(await loadRetiring(PK1)).toBeNull()
  })

  it('a pass queued for one key refuses the same id opened with other words, and leaves its marker', async () => {
    await connect(wallets.w1)
    const old = await expectOneHook('w1')
    await connect(wallets.w2)
    await retirePaymentWebhook('w1')
    // The id w1 opened again with other words, before a pass for the first key runs.
    mockConnected = { walletId: 'w1', pubkey: '04'.padEnd(66, 'c') }
    await expect(
      syncPaymentWebhook({ walletId: 'w1', pubkey: PK1, gatewayBase: 'https://lnurl.usevoltz.app' }),
    ).rejects.toThrow('another identity')
    expect(await loadRetiring(PK1)).not.toBeNull()
    expect(hooksOf('w1').map(hook => hook.id)).toEqual([old.id])
    // The first key connected again finishes the removal.
    await connect(wallets.w3)
    expect(hooksOf('w1').map(hook => hook.id)).not.toContain(old.id)
    expect(await loadRetiring(PK1)).toBeNull()
  })

  it('a provider that never answers the removal holds the caller only for the wait', async () => {
    jest.useFakeTimers()
    try {
      await connect()
      mockProvider.hang = true
      const retired = retirePaymentWebhook('w1', undefined, 1_000)
      await jest.advanceTimersByTimeAsync(1_000)
      await expect(retired).resolves.toBeUndefined()
      expect(await loadRetiring(PK1)).not.toBeNull()
      mockProvider.hang = false
      await jest.advanceTimersByTimeAsync(PASS_WAIT_MS)
      await connect()
    } finally {
      jest.useRealTimers()
    }
    expect(await loadRetiring(PK1)).toBeNull()
  })
})

describe('the gateway forgets every registration made with each secret that goes', () => {
  const PK1 = wallets.w1.pubkey
  const PK2 = wallets.w2.pubkey
  const off = () => jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.DENIED)
  const on = () => jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)
  const rowOf = (pubkey: string) => gateway.ids.has(`${pubkey}|fcm-token-one`)

  beforeEach(async () => {
    const file = `${RNFS.DocumentDirectoryPath}/wallets.json`
    if (await RNFS.exists(file)) {
      await RNFS.unlink(file)
    }
  })

  it('notifications turned off: the row goes, and the request carries the key and the proof only', async () => {
    await connect()
    off()
    expect(await connect()).toBe(false)
    expect(gateway.forgets).toEqual([{ pubkey: PK1, proof: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(rowOf(PK1)).toBe(false)
    expect(await loadDeviceForgets()).toEqual([])
  })

  it('notifications turned off: every wallet listed here goes at once, the ones not connected included', async () => {
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(true)
    await ensureRegistered('w1', 'fp1')
    await ensureRegistered('w2', 'fp2')
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(false)
    await connect(wallets.w2)
    await connect(wallets.w1)
    off()
    await connect(wallets.w1)
    // No connection of w2 and none of its words were needed.
    expect(gateway.forgets.map(body => body.pubkey).sort()).toEqual([PK1, PK2].sort())
    expect(rowOf(PK1)).toBe(false)
    expect(rowOf(PK2)).toBe(false)
    expect(await loadWebhookState('w2')).toBeNull()
    expect(await loadDeviceForgets()).toEqual([])
  })

  it('a token the device held earlier goes with the current one, since both were registered with the secret', async () => {
    await connect()
    token = 'fcm-token-two'
    await connect()
    expect(gateway.ids.has(`${PK1}|fcm-token-one`)).toBe(true)
    expect(gateway.ids.has(`${PK1}|fcm-token-two`)).toBe(true)
    off()
    await connect()
    expect(gateway.forgets).toHaveLength(1)
    expect(gateway.ids.has(`${PK1}|fcm-token-one`)).toBe(false)
    expect(gateway.ids.has(`${PK1}|fcm-token-two`)).toBe(false)
  })

  it('a registration whose answer never came back is forgotten all the same', async () => {
    gateway.loseAnswer = true
    await expect(ensurePushRegistered(false)).rejects.toThrow('connection reset')
    await paymentWebhookSettled()
    expect(rowOf(PK1)).toBe(true)
    expect((await loadWebhookState('w1'))?.webhookId).toBeUndefined()
    gateway.loseAnswer = false
    off()
    await connect()
    expect(rowOf(PK1)).toBe(false)
    expect(await loadDeviceForgets()).toEqual([])
  })

  it('a forget the gateway did not get is sent again on the next connect, and never blocks it', async () => {
    await connect()
    off()
    gateway.forgetDown = true
    expect(await connect()).toBe(false)
    expect(await loadDeviceForgets()).toHaveLength(1)
    expect(rowOf(PK1)).toBe(true)
    gateway.forgetDown = false
    await connect()
    expect(rowOf(PK1)).toBe(false)
    expect(await loadDeviceForgets()).toEqual([])
  })

  it('notifications on again before the forget landed: the late forget removes nothing of the new registration', async () => {
    await connect()
    const before = gateway.ids.get(`${PK1}|fcm-token-one`)
    off()
    gateway.forgetDown = true
    await connect()
    on()
    gateway.forgetDown = false
    // The registration with the new secret goes first and the queued forget after it, on this connect.
    await connect()
    expect(gateway.forgets).toHaveLength(1)
    expect(gateway.ids.get(`${PK1}|fcm-token-one`)).toBe(before)
    expect(await loadDeviceForgets()).toEqual([])
    await connect()
    await expectOneHook('w1')
    expect(rowOf(PK1)).toBe(true)
  })

  it('a return to the foreground with notifications turned off in the settings forgets, and an unchanged answer sends nothing', async () => {
    await connect()
    const tokens = jest.mocked(getToken).mock.calls.length
    await recheckNotifications()
    await deviceForgetSettled()
    expect(jest.mocked(getToken).mock.calls.length).toBe(tokens)
    expect(gateway.forgets).toEqual([])
    off()
    await recheckNotifications()
    await paymentWebhookSettled()
    await deviceForgetSettled()
    expect(rowOf(PK1)).toBe(false)
    expect(hooksOf('w1')).toEqual([])
    // Turned on again, it registers once more with a new secret.
    on()
    await recheckNotifications()
    await paymentWebhookSettled()
    await expectOneHook('w1')
  })

  it('a removal of the connected wallet queues and sends its forget', async () => {
    await connect()
    await retirePaymentWebhook('w1')
    await deviceForgetSettled()
    expect(rowOf(PK1)).toBe(false)
    expect(hooksOf('w1')).toEqual([])
  })

  it('a gateway that never answers the forget holds the removal not at all, and keeps the forget', async () => {
    jest.useFakeTimers()
    try {
      await connect()
      gateway.forgetDown = 'hang'
      // Resolves with no timer advanced: only the provider removal is waited on, and it answered.
      await retirePaymentWebhook('w1')
      expect(hooksOf('w1')).toEqual([])
      expect(await loadDeviceForgets()).toHaveLength(1)
      // The queue lets go of the forget that never answered, so nothing after waits on it.
      await jest.advanceTimersByTimeAsync(30_000)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('the secret never reaches a log', () => {
  it('reads a value nested in what is logged', async () => {
    const lines = await consoleLines(async () => console.warn('pass failed', { cause: { state: { secret: 'f00d' } } }))
    expect(lines).toEqual([expect.stringContaining("'f00d'")])
  })

  it('through the registration, the passes, a removal and the forgets, failures included', async () => {
    const off = () => jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.DENIED)
    const on = () => jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)
    const lines = await consoleLines(async () => {
      // A v5 registration and the pass that registers its webhook.
      await connect()
      // A pass whose list fails, then one whose removal of the old webhook fails.
      mockProvider.failing.list = 1
      await connect()
      token = 'fcm-token-two'
      mockProvider.failing.unregister = 1
      await connect()
      // A gateway that cannot be reached, then one that loses its answer.
      gateway.down = true
      token = 'fcm-token-three'
      await ensurePushRegistered(false).catch(() => undefined)
      await paymentWebhookSettled()
      gateway.down = false
      gateway.loseAnswer = true
      await ensurePushRegistered(false).catch(() => undefined)
      await paymentWebhookSettled()
      gateway.loseAnswer = false
      await connect()
      // Notifications off with the forget refused, then on with a new secret whose register fails.
      off()
      gateway.forgetDown = true
      await connect()
      on()
      gateway.forgetDown = false
      mockProvider.failing.register = 1
      await connect()
      await connect()
      // The wallet removed while connected, and another removed while it is not.
      await connect(wallets.w2)
      await connect(wallets.w1)
      await retirePaymentWebhook('w1')
      await retirePaymentWebhook('w2')
      await deviceForgetSettled()
    })
    const secrets = new Set([...gateway.secrets.values(), ...[...mockProvider.hooks.values()].flat().map(hook => hook.secret)])
    expect(secrets.size).toBeGreaterThan(2)
    for (const line of lines) {
      for (const secret of secrets) {
        expect(line).not.toContain(secret)
      }
    }
  })
})
