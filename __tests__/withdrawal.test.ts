import fs from 'fs'
import path from 'path'
import { Platform } from 'react-native'
import {
  channelOf,
  needsAppleSheet,
  payLineKey,
  purchaseLine,
  readPurchase,
  receiptNextKey,
  receiptNextLine,
  refusalKey,
  requestWithdrawal,
  shownPurchases,
  stateLine,
  walletPurchases,
  withdrawMessage,
  withdrawResultOf,
  type Channel,
  type WalletPurchase,
  type WithdrawDeps,
  type WithdrawReceipt,
  type WithdrawalState,
} from '../src/wallet/withdrawal'
import { storeCreditsMessage } from '../src/wallet/storePurchase'

const PUB = `02${'ab'.repeat(32)}`
const NOW = 1_800_000_000
const APPLE_REF = 'apple:Production:2000000123456789'
const GOOGLE_REF = `google:${'f'.repeat(64)}`
const SATS_REF = 'a'.repeat(64)
const SPARK = 'spark1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqqqqq'

// Printed for these inputs by the gateway's own builder of the statement, the one it verifies
// signatures against. A drift on either side fails here with both suites green.
const GOLDEN = [
  {
    args: [PUB, APPLE_REF, '', 1, 1_800_000_000] as const,
    statement: `voltz-withdraw:v1\n${PUB}\napple:Production:2000000123456789\n\n1\n1800000000`,
  },
  {
    args: [PUB, SATS_REF, SPARK, 0, 1_800_000_123] as const,
    statement: `voltz-withdraw:v1\n${PUB}\n${'a'.repeat(64)}\n${SPARK}\n0\n1800000123`,
  },
  {
    args: [PUB, GOOGLE_REF, '', 0, 1_800_000_000] as const,
    statement: `voltz-withdraw:v1\n${PUB}\ngoogle:${'f'.repeat(64)}\n\n0\n1800000000`,
  },
]

const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as {
  withdrawal: Record<string, string>
}
const pt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'pt-BR.json'), 'utf8')) as {
  withdrawal: Record<string, string>
}
const LOCALES = path.join(__dirname, '..', 'src', 'i18n', 'locales')
const allLocales = () =>
  fs.readdirSync(LOCALES).map(f => [f, (JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8')) as typeof en).withdrawal] as const)
// The time Apple's own refund page gives for an update on a request, which the receipt quotes as Apple's.
const APPLE_QUOTE = 'Apple says to expect an update within 24 to 48 hours'

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentRef: APPLE_REF,
    channel: 'apple',
    kind: 'name',
    domain: 'usevoltz.app',
    subject: 'satoshi',
    purchasedAt: NOW - 86_400,
    withdrawableUntil: NOW + 13 * 86_400,
    withdrawable: true,
    transactionId: '2000000123456789',
    withdrawal: null,
    ...over,
  }
}

function purchase(over: Partial<WalletPurchase> = {}): WalletPurchase {
  return readPurchase(row(over as Record<string, unknown>))!
}

type Call = { url: string; body: Record<string, unknown> }

function gateway(answers: Array<{ status: number; body: unknown } | 'network'>) {
  const calls: Call[] = []
  const request = jest.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init?.body ?? '{}') })
    const next = answers.length > 1 ? answers.shift()! : answers[0]!
    if (next === 'network') {
      throw new Error('offline')
    }
    return { status: next.status, text: async () => JSON.stringify(next.body) }
  }) as unknown as typeof fetch
  return { calls, request }
}

function deps(request: typeof fetch, over: Partial<WithdrawDeps> = {}): WithdrawDeps & { sign: jest.Mock } {
  return {
    gatewayUrl: 'https://usevoltz.app',
    domain: 'usevoltz.app',
    pubkey: PUB,
    sign: jest.fn(async (message: string) => `sig(${message.length})`),
    now: () => NOW * 1000,
    request,
    sleep: async () => undefined,
    walletId: 'w1',
    connectedWalletId: () => 'w1',
    refundAddress: jest.fn(async () => SPARK),
    ...over,
  } as WithdrawDeps & { sign: jest.Mock }
}

const receiptBody = (over: Record<string, unknown> = {}) => ({
  paymentRef: APPLE_REF,
  channel: 'apple',
  state: 'requested',
  requestedAt: NOW - 5,
  withdrawableUntil: NOW + 13 * 86_400,
  transactionId: '2000000123456789',
  ...over,
})

describe('the statement', () => {
  test.each(GOLDEN)('matches the gateway byte for byte ($statement)', ({ args, statement }) => {
    const [pubkey, ref, refundTo, consent, timestamp] = args
    expect(withdrawMessage(pubkey, ref, refundTo, consent, timestamp)).toBe(statement)
    // The SDK refuses to sign the LNURL server's namespace.
    expect(statement.startsWith('breez-lnurl:')).toBe(false)
  })
})

describe('the purchases list', () => {
  test('a whole row on each rail reads as the gateway wrote it', () => {
    expect(readPurchase(row())).toEqual({
      paymentRef: APPLE_REF,
      channel: 'apple',
      kind: 'name',
      domain: 'usevoltz.app',
      subject: 'satoshi',
      purchasedAt: NOW - 86_400,
      withdrawableUntil: NOW + 13 * 86_400,
      withdrawable: true,
      transactionId: '2000000123456789',
      amountSats: null,
      withdrawal: null,
    })
    expect(readPurchase(row({ paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined, kind: 'tier' }))).toMatchObject({
      channel: 'google',
      kind: 'tier',
      transactionId: null,
    })
    expect(
      readPurchase(row({ paymentRef: SATS_REF, channel: 'sats', transactionId: undefined, withdrawal: { state: 'refunded', requestedAt: NOW - 9, outcomeAt: NOW } })),
    ).toMatchObject({ channel: 'sats', withdrawal: { state: 'refunded', requestedAt: NOW - 9, outcomeAt: NOW } })
  })

  // The amount is shown, never signed: one the list does not say as a whole number of sats on a sats
  // row is no amount, and the row stays.
  test.each<[string, Record<string, unknown>, number | null]>([
    ['a sats charge', { paymentRef: SATS_REF, channel: 'sats', transactionId: undefined, amountSats: 21_000 }, 21_000],
    ['a sats charge from a gateway that does not say it', { paymentRef: SATS_REF, channel: 'sats', transactionId: undefined }, null],
    ['a sats charge of zero', { paymentRef: SATS_REF, channel: 'sats', transactionId: undefined, amountSats: 0 }, null],
    ['a sats charge below zero', { paymentRef: SATS_REF, channel: 'sats', transactionId: undefined, amountSats: -21 }, null],
    ['a sats charge with a fraction', { paymentRef: SATS_REF, channel: 'sats', transactionId: undefined, amountSats: 21.5 }, null],
    ['a sats charge as text', { paymentRef: SATS_REF, channel: 'sats', transactionId: undefined, amountSats: '21000' }, null],
    ['a sats charge past a safe integer', { paymentRef: SATS_REF, channel: 'sats', transactionId: undefined, amountSats: 2 ** 60 }, null],
    ['an Apple purchase that carries one', { amountSats: 21_000 }, null],
    ['a Google purchase that carries one', { paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined, amountSats: 21_000 }, null],
  ])('the amount of %s', (_name, over, amount) => {
    expect(readPurchase(row(over))?.amountSats).toBe(amount)
  })

  test('a lapsed withdrawal reads', () => {
    const lapsed = { state: 'lapsed', requestedAt: NOW - 15 * 86_400, outcomeAt: NOW - 86_400 }
    expect(readPurchase(row({ withdrawable: false, withdrawal: lapsed }))?.withdrawal).toEqual(lapsed)
  })

  test.each<[string, Record<string, unknown>]>([
    ['a reference in no known form', { paymentRef: 'apple:Xcode:1' }],
    ['a channel that is not the reference\'s', { channel: 'google' }],
    ['a kind not known', { kind: 'domain' }],
    ['no domain', { domain: '' }],
    ['no subject', { subject: '' }],
    ['a purchase time that is not a number', { purchasedAt: String(NOW) }],
    ['no deadline', { withdrawableUntil: undefined }],
    ['withdrawable that is not a boolean', { withdrawable: 'yes' }],
    ['a withdrawal state not known', { withdrawal: { state: 'pending', requestedAt: NOW, outcomeAt: null } }],
    ['a withdrawal with no request time', { withdrawal: { state: 'requested', outcomeAt: null } }],
    ['a withdrawal outcome that is not a number', { withdrawal: { state: 'refunded', requestedAt: NOW, outcomeAt: 'now' } }],
    ['an Apple row with no transaction id', { transactionId: undefined }],
    ['an Apple transaction id that is not a number', { transactionId: '12a' }],
  ])('a row with %s is left out', (_name, over) => {
    expect(readPurchase(row(over))).toBeNull()
  })

  test('the list is read with the credits statement and keeps only the rows it can read', async () => {
    const { calls, request } = gateway([{ status: 200, body: { credits: [], purchases: [row(), row({ paymentRef: 'bad' })] } }])
    const d = deps(request)
    const list = await walletPurchases(d)
    expect(list?.map(p => p.paymentRef)).toEqual([APPLE_REF])
    expect(calls[0]?.url).toBe('https://usevoltz.app/api/store/credits')
    expect(d.sign).toHaveBeenCalledWith(storeCreditsMessage(PUB, NOW))
  })

  test.each<[string, Array<{ status: number; body: unknown } | 'network'>]>([
    ['an older gateway with credits alone', [{ status: 200, body: { credits: [] } }]],
    ['a 500', [{ status: 500, body: { error: 'internal error' } }]],
    ['a 401 twice', [{ status: 401, body: { error: 'invalid_signature' } }]],
    ['no connection', ['network']],
  ])('%s is no list, never an empty one', async (_name, answers) => {
    const { request } = gateway(answers)
    await expect(walletPurchases(deps(request))).resolves.toBeNull()
  })
})

// The row is offered only while the gateway says withdrawable, and gives way to the state once
// a withdrawal exists.
describe('what a screen shows', () => {
  test('a withdrawable purchase of the kind shows, one not withdrawable without a withdrawal does not', () => {
    const open = purchase()
    const closed = purchase({ paymentRef: 'apple:Production:2', transactionId: '2', withdrawable: false })
    const year = purchase({ paymentRef: 'apple:Production:3', transactionId: '3', kind: 'tier' })
    expect(shownPurchases([open, closed, year], 'name')).toEqual([open])
    expect(shownPurchases([open, closed, year], 'tier')).toEqual([year])
  })

  test('a purchase with a withdrawal shows its state whatever withdrawable says', () => {
    const asked = purchase({ withdrawable: false, withdrawal: { state: 'requested', requestedAt: NOW, outcomeAt: null } })
    expect(shownPurchases([asked], 'name')).toEqual([asked])
  })
})

describe('the request', () => {
  test('a store purchase signs an empty refund address and the consent ticked, and posts what it signed', async () => {
    const { calls, request } = gateway([{ status: 200, body: receiptBody() }])
    const d = deps(request)
    const result = await requestWithdrawal(d, { purchase: purchase(), consent: true })
    expect(result).toEqual({
      kind: 'received',
      receipt: {
        paymentRef: APPLE_REF,
        channel: 'apple',
        state: 'requested',
        requestedAt: NOW - 5,
        outcomeAt: null,
        withdrawableUntil: NOW + 13 * 86_400,
        transactionId: '2000000123456789',
      },
    })
    expect(d.sign).toHaveBeenCalledWith(withdrawMessage(PUB, APPLE_REF, '', 1, NOW))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://usevoltz.app/api/purchase/withdraw')
    // What was signed and nothing more: no holder name, which the app never asks for.
    expect(calls[0]!.body).toEqual({
      pubkey: PUB,
      paymentRef: APPLE_REF,
      refundTo: '',
      consent: 1,
      signature: `sig(${withdrawMessage(PUB, APPLE_REF, '', 1, NOW).length})`,
      timestamp: NOW,
    })
    expect(d.refundAddress).not.toHaveBeenCalled()
  })

  // Only a tick sends 1, and only on Apple, where the gateway reads it.
  test.each<[string, Partial<WalletPurchase>, boolean, 0 | 1]>([
    ['Apple unticked', {}, false, 0],
    ['Apple ticked', {}, true, 1],
    ['Google ticked', { paymentRef: GOOGLE_REF, channel: 'google', transactionId: null }, true, 0],
  ])('%s signs and sends consent %s', async (_name, over, ticked, sent) => {
    const { calls, request } = gateway([{ status: 200, body: receiptBody({ paymentRef: over.paymentRef ?? APPLE_REF, channel: over.channel ?? 'apple' }) }])
    const d = deps(request)
    const p = purchase({ transactionId: '2000000123456789', ...over })
    await requestWithdrawal(d, { purchase: p, consent: ticked })
    expect(calls[0]!.body.consent).toBe(sent)
    expect(calls[0]!.body).not.toHaveProperty('holderName')
    expect(d.sign).toHaveBeenCalledWith(withdrawMessage(PUB, p.paymentRef, '', sent, NOW))
  })

  test('a sats purchase signs and sends the paying wallet\'s own Spark address, asked as its key', async () => {
    const { calls, request } = gateway([{ status: 200, body: receiptBody({ paymentRef: SATS_REF, channel: 'sats', transactionId: undefined }) }])
    const d = deps(request)
    const result = await requestWithdrawal(d, {
      purchase: purchase({ paymentRef: SATS_REF, channel: 'sats' as Channel, transactionId: null }),
      consent: true,
    })
    expect(d.refundAddress).toHaveBeenCalledWith(PUB)
    expect(calls[0]!.body.refundTo).toBe(SPARK)
    expect(calls[0]!.body.consent).toBe(0)
    expect(d.sign).toHaveBeenCalledWith(withdrawMessage(PUB, SATS_REF, SPARK, 0, NOW))
    expect(result).toMatchObject({ kind: 'received', receipt: { channel: 'sats', transactionId: null } })
  })

  test.each([
    ['a regtest address', async () => 'sparkrt1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jq'],
    ['an address that cannot be read', async () => Promise.reject(new Error('spark not connected'))],
  ])('a sats purchase with %s sends nothing', async (_name, refundAddress) => {
    const { calls, request } = gateway([{ status: 200, body: receiptBody() }])
    const d = deps(request, { refundAddress })
    const result = await requestWithdrawal(d, {
      purchase: purchase({ paymentRef: SATS_REF, channel: 'sats' as Channel, transactionId: null }),
      consent: false,
    })
    expect(result).toEqual({ kind: 'noRefundAddress' })
    expect(calls).toEqual([])
    expect(d.sign).not.toHaveBeenCalled()
  })

  // A request is signed by the wallet that read the list, or by nobody.
  test('a connection on another wallet signs and sends nothing', async () => {
    const { calls, request } = gateway([{ status: 200, body: receiptBody() }])
    const d = deps(request, { connectedWalletId: () => 'w2' })
    await expect(requestWithdrawal(d, { purchase: purchase(), consent: false })).resolves.toEqual({ kind: 'otherWallet' })
    expect(d.sign).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  // Apple hears of a withdrawal only through its own sheet, so where that sheet cannot open an Apple
  // purchase is neither signed nor sent, whatever a screen offered; the other rails still go.
  test('an Apple purchase where Apple\'s sheet cannot open signs and sends nothing, and says where to ask', async () => {
    const os = Platform.OS
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true })
    try {
      const { calls, request } = gateway([{ status: 200, body: receiptBody() }])
      const d = deps(request)
      const result = await requestWithdrawal(d, { purchase: purchase(), consent: true })
      expect(result).toEqual({ kind: 'appleElsewhere' })
      expect(refusalKey(result as { kind: 'appleElsewhere' })).toBe('withdrawal.appleElsewhere')
      expect(d.sign).not.toHaveBeenCalled()
      expect(calls).toEqual([])

      const google = gateway([{ status: 200, body: receiptBody({ paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined }) }])
      const sent = await requestWithdrawal(deps(google.request), {
        purchase: purchase({ paymentRef: GOOGLE_REF, channel: 'google', transactionId: null }),
        consent: false,
        })
      expect(sent).toMatchObject({ kind: 'received' })
      expect(google.calls).toHaveLength(1)
    } finally {
      Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
    }
  })

  test('a signer that finds another identity sends nothing and says so, without retrying', async () => {
    const { calls, request } = gateway([{ status: 200, body: receiptBody() }])
    const d = deps(request, { sign: jest.fn(async () => Promise.reject(new Error('spark connected as another identity'))) })
    await expect(requestWithdrawal(d, { purchase: purchase(), consent: false })).resolves.toEqual({ kind: 'otherWallet' })
    expect(d.sign).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
  })

  test('a sats refund address asked of another identity sends nothing and says so', async () => {
    const { calls, request } = gateway([{ status: 200, body: receiptBody() }])
    const d = deps(request, { refundAddress: async () => Promise.reject(new Error('spark connected as another identity')) })
    const result = await requestWithdrawal(d, {
      purchase: purchase({ paymentRef: SATS_REF, channel: 'sats' as Channel, transactionId: null }),
      consent: false,
    })
    expect(result).toEqual({ kind: 'otherWallet' })
    expect(calls).toEqual([])
  })

  test('a switch between tries stops the retries before the next signature', async () => {
    let connected = 'w1'
    const { calls, request } = gateway(['network'])
    const d = deps(request, {
      connectedWalletId: () => connected,
      sleep: async () => {
        connected = 'w2'
      },
    })
    await expect(requestWithdrawal(d, { purchase: purchase(), consent: false })).resolves.toEqual({ kind: 'otherWallet' })
    expect(calls).toHaveLength(1)
  })

  test('a gateway out of reach is retried in the session and then says it could not confirm', async () => {
    const { calls, request } = gateway(['network'])
    const sleep = jest.fn(async () => undefined)
    const result = await requestWithdrawal(deps(request, { sleep }), { purchase: purchase(), consent: false })
    expect(result).toEqual({ kind: 'unknown', network: true })
    expect(calls).toHaveLength(4)
    expect(sleep.mock.calls.map(c => (c as unknown[])[0])).toEqual([2_000, 4_000, 8_000])
  })

  test('a 401 is signed again once with a fresh timestamp', async () => {
    const { calls, request } = gateway([{ status: 401, body: { error: 'invalid_signature' } }, { status: 200, body: receiptBody() }])
    let clock = NOW
    const d = deps(request, { now: () => (clock++) * 1000 })
    await expect(requestWithdrawal(d, { purchase: purchase(), consent: false })).resolves.toMatchObject({ kind: 'received' })
    expect(calls.map(c => c.body.timestamp)).toEqual([NOW, NOW + 1])
    expect(d.sign).toHaveBeenCalledTimes(2)
  })
})

describe('the answer', () => {
  // The receipt time is the gateway's, never the device's.
  test('the receipt carries the gateway\'s requestedAt', () => {
    const result = withdrawResultOf({ kind: 'json', status: 200, body: receiptBody({ requestedAt: 1_700_000_042 }) }, APPLE_REF)
    expect(result).toMatchObject({ kind: 'received', receipt: { requestedAt: 1_700_000_042 } })
  })

  test.each<[string, Record<string, unknown>]>([
    ['about another purchase', { paymentRef: GOOGLE_REF }],
    ['on another rail', { channel: 'google' }],
    ['in a state not known', { state: 'pending' }],
    ['with no time', { requestedAt: undefined }],
  ])('a 200 %s is no receipt', (_name, over) => {
    expect(withdrawResultOf({ kind: 'json', status: 200, body: receiptBody(over) }, APPLE_REF)).toEqual({ kind: 'unknown', network: false })
  })

  test.each<[string, Record<string, unknown>, number | null]>([
    ['a refund with its time', { state: 'refunded', outcomeAt: NOW - 3 }, NOW - 3],
    ['a refund from a gateway that does not say when', { state: 'refunded' }, null],
    ['a refund whose time is not a number', { state: 'refunded', outcomeAt: 'now' }, null],
    ['a request, whatever time comes with it', { state: 'requested', outcomeAt: NOW - 3 }, null],
  ])('a receipt for %s', (_name, over, outcomeAt) => {
    expect(withdrawResultOf({ kind: 'json', status: 200, body: receiptBody(over) }, APPLE_REF)).toMatchObject({
      kind: 'received',
      receipt: { outcomeAt },
    })
  })

  test('an Apple receipt without a usable transaction id keeps none', () => {
    expect(withdrawResultOf({ kind: 'json', status: 200, body: receiptBody({ transactionId: 'x' }) }, APPLE_REF)).toMatchObject({
      kind: 'received',
      receipt: { transactionId: null },
    })
  })

  test.each<[number, string, string]>([
    // The app sends no name, so a refusal of one is this build sending what the gateway could not take.
    [400, 'invalid_holder_name', 'withdrawal.refused'],
    [409, 'unknown_purchase', 'withdrawal.unknownPurchase'],
    [409, 'not_withdrawable', 'withdrawal.notWithdrawable'],
    [409, 'window_closed', 'withdrawal.windowClosed'],
    [409, 'credit_reserved', 'withdrawal.creditReserved'],
    [429, 'too many requests', 'withdrawal.tooMany'],
    [400, 'missing_fields', 'withdrawal.refused'],
    [400, 'invalid_pubkey', 'withdrawal.refused'],
    [400, 'invalid_payment_ref', 'withdrawal.refused'],
    [400, 'invalid_refund_to', 'withdrawal.refused'],
    [400, 'refund_to_required', 'withdrawal.refused'],
    [400, 'refund_to_not_allowed', 'withdrawal.refused'],
    [401, 'invalid_signature', 'withdrawal.refused'],
    [500, 'internal error', 'withdrawal.unknown'],
    [503, 'unavailable', 'withdrawal.unknown'],
  ])('%s %s says %s', (status, error, key) => {
    const result = withdrawResultOf({ kind: 'json', status, body: { error } }, APPLE_REF)
    expect(result.kind).not.toBe('received')
    expect(refusalKey(result as Exclude<typeof result, { kind: 'received' }>)).toBe(key)
    expect(en.withdrawal[key.split('.')[1]!]).toBeDefined()
  })

  test('an answer that is not the gateway\'s, or none, says the request could not be confirmed', () => {
    expect(refusalKey(withdrawResultOf({ kind: 'notJson', status: 403 }, APPLE_REF) as never)).toBe('withdrawal.unknown')
    expect(refusalKey(withdrawResultOf({ kind: 'network' }, APPLE_REF) as never)).toBe('withdrawal.unknownNetwork')
    expect(refusalKey({ kind: 'otherWallet' })).toBe('withdrawal.otherWallet')
    expect(refusalKey({ kind: 'noRefundAddress' })).toBe('withdrawal.noRefundAddress')
  })
})

// What the lines claim, read in the words a person sees.
describe('what the lines claim', () => {
  const format = { item: 'The name satoshi@usevoltz.app', date: () => '10/29/2026', time: () => '1:00 PM' }
  const channels: Channel[] = ['apple', 'google', 'sats']
  const states: WithdrawalState[] = ['requested', 'refunded', 'declined', 'failed', 'lapsed']
  const cases = channels.flatMap(channel => states.map(state => [channel, state] as const))
  const words = (locale: { withdrawal: Record<string, string> }, key: string) => locale.withdrawal[key.replace('withdrawal.', '')]!

  test.each(cases)('on %s, %s says refunded only when the list says refunded', (channel, state) => {
    const line = stateLine({ state, requestedAt: NOW, outcomeAt: state === 'requested' ? null : NOW }, channel, format)
    const text = words(en, line.key)
    expect(text).toBeDefined()
    expect(/refund(ed)? on|^Refunded/i.test(text)).toBe(state === 'refunded')
    expect(/^Devolvido/.test(words(pt, line.key))).toBe(state === 'refunded')
  })

  test.each(cases)('on %s, %s promises 3 business days only on the sats rail', (channel, state) => {
    const line = stateLine({ state, requestedAt: NOW, outcomeAt: NOW }, channel, format)
    expect(words(en, line.key).includes('3 business days')).toBe(channel === 'sats' && state === 'requested')
    expect(words(pt, line.key).includes('3 dias úteis')).toBe(channel === 'sats' && state === 'requested')
  })

  test.each(channels)('the receipt and the line above Pay on %s promise 3 business days only on the sats rail', channel => {
    for (const key of [receiptNextKey(channel), payLineKey(channel)]) {
      expect(words(en, key).includes('3 business days')).toBe(channel === 'sats' && key === receiptNextKey(channel))
      expect(words(pt, key).includes('3 dias úteis')).toBe(channel === 'sats' && key === receiptNextKey(channel))
    }
  })

  test('no withdrawal line but the two on the sats rail mentions 3 business days, in any form', () => {
    const promising = Object.entries(en.withdrawal).filter(([, text]) => /\b3\b/.test(text)).map(([key]) => key)
    expect(promising.sort()).toEqual(['receiptSats', 'waitingSats'])
    const promisingPt = Object.entries(pt.withdrawal).filter(([, text]) => /\b3\b/.test(text)).map(([key]) => key)
    expect(promisingPt.sort()).toEqual(['receiptSats', 'waitingSats'])
  })

  test('a decline by Apple says only that Apple did not approve it, and promises nothing from Voltz', () => {
    const line = stateLine({ state: 'declined', requestedAt: NOW, outcomeAt: NOW }, 'apple', format)
    expect(line.key).toBe('withdrawal.declinedApple')
    expect(words(en, line.key)).toBe('Apple did not approve the refund for this purchase.')
    expect(words(en, line.key)).not.toMatch(/Voltz|refunds? you|will/i)
    expect(words(pt, line.key)).not.toMatch(/Voltz/)
  })

  test('a refund with no outcome time says refunded without a date', () => {
    expect(stateLine({ state: 'refunded', requestedAt: NOW, outcomeAt: null }, 'google', format)).toEqual({
      key: 'withdrawal.refundedUndated',
      params: { item: format.item },
    })
  })

  test('a state the rail never reaches claims only the request', () => {
    expect(stateLine({ state: 'declined', requestedAt: NOW, outcomeAt: NOW }, 'sats', format).key).toBe('withdrawal.requestedOn')
    expect(stateLine({ state: 'failed', requestedAt: NOW, outcomeAt: NOW }, 'apple', format).key).toBe('withdrawal.requestedOn')
  })

  // The gateway lapses a withdrawal on 14 days with no word from Apple, which is all it knows: Apple
  // may have the request, and can still refund it later.
  test('a lapsed Apple withdrawal says only that Apple sent no word in 14 days, and claims no refund', () => {
    const line = stateLine({ state: 'lapsed', requestedAt: NOW, outcomeAt: NOW }, 'apple', format)
    expect(line).toEqual({ key: 'withdrawal.lapsedApple' })
    expect(words(en, line.key)).toBe('Apple sent no word about this request within 14 days, so it was closed. The purchase is still yours.')
    const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales')
    const all = fs.readdirSync(dir).map(f => [f, (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as typeof en).withdrawal.lapsedApple!] as const)
    expect(all).toHaveLength(24)
    expect(all.filter(([, text]) => !text.includes('14'))).toEqual([])
    expect(words(pt, line.key)).not.toMatch(/nunca chegou/)
    expect(stateLine({ state: 'lapsed', requestedAt: NOW, outcomeAt: NOW }, 'google', format).key).toBe('withdrawal.requestedOn')
    expect(stateLine({ state: 'lapsed', requestedAt: NOW, outcomeAt: NOW }, 'sats', format).key).toBe('withdrawal.requestedOn')
  })

  test('the channel is read from the reference', () => {
    expect(channelOf(APPLE_REF)).toBe('apple')
    expect(channelOf(GOOGLE_REF)).toBe('google')
    expect(channelOf(SATS_REF)).toBe('sats')
  })
})

// What the receipt says next follows the state the answer carries, never only its rail: Google's 200
// can already be refunded or failed, and a repeat answers the state the withdrawal is in now.
describe('the receipt\'s next line', () => {
  const format = { item: 'The name satoshi@usevoltz.app', date: (s: number) => `day ${s}`, time: () => '1:00 PM' }
  const words = (locale: { withdrawal: Record<string, string> }, key: string) => locale.withdrawal[key.replace('withdrawal.', '')]!
  const receipt = (over: Partial<WithdrawReceipt>): WithdrawReceipt => ({
    paymentRef: GOOGLE_REF,
    channel: 'google',
    state: 'requested',
    requestedAt: NOW - 5,
    outcomeAt: null,
    withdrawableUntil: NOW + 13 * 86_400,
    transactionId: null,
    ...over,
  })

  test.each<[string, Partial<WithdrawReceipt>, { key: string; params?: Record<string, string> }]>([
    ['Apple requested', { paymentRef: APPLE_REF, channel: 'apple', transactionId: '2000000123456789' }, { key: 'withdrawal.receiptApple' }],
    ['Google requested', {}, { key: 'withdrawal.receiptGoogle' }],
    ['sats requested', { paymentRef: SATS_REF, channel: 'sats' }, { key: 'withdrawal.receiptSats' }],
    ['Google refunded', { state: 'refunded', outcomeAt: NOW - 1 }, { key: 'withdrawal.refunded', params: { item: format.item, date: `day ${NOW - 1}` } }],
    ['Google refunded with no time', { state: 'refunded' }, { key: 'withdrawal.refundedUndated', params: { item: format.item } }],
    ['Google failed', { state: 'failed', outcomeAt: NOW - 1 }, { key: 'withdrawal.failedGoogle' }],
    ['Apple lapsed', { paymentRef: APPLE_REF, channel: 'apple', state: 'lapsed', outcomeAt: NOW - 1 }, { key: 'withdrawal.lapsedApple' }],
    ['Apple declined', { paymentRef: APPLE_REF, channel: 'apple', state: 'declined', outcomeAt: NOW - 1 }, { key: 'withdrawal.declinedApple', params: { item: format.item } }],
    ['Apple failed, which the rail never reaches', { paymentRef: APPLE_REF, channel: 'apple', state: 'failed', outcomeAt: NOW - 1 }, { key: 'withdrawal.requestedOn', params: { date: `day ${NOW - 5}` } }],
    ['sats lapsed, which the rail never reaches', { paymentRef: SATS_REF, channel: 'sats', state: 'lapsed', outcomeAt: NOW - 1 }, { key: 'withdrawal.requestedOn', params: { date: `day ${NOW - 5}` } }],
  ])('%s', (_name, over, line) => {
    expect(receiptNextLine(receipt(over), format)).toEqual(line)
  })

  const channels: Channel[] = ['apple', 'google', 'sats']
  const states: WithdrawalState[] = ['requested', 'refunded', 'declined', 'failed', 'lapsed']
  const cases = channels.flatMap(channel => states.map(state => [channel, state] as const))

  test.each(cases)('on %s, a reply %s says refunded only when the reply says refunded', (channel, state) => {
    const line = receiptNextLine(receipt({ channel, state, outcomeAt: state === 'requested' ? null : NOW }), format)
    expect(/refund(ed)? on|^Refunded/i.test(words(en, line.key))).toBe(state === 'refunded')
    expect(/^Devolvido/.test(words(pt, line.key))).toBe(state === 'refunded')
  })

  test.each(cases)('on %s, a reply %s promises a time of Voltz\'s own only on the sats rail while requested', (channel, state) => {
    const text = words(en, receiptNextLine(receipt({ channel, state, outcomeAt: state === 'requested' ? null : NOW }), format).key)
    // The lapsed line names the 14 days that went by with no word from Apple, a period past and not a
    // time promised, and Apple's requested line quotes the time Apple's own refund page gives, as
    // Apple's word. Beyond those phrases a line carries no number or period.
    const promised = state === 'lapsed' ? text.replace('within 14 days', '') : text.replace(APPLE_QUOTE, '')
    expect(/business days|within/.test(promised)).toBe(channel === 'sats' && state === 'requested')
    if (channel !== 'sats' || state !== 'requested') {
      expect(promised).not.toMatch(/\d|business days|hours|within/)
    }
  })

  // Apple's refund page (support.apple.com/118223) says to wait 24 to 48 hours for an update once the
  // request is sent, and gives no time for its decision. Google's (support.google.com/googleplay/
  // answer/15576193) says the time depends on how the buyer paid, from 1 business day to 2 monthly
  // statements, so no single range is Google's. Each store's time is said as that store's word, and
  // no locale names any other.
  test('the store receipts quote the store, Apple with its own 24 to 48 hours and Google with no time', () => {
    expect(words(en, 'withdrawal.receiptApple')).toBe(
      `Apple now asks for a reason and decides on the refund. Once you send the request, ${APPLE_QUOTE}.`,
    )
    expect(words(en, 'withdrawal.receiptGoogle')).toBe(
      'Voltz has already asked Google Play for the refund. Google says how long it takes to show up depends on how you paid.',
    )
    expect(words(pt, 'withdrawal.receiptApple')).toBe(
      'Agora a Apple pede o motivo e decide a devolução. Depois que você enviar o pedido, a Apple diz para esperar uma atualização em 24 a 48 horas.',
    )
    expect(words(pt, 'withdrawal.receiptGoogle')).toBe(
      'A Voltz já pediu a devolução ao Google Play. O Google diz que o prazo para o valor aparecer depende de como você pagou.',
    )
    const all = allLocales()
    expect(all).toHaveLength(24)
    expect(all.filter(([, w]) => (w.receiptApple!.match(/\p{Nd}+/gu) ?? []).join(' ') !== '24 48').map(([f]) => f)).toEqual([])
    expect(all.filter(([, w]) => /\p{Nd}/u.test(w.receiptGoogle!)).map(([f]) => f)).toEqual([])
  })

  // One line for a failed Google refund, on the receipt and in the list alike, so the two never
  // say it in different words.
  test('a Google refund that failed says Voltz was alerted to finish it by hand, with no time promised, on the receipt and in the list', () => {
    const failed = receipt({ state: 'failed', outcomeAt: NOW - 1 })
    expect(receiptNextLine(failed, format)).toEqual(stateLine({ state: 'failed', requestedAt: failed.requestedAt, outcomeAt: failed.outcomeAt }, 'google', format))
    expect(words(en, 'withdrawal.failedGoogle')).toBe(
      'Google Play did not complete the refund. Voltz has been alerted and will finish it by hand.',
    )
    expect(words(pt, 'withdrawal.failedGoogle')).toBe('O Google Play não concluiu a devolução. A Voltz foi avisada e vai concluí-la manualmente.')
    expect(words(pt, 'withdrawal.failedGoogle')).not.toMatch(/\d|dias/)
  })
})

// The gateway answers Apple's CONSUMPTION_REQUEST for a ticked box with customerConsented true,
// deliveryStatus DELIVERED, sampleContentProvided false and refundPreference GRANT_FULL. The box says
// those four and nothing else, such as calling the purchase a withdrawal, which no field of that
// answer says.
describe('the Apple consent box', () => {
  const words = (locale: { withdrawal: Record<string, string> }) => locale.withdrawal.consent!

  test('says what Voltz answers Apple when Apple asks, in English and Portuguese', () => {
    expect(words(en)).toBe(
      'If Apple asks about this purchase, I allow Voltz to tell Apple that I agree to share this, that the purchase was delivered and works, that no free sample or trial came before it, and that Voltz prefers a full refund.',
    )
    expect(words(pt)).toBe(
      'Se a Apple perguntar sobre esta compra, autorizo a Voltz a dizer à Apple que concordo em compartilhar isso, que a compra foi entregue e funciona, que não houve amostra nem teste grátis antes dela e que a Voltz prefere a devolução integral.',
    )
    expect(words(en)).not.toMatch(/withdraw/i)
    expect(words(pt)).not.toMatch(/desist/i)
  })

  test('names Apple and no time or amount in every locale', () => {
    const all = allLocales()
    expect(all).toHaveLength(24)
    expect(all.filter(([, w]) => !w.consent!.includes('Apple') || /\p{Nd}/u.test(w.consent!)).map(([f]) => f)).toEqual([])
  })
})

// An Apple purchase is sent only where Apple's sheet can open, since anywhere else Apple never gets it.
describe('where an Apple purchase can be asked from', () => {
  test.each<[Channel, boolean, boolean]>([
    ['apple', true, false],
    ['apple', false, true],
    ['google', false, false],
    ['google', true, false],
    ['sats', false, false],
    ['sats', true, false],
  ])('%s with the sheet %s needs Apple\'s sheet elsewhere: %s', (channel, sheet, needs) => {
    expect(needsAppleSheet({ channel }, sheet)).toBe(needs)
  })
})

// The confirmation names the amount only when the list carries it, which only a sats charge does.
describe('the confirmation\'s purchase line', () => {
  const format = { item: 'The name satoshi@usevoltz.app', date: (s: number) => `day ${s}`, time: () => '', sats: (n: number) => `${n} sats` }

  test('a sats charge with its amount says it', () => {
    const p = purchase({ paymentRef: SATS_REF, channel: 'sats', transactionId: undefined, amountSats: 21_000 } as Partial<WalletPurchase>)
    expect(purchaseLine(p, format)).toEqual({
      key: 'withdrawal.purchaseAmount',
      params: { item: format.item, date: `day ${NOW - 86_400}`, amount: '21000 sats' },
    })
    expect(en.withdrawal.purchaseAmount).toBe('{{item}}, bought on {{date}} for {{amount}}.')
  })

  test.each<[string, Record<string, unknown>]>([
    ['an Apple purchase', {}],
    ['a Google purchase', { paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined }],
    ['a sats charge the list gives no amount for', { paymentRef: SATS_REF, channel: 'sats', transactionId: undefined }],
  ])('%s says no amount', (_name, over) => {
    expect(purchaseLine(purchase(over as Partial<WalletPurchase>), format)).toEqual({
      key: 'withdrawal.purchase',
      params: { item: format.item, date: `day ${NOW - 86_400}` },
    })
    expect(en.withdrawal.purchase).toBe('{{item}}, bought on {{date}}.')
  })
})
