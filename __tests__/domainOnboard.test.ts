import RNFS from 'react-native-fs'
import {
  claimDomain,
  factsOf,
  clearPendingPurchase,
  confirmDomain,
  forgetWalletDomainPurchase,
  loadPendingPurchase,
  normaliseDomain,
  onboardMessage,
  providerName,
  quoteDomain,
  recordName,
  recordPurchaseRefusal,
  savePendingPurchase,
  type OnboardDeps,
} from '../src/wallet/domainOnboard'

// The store keys by the active wallet, so the tests that care which wallet is paying drive it.
const mockActive = { id: 'primary' as string | null }
jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => mockActive.id),
}))

const OWNER = `02${'a'.repeat(64)}`
const HOST = 'pay.bakery.com.br'

function deps(over: Partial<OnboardDeps> = {}): OnboardDeps & { sent: string[]; signed: string[] } {
  const sent: string[] = []
  const signed: string[] = []
  return {
    sent,
    signed,
    gatewayUrl: 'https://lnurl.usevoltz.app/',
    ownerPubkey: OWNER,
    sign: async message => {
      signed.push(message)
      return 'deadbeef'
    },
    now: () => 1_700_000_000_000,
    request: (async (url: string, init: RequestInit) => {
      sent.push(`${url}|${String(init.body)}`)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          host: HOST,
          provider: 'hostinger',
          state: 'awaiting_dns',
          target: 'saas.usevoltz.app',
        }),
      } as unknown as Response
    }) as unknown as typeof fetch,
    ...over,
  }
}

it('pins the host inside the signature, so one signature cannot claim another domain', () => {
  expect(onboardMessage(HOST, OWNER, 1700).split('\n')).toEqual([
    'voltz-onboard:v1',
    'claim',
    HOST,
    OWNER,
    '1700',
  ])
  expect(onboardMessage(HOST, OWNER, 1700)).not.toEqual(onboardMessage('other.com', OWNER, 1700))
})

it('reads a domain out of whatever was pasted, and refuses what is not one', () => {
  expect(normaliseDomain('  https://Bakery.com.br/prices ')).toBe('bakery.com.br')
  for (const junk of [
    '',
    'not a domain',
    'localhost',
    '1.2.3.4',
    '1.2.3.44',
    '200.160.2.3',
    '-bakery.com.br',
    'a..b.com',
  ]) {
    expect(normaliseDomain(junk)).toBeNull()
  }
})

it('gives the record the name the provider panel expects', () => {
  // A subdomain takes only its own label, since the panel appends the rest; the root takes the
  // marker every provider uses for it.
  expect(recordName('pay.bakery.com.br', false)).toBe('pay')
  expect(recordName('bakery.com.br', true)).toBe('@')
})

it('names the provider as the provider writes it', () => {
  expect(providerName('registrobr')).toBe('Registro.br')
  expect(providerName('cloudflare')).toBe('Cloudflare')
  // Unknown has no name, and the instructions read without one.
  expect(providerName('generic')).toBe('')
})

it('sends the claim to the routed prefix, signed', async () => {
  const d = deps()
  const status = await claimDomain(d, HOST)
  const [url, body] = d.sent[0]!.split('|')
  expect(url).toBe('https://lnurl.usevoltz.app/api/domain/claim')
  expect(JSON.parse(body!)).toMatchObject({ host: HOST, ownerPubkey: OWNER })
  expect(d.signed[0]).toBe(onboardMessage(HOST, OWNER, 1_700_000_000))
  expect(status.state).toBe('awaiting_dns')
})

it('surfaces the gateway reason rather than a bare failure', async () => {
  const d = deps({
    request: (async () =>
      ({
        ok: false,
        status: 402,
        json: async () => ({ error: 'domain_tier_not_paid' }),
      } as unknown as Response)) as unknown as typeof fetch,
  })
  await expect(claimDomain(d, HOST)).rejects.toThrow('domain_tier_not_paid')
})

it('signs the quote with the same statement, so the payer is the future owner', async () => {
  const d = deps({
    request: (async (url: string, init: RequestInit) => {
      d.sent.push(`${url}|${String(init.body)}`)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          host: HOST,
          priceUsdCents: 9990,
          days: 365,
          amountSats: 199800,
          invoice: 'lnbc1',
          reference: 'ref-1',
        }),
      } as unknown as Response
    }) as unknown as typeof fetch,
  })
  const quote = await quoteDomain(d, HOST)
  expect(quote.amountSats).toBe(199800)
  expect(d.signed[0]).toBe(onboardMessage(HOST, OWNER, 1_700_000_000))
  expect(d.sent[0]!.split('|')[0]).toBe('https://lnurl.usevoltz.app/api/domain/quote')
})

it('treats an unpaid confirmation as still waiting, not as a failure', async () => {
  // The screen keeps polling; throwing here would show an error for the ordinary case of a payment
  // that has not settled yet.
  const d = deps({
    request: (async () =>
      ({
        ok: false,
        status: 402,
        json: async () => ({ paid: false }),
      } as unknown as Response)) as unknown as typeof fetch,
  })
  expect(await confirmDomain(d, HOST, 'ref-1')).toBeNull()
})

it('reports a settled payment, with the year it bought and whether the domain was off', async () => {
  const d = deps({
    request: (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          paid: true,
          entitled: true,
          days: 365,
          expiresAt: 1_800_000_000,
          frozen: true,
        }),
      } as unknown as Response)) as unknown as typeof fetch,
  })
  expect(await confirmDomain(d, HOST, 'ref-1')).toEqual({ expiresAt: 1_800_000_000, frozen: true })
})

// A year's paid refusal carries `final` the way a name's does, so a gateway that sends it reaches the
// screens, and one that sends none leaves it absent rather than guessed.
it('carries final beside a paid refusal of the year, and only when it is sent', async () => {
  const refusing = (body: unknown) =>
    deps({
      request: (async () =>
        ({ ok: false, status: 409, json: async () => body } as unknown as Response)) as unknown as typeof fetch,
    })
  const refused = { paid: true, entitled: false, days: 365, error: 'paid_but_not_granted' }
  await expect(confirmDomain(refusing({ ...refused, final: false }), HOST, 'ref-1')).rejects.toMatchObject({
    message: 'paid_but_not_granted',
    final: false,
  })
  const plain = await confirmDomain(refusing(refused), HOST, 'ref-1').catch((e: unknown) => e)
  expect(plain).toMatchObject({ message: 'paid_but_not_granted' })
  expect((plain as { final?: unknown }).final).toBeUndefined()
})

// The year is granted before this reply exists, so a body that cannot be read must never look like
// a purchase that did not happen. The two fields only choose which words the screen shows.
it('still reports the purchase when the reply body cannot be read', async () => {
  const d = deps({
    request: (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('unexpected end of JSON input')
        },
      } as unknown as Response)) as unknown as typeof fetch,
  })
  expect(await confirmDomain(d, HOST, 'ref-1')).toEqual({ expiresAt: null, frozen: false })
})

// The product is international, so a domain in a non-Latin script has to reach the gateway, which
// is the only side that can convert it to punycode.
describe('normaliseDomain accepts any script', () => {
  it('keeps an internationalised domain instead of refusing it', () => {
    expect(normaliseDomain('bakery.рф')).toBe('bakery.рф')
    expect(normaliseDomain('商店.中国')).toBe('商店.中国')
    expect(normaliseDomain('متجر.مصر')).toBe('متجر.مصر')
    expect(normaliseDomain('https://Bakery.РФ/prices')).toBe('bakery.рф')
  })

  it('still turns away what is not a domain', () => {
    for (const notADomain of [
      '',
      'bakery',
      'bakery .com.br',
      'pad@ria.com.br',
      '1.2.3.4',
      'a.b',
      'x..y',
      '-a.com',
      'a-.com',
    ]) {
      expect(normaliseDomain(notADomain)).toBeNull()
    }
  })
})

describe('the proof of a payment', () => {
  const first = { host: HOST, reference: 'ref-1', amountSats: 199800 }

  beforeEach(async () => {
    for (const id of ['wallet-a', 'wallet-b', 'primary']) {
      mockActive.id = id
      await forgetWalletDomainPurchase(id)
    }
    mockActive.id = 'primary'
  })

  // One file holds the buyer's only reference. A write for a different payment puts itself where
  // the first one's proof was, and the money that already left can no longer be pointed at
  // anything, which is why the answer is the purchase that is actually on disk and not silence.
  it('refuses to write over a payment that is still owed, and says which one won', async () => {
    expect(await savePendingPurchase(first)).toEqual(first)

    const second = { host: 'pay.other.com.br', reference: 'ref-2', amountSats: 1 }
    expect(await savePendingPurchase(second)).toEqual(first)
    expect(await loadPendingPurchase()).toEqual(first)
  })

  // Retrying one invoice is one payment. Refusing it would leave the caller reading a refusal for
  // the very purchase it is making.
  it('writes through when the reference is the one already held', async () => {
    await savePendingPurchase(first)
    const retry = { ...first, amountSats: 199801 }

    expect(await savePendingPurchase(retry)).toEqual(retry)
    expect(await loadPendingPurchase()).toEqual(retry)
  })

  // A record written before the send was dispatched stands for no payment. Answered as a proof it
  // would hide every price behind a wait on a charge the gateway never took, and refuse the next
  // purchase on behalf of money nobody spent.
  it('reads a record that stands for no payment as no record at all', async () => {
    await savePendingPurchase({ ...first, unpaid: true })
    expect(await loadPendingPurchase()).toBeNull()

    const second = { host: 'pay.other.com.br', reference: 'ref-2', amountSats: 1 }
    expect(await savePendingPurchase(second)).toEqual(second)
    expect(await loadPendingPurchase()).toEqual(second)
  })

  // What the payer does between preparing a send and dispatching it. The write replaces the record
  // rather than merging into it, or the flag outlives the send and the proof of a real payment reads
  // as nothing on the next open.
  it('answers with the purchase again once it is promoted past the send', async () => {
    await savePendingPurchase({ ...first, unpaid: true })

    expect(await savePendingPurchase(first)).toEqual(first)
    expect(await loadPendingPurchase()).toEqual(first)
  })

  // The slot can change hands between writing a proof and dropping it: the recovery sweep files one
  // for any charge the gateway says this wallet is owed. A purchase that gave up must give up its
  // own record and no other, or a send that never left deletes the proof of one that did.
  it('gives up its own record and leaves a payment that took the slot', async () => {
    await savePendingPurchase({ ...first, unpaid: true })
    const landed = { host: 'pay.other.com.br', reference: 'ref-9', amountSats: 199800 }
    expect(await savePendingPurchase(landed)).toEqual(landed)

    await clearPendingPurchase(first.reference)
    expect(await loadPendingPurchase()).toEqual(landed)

    // And its own record is still its to drop, standing for no payment or not.
    await clearPendingPurchase(landed.reference)
    expect(await loadPendingPurchase()).toBeNull()
  })

  // A clear names the payment it gives up. One naming none would drop whatever proof the record
  // holds, a paid one the recovery sweep filed included, so the signature refuses it; the type check
  // holds this, and the call never runs.
  it('takes no clear that names no payment', () => {
    const nameless = (): Promise<void> =>
      // @ts-expect-error the reference is required
      clearPendingPurchase()
    expect(nameless).toBeInstanceOf(Function)
  })

  it('takes any purchase once the last one has been finished', async () => {
    await savePendingPurchase(first)
    await clearPendingPurchase(first.reference)

    const next = { host: 'pay.other.com.br', reference: 'ref-2', amountSats: 1 }
    expect(await savePendingPurchase(next)).toEqual(next)
    expect(await loadPendingPurchase()).toEqual(next)
  })

  // The gateway ties a charge to the key that paid, so one wallet can never confirm another's
  // reference. A shared slot therefore hands the second wallet a proof it is refused on forever,
  // and the refusal to overwrite then stops it buying anything of its own.
  it("keeps one wallet out of another wallet's payment, in both directions", async () => {
    mockActive.id = 'wallet-a'
    await savePendingPurchase(first)

    mockActive.id = 'wallet-b'
    expect(await loadPendingPurchase()).toBeNull()
    const own = { host: 'pay.other.com.br', reference: 'ref-2', amountSats: 1 }
    expect(await savePendingPurchase(own)).toEqual(own)
    expect(await loadPendingPurchase()).toEqual(own)

    mockActive.id = 'wallet-a'
    expect(await loadPendingPurchase()).toEqual(first)
  })

  // Finishing one wallet's purchase must not throw away a payment another wallet is still owed.
  it('clears only the wallet that finished', async () => {
    mockActive.id = 'wallet-a'
    await savePendingPurchase(first)
    mockActive.id = 'wallet-b'
    await savePendingPurchase({ host: 'pay.other.com.br', reference: 'ref-2', amountSats: 1 })

    await clearPendingPurchase('ref-2')
    expect(await loadPendingPurchase()).toBeNull()

    mockActive.id = 'wallet-a'
    expect(await loadPendingPurchase()).toEqual(first)
  })

  // A record written before the store was keyed no longer names its payer. Dropping it would strand
  // the only proof of a payment that was made, so it is answered to whoever asks and never rewritten.
  it('still answers a record left by the unkeyed store', async () => {
    await RNFS.writeFile(
      `${RNFS.DocumentDirectoryPath}/domain-purchase.json`,
      JSON.stringify(first),
      'utf8',
    )
    mockActive.id = 'wallet-b'
    expect(await loadPendingPurchase()).toEqual(first)
  })

  // The gateway's last paid refusal is kept on the proof it is about, so a screen that cannot reach
  // the gateway after a restart still says what it said. It is a mark on that one record and
  // nothing more, since the record is the buyer's only pointer at money that already left.
  describe('a paid refusal kept with it', () => {
    const kept = { ...first, refusedForGood: true }

    it('marks the record with that reference and takes the mark back, changing nothing else', async () => {
      await savePendingPurchase(first)
      await recordPurchaseRefusal('ref-1', true)
      expect(await loadPendingPurchase()).toEqual(kept)

      await recordPurchaseRefusal('ref-1', false)
      const held = await loadPendingPurchase()
      expect(held).toEqual(first)
      expect(held).not.toHaveProperty('refusedForGood')
    })

    it('touches no other payment and invents none', async () => {
      await recordPurchaseRefusal('ref-1', true)
      expect(await RNFS.exists(`${RNFS.DocumentDirectoryPath}/domain-purchase.json`)).toBe(false)

      const other = { host: 'pay.other.com.br', reference: 'ref-2', amountSats: 1 }
      await savePendingPurchase(other)
      await recordPurchaseRefusal('ref-1', true)
      expect(await loadPendingPurchase()).toEqual(other)
    })

    it("leaves another wallet's record alone", async () => {
      mockActive.id = 'wallet-a'
      await savePendingPurchase(first)
      mockActive.id = 'wallet-b'
      await recordPurchaseRefusal('ref-1', true)
      expect(await loadPendingPurchase()).toBeNull()
      mockActive.id = 'wallet-a'
      expect(await loadPendingPurchase()).toEqual(first)
    })

    // Writing the same reference again is a retry of one invoice or the recovery filing a charge it
    // was told about, and neither is an answer about the payment.
    it('survives the same reference being written again', async () => {
      await savePendingPurchase(first)
      await recordPurchaseRefusal('ref-1', true)
      expect(await savePendingPurchase(first)).toEqual(kept)
      expect(await loadPendingPurchase()).toEqual(kept)
    })

    it('never turns a paid record into one that stands for no payment', async () => {
      await savePendingPurchase(first)
      await recordPurchaseRefusal('ref-1', true)
      await recordPurchaseRefusal('ref-1', false)
      const raw = JSON.parse(await RNFS.readFile(`${RNFS.DocumentDirectoryPath}/domain-purchase.json`, 'utf8'))
      expect(raw.primary).toEqual(first)
    })

    // A record from before the store was keyed is the whole file, and the mark goes on it, where
    // the next read finds it.
    it('marks the unkeyed record', async () => {
      const FILE = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`
      await RNFS.writeFile(FILE, JSON.stringify(first), 'utf8')
      await recordPurchaseRefusal('ref-1', true)
      expect(JSON.parse(await RNFS.readFile(FILE, 'utf8'))).toEqual(kept)
      expect(await loadPendingPurchase()).toEqual(kept)

      await recordPurchaseRefusal('ref-1', false)
      expect(JSON.parse(await RNFS.readFile(FILE, 'utf8'))).toEqual(first)
    })

    it('leaves an unkeyed record with another reference alone', async () => {
      const FILE = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`
      const other = { host: 'pay.other.com.br', reference: 'ref-2', amountSats: 1 }
      await RNFS.writeFile(FILE, JSON.stringify(other), 'utf8')
      await recordPurchaseRefusal('ref-1', true)
      expect(JSON.parse(await RNFS.readFile(FILE, 'utf8'))).toEqual(other)
    })

    // Every proof already on a device was written without the mark.
    it('reads a record written without the mark as never refused', async () => {
      await RNFS.writeFile(
        `${RNFS.DocumentDirectoryPath}/domain-purchase.json`,
        JSON.stringify({ primary: first }),
        'utf8',
      )
      const held = await loadPendingPurchase()
      expect(held).toEqual(first)
      expect(held?.refusedForGood).toBeUndefined()
    })
  })
})

// Every string here is written out rather than produced by the helper the app signs with. An
// expectation built by the function under test matches whatever that function returns, including a
// statement the gateway rejects, which is the only failure that matters on this route.
describe('the statement the confirmation signs', () => {
  const STAMP = 1_700_000_000
  const CONFIRM = `voltz-onboard:v1\nconfirm\n${HOST}\n${OWNER}\nref-1\n${STAMP}`
  const CLAIM = `voltz-onboard:v1\nclaim\n${HOST}\n${OWNER}\n${STAMP}`

  function granting(): OnboardDeps & { sent: string[]; signed: string[] } {
    const d = deps({
      request: (async (url: string, init: RequestInit) => {
        d.sent.push(`${url}|${String(init.body)}`)
        return {
          ok: true,
          status: 200,
          json: async () => ({ paid: true, entitled: true, days: 365, expiresAt: 1_800_000_000 }),
        } as unknown as Response
      }) as unknown as typeof fetch,
    })
    return d
  }

  // The gateway's confirmation message, field for field, is the version, the action word, the host
  // as sent, the key, the reference and the seconds. The gateway refuses anything else as an
  // invalid signature, which is a 400 on every purchase and every renewal.
  it('signs the form the gateway verifies, and sends the signature with it', async () => {
    const d = granting()

    expect(await confirmDomain(d, HOST, 'ref-1')).toEqual({
      expiresAt: 1_800_000_000,
      frozen: false,
    })

    expect(d.signed).toEqual([CONFIRM])
    const [url, body] = d.sent[0]!.split('|')
    expect(url).toBe('https://lnurl.usevoltz.app/api/domain/quote/confirm')
    expect(JSON.parse(body!)).toEqual({
      host: HOST,
      pubkey: OWNER,
      reference: 'ref-1',
      signature: 'deadbeef',
      timestamp: STAMP,
    })
  })

  // The action word is what stops a signature made to price a domain from settling a charge on it,
  // and the reference is what stops one charge settling another. The gateway has a test for each.
  it('cannot be replayed from a quote, nor from another charge', async () => {
    const d = granting()

    await confirmDomain(d, HOST, 'ref-1')
    await confirmDomain(d, HOST, 'ref-2')

    expect(d.signed[0]).not.toBe(CLAIM)
    expect(d.signed[1]).toBe(`voltz-onboard:v1\nconfirm\n${HOST}\n${OWNER}\nref-2\n${STAMP}`)
    expect(d.signed[0]).not.toBe(d.signed[1])
  })

  // The gateway verifies against the host in the payload before it is normalised, so the host that
  // is signed and the host that is sent have to be one string.
  it('signs the host it sends', async () => {
    const d = granting()

    await confirmDomain(d, 'pay.other.com.br', 'ref-1')

    expect(d.signed[0]).toBe(
      `voltz-onboard:v1\nconfirm\npay.other.com.br\n${OWNER}\nref-1\n${STAMP}`,
    )
    expect(JSON.parse(d.sent[0]!.split('|')[1]!)).toMatchObject({ host: 'pay.other.com.br' })
  })
})

it('keeps what the refusal measured, instead of flattening it to a word', async () => {
  // The gateway answers its 402 with what it learned about the domain, and that is the only moment
  // before the money where those facts exist. Reading only `error` would throw them away one line
  // after parsing them.
  const d = deps({
    request: (async () =>
      ({
        ok: false,
        status: 402,
        json: async () => ({
          error: 'domain_tier_not_paid',
          host: HOST,
          provider: 'cloudflare',
          supportsRoot: true,
          isRoot: false,
          rootOccupied: true,
        }),
      } as unknown as Response)) as unknown as typeof fetch,
  })
  const err = await claimDomain(d, HOST).catch((e: unknown) => e)
  // The message stays the bare code: three call sites compare that string and one maps it to a
  // sentence, so the facts ride alongside rather than instead.
  expect((err as Error).message).toBe('domain_tier_not_paid')
  expect(factsOf(err)).toEqual({
    provider: 'cloudflare',
    supportsRoot: true,
    isRoot: false,
    occupied: undefined,
    rootOccupied: true,
  })
})

it('reports nothing rather than false when the gateway measured nothing', async () => {
  // Absent is unmeasured, never free. A root reported free because nobody could check it is how
  // somebody buys a year on a domain that already carries their site.
  const d = deps({
    request: (async () =>
      ({
        ok: false,
        status: 402,
        json: async () => ({ error: 'domain_tier_not_paid', host: HOST }),
      } as unknown as Response)) as unknown as typeof fetch,
  })
  const err = await claimDomain(d, HOST).catch((e: unknown) => e)
  expect(factsOf(err).rootOccupied).toBeUndefined()
  expect(factsOf(err).supportsRoot).toBeUndefined()
})

it('answers with nothing when the error carried no facts at all', async () => {
  expect(factsOf(new Error('boom'))).toEqual({})
  expect(factsOf(undefined)).toEqual({})
})
