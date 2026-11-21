import {
  SESSION_WAITS_MS,
  confirmStorePurchase,
  openStoreOrder,
  recordSpendIntent,
  storeConfirmMessage,
  storeCredits,
  storeCreditsMessage,
  storeOrderMessage,
  storeSpendMessage,
  type StoreGatewayDeps,
} from '../src/wallet/storePurchase'
import type { StorePurchase } from '../src/wallet/store'
import { onGatewayDeleted } from '../src/wallet/deletionMark'

const DOMAIN = 'usevoltz.app'
const PUBKEY = `02${'b'.repeat(64)}`
const REF = 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f'
const OTHER_REF = '7d444840-9dc0-11d1-b245-5ffdce74fad2'
const HMAC = 'c'.repeat(64)
const NOW_MS = 1_800_000_000_000
const HTML = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head></html>'

type Answer = { status: number; text: string } | 'network'
type Call = { url: string; body: Record<string, unknown> }

const json = (status: number, body: unknown): Answer => ({ status, text: JSON.stringify(body) })
const html = (status: number): Answer => ({ status, text: HTML })

// One answer per request, in order, and every request kept as it was sent.
function gateway(...answers: Answer[]) {
  const calls: Call[] = []
  const signed: string[] = []
  const slept: number[] = []
  let clock = NOW_MS
  const deps: StoreGatewayDeps = {
    gatewayUrl: `https://${DOMAIN}/`,
    domain: DOMAIN,
    pubkey: PUBKEY,
    sign: async message => {
      signed.push(message)
      return `sig-${signed.length}`
    },
    now: () => clock,
    sleep: async ms => {
      slept.push(ms)
      clock += ms
    },
    request: (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      const next = answers.shift()
      if (!next) {
        throw new Error('the double has no answer left')
      }
      if (next === 'network') {
        throw new TypeError('Network request failed')
      }
      return { status: next.status, ok: next.status < 300, text: async () => next.text } as unknown as Response
    }) as unknown as typeof fetch,
  }
  return { deps, calls, signed, slept }
}

function purchase(over: Partial<StorePurchase> = {}): StorePurchase & { reference: string } {
  return {
    store: 'apple',
    productId: 'name_standard',
    state: 'purchased',
    purchasedAt: NOW_MS,
    reference: REF,
    key: '2000000123456789',
    verified: true,
    revoked: false,
    ...over,
  } as StorePurchase & { reference: string }
}

const delivered = json(200, {
  state: 'delivered',
  reference: REF,
  kind: 'name',
  credit: { domain: DOMAIN, tier: 'standard' },
})

describe('signed statements', () => {
  test('match the gateway byte for byte', () => {
    expect(storeOrderMessage(DOMAIN, PUBKEY, 'apple', 'name', 'alice', 1_800_000_000)).toBe(
      `voltz-store-order:v1\norder\n${DOMAIN}\n${PUBKEY}\napple\nname\nalice\n1800000000`,
    )
    expect(storeConfirmMessage(DOMAIN, PUBKEY, 'google', REF, 'token-1', 1_800_000_000)).toBe(
      `voltz-store-confirm:v1\nconfirm\n${DOMAIN}\n${PUBKEY}\ngoogle\n${REF}\ntoken-1\n1800000000`,
    )
    expect(storeCreditsMessage(PUBKEY, 1_800_000_000)).toBe(`voltz-store-credits:v1\ncredits\n${PUBKEY}\n1800000000`)
    expect(storeSpendMessage(DOMAIN, PUBKEY, 'alice', 1_800_000_000)).toBe(
      `voltz-store-spend:v1\nspend\n${DOMAIN}\n${PUBKEY}\nalice\n1800000000`,
    )
  })
})

describe('opening an order', () => {
  test('signs the order for this host and hands back what Apple is given', async () => {
    const g = gateway(
      json(200, { reference: REF, productId: 'name_standard', state: 'held', kind: 'name', subject: 'alice', appAccountToken: REF }),
    )
    const result = await openStoreOrder(g.deps, 'apple', 'name', 'alice')
    expect(result).toEqual({
      kind: 'order',
      order: { reference: REF, productId: 'name_standard', state: 'held', kind: 'name', subject: 'alice', storeReference: REF, accountId: null },
    })
    expect(g.calls).toEqual([
      {
        url: `https://${DOMAIN}/api/store/order`,
        body: { host: DOMAIN, store: 'apple', kind: 'name', subject: 'alice', pubkey: PUBKEY, signature: 'sig-1', timestamp: 1_800_000_000 },
      },
    ])
    expect(g.signed).toEqual([storeOrderMessage(DOMAIN, PUBKEY, 'apple', 'name', 'alice', 1_800_000_000)])
  })

  test("hands back Google's identifiers as the order holds them", async () => {
    const g = gateway(
      json(200, {
        reference: REF,
        productId: 'domain_year',
        state: 'paid',
        kind: 'tier',
        subject: 'bakery.com.br',
        obfuscatedProfileId: REF,
        obfuscatedAccountId: HMAC,
      }),
    )
    const result = await openStoreOrder(g.deps, 'google', 'tier', 'bakery.com.br')
    expect(result).toMatchObject({ kind: 'order', order: { state: 'paid', storeReference: REF, accountId: HMAC } })
  })

  test.each([
    [409, 'name_pending'],
    [409, 'held_by_another_wallet'],
    [403, 'reserved'],
    [429, 'change_limit_reached'],
    [400, 'malformed username'],
  ])('a %p %p is the gateway refusing, with its reason', async (status, code) => {
    const g = gateway(json(status, { error: code }))
    expect(await openStoreOrder(g.deps, 'apple', 'name', 'alice')).toStrictEqual({ kind: 'refused', status, code })
  })

  // A name another wallet's credit blocks clears on its own, and the gateway says when.
  test('a refusal that clears on its own carries the second it clears, and only a number', async () => {
    const held = gateway(json(409, { error: 'name_held_for_credit', retry_at: 1_800_000_600 }))
    expect(await openStoreOrder(held.deps, 'apple', 'name', 'alice')).toStrictEqual({
      kind: 'refused',
      status: 409,
      code: 'name_held_for_credit',
      retryAt: 1_800_000_600,
    })
    const odd = gateway(json(409, { error: 'name_held_for_credit', retry_at: 'soon' }))
    expect(await openStoreOrder(odd.deps, 'apple', 'name', 'alice')).toStrictEqual({ kind: 'refused', status: 409, code: 'name_held_for_credit' })
  })

  test.each<[string, Answer]>([
    ['its 503', json(503, { error: 'store_unavailable' })],
    ['an edge page', html(502)],
    ['an edge 403', html(403)],
    ['a network failure', 'network'],
    ['a 500', json(500, { error: 'internal error' })],
    [
      'an order whose Apple token is not its reference',
      json(200, { reference: REF, productId: 'name_standard', state: 'held', kind: 'name', subject: 'alice', appAccountToken: OTHER_REF }),
    ],
    [
      'a product this build does not sell',
      json(200, { reference: REF, productId: 'name_mega', state: 'held', kind: 'name', subject: 'alice', appAccountToken: REF }),
    ],
    [
      'a reference in capitals',
      json(200, {
        reference: REF.toUpperCase(),
        productId: 'name_standard',
        state: 'held',
        kind: 'name',
        subject: 'alice',
        appAccountToken: REF.toUpperCase(),
      }),
    ],
  ])('%s is a retry with no wait, never a refusal', async (_label, answer) => {
    const g = gateway(answer)
    expect(await openStoreOrder(g.deps, 'apple', 'name', 'alice')).toEqual({ kind: 'retry' })
    expect(g.calls).toHaveLength(1)
    expect(g.slept).toEqual([])
  })

  test('a Google account id the store would block is a retry', async () => {
    const g = gateway(
      json(200, {
        reference: REF,
        productId: 'name_standard',
        state: 'held',
        kind: 'name',
        subject: 'alice',
        obfuscatedProfileId: REF,
        obfuscatedAccountId: 'c'.repeat(65),
      }),
    )
    expect(await openStoreOrder(g.deps, 'google', 'name', 'alice')).toEqual({ kind: 'retry' })
  })
})

describe('confirming a purchase', () => {
  test('sends the transaction id on Apple, signed with it, and no JWS', async () => {
    const g = gateway(delivered)
    expect(await confirmStorePurchase(g.deps, purchase())).toMatchObject({ kind: 'delivered' })
    expect(g.calls).toEqual([
      {
        url: `https://${DOMAIN}/api/store/confirm`,
        body: {
          host: DOMAIN,
          store: 'apple',
          reference: REF,
          transactionId: '2000000123456789',
          pubkey: PUBKEY,
          signature: 'sig-1',
          timestamp: 1_800_000_000,
        },
      },
    ])
    expect(g.signed).toEqual([storeConfirmMessage(DOMAIN, PUBKEY, 'apple', REF, '2000000123456789', 1_800_000_000)])
  })

  test('sends the purchase token on Google', async () => {
    const g = gateway(delivered)
    await confirmStorePurchase(g.deps, purchase({ store: 'google', key: 'token-1' }))
    expect(g.calls[0]!.body).toMatchObject({ store: 'google', reference: REF, purchaseToken: 'token-1' })
    expect(g.calls[0]!.body).not.toHaveProperty('transactionId')
    expect(g.signed[0]).toBe(storeConfirmMessage(DOMAIN, PUBKEY, 'google', REF, 'token-1', 1_800_000_000))
  })

  test.each([
    [409, 'refunded'],
    [409, 'order_already_delivered'],
    [409, 'domain_held_by_another_wallet'],
    [409, 'product_mismatch'],
    [409, 'refused'],
    [403, 'environment_not_allowed'],
    [403, 'xcode_environment'],
  ])('a %p %p is final', async (status, code) => {
    const g = gateway(json(status, { error: code }))
    expect(await confirmStorePurchase(g.deps, purchase())).toEqual({ kind: 'refused', status, code })
  })

  test.each([
    'store_mismatch',
    'no_app_account_token',
    'wrong_app_account_token',
    'purchase_of_another_order',
    'wrong_bundle',
    'wrong_product',
    'not_consumable',
    'wrong_quantity',
    'no_profile_id',
    'wrong_profile_id',
    'no_account_id',
    'wrong_account_id',
  ])('a 409 %p comes from a defect and goes to support', async code => {
    const g = gateway(json(409, { error: code }))
    expect(await confirmStorePurchase(g.deps, purchase())).toEqual({ kind: 'support', code })
  })

  test('an unknown order is its own verdict', async () => {
    const g = gateway(json(409, { error: 'unknown_order' }))
    expect(await confirmStorePurchase(g.deps, purchase())).toEqual({ kind: 'unknownOrder' })
  })

  test('a pending purchase waits for the store', async () => {
    const g = gateway(json(402, { error: 'purchase_pending' }))
    expect(await confirmStorePurchase(g.deps, purchase())).toEqual({ kind: 'pending' })
  })

  test.each(['purchase_not_found', 'not_paid'])('a 402 %p is a purchase the store does not confirm', async code => {
    const g = gateway(json(402, { error: code }))
    expect(await confirmStorePurchase(g.deps, purchase())).toEqual({ kind: 'notVerified', code })
  })

  test.each<[string, Answer]>([
    ['an edge 403 page', html(403)],
    ['a 403 the gateway never sends', json(403, { error: 'forbidden' })],
    ['a 429 from the rate window', json(429, { error: 'too many requests' })],
    ['an edge 502 page', html(502)],
    ['an edge 503 page', html(503)],
    ['a 500', json(500, { error: 'internal error' })],
    ['a 404 unknown domain', json(404, { error: 'unknown domain' })],
    ['a 400', json(400, { error: 'invalid_reference' })],
    ['a 409 code this build does not know', json(409, { error: 'purchase_on_fire' })],
    ['a 402 the list lacks', json(402, { error: 'purchase_cancelled' })],
    ['a 409 with no code', json(409, {})],
    ['a 200 that names another reference', json(200, { state: 'delivered', reference: OTHER_REF })],
    ['a 200 that is not a delivery', json(200, { state: 'held', reference: REF })],
    ['a 200 page', { status: 200, text: HTML }],
  ])('%s is asked again later, once in this session', async (_label, answer) => {
    const g = gateway(answer)
    expect(await confirmStorePurchase(g.deps, purchase())).toMatchObject({ kind: 'later' })
    expect(g.calls).toHaveLength(1)
    expect(g.slept).toEqual([])
  })

  test("the gateway's 503 is tried three more times, waiting 2, 4 and 8 seconds", async () => {
    const busy = json(503, { error: 'store_unavailable' })
    const g = gateway(busy, busy, busy, delivered)
    expect(await confirmStorePurchase(g.deps, purchase())).toMatchObject({ kind: 'delivered' })
    expect(g.slept).toEqual([...SESSION_WAITS_MS])
    expect(SESSION_WAITS_MS).toEqual([2_000, 4_000, 8_000])
    // Every try is signed afresh, so the last one is still inside the signature window.
    expect(g.calls.map(c => c.body.timestamp)).toEqual([1_800_000_000, 1_800_000_002, 1_800_000_006, 1_800_000_014])
  })

  test('a network that stays down leaves the purchase for the next open', async () => {
    const g = gateway('network', 'network', 'network', 'network')
    expect(await confirmStorePurchase(g.deps, purchase())).toEqual({ kind: 'retry' })
    expect(g.calls).toHaveLength(4)
  })

  test('a 401 is tried once more with a new timestamp', async () => {
    const g = gateway(json(401, { error: 'invalid_signature' }), delivered)
    expect(await confirmStorePurchase(g.deps, purchase())).toMatchObject({ kind: 'delivered' })
    expect(g.calls).toHaveLength(2)
  })

  test('a second 401 is asked again later', async () => {
    const g = gateway(json(401, { error: 'invalid_signature' }), json(401, { error: 'invalid_signature' }))
    expect(await confirmStorePurchase(g.deps, purchase())).toEqual({ kind: 'later', status: 401, code: 'invalid_signature' })
    expect(g.calls).toHaveLength(2)
  })
})

describe('reading credits', () => {
  const credit = { id: 'a'.repeat(64), domain: DOMAIN, tier: 'standard', state: 'available', name: null, grantedAt: 1_800_000_000 }

  test('lists every credit the gateway holds for the wallet', async () => {
    const g = gateway(json(200, { credits: [credit, { ...credit, state: 'spent', name: 'alice' }] }))
    expect(await storeCredits(g.deps)).toEqual([credit, { ...credit, state: 'spent', name: 'alice' }])
    expect(g.calls[0]).toEqual({
      url: `https://${DOMAIN}/api/store/credits`,
      body: { pubkey: PUBKEY, signature: 'sig-1', timestamp: 1_800_000_000 },
    })
    expect(g.signed).toEqual([storeCreditsMessage(PUBKEY, 1_800_000_000)])
  })

  // A credit whose purchase has a withdrawal open is spent on nothing, and the gateway marks it in a
  // field of its own; a row without the field reads as it always did.
  test('reads the mark a withdrawal puts on a credit, and a row without it as before', async () => {
    const list = await storeCredits(gateway(json(200, { credits: [{ ...credit, held: 'withdrawal' }, credit] })).deps)
    expect(list?.[0]?.held).toBe('withdrawal')
    expect(list?.[1]).toEqual(credit)
    expect(list?.[1]).not.toHaveProperty('held')
  })

  test('an empty list is owning nothing', async () => {
    expect(await storeCredits(gateway(json(200, { credits: [] })).deps)).toEqual([])
  })

  test('retries a 503 like a confirmation', async () => {
    const g = gateway(json(503, { error: 'store_unavailable' }), json(200, { credits: [credit] }))
    expect(await storeCredits(g.deps)).toEqual([credit])
    expect(g.slept).toEqual([2_000])
  })

  test.each<[string, Answer]>([
    ['an edge page', html(502)],
    ['a 429', json(429, { error: 'too many requests' })],
    ['a body with no list', json(200, { credit })],
    ['a row that does not read', json(200, { credits: [credit, { ...credit, grantedAt: 'yesterday' }] })],
    // The id is what tells a register that landed from an earlier spend on the same name.
    ['a row without its id', json(200, { credits: [credit, { ...credit, id: undefined }] })],
    ['a row with an empty id', json(200, { credits: [credit, { ...credit, id: '' }] })],
  ])('%s is no answer, never an empty list', async (_label, answer) => {
    expect(await storeCredits(gateway(answer).deps)).toBeNull()
  })
})

describe('recording a spend intent', () => {
  const recorded = json(200, { recorded: true, username: 'alice', expiresAt: 1_800_000_600 })

  test('signs the name for this host and reads when the intent lapses', async () => {
    const g = gateway(recorded)
    expect(await recordSpendIntent(g.deps, 'alice')).toEqual({ kind: 'recorded', expiresAt: 1_800_000_600 })
    expect(g.calls).toEqual([
      {
        url: `https://${DOMAIN}/api/store/spend`,
        body: { host: DOMAIN, username: 'alice', pubkey: PUBKEY, signature: 'sig-1', timestamp: 1_800_000_000 },
      },
    ])
    expect(g.signed).toEqual([storeSpendMessage(DOMAIN, PUBKEY, 'alice', 1_800_000_000)])
  })

  test.each([
    [400, 'missing_fields'],
    [400, 'invalid_pubkey'],
    [400, 'malformed username'],
    [401, 'invalid_signature'],
    [429, 'too many requests'],
  ])('a %p %p is the gateway refusing, with its reason', async (status, code) => {
    const g = gateway(json(status, { error: code }))
    expect(await recordSpendIntent(g.deps, 'alice')).toEqual({ kind: 'refused', status, code })
  })

  test('a 409 deleted is a refusal, never a retry, and the deletion is noted for this key', async () => {
    const heard = jest.fn()
    const stop = onGatewayDeleted(heard)
    // Subscribing hands over refusals noted before it, from earlier cases.
    heard.mockClear()
    try {
      const g = gateway(json(409, { error: 'deleted' }))
      expect(await recordSpendIntent(g.deps, 'alice')).toEqual({ kind: 'refused', status: 409, code: 'deleted' })
      expect(heard).toHaveBeenCalledWith(PUBKEY)
    } finally {
      stop()
    }
  })

  test.each<[string, Answer]>([
    ['an intent recorded for another name', json(200, { recorded: true, username: 'bob', expiresAt: 1_800_000_600 })],
    ['a 200 that records nothing', json(200, { recorded: false, username: 'alice', expiresAt: 1_800_000_600 })],
    ['a 200 that does not say it recorded', json(200, { username: 'alice', expiresAt: 1_800_000_600 })],
    ['a 200 with no lapse', json(200, { recorded: true, username: 'alice' })],
    ['its 503', json(503, { error: 'store_unavailable' })],
    ['an unknown host', json(404, { error: 'unknown domain' })],
    ['a code this build does not know', json(409, { error: 'name_pending' })],
    ['a known code under another status', json(403, { error: 'invalid_signature' })],
    ['an edge 403', html(403)],
    ['an edge page', html(502)],
    ['a network failure', 'network'],
  ])('%s is a retry with no wait, never a refusal', async (_label, answer) => {
    const g = gateway(answer)
    expect(await recordSpendIntent(g.deps, 'alice')).toEqual({ kind: 'retry' })
    expect(g.calls).toHaveLength(1)
    expect(g.slept).toEqual([])
  })

  test('a wallet that cannot sign never reaches the gateway', async () => {
    const g = gateway(recorded)
    g.deps.sign = async () => {
      throw new Error('not connected')
    }
    expect(await recordSpendIntent(g.deps, 'alice')).toEqual({ kind: 'retry' })
    expect(g.calls).toHaveLength(0)
  })
})
