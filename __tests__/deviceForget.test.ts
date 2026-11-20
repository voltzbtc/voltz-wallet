import * as Keychain from 'react-native-keychain'
import { createHmac } from 'crypto'
import { deviceForgetSettled, FORGET_WAIT_MS, sendDeviceForgets } from '../src/wallet/deviceForget'
import { forgetProof, forgetStatement } from '../src/wallet/webhook'
import { loadDeviceForgets, retireWebhookState, webhookStateFor } from '../src/wallet/webhookSecret'

// The gateway forget as the app proves and sends it: the statement, the proof, and when it goes again.

jest.mock('../src/config', () => ({
  getBreezLnurlDomain: jest.fn(() => 'lnurl.usevoltz.app'),
}))

const DOMAIN = 'lnurl.usevoltz.app'
const PK = '02'.padEnd(66, 'a')

const keychain = new Map<string, string>()

type Sent = { url: string; body: Record<string, unknown> }
let sent: Sent[] = []
let answer: () => Promise<{ ok: boolean; status: number }> = async () => ({ ok: true, status: 200 })

const fetchMock = jest.fn(async (url: string, init: { body: string }) => {
  sent.push({ url, body: JSON.parse(init.body) })
  const reply = await answer()
  return { ...reply, json: async () => ({}) }
})

beforeEach(() => {
  jest.clearAllMocks()
  keychain.clear()
  sent = []
  answer = async () => ({ ok: true, status: 200 })
  global.fetch = fetchMock as unknown as typeof fetch
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest
    .mocked(Keychain.getGenericPassword)
    .mockImplementation(async options =>
      keychain.has(options?.service ?? '')
        ? ({ username: 'u', password: keychain.get(options?.service ?? '')! } as never)
        : false,
    )
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
})

// A wallet whose secret was drawn on this device and then retired, which is what each trigger does.
async function retired(walletId = 'w1', pubkey = PK): Promise<string> {
  const { secret } = await webhookStateFor(walletId, pubkey)
  await retireWebhookState(walletId)
  return secret
}

// Written by hand, not with the helpers, since a vector built by the function it checks passes
// against any string. The gateway's test pins the same statement bytes and proof.
const GOLDEN = {
  domain: 'lnurl.usevoltz.app',
  pubkey: `02${'a'.repeat(64)}`,
  secret: 'b'.repeat(64),
  statement: `voltz-push-forget:v1\nlnurl.usevoltz.app\n02${'a'.repeat(64)}`,
  statementHex:
    '766f6c747a2d707573682d666f726765743a76310a6c6e75726c2e757365766f6c747a2e6170700a3032' + '61'.repeat(64),
  proof: '06d164777394e1357dd427cdc3536a02d07b58c4462257522a1f7b4869f98a0b',
}

describe('the statement and its proof', () => {
  test('are the exact bytes and hex the gateway pins', () => {
    const statement = forgetStatement(GOLDEN.domain, GOLDEN.pubkey)
    expect(statement).toBe(GOLDEN.statement)
    expect(Buffer.from(statement, 'utf8').toString('hex')).toBe(GOLDEN.statementHex)
    expect(forgetProof(GOLDEN.domain, GOLDEN.pubkey, GOLDEN.secret)).toBe(GOLDEN.proof)
    // HMAC-SHA256 keyed with the secret's UTF-8 bytes, as the provider signs its deliveries.
    expect(createHmac('sha256', Buffer.from(GOLDEN.secret, 'utf8')).update(GOLDEN.statementHex, 'hex').digest('hex')).toBe(
      GOLDEN.proof,
    )
  })

  test('name the key in lowercase, and each part is under the proof', () => {
    expect(forgetStatement(GOLDEN.domain, GOLDEN.pubkey.toUpperCase())).toBe(GOLDEN.statement)
    expect(forgetProof('usevoltz.app', GOLDEN.pubkey, GOLDEN.secret)).not.toBe(GOLDEN.proof)
    expect(forgetProof(GOLDEN.domain, `03${'a'.repeat(64)}`, GOLDEN.secret)).not.toBe(GOLDEN.proof)
    expect(forgetProof(GOLDEN.domain, GOLDEN.pubkey, 'c'.repeat(64))).not.toBe(GOLDEN.proof)
  })
})

describe('the sender', () => {
  test('posts the key and the proof, and nothing else, then drops the entry on a 200', async () => {
    const secret = await retired()

    await sendDeviceForgets()

    expect(sent).toEqual([
      { url: `https://${DOMAIN}/api/device/forget`, body: { pubkey: PK, proof: forgetProof(DOMAIN, PK, secret) } },
    ])
    expect(await loadDeviceForgets()).toEqual([])
  })

  test.each([
    ['a 404 from a gateway without the route', async () => ({ ok: false, status: 404 })],
    ['a server error', async () => ({ ok: false, status: 503 })],
    ['a refusal', async () => ({ ok: false, status: 400 })],
    ['a success that is not a 200', async () => ({ ok: true, status: 204 })],
    [
      'no network',
      async () => {
        throw new Error('network down')
      },
    ],
  ])('keeps the entry on %s, and the next run sends it again', async (_case, reply) => {
    await retired()
    answer = reply as typeof answer

    await sendDeviceForgets()
    expect(await loadDeviceForgets()).toHaveLength(1)

    answer = async () => ({ ok: true, status: 200 })
    await sendDeviceForgets()
    expect(await loadDeviceForgets()).toEqual([])
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
  })

  test('outlives the words and an hour offline, and goes unchanged once the network is back', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-12T12:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] })
    try {
      const secret = await retired()
      // Nothing on the device holds the secret or any words now, and nothing signs.
      expect([...keychain.values()].join('')).not.toContain(secret)
      answer = async () => {
        throw new Error('network down')
      }
      await sendDeviceForgets()
      jest.setSystemTime(new Date('2026-11-12T13:00:01Z'))
      await jest.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(await loadDeviceForgets()).toHaveLength(1)

      answer = async () => ({ ok: true, status: 200 })
      await sendDeviceForgets()
    } finally {
      jest.useRealTimers()
    }
    expect(sent).toHaveLength(2)
    expect(sent[1]!.body).toEqual({ pubkey: PK, proof: sent[0]!.body.proof })
    expect(await loadDeviceForgets()).toEqual([])
  })

  test("sends each wallet's entry, and a failing one keeps only itself", async () => {
    const PK2 = '03'.padEnd(66, 'b')
    await retired('w1', PK)
    await retired('w2', PK2)
    answer = async () => (sent.length === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 })

    await sendDeviceForgets()

    expect(sent.map(call => call.body.pubkey)).toEqual([PK, PK2])
    expect(await loadDeviceForgets()).toEqual([expect.objectContaining({ pubkey: PK })])
  })

  test('a gateway that never answers releases the queue after the wait, and the next run goes on', async () => {
    jest.useFakeTimers()
    try {
      await retired()
      answer = () => new Promise(() => undefined)
      sendDeviceForgets().catch(() => undefined)
      await jest.advanceTimersByTimeAsync(FORGET_WAIT_MS)
      await deviceForgetSettled()
      answer = async () => ({ ok: true, status: 200 })
      await sendDeviceForgets()
    } finally {
      jest.useRealTimers()
    }
    expect(await loadDeviceForgets()).toEqual([])
  })

  test('each run holds the queue for its own wait, counted from its start, not from its call', async () => {
    jest.useFakeTimers()
    try {
      await retired()
      answer = () => new Promise(() => undefined)
      sendDeviceForgets().catch(() => undefined)
      await jest.advanceTimersByTimeAsync(FORGET_WAIT_MS - 5_000)
      // Called while the first run holds the queue, so it starts once the first is released.
      sendDeviceForgets().catch(() => undefined)
      await jest.advanceTimersByTimeAsync(5_000)
      expect(sent).toHaveLength(2)
      // Called once the second has started, so it waits out the second's whole wait.
      sendDeviceForgets().catch(() => undefined)
      await jest.advanceTimersByTimeAsync(FORGET_WAIT_MS - 1)
      expect(sent).toHaveLength(2)
      await jest.advanceTimersByTimeAsync(1)
      expect(sent).toHaveLength(3)
    } finally {
      // Every wait runs out, so the queue is free for the next test whatever failed above.
      await jest.advanceTimersByTimeAsync(3 * FORGET_WAIT_MS)
      await deviceForgetSettled()
      jest.useRealTimers()
    }
  })
})
