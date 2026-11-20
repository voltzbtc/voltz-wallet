import * as Keychain from 'react-native-keychain'
import RNFS from 'react-native-fs'
import { forgetProof } from '../src/wallet/webhook'
import {
  drawWebhookSecret,
  loadDeviceForgets,
  loadRetiring,
  loadWebhookState,
  noteGatewayWebhookId,
  noteSdkWebhook,
  retireWebhookState,
  settleRetiring,
  webhookStateFor,
} from '../src/wallet/webhookSecret'

const PK = '02'.padEnd(66, 'a')
const PK2 = '03'.padEnd(66, 'b')
const DOMAIN = 'lnurl.usevoltz.app'

jest.mock('../src/config', () => ({ getBreezLnurlDomain: jest.fn(() => 'lnurl.usevoltz.app') }))

// A Keychain that keeps what it is given, as the device's does.
const keychain = new Map<string, string>()

beforeEach(() => {
  jest.clearAllMocks()
  keychain.clear()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return { service: options?.service ?? '', storage: 'keychain' } as never
  })
  jest
    .mocked(Keychain.getGenericPassword)
    .mockImplementation(async options =>
      keychain.has(options?.service ?? '')
        ? ({ username: 'webhook', password: keychain.get(options?.service ?? '')! } as never)
        : false,
    )
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('the secret', () => {
  it('is the 32 bytes the platform CSPRNG drew, in hex', () => {
    const draw = jest.spyOn(globalThis.crypto, 'getRandomValues')
    const secret = drawWebhookSecret()
    expect(draw).toHaveBeenCalledTimes(1)
    const bytes = draw.mock.calls[0]![0] as Uint8Array
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes).toHaveLength(32)
    expect(secret).toBe(Buffer.from(bytes).toString('hex'))
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses to draw without getRandomValues rather than fall back to a weaker source', () => {
    const crypto = globalThis.crypto as unknown as Record<string, unknown>
    const own = Object.getOwnPropertyDescriptor(crypto, 'getRandomValues')
    Object.defineProperty(crypto, 'getRandomValues', { value: undefined, configurable: true })
    try {
      expect(() => drawWebhookSecret()).toThrow('crypto.getRandomValues is unavailable')
    } finally {
      if (own) {
        Object.defineProperty(crypto, 'getRandomValues', own)
      } else {
        delete crypto.getRandomValues
      }
    }
  })

  it('refuses a draw whose tail came back zeroed, the trace of a truncated native answer', () => {
    jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(bytes => {
      const view = bytes as unknown as Uint8Array
      view.fill(7)
      view.fill(0, 28)
      return bytes
    })
    expect(() => drawWebhookSecret()).toThrow('run of zero bytes')
  })

  it('is kept in the Keychain under the wallet, this device only, and in no file', async () => {
    const write = jest.spyOn(RNFS, 'writeFile')
    const state = await webhookStateFor('w1', PK)
    expect(Keychain.setGenericPassword).toHaveBeenCalledWith('webhook', expect.stringContaining(state.secret), {
      service: 'com.voltz.wallet.pushwebhook.w1',
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    })
    for (const call of write.mock.calls) {
      expect(String(call[1])).not.toContain(state.secret)
    }
  })

  it('is drawn once per wallet and read back after that', async () => {
    const first = await webhookStateFor('w1', PK)
    const again = await webhookStateFor('w1', PK)
    const other = await webhookStateFor('w2', PK2)
    expect(again.secret).toBe(first.secret)
    expect(other.secret).not.toBe(first.secret)
  })

  it('is drawn once when two registrations ask at the same moment', async () => {
    // Two secrets would send one to the gateway and keep the other, and every notice after that would
    // fail its signature at the gateway.
    const [a, b] = await Promise.all([webhookStateFor('w1', PK), webhookStateFor('w1', PK)])
    expect(a.secret).toBe(b.secret)
    expect((await loadWebhookState('w1'))?.secret).toBe(a.secret)
  })

  it('is drawn again over an entry that does not parse', async () => {
    keychain.set('com.voltz.wallet.pushwebhook.w1', '{"secret":"short"}')
    const state = await webhookStateFor('w1', PK)
    expect(state.secret).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is never drawn over an entry the Keychain could not read', async () => {
    jest.mocked(Keychain.getGenericPassword).mockRejectedValueOnce(new Error('locked'))
    await expect(webhookStateFor('w1', PK)).rejects.toThrow('locked')
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
  })
})

describe('what is noted beside it', () => {
  it('keeps the gateway id and the SDK marker together with the secret', async () => {
    const { secret } = await webhookStateFor('w1', PK)
    await noteGatewayWebhookId('w1', secret, 'AbCdEfGhIjKlMnOpQrStUv', PK)
    await noteSdkWebhook('w1', secret, { id: 'h1', url: 'https://x/api/push/spark/AbCdEfGhIjKlMnOpQrStUv' })
    expect(await loadWebhookState('w1')).toEqual({
      secret,
      webhookId: 'AbCdEfGhIjKlMnOpQrStUv',
      pubkey: PK,
      sdk: { id: 'h1', url: 'https://x/api/push/spark/AbCdEfGhIjKlMnOpQrStUv' },
    })
  })

  it('loses neither of two notes landing together', async () => {
    const { secret } = await webhookStateFor('w1', PK)
    await Promise.all([
      noteGatewayWebhookId('w1', secret, 'AbCdEfGhIjKlMnOpQrStUv', PK),
      noteSdkWebhook('w1', secret, { id: 'h1', url: 'u' }),
    ])
    expect(await loadWebhookState('w1')).toMatchObject({ webhookId: 'AbCdEfGhIjKlMnOpQrStUv', sdk: { id: 'h1' } })
  })

  it('drops a note about a secret that is no longer the one held', async () => {
    const { secret } = await webhookStateFor('w1', PK)
    await retireWebhookState('w1')
    await noteGatewayWebhookId('w1', secret, 'AbCdEfGhIjKlMnOpQrStUv', PK)
    expect(await loadWebhookState('w1')).toBeNull()
    const fresh = await webhookStateFor('w1', PK)
    await noteSdkWebhook('w1', secret, { id: 'h1', url: 'u' })
    expect(await loadWebhookState('w1')).toEqual({ secret: fresh.secret, pubkey: PK })
  })

  it('forgets the secret, the id and the marker of one wallet only', async () => {
    const w1 = await webhookStateFor('w1', PK)
    const w2 = await webhookStateFor('w2', PK2)
    await noteGatewayWebhookId('w1', w1.secret, 'AbCdEfGhIjKlMnOpQrStUv', PK)
    await retireWebhookState('w1')
    expect(await loadWebhookState('w1')).toBeNull()
    expect((await loadWebhookState('w2'))?.secret).toBe(w2.secret)
  })
})

describe('the removal marker', () => {
  const GID = 'AbCdEfGhIjKlMnOpQrStUv'
  const URL = `https://x/api/push/spark/${GID}`

  async function registered(walletId: string, pubkey = PK, gid = GID, sdkId = 'h1') {
    const { secret } = await webhookStateFor(walletId, pubkey)
    await noteGatewayWebhookId(walletId, secret, gid, pubkey)
    await noteSdkWebhook(walletId, secret, { id: sdkId, url: `https://x/api/push/spark/${gid}` })
    return secret
  }

  it('names what the provider may hold under the key, then drops the secret', async () => {
    await registered('w1')
    await retireWebhookState('w1')
    expect(await loadWebhookState('w1')).toBeNull()
    expect(await loadRetiring(PK)).toEqual({ webhookIds: [GID], sdkIds: ['h1'], urls: [URL] })
  })

  it('takes the key the caller gives over the one noted', async () => {
    await registered('w1')
    const other = '03'.padEnd(66, 'c')
    await retireWebhookState('w1', other)
    expect(await loadRetiring(other)).toMatchObject({ webhookIds: [GID] })
    expect(await loadRetiring(PK)).toBeNull()
  })

  it('keeps the state when nothing can key the marker, so the webhook is never forgotten', async () => {
    // A state noted before the key was kept beside it.
    const { secret } = await webhookStateFor('w1', PK)
    keychain.set('com.voltz.wallet.pushwebhook.w1', JSON.stringify({ secret, webhookId: GID }))
    await retireWebhookState('w1')
    expect(await loadWebhookState('w1')).toEqual({ secret, webhookId: GID })
    expect(keychain.has('com.voltz.wallet.pushwebhook.retiring')).toBe(false)
  })

  it('drops a secret that never reached the gateway without writing a marker', async () => {
    await webhookStateFor('w1', PK)
    await retireWebhookState('w1', PK)
    expect(await loadWebhookState('w1')).toBeNull()
    expect(await loadRetiring(PK)).toBeNull()
  })

  it('adds to a marker already waiting, and keeps each wallet apart', async () => {
    await registered('w1')
    await retireWebhookState('w1')
    await registered('w1', PK, 'ZyXwVuTsRqPoNmLkJiHgFe', 'h2')
    await retireWebhookState('w1')
    const two = '03'.padEnd(66, 'b')
    await registered('w2', two, 'TwoTwoTwoTwoTwoTwoTwo2', 'h9')
    await retireWebhookState('w2')
    expect(await loadRetiring(PK)).toEqual({
      webhookIds: [GID, 'ZyXwVuTsRqPoNmLkJiHgFe'],
      sdkIds: ['h1', 'h2'],
      urls: [URL, 'https://x/api/push/spark/ZyXwVuTsRqPoNmLkJiHgFe'],
    })
    expect(await loadRetiring(two)).toMatchObject({ sdkIds: ['h9'] })
  })

  it('settles only what a pass removed, keeping an entry retired after it read the marker', async () => {
    await registered('w1')
    await retireWebhookState('w1')
    const read = (await loadRetiring(PK))!
    await registered('w1', PK, 'ZyXwVuTsRqPoNmLkJiHgFe', 'h2')
    await retireWebhookState('w1')
    await settleRetiring(PK, read)
    expect(await loadRetiring(PK)).toEqual({
      webhookIds: ['ZyXwVuTsRqPoNmLkJiHgFe'],
      sdkIds: ['h2'],
      urls: ['https://x/api/push/spark/ZyXwVuTsRqPoNmLkJiHgFe'],
    })
    await settleRetiring(PK, (await loadRetiring(PK))!)
    expect(await loadRetiring(PK)).toBeNull()
    expect(keychain.has('com.voltz.wallet.pushwebhook.retiring')).toBe(false)
  })

  it('never writes over a marker that does not parse, and keeps the state', async () => {
    const secret = await registered('w1')
    keychain.set('com.voltz.wallet.pushwebhook.retiring', '{"x":')
    await expect(retireWebhookState('w1')).rejects.toThrow('does not parse')
    expect(keychain.get('com.voltz.wallet.pushwebhook.retiring')).toBe('{"x":')
    expect((await loadWebhookState('w1'))?.secret).toBe(secret)
    await expect(loadRetiring(PK)).rejects.toThrow('does not parse')
  })
})

describe('the gateway forget queued with each retirement', () => {
  const FORGETS = 'com.voltz.wallet.pushwebhook.forget'

  it('is written, with the key and the proof of the secret, before the secret is dropped, though no id came back', async () => {
    const { secret } = await webhookStateFor('w1', PK)

    await retireWebhookState('w1')

    expect(await loadDeviceForgets()).toEqual([{ pubkey: PK, proof: forgetProof(DOMAIN, PK, secret) }])
    expect(await loadWebhookState('w1')).toBeNull()
    const queued = jest.mocked(Keychain.setGenericPassword).mock.calls.findIndex(call => call[2]?.service === FORGETS)
    const dropped = jest
      .mocked(Keychain.resetGenericPassword)
      .mock.calls.findIndex(call => call[0]?.service === 'com.voltz.wallet.pushwebhook.w1')
    expect(jest.mocked(Keychain.setGenericPassword).mock.invocationCallOrder[queued]).toBeLessThan(
      jest.mocked(Keychain.resetGenericPassword).mock.invocationCallOrder[dropped]!,
    )
    // Nothing of the secret itself is kept once it is dropped.
    expect([...keychain.values()].join('')).not.toContain(secret)
  })

  it('names the caller key and the drawn key when they differ, and each secret once', async () => {
    const one = await webhookStateFor('w1', PK)
    await retireWebhookState('w1', PK2)
    const two = await webhookStateFor('w1', PK)
    await retireWebhookState('w1', PK)
    await retireWebhookState('w1', PK)

    expect(await loadDeviceForgets()).toEqual([
      { pubkey: PK, proof: forgetProof(DOMAIN, PK, one.secret) },
      { pubkey: PK2, proof: forgetProof(DOMAIN, PK2, one.secret) },
      { pubkey: PK, proof: forgetProof(DOMAIN, PK, two.secret) },
    ])
  })

  it('never writes over a forget list that does not parse, and keeps the secret', async () => {
    const { secret } = await webhookStateFor('w1', PK)
    keychain.set(FORGETS, '[{"pubkey":')
    await expect(retireWebhookState('w1')).rejects.toThrow('does not parse')
    expect(keychain.get(FORGETS)).toBe('[{"pubkey":')
    expect((await loadWebhookState('w1'))?.secret).toBe(secret)
  })

  it('hands out no secret a queued forget names, as after a retirement cut before the drop', async () => {
    const { secret } = await webhookStateFor('w1', PK)
    keychain.set(FORGETS, JSON.stringify([{ pubkey: PK, proof: forgetProof(DOMAIN, PK, secret) }]))

    const next = await webhookStateFor('w1', PK)

    expect(next.secret).not.toBe(secret)
    expect(await loadDeviceForgets()).toEqual([{ pubkey: PK, proof: forgetProof(DOMAIN, PK, secret) }])
  })

  it('retires a secret drawn for another key rather than register it under this one, and queues its forget', async () => {
    const { secret } = await webhookStateFor('w1', PK)
    await noteGatewayWebhookId('w1', secret, 'AbCdEfGhIjKlMnOpQrStUv', PK)

    const next = await webhookStateFor('w1', PK2)

    expect(next).toEqual({ secret: expect.not.stringMatching(secret), pubkey: PK2 })
    expect(await loadDeviceForgets()).toEqual([{ pubkey: PK, proof: forgetProof(DOMAIN, PK, secret) }])
    expect(await loadRetiring(PK)).toMatchObject({ webhookIds: ['AbCdEfGhIjKlMnOpQrStUv'] })
  })

  it('writes the key beside a secret held without one before handing it out', async () => {
    const secret = 'c'.repeat(64)
    keychain.set('com.voltz.wallet.pushwebhook.w1', JSON.stringify({ secret }))
    expect(await webhookStateFor('w1', PK)).toEqual({ secret, pubkey: PK })
    expect(await loadWebhookState('w1')).toEqual({ secret, pubkey: PK })
  })
})
