import {
  PAYMENT_WEBHOOK_EVENTS,
  isWebhookId,
  isWebhookSecret,
  paymentWebhookUrl,
  planWebhooks,
  type ListedWebhook,
} from '../src/wallet/webhook'

const BASE = 'https://lnurl.usevoltz.app'
const ID = 'AbCdEfGhIjKlMnOpQrStUv'
const OTHER_ID = 'ZyXwVuTsRqPoNmLkJiHgFe'
const TOKEN = 'fcm:token/with+chars='
const ALL = [...PAYMENT_WEBHOOK_EVENTS]

const hook = (id: string, url: string, events: string[] = ALL): ListedWebhook => ({ id, url, events })

describe('paymentWebhookUrl', () => {
  it('puts the gateway id under the payment route and nothing else', () => {
    expect(paymentWebhookUrl(BASE, ID)).toBe(`${BASE}/api/push/spark/${ID}`)
    expect(paymentWebhookUrl(`${BASE}//`, ID)).toBe(`${BASE}/api/push/spark/${ID}`)
  })

  it('refuses an id that could add a segment, a query or a host to the URL', () => {
    for (const bad of ['../../device', `${ID}?token=x`, `${ID}/x`, `${ID}#x`, 'short', `${ID}%2F`, '']) {
      expect(() => paymentWebhookUrl(BASE, bad)).toThrow('invalid webhook id')
    }
  })

  it('needs a base', () => {
    expect(() => paymentWebhookUrl('  ', ID)).toThrow('gateway base url is required')
  })
})

describe('format checks', () => {
  it('takes the 22 base64url characters of 16 bytes and refuses fewer', () => {
    expect(isWebhookId(ID)).toBe(true)
    expect(isWebhookId('A'.repeat(21))).toBe(false)
    expect(isWebhookId(42)).toBe(false)
  })

  it('takes a secret as 64 lowercase hex characters and nothing else', () => {
    expect(isWebhookSecret('ab'.repeat(32))).toBe(true)
    expect(isWebhookSecret('ab'.repeat(31))).toBe(false)
    expect(isWebhookSecret('AB'.repeat(32))).toBe(false)
    expect(isWebhookSecret('zz'.repeat(32))).toBe(false)
  })
})

describe('planWebhooks', () => {
  const want = `${BASE}/api/push/spark/${ID}`
  const old = `${BASE}/api/push/spark/${OTHER_ID}`

  it('registers when the provider holds nothing of this device', () => {
    expect(planWebhooks([], want, { gatewayBase: BASE })).toEqual({ keep: null, remove: [], register: true })
  })

  it('keeps the webhook the marker names at the wanted URL with the four events', () => {
    const listed = [hook('h1', want)]
    expect(planWebhooks(listed, want, { gatewayBase: BASE, marker: { id: 'h1', url: want } })).toEqual({
      keep: 'h1',
      remove: [],
      register: false,
    })
  })

  it('replaces a webhook at the wanted URL that no marker vouches for, since its secret is unknown', () => {
    // The gateway keeps a wallet's id when only the secret moves, so a webhook at the same URL can
    // carry a secret the gateway no longer has, and every notice it sends would fail there.
    const plan = planWebhooks([hook('h1', want)], want, { gatewayBase: BASE })
    expect(plan).toEqual({ keep: null, remove: ['h1'], register: true })
  })

  it('replaces the marked webhook when it lacks an event or has one too many', () => {
    const marker = { id: 'h1', url: want }
    const fewer = planWebhooks([hook('h1', want, ALL.slice(0, 2))], want, { gatewayBase: BASE, marker })
    expect(fewer).toEqual({ keep: null, remove: ['h1'], register: true })
    const extra = planWebhooks([hook('h1', want, [...ALL, 'Unknown:SparkNew'])], want, { gatewayBase: BASE, marker })
    expect(extra).toEqual({ keep: null, remove: ['h1'], register: true })
  })

  it('removes the webhook of an id the gateway replaced, by the marker', () => {
    const plan = planWebhooks([hook('h1', old)], want, { gatewayBase: BASE, marker: { id: 'h1', url: old } })
    expect(plan).toEqual({ keep: null, remove: ['h1'], register: true })
  })

  it('keeps one and removes every other copy of this device', () => {
    const marker = { id: 'h2', url: want }
    const plan = planWebhooks([hook('h1', want), hook('h2', want), hook('h3', want)], want, {
      gatewayBase: BASE,
      marker,
    })
    expect(plan).toEqual({ keep: 'h2', remove: ['h1', 'h3'], register: false })
  })

  it('leaves another device of the same wallet alone, on the same gateway', () => {
    // The provider's list is the wallet's. Removing what only looks like ours would have two devices
    // take each other's webhook away on every connect.
    const plan = planWebhooks([hook('other-device', old), hook('h1', want)], want, {
      gatewayBase: BASE,
      marker: { id: 'h1', url: want },
    })
    expect(plan).toEqual({ keep: 'h1', remove: [], register: false })
  })

  it('leaves another app on the same wallet alone', () => {
    const glow = hook('glow', 'https://notify.example.com/api/v1/notify?platform=ios&token=someone-else')
    const plan = planWebhooks([glow], want, { gatewayBase: BASE, token: TOKEN })
    expect(plan.remove).toEqual([])
  })

  it('removes the old notify route of this device, by its host or by its token', () => {
    const onGateway = hook('n1', `${BASE}/api/v1/notify?platform=android&token=abc`)
    const elsewhere = hook(
      'n2',
      `https://nds.example.com/api/v1/notify?platform=android&token=${encodeURIComponent(TOKEN)}`,
    )
    const plan = planWebhooks([onGateway, elsewhere], want, { gatewayBase: `${BASE}/`, token: TOKEN })
    expect(plan.remove).toEqual(['n1', 'n2'])
  })

  it('removes everything of this device and registers nothing when nothing is wanted', () => {
    const marker = { id: 'h1', url: want }
    const plan = planWebhooks([hook('h1', want), hook('other-device', old)], null, { gatewayBase: BASE, marker })
    expect(plan).toEqual({ keep: null, remove: ['h1'], register: false })
  })

  it('removes what the removal marker names, on any host, and leaves another device alone', () => {
    const retiring = { webhookIds: [ID], sdkIds: ['h7'], urls: ['https://own.example/hook'] }
    const listed = [
      hook('h1', `https://own-domain.example/api/push/spark/${ID}`),
      hook('h7', 'https://anywhere.example/x'),
      hook('h8', 'https://own.example/hook'),
      hook('other-device', old),
    ]
    const plan = planWebhooks(listed, null, { gatewayBase: BASE, retiring })
    expect(plan).toEqual({ keep: null, remove: ['h1', 'h7', 'h8'], register: false })
  })

  it('never keeps a retired webhook, even one the marker vouches for at the wanted URL', () => {
    // The gateway keeps an id when only the secret moves, so the URL wanted after notifications came
    // back on can be the one retired, and the webhook there was made with the secret that went.
    const marker = { id: 'h1', url: want }
    const retiring = { webhookIds: [ID], sdkIds: [], urls: [] }
    const plan = planWebhooks([hook('h1', want)], want, { gatewayBase: BASE, marker, retiring })
    expect(plan).toEqual({ keep: null, remove: ['h1'], register: true })
  })
})
