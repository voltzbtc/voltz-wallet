import RNFS from 'react-native-fs'
import {
  BOUGHT_BEFORE,
  keptAnswer,
  PAID_AGAIN,
  PAID_NOT_GRANTED,
  paidRefusal,
  refusalKey,
  releases,
} from '../src/wallet/lnRefusal'
import { confirmName } from '../src/wallet/namePurchase'
import {
  clearPendingPurchase,
  confirmDomain,
  loadPendingPurchase,
  recordPurchaseRefusal,
  releasePendingPurchase,
  savePendingPurchase,
} from '../src/wallet/domainOnboard'
import {
  clearPending,
  loadPending,
  recordRefusal,
  releasePending,
  savePending,
} from '../src/wallet/purchase'

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app' }))
jest.mock('../src/wallet/spark', () => ({
  connectedLnurlDomain: jest.fn(),
  sparkGetIdentityPubkey: async () => '02aa',
  sparkSignMessage: async () => 'sig',
  sparkPrepareSend: jest.fn(),
  sparkConfirmSend: jest.fn(),
}))
jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn(async () => 'w_a') }))

// What the gateway's answer about a paid charge says of the money, read from the answer for that
// charge alone, for a name and for a domain year alike. Only `repaid: true` says the sats came back;
// an answer without these fields reads as it always did.
describe('paidRefusal', () => {
  const answer = (message: string, fields: Record<string, unknown> = {}): Error =>
    Object.assign(new Error(message), fields)

  it.each([
    ['a final refusal given back', answer('paid_but_not_granted', { final: true, repaid: true }), 'repaid'],
    ['a year refusal given back', answer('paid_but_not_granted', { repaid: true }), 'repaid'],
    ['a final refusal with repaid false', answer('paid_but_not_granted', { final: true, repaid: false }), 'kept'],
    ['a final refusal without repaid', answer('paid_but_not_granted', { final: true }), 'kept'],
    ['a refusal with no field at all', answer('paid_but_not_granted'), 'kept'],
    ['a refusal that may still clear', answer('paid_but_not_granted', { final: false }), 'coming'],
    ['a paid-again holder answer', answer(PAID_AGAIN, { paidAgain: true }), 'paidAgain'],
    ['a paid-again holder answer, repaid false', answer(PAID_AGAIN, { paidAgain: true, repaid: false }), 'paidAgain'],
    ['a paid-again holder answer given back', answer(PAID_AGAIN, { paidAgain: true, repaid: true }), 'paidAgainRepaid'],
    ['a paid-again refusal once the name is gone', answer('paid_but_not_granted', { paidAgain: true }), 'paidAgain'],
    [
      'a paid-again refusal once the name is gone, given back',
      answer('paid_but_not_granted', { paidAgain: true, repaid: true }),
      'paidAgainRepaid',
    ],
    ['a year bought before', answer(BOUGHT_BEFORE, { final: true }), 'boughtBefore'],
  ])('reads %s', (_, err, expected) => {
    expect(paidRefusal(err)).toBe(expected)
  })

  it('answers nothing for any other code, a repaid field included', () => {
    expect(paidRefusal(answer('deleted', { repaid: true }))).toBeUndefined()
    expect(paidRefusal(answer('Network request failed'))).toBeUndefined()
    expect(paidRefusal(null)).toBeUndefined()
  })

  it('reads a proof by the answer it keeps, and a bare or unknown mark as kept', () => {
    expect(keptAnswer({})).toBeUndefined()
    expect(keptAnswer({ finalAnswer: 'repaid' })).toBeUndefined()
    expect(keptAnswer({ refusedForGood: true })).toBe('kept')
    expect(keptAnswer({ refusedForGood: true, finalAnswer: 'repaid' })).toBe('repaid')
    expect(keptAnswer({ refusedForGood: true, finalAnswer: 'constructor' })).toBe('kept')
    expect(keptAnswer({ refusedForGood: true, finalAnswer: 1 })).toBe('kept')
  })
})

function replying(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response) as unknown as typeof fetch
}

const nameDeps = (request: typeof fetch) => ({
  gatewayUrl: 'https://usevoltz.app',
  domain: 'usevoltz.app',
  pubkey: `02${'a'.repeat(64)}`,
  sign: async () => 'sig',
  request,
})

describe('confirmName', () => {
  it('answers a grant, and an older gateway with no field, as before', async () => {
    expect(await confirmName(nameDeps(replying(200, { paid: true, entitled: true })), 'alice', 'ref-1')).toBe(true)
    expect(await confirmName(nameDeps(replying(409, { paid: true, entitled: false })), 'alice', 'ref-1').catch(e => e))
      .toMatchObject({ message: 'status 409' })
  })

  // The wallet holds the name, so the gateway answers as the holder, and this payment bought nothing.
  it('throws a paid-again holder answer, carrying repaid only when the gateway says so', async () => {
    const again = await confirmName(
      nameDeps(replying(200, { paid: true, entitled: true, paidAgain: true })),
      'alice',
      'ref-1',
    ).catch((e: unknown) => e)
    expect(again).toMatchObject({ message: PAID_AGAIN, paidAgain: true, final: true })
    expect((again as { repaid?: unknown }).repaid).toBeUndefined()
    expect(paidRefusal(again)).toBe('paidAgain')

    const given = await confirmName(
      nameDeps(replying(200, { paid: true, entitled: true, paidAgain: true, repaid: true })),
      'alice',
      'ref-1',
    ).catch((e: unknown) => e)
    expect(paidRefusal(given)).toBe('paidAgainRepaid')
  })

  it('carries repaid and paidAgain beside a paid refusal', async () => {
    for (const [body, expected] of [
      [{ final: true }, 'kept'],
      [{ final: true, repaid: true }, 'repaid'],
      [{ paidAgain: true }, 'paidAgain'],
      [{ paidAgain: true, repaid: true }, 'paidAgainRepaid'],
    ] as const) {
      const err = await confirmName(
        nameDeps(replying(409, { paid: true, entitled: false, error: 'paid_but_not_granted', ...body })),
        'alice',
        'ref-1',
      ).catch((e: unknown) => e)
      expect(paidRefusal(err)).toBe(expected)
    }
  })
})

describe('confirmDomain', () => {
  const domainDeps = (request: typeof fetch) => ({
    gatewayUrl: 'https://usevoltz.app',
    ownerPubkey: `02${'a'.repeat(64)}`,
    sign: async () => 'sig',
    now: () => 1_700_000_000_000,
    request,
  })
  const refused = { paid: true, entitled: false, days: 365, error: 'paid_but_not_granted' }

  it('carries repaid beside a paid refusal only when the gateway says so', async () => {
    const plain = await confirmDomain(domainDeps(replying(409, refused)), 'pay.bakery.com.br', 'ref-1').catch(e => e)
    expect(paidRefusal(plain)).toBe('kept')
    const given = await confirmDomain(
      domainDeps(replying(409, { ...refused, repaid: true })),
      'pay.bakery.com.br',
      'ref-1',
    ).catch(e => e)
    expect(paidRefusal(given)).toBe('repaid')
  })

  it('reads a year bought before as final, and never as sats owed back', async () => {
    const err = await confirmDomain(
      domainDeps(replying(409, { paid: true, entitled: false, days: 365, error: 'bought_before', final: true })),
      'pay.bakery.com.br',
      'ref-1',
    ).catch(e => e)
    expect(paidRefusal(err)).toBe('boughtBefore')
  })
})

describe('the proof keeps the final answer', () => {
  const nameProof = { kind: 'name' as const, subject: 'alice', reference: 'ref-1', amountSats: 19800 }
  const yearProof = { host: 'pay.bakery.com.br', reference: 'ref-1', amountSats: 199800 }

  afterEach(async () => {
    await clearPending('name', 'ref-1')
    await clearPendingPurchase('ref-1')
    for (const file of ['purchases.json', 'domain-purchase.json']) {
      const path = `${RNFS.DocumentDirectoryPath}/${file}`
      if (await RNFS.exists(path)) {
        await RNFS.unlink(path)
      }
    }
  })

  it('on a name, through a write of the same reference, and drops it on a grant', async () => {
    await savePending(nameProof)
    await recordRefusal('name', 'ref-1', true, 'paidAgain')
    expect(keptAnswer((await loadPending('name'))!)).toBe('paidAgain')
    await savePending(nameProof)
    expect(keptAnswer((await loadPending('name'))!)).toBe('paidAgain')
    await recordRefusal('name', 'ref-1', true)
    expect(keptAnswer((await loadPending('name'))!)).toBe('kept')
    await recordRefusal('name', 'ref-1', true, 'repaid')
    await recordRefusal('name', 'ref-1', false)
    const granted = await loadPending('name')
    expect(keptAnswer(granted!)).toBeUndefined()
    expect(granted).not.toHaveProperty('finalAnswer')
  })

  it('on a year, through a write of the same reference, and drops it on a grant', async () => {
    await savePendingPurchase(yearProof)
    await recordPurchaseRefusal('ref-1', true)
    expect(keptAnswer((await loadPendingPurchase())!)).toBe('kept')
    await savePendingPurchase(yearProof)
    expect(keptAnswer((await loadPendingPurchase())!)).toBe('kept')
    await recordPurchaseRefusal('ref-1', false)
    const granted = await loadPendingPurchase()
    expect(keptAnswer(granted!)).toBeUndefined()
    expect(granted).not.toHaveProperty('finalAnswer')
  })
})

// An answer that owes nothing gives the slot up. Its mark alone already reads as no proof, so a
// clear that fails after it never holds back a fresh quote nor asks the gateway again, and an answer
// still owed keeps the proof as before.
describe('a proof whose answer owes nothing', () => {
  const nameProof = { kind: 'name' as const, subject: 'alice', reference: 'ref-1', amountSats: 19800 }
  const yearProof = { host: 'pay.bakery.com.br', reference: 'ref-1', amountSats: 199800 }
  const STORE = `${RNFS.DocumentDirectoryPath}/purchases.json`
  const DOMAIN_STORE = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`
  const onFile = async (file: string): Promise<boolean> =>
    (await RNFS.exists(file)) && (await RNFS.readFile(file, 'utf8')).includes('ref-1')

  afterEach(async () => {
    await clearPending('name', 'ref-1')
    await clearPendingPurchase('ref-1')
    for (const file of [STORE, DOMAIN_STORE, `${RNFS.DocumentDirectoryPath}/purchase-name.json`]) {
      if (await RNFS.exists(file)) {
        await RNFS.unlink(file)
      }
    }
  })

  // A holder's paid-again answer releases too, and nothing of any released answer stays on the
  // proof: its line lives in releasedLines.ts.
  it.each(['repaid', 'paidAgainRepaid', 'boughtBefore', 'paidAgain'] as const)(
    '%s on a name is released and leaves nothing on file',
    async answer => {
      await savePending(nameProof)
      await releasePending('name', 'ref-1', answer)
      expect(await loadPending('name')).toBeNull()
      expect(await onFile(STORE)).toBe(false)
      const fresh = { ...nameProof, reference: 'ref-2' }
      expect(await savePending(fresh)).toEqual(fresh)
    },
  )

  it.each(['repaid', 'boughtBefore'] as const)('%s on a year is released and leaves nothing on file', async answer => {
    await savePendingPurchase(yearProof)
    await releasePendingPurchase('ref-1', answer)
    expect(await loadPendingPurchase()).toBeNull()
    expect(await onFile(DOMAIN_STORE)).toBe(false)
  })

  it.each(['repaid', 'paidAgainRepaid', 'boughtBefore'] as const)(
    '%s marked and never cleared reads as no proof and gives way to a fresh quote',
    async answer => {
      await savePending(nameProof)
      await recordRefusal('name', 'ref-1', true, answer)
      expect(await loadPending('name')).toBeNull()
      const fresh = { ...nameProof, subject: 'bob', reference: 'ref-2' }
      expect(await savePending(fresh)).toEqual(fresh)
      expect((await loadPending('name'))?.reference).toBe('ref-2')

      await savePendingPurchase(yearProof)
      await recordPurchaseRefusal('ref-1', true, answer)
      expect(await loadPendingPurchase()).toBeNull()
      const freshYear = { ...yearProof, reference: 'ref-2' }
      expect(await savePendingPurchase(freshYear)).toEqual(freshYear)
    },
  )

  it('an unkeyed record marked as owing nothing reads as no proof too', async () => {
    await RNFS.writeFile(
      `${RNFS.DocumentDirectoryPath}/purchase-name.json`,
      JSON.stringify({ ...nameProof, refusedForGood: true, finalAnswer: 'repaid' }),
      'utf8',
    )
    expect(await loadPending('name')).toBeNull()
    await RNFS.writeFile(DOMAIN_STORE, JSON.stringify({ ...yearProof, refusedForGood: true, finalAnswer: 'boughtBefore' }), 'utf8')
    expect(await loadPendingPurchase()).toBeNull()
  })

  it.each(['kept', 'paidAgain'] as const)('control: %s keeps the proof and holds back another payment', async answer => {
    await savePending(nameProof)
    await recordRefusal('name', 'ref-1', true, answer)
    expect(keptAnswer((await loadPending('name'))!)).toBe(answer)
    expect((await savePending({ ...nameProof, reference: 'ref-2' })).reference).toBe('ref-1')
    await savePendingPurchase(yearProof)
    await recordPurchaseRefusal('ref-1', true, answer)
    expect((await savePendingPurchase({ ...yearProof, reference: 'ref-2' })).reference).toBe('ref-1')
  })

  it('a release names its reference and leaves a slot another purchase took meanwhile', async () => {
    for (const answer of ['repaid', 'paidAgain'] as const) {
      await savePending({ ...nameProof, reference: 'ref-2' })
      await releasePending('name', 'ref-1', answer)
      expect(await loadPending('name')).toMatchObject({ reference: 'ref-2' })
      expect(keptAnswer((await loadPending('name'))!)).toBeUndefined()
      await savePendingPurchase({ ...yearProof, reference: 'ref-2' })
      await releasePendingPurchase('ref-1', 'repaid')
      expect(await loadPendingPurchase()).toMatchObject({ reference: 'ref-2' })
      expect(keptAnswer((await loadPendingPurchase())!)).toBeUndefined()
    }
  })
})

// Which answers give the slot up at the first answer: every final one except the two owed with
// nothing delivered, `kept` and a paid-again answer whose name is gone since (a 409). A holder's
// paid-again answer (a 200, thrown as PAID_AGAIN) releases too.
describe('releases', () => {
  const holder = Object.assign(new Error(PAID_AGAIN), { paidAgain: true, final: true })
  const gone = Object.assign(new Error(PAID_NOT_GRANTED), { paidAgain: true })
  const other = new Error(PAID_NOT_GRANTED)

  it.each([
    ['repaid', other, true],
    ['paidAgainRepaid', holder, true],
    ['paidAgainRepaid', gone, true],
    ['boughtBefore', other, true],
    ['paidAgain', holder, true],
    ['paidAgain', gone, false],
    ['kept', other, false],
    ['coming', other, false],
  ] as const)('%s answered as %p releases: %p', (answer, err, expected) => {
    expect(releases(answer, err)).toBe(expected)
  })
})

// Read from the code alone, as a name's refusal is, a charge that bought what it was for before names
// the name, never a year on a domain.
it('bought_before read from the code alone is the name line', () => {
  expect(refusalKey(BOUGHT_BEFORE)).toBe('recover.boughtBeforeNameBody')
})

// Read from the code alone, a payment that bought nothing claims nothing came back and sends the buyer
// to a person, as a paid refusal read that way does, since only the whole answer says the sats were
// given back.
it('paid_again read from the code alone sends the buyer to a person and never says the sats came back', () => {
  expect(refusalKey(PAID_AGAIN)).toBe('recover.paidAgainBody')
  expect(paidRefusal(Object.assign(new Error(PAID_AGAIN), { final: true, repaid: true, paidAgain: true }))).toBe(
    'paidAgainRepaid',
  )
})
