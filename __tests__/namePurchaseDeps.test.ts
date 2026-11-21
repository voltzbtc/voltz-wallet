import { confirmName, currentDeps, nameQuoteMessage, quoteName } from '../src/wallet/namePurchase'
import { connectedLnurlDomain } from '../src/wallet/spark'

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app' }))
jest.mock('../src/wallet/spark', () => ({
  connectedLnurlDomain: jest.fn(),
  sparkGetIdentityPubkey: async () => '02aa',
  sparkSignMessage: async () => 'sig',
}))

const connected = connectedLnurlDomain as jest.Mock

// The gateway decides free or paid from the domain the request names. A wallet whose address lives
// on a domain it bought must quote against that domain, or it is charged for a name that is free
// there. The request still goes to the build's domain: the customer's own hostname is whoever holds
// it, and a frozen one reaches nobody.
it('quotes against the domain the session is on, sent to the build domain', async () => {
  connected.mockReturnValue('pay.bakery.com.br')
  const deps = await currentDeps()
  expect(deps.domain).toBe('pay.bakery.com.br')
  expect(deps.gatewayUrl).toBe('https://usevoltz.app')
})

it('names the domain in the signed body of the quote and of its confirmation', async () => {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = []
  const request = (async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ invoice: 'lnbc1', reference: 'r1', amountSats: 1, expiresAt: 1 }) }
  }) as unknown as typeof fetch
  connected.mockReturnValue('pay.bakery.com.br')
  const deps = { ...(await currentDeps()), request, now: () => 1_700_000_000_000 }
  await quoteName(deps, 'bakery').catch(() => undefined)
  await confirmName(deps, 'bakery', 'r1').catch(() => undefined)
  expect(sent.map(s => s.url)).toEqual(['https://usevoltz.app/api/quote', 'https://usevoltz.app/api/quote/confirm'])
  expect(sent.map(s => s.body.host)).toEqual(['pay.bakery.com.br', 'pay.bakery.com.br'])
})

it('falls back to the build domain before a session has one', async () => {
  connected.mockReturnValue(undefined)
  const deps = await currentDeps()
  expect(deps.domain).toBe('usevoltz.app')
  expect(deps.gatewayUrl).toBe('https://usevoltz.app')
})

// The Spark SDK refuses to sign any message in the `breez-lnurl:` namespace, which it reserves for
// requests it makes itself. Asking a wallet to sign one fails with InvalidInput before the quote is
// ever sent, so the whole purchase dies at the first step with no server involved. The quote is
// signed here rather than by the SDK, so the message carries the app's own `voltz-name:` prefix.
it('signs the quote outside the namespace the SDK refuses', () => {
  const message = nameQuoteMessage('usevoltz.app', '02aa', 'bakery', 1_700_000_000)
  expect(message.startsWith('breez-lnurl:')).toBe(false)
  expect(message.split('\n')[0]).toBe('voltz-name:v1')
})

// Byte-identical to the gateway's name quote message. A field reordered or a separator changed on
// one side turns every quote into an invalid signature.
it('matches the statement the gateway verifies', () => {
  expect(nameQuoteMessage('usevoltz.app', '02aa', 'bakery', 1_700_000_000)).toBe(
    ['voltz-name:v1', 'quote', 'usevoltz.app', '02aa', 'bakery', '1700000000'].join('\n'),
  )
})

// Each field is inside the signature, so a signature made for one name, wallet or domain cannot be
// presented for another.
it('separates quotes that differ in any single field', () => {
  const base = nameQuoteMessage('usevoltz.app', '02aa', 'bakery', 1_700_000_000)
  expect(nameQuoteMessage('other.app', '02aa', 'bakery', 1_700_000_000)).not.toBe(base)
  expect(nameQuoteMessage('usevoltz.app', '02bb', 'bakery', 1_700_000_000)).not.toBe(base)
  expect(nameQuoteMessage('usevoltz.app', '02aa', 'market', 1_700_000_000)).not.toBe(base)
  expect(nameQuoteMessage('usevoltz.app', '02aa', 'bakery', 1_700_000_001)).not.toBe(base)
})

// A refusal that clears on its own carries the second it clears beside its code, which the sheet
// reads to say when rather than that the name is taken.
describe('a quote refused', () => {
  const deps = (body: unknown) => ({
    gatewayUrl: 'https://usevoltz.app',
    domain: 'usevoltz.app',
    pubkey: '02aa',
    sign: async () => 'sig',
    request: (async () => ({ ok: false, status: 409, json: async () => body })) as unknown as typeof fetch,
  })

  it('carries the second a hold clears', async () => {
    await expect(quoteName(deps({ error: 'name_held_for_credit', retry_at: 1_800_000_120 }), 'alice')).rejects.toMatchObject({
      message: 'name_held_for_credit',
      retryAt: 1_800_000_120,
    })
  })

  it('carries no second when the gateway names none', async () => {
    const err = await quoteName(deps({ error: 'name_held_for_credit' }), 'alice').catch((e: unknown) => e)
    expect(err).toMatchObject({ message: 'name_held_for_credit' })
    expect((err as { retryAt?: unknown }).retryAt).toBeUndefined()
  })
})

// A paid confirmation the gateway cannot grant says whether a later one still may, and the refusal
// carries that beside its code for the screens to read.
describe('a paid confirmation refused', () => {
  const deps = (body: unknown) => ({
    gatewayUrl: 'https://usevoltz.app',
    domain: 'usevoltz.app',
    pubkey: '02aa',
    sign: async () => 'sig',
    request: (async () => ({ ok: false, status: 409, json: async () => body })) as unknown as typeof fetch,
  })
  const refused = { paid: true, entitled: false, error: 'paid_but_not_granted' }

  it('carries final as the gateway sends it', async () => {
    await expect(confirmName(deps({ ...refused, final: false }), 'alice', 'ref-1')).rejects.toMatchObject({
      message: 'paid_but_not_granted',
      final: false,
    })
    await expect(confirmName(deps({ ...refused, final: true }), 'alice', 'ref-1')).rejects.toMatchObject({
      message: 'paid_but_not_granted',
      final: true,
    })
  })

  it('carries no final when the gateway sends none', async () => {
    const err = await confirmName(deps(refused), 'alice', 'ref-1').catch((e: unknown) => e)
    expect(err).toMatchObject({ message: 'paid_but_not_granted' })
    expect((err as { final?: unknown }).final).toBeUndefined()
  })
})
