import RNFS from 'react-native-fs'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { idempotencyKeyFor,
  clearPending,
  disownPending,
  loadPending,
  payAndSettle,
  recordRefusal,
  savePending,
  settlePending,
} from '../src/wallet/purchase'
import { sparkConfirmSend, sparkPrepareSend } from '../src/wallet/spark'
import { SpendHeldByExit } from '../src/wallet/errors'

jest.mock('../src/wallet/spark', () => ({
  sparkPrepareSend: jest.fn(async () => ({ handle: 'h-1', amount: 12821, fee: 0 })),
  sparkConfirmSend: jest.fn(async () => 'complete'),
}))

// The proof belongs to the wallet that pays, so the active wallet decides where it is written.
jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn(async () => 'w_a') }))

const active = jest.mocked(getActiveWalletId)
const STORE = `${RNFS.DocumentDirectoryPath}/purchases.json`
const UNKEYED = `${RNFS.DocumentDirectoryPath}/purchase-name.json`

const purchase = {
  kind: 'name' as const,
  subject: 'bakery',
  reference: 'ref-1',
  amountSats: 12821,
}
const otherPurchase = { ...purchase, subject: 'otherbakery', reference: 'ref-2' }

async function remove(path: string): Promise<void> {
  if (await RNFS.exists(path)) {
    await RNFS.unlink(path)
  }
}

beforeEach(async () => {
  jest.clearAllMocks()
  // clearAllMocks clears calls, not implementations, so a send forced to fail in one test would
  // still be failing in the next.
  ;(jest.requireMock('../src/wallet/spark').sparkPrepareSend as jest.Mock).mockResolvedValue({
    handle: 'h-1',
    amount: 12821,
    fee: 0,
  })
  ;(jest.requireMock('../src/wallet/spark').sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
  active.mockResolvedValue('w_a')
  await remove(STORE)
  await remove(UNKEYED)
})

// Buying and receiving are two steps. Dropping the record between them leaves an entitlement that
// was paid for and that nothing in the app can reach afterwards, while the only way forward on screen
// offers to charge again.
it('keeps the proof after the payment settles, since the name is not claimed yet', async () => {
  await savePending(purchase)

  expect(await settlePending('name', async () => true)).toBe('done')
  expect(await loadPending('name')).toMatchObject({ subject: 'bakery', reference: 'ref-1' })
})

it('keeps the proof while the payment has not been seen', async () => {
  await savePending(purchase)

  expect(await settlePending('name', async () => false)).toBe('settling')
  expect(await loadPending('name')).not.toBeNull()
})

it('reads back nothing once the purchase is finished', async () => {
  await savePending(purchase)
  await clearPending('name', purchase.reference)

  expect(await loadPending('name')).toBeNull()
  expect(await RNFS.exists(STORE)).toBe(false)
})

// This app holds several wallets. One slot per kind would put every wallet's proof in the same
// place, so the sheet opened on one wallet would resume another's purchase, and paying on the
// second would write over the first's only record. Nothing in the service gives money back.
it('keeps the proof of each wallet apart', async () => {
  await savePending(purchase)

  active.mockResolvedValue('w_b')
  expect(await loadPending('name')).toBeNull()
  await savePending(otherPurchase)
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-2' })

  active.mockResolvedValue('w_a')
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-1' })
})

it('finishing one wallet leaves the proof of the other where it was', async () => {
  await savePending(purchase)
  active.mockResolvedValue('w_b')
  await savePending(otherPurchase)

  await clearPending('name', otherPurchase.reference)
  expect(await loadPending('name')).toBeNull()

  active.mockResolvedValue('w_a')
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-1' })
})

// A bare write would let a second purchase erase the reference of a first that is still owed.
it('refuses to write over a payment still owed, and says what is owed', async () => {
  expect(await savePending(purchase)).toMatchObject({ reference: 'ref-1' })

  expect(await savePending(otherPurchase)).toMatchObject({ subject: 'bakery', reference: 'ref-1' })
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-1' })
})

// Retrying one invoice is not a second payment, so the same reference goes through.
it('writes the same purchase through', async () => {
  await savePending(purchase)

  expect(await savePending({ ...purchase, amountSats: 13000 })).toMatchObject({ amountSats: 13000 })
  expect(await loadPending('name')).toMatchObject({ amountSats: 13000 })
})

// The refusal is worth nothing if paying goes ahead anyway: the send would take a second amount for
// a name the wallet has already bought, with no way to give either back.
it('sends nothing while another payment is owed, and hands back the one that is', async () => {
  await savePending(purchase)

  const result = await payAndSettle(otherPurchase, 'lnbc1', async () => true)

  expect(result).toEqual({ outcome: 'owed', owed: expect.objectContaining({ reference: 'ref-1' }) })
  expect(sparkPrepareSend).not.toHaveBeenCalled()
  expect(sparkConfirmSend).not.toHaveBeenCalled()
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-1' })
})

// Written before the store was keyed by wallet, so it says nothing about whose payment it is. It is
// read rather than ignored, since ignoring it strands a payment that was really made.
it('finds a proof left at the unkeyed path', async () => {
  await RNFS.writeFile(UNKEYED, JSON.stringify({ ...purchase, reference: 'ref-old' }), 'utf8')

  expect(await loadPending('name')).toMatchObject({ subject: 'bakery', reference: 'ref-old' })
})

// Which wallet paid cannot be told from disk. Adopting it for one would bury the payment under a
// wallet that can never confirm it, so every wallet is shown it until the one that paid finishes it.
it('offers the unkeyed proof to every wallet, and refuses to sell over it', async () => {
  await RNFS.writeFile(UNKEYED, JSON.stringify({ ...purchase, reference: 'ref-old' }), 'utf8')

  active.mockResolvedValue('w_b')
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-old' })
  expect(await savePending(otherPurchase)).toMatchObject({ reference: 'ref-old' })
})

// The wallet that owns the unkeyed purchase reaches it through the same calls as any other, so
// retrying it writes a copy under that wallet and the sheet reads its own record from then on.
it('writes the unkeyed purchase through under the wallet that retries it', async () => {
  await RNFS.writeFile(UNKEYED, JSON.stringify({ ...purchase, reference: 'ref-old' }), 'utf8')

  expect(await savePending({ ...purchase, reference: 'ref-old' })).toMatchObject({ reference: 'ref-old' })

  expect(JSON.parse(await RNFS.readFile(STORE, 'utf8'))).toEqual({
    w_a: { name: { ...purchase, reference: 'ref-old' } },
  })
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-old' })
})

// A clear names the payment it gives up. One naming none would drop whatever proof the slot holds, a
// paid one the recovery sweep filed included, so the signature refuses it; the type check holds this,
// and the call never runs.
it('takes no clear that names no payment', () => {
  const nameless = (): Promise<void> =>
    // @ts-expect-error the reference is required
    clearPending('name')
  expect(nameless).toBeInstanceOf(Function)
})

// Clearing happens on paths where nothing was paid too, so a clear that names another payment must
// not take the one record whose owner is unknown.
it('leaves the unkeyed proof alone when the clear names another payment', async () => {
  await RNFS.writeFile(UNKEYED, JSON.stringify({ ...purchase, reference: 'ref-old' }), 'utf8')

  await clearPending('name', 'ref-1')

  expect(await RNFS.exists(UNKEYED)).toBe(true)
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-old' })
})

// Retired only by the purchase it holds, which is proof enough that the wallet finishing it is the
// one that paid: no other wallet can get a confirmation for that reference.
it('retires the unkeyed proof once its own purchase is finished', async () => {
  await RNFS.writeFile(UNKEYED, JSON.stringify({ ...purchase, reference: 'ref-old' }), 'utf8')

  await clearPending('name', 'ref-old')

  expect(await RNFS.exists(UNKEYED)).toBe(false)
  expect(await loadPending('name')).toBeNull()
})

// A different payment finishing says nothing about the unkeyed one.
it('keeps the unkeyed proof when the clear names another payment', async () => {
  await RNFS.writeFile(UNKEYED, JSON.stringify({ ...purchase, reference: 'ref-old' }), 'utf8')

  await clearPending('name', 'ref-2')

  expect(await RNFS.exists(UNKEYED)).toBe(true)
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-old' })
})

// The treasury delivers on its invoice settling, so a charge never takes the Spark route.
it('pays a charge with no route of its own, only the name that keeps it once', async () => {
  await payAndSettle(purchase, 'lnbc1', async () => true)

  expect(sparkConfirmSend).toHaveBeenCalledWith('h-1', undefined, idempotencyKeyFor(purchase.reference))
})

// A send that never left, for want of balance or a refused invoice, leaves a proof of a payment that
// did not happen. Kept, it answers every later purchase with a refusal and a wait that never ends.
it('drops the proof when the send was never attempted', async () => {
  jest.mocked(sparkPrepareSend).mockRejectedValue(new Error('insufficient funds'))

  await expect(payAndSettle(purchase, 'lnbc1', async () => true)).rejects.toThrow('insufficient funds')

  expect(sparkConfirmSend).not.toHaveBeenCalled()
  expect(await loadPending('name')).toBeNull()
  // Read off disk rather than through the reader, which answers null for a record standing for no
  // payment whether it was dropped or left where it was. A clear that never lets go passes the line
  // above, so only the file says whether the proof was given up.
  expect(await RNFS.exists(STORE)).toBe(false)
})

// Once a send is under way, a throw says nothing about whether the money went, so the proof stays.
it('keeps the proof when the send is under way and something throws', async () => {
  jest.mocked(sparkConfirmSend).mockRejectedValue(new Error('SdkError.NetworkError'))

  await expect(payAndSettle(purchase, 'lnbc1', async () => true)).rejects.toThrow('SdkError.NetworkError')

  expect(await loadPending('name')).toMatchObject({ reference: 'ref-1' })
})

// An exit's hold refuses in spark.ts before the SDK is called, so that one throw is knowably unpaid and
// the proof goes: kept, it would tell the buyer a payment is on its way that never left.
it.each(['exit', 'unread'] as const)('drops the proof when an exit holds the send (%s)', async hold => {
  jest.mocked(sparkConfirmSend).mockRejectedValue(new SpendHeldByExit(hold))

  await expect(payAndSettle(purchase, 'lnbc1', async () => true)).rejects.toBeInstanceOf(SpendHeldByExit)

  expect(await loadPending('name')).toBeNull()
  expect(await RNFS.exists(STORE)).toBe(false)
})


// The press names the wallet it started on, and a switch while the send is out moves the registry to
// another wallet holding a proof of its own. Every write of the pay goes to the press's wallet: the
// record before the send, its promotion, and the clear after a send that never left or failed.
describe('a pay for the wallet its press started on, after a switch', () => {
  const B_PROOF = { ...purchase, subject: 'bob', reference: 'ref-b' }
  const raw = async (walletId: string): Promise<unknown> =>
    (JSON.parse(await RNFS.readFile(STORE, 'utf8')) as Record<string, { name?: unknown }>)[walletId]?.name

  beforeEach(async () => {
    await savePending(B_PROOF, 'w_b')
    active.mockResolvedValue('w_b')
  })

  it('files and promotes the proof on that wallet', async () => {
    let atDispatch: unknown = 'never asked'
    jest.mocked(sparkConfirmSend).mockImplementation(async () => {
      atDispatch = await loadPending('name', 'w_a')
      return 'complete'
    })
    expect(await payAndSettle(purchase, 'lnbc1', async () => false, 'w_a')).toEqual({ outcome: 'settling' })
    expect(atDispatch).toEqual(purchase)
    expect(await loadPending('name', 'w_a')).toEqual(purchase)
    expect(await loadPending('name', 'w_b')).toEqual(B_PROOF)
  })

  it('drops its record there when the send was never attempted', async () => {
    jest.mocked(sparkPrepareSend).mockRejectedValue(new Error('insufficient funds'))
    await expect(payAndSettle(purchase, 'lnbc1', async () => true, 'w_a')).rejects.toThrow('insufficient funds')
    expect(await raw('w_a')).toBeUndefined()
    expect(await loadPending('name', 'w_b')).toEqual(B_PROOF)
  })

  it('drops its promoted proof there when the send failed', async () => {
    jest.mocked(sparkConfirmSend).mockResolvedValue('failed')
    expect(await payAndSettle(purchase, 'lnbc1', async () => true, 'w_a')).toEqual({ outcome: 'failed' })
    expect(await raw('w_a')).toBeUndefined()
    expect(await loadPending('name', 'w_b')).toEqual(B_PROOF)
  })
})

// The record is written before the money moves so a crash mid send is recoverable, which means a
// crash before the send leaves one too. Read back as a payment it says the buyer paid when nothing
// left, and every later purchase is refused in favour of a wait that never ends.
it('does not read back a record written before the send was dispatched as a payment', async () => {
  let atPrepare: unknown = 'never asked'
  let atDispatch: unknown = 'never asked'
  ;(jest.requireMock('../src/wallet/spark').sparkPrepareSend as jest.Mock).mockImplementation(async () => {
    atPrepare = await loadPending('name')
    return { handle: 'h-1', amount: 12821, fee: 0 }
  })
  ;(jest.requireMock('../src/wallet/spark').sparkConfirmSend as jest.Mock).mockImplementation(async () => {
    atDispatch = await loadPending('name')
    return 'complete'
  })

  await payAndSettle(purchase, 'lnbc1', async () => true)

  // Preparing moves nothing, so a kill up to here must leave no payment to wait for.
  expect(atPrepare).toBeNull()
  // From the dispatch on, whether the money went is unknowable, so the record counts as one.
  expect(atDispatch).toMatchObject({ reference: 'ref-1' })
})

it('sells again over a record left by a kill before the send', async () => {
  await RNFS.writeFile(STORE, JSON.stringify({ w_a: { name: { ...purchase, unpaid: true } } }), 'utf8')

  expect(await loadPending('name')).toBeNull()
  expect(await payAndSettle(otherPurchase, 'lnbc2', async () => true)).toEqual({ outcome: 'done' })
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-2' })
})

// The unkeyed record is offered to every wallet because nothing on disk says whose it is. A wallet
// the gateway has refused cannot finish it and would be handed it again on every open, unable to buy
// a name of its own, so the refusal releases that wallet and leaves the record for whoever paid.
it('releases a wallet the gateway disowns, and keeps the record for whoever paid', async () => {
  await RNFS.writeFile(UNKEYED, JSON.stringify({ ...purchase, reference: 'ref-old' }), 'utf8')
  active.mockResolvedValue('w_b')

  expect(await disownPending('name', 'ref-old')).toBe(true)
  expect(await loadPending('name')).toBeNull()
  expect(await savePending(otherPurchase)).toMatchObject({ reference: 'ref-2' })
  expect(await RNFS.exists(UNKEYED)).toBe(true)

  active.mockResolvedValue('w_a')
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-old' })
})

// The gateway also refuses a reference whose domain has moved on since it was paid, and that refusal
// says nothing about who paid. A wallet's own record is the only proof of its own payment, and the
// wallet that owns the unkeyed one and has retried it holds a copy under its own key.
it('leaves a wallet its own record, whatever the gateway says of it', async () => {
  await RNFS.writeFile(UNKEYED, JSON.stringify({ ...purchase, reference: 'ref-old' }), 'utf8')
  await savePending({ ...purchase, reference: 'ref-old' })

  expect(await disownPending('name', 'ref-old')).toBe(false)
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-old' })
})

it('releases nothing when the refusal names another payment', async () => {
  await RNFS.writeFile(UNKEYED, JSON.stringify({ ...purchase, reference: 'ref-old' }), 'utf8')

  expect(await disownPending('name', 'ref-2')).toBe(false)
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-old' })
})


// Preparing an invoice is a round trip, and the slot can be taken while it is in flight. Sending
// then takes a second amount against a record that no longer names this purchase.
it('sends nothing when the slot is taken while the invoice is being prepared', async () => {
  ;(jest.requireMock('../src/wallet/spark').sparkPrepareSend as jest.Mock).mockImplementation(async () => {
    await savePending(otherPurchase)
    return { handle: 'h-1', amount: 12821, fee: 0 }
  })

  const result = await payAndSettle(purchase, 'lnbc1', async () => true)

  expect(result).toEqual({ outcome: 'owed', owed: expect.objectContaining({ reference: 'ref-2' }) })
  expect(sparkConfirmSend).not.toHaveBeenCalled()
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-2' })
})

// The slot is not private to this flow: recover.ts files a proof into it for any charge the gateway
// says this wallet is owed, and Home starts that sweep on focus. Preparing a send is a round trip,
// so a sweep can land inside one. A clear that drops whatever the slot holds then deletes the only
// thing on the device pointing at money that already left, and nothing in the service gives it
// back.
it('leaves a payment that took the slot while the send was being prepared', async () => {
  const swept = { kind: 'name' as const, subject: 'otherbakery', reference: 'ref-swept', amountSats: 30000 }
  ;(jest.requireMock('../src/wallet/spark').sparkPrepareSend as jest.Mock).mockImplementation(async () => {
    // This is what the sweep does, displacing the record standing for no payment with a real one.
    await savePending(swept)
    throw new Error('insufficient funds')
  })

  await expect(payAndSettle(purchase, 'lnbc1', async () => true)).rejects.toThrow('insufficient funds')

  expect(sparkConfirmSend).not.toHaveBeenCalled()
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-swept' })
})

// Past the dispatch the slot can hold a record this send never wrote. 'failed' says nothing was
// charged on this send, never that whatever holds the slot now was unpaid. The write is direct
// because savePending refuses to displace a proof, so only a writer outside this flow gets there.
it('leaves a record it never wrote when the send fails', async () => {
  const swept = { ...purchase, subject: 'otherbakery', reference: 'ref-swept', amountSats: 30000 }
  ;(jest.requireMock('../src/wallet/spark').sparkConfirmSend as jest.Mock).mockImplementation(async () => {
    await RNFS.writeFile(STORE, JSON.stringify({ w_a: { name: swept } }), 'utf8')
    return 'failed'
  })

  expect(await payAndSettle(purchase, 'lnbc1', async () => true)).toEqual({ outcome: 'failed' })
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-swept' })
})

// The reference is the whole guard, so it has to be read against what the slot holds and not against
// the caller's word for it.
it('drops nothing when the clear names a payment the slot does not hold', async () => {
  await savePending(purchase)

  await clearPending('name', 'ref-2')
  expect(await loadPending('name')).toMatchObject({ reference: 'ref-1' })

  await clearPending('name', 'ref-1')
  expect(await loadPending('name')).toBeNull()
})

// The guard reads the slot as it stands on disk. Read through loadPending it would answer with the
// unkeyed record whenever this wallet's own stands for no payment, and refuse to drop a record that
// is this purchase's own to drop, which is the whole of the abandoned-send path.
it('drops its own record standing for no payment, past an unkeyed one naming another charge', async () => {
  await RNFS.writeFile(UNKEYED, JSON.stringify({ ...purchase, reference: 'ref-old' }), 'utf8')
  await RNFS.writeFile(STORE, JSON.stringify({ w_a: { name: { ...purchase, unpaid: true } } }), 'utf8')

  await clearPending('name', 'ref-1')

  expect(await RNFS.exists(STORE)).toBe(false)
  expect(await RNFS.exists(UNKEYED)).toBe(true)
})

// The guard reads the slot as it stands on disk. Through loadPending a record standing for no
// payment reads as no record at all, so the reference would go unread and this clear would drop a
// record another purchase had just written there, leaving that send with nothing to recover from.
it('reads the slot as it stands, so a record standing for no payment still belongs to somebody', async () => {
  await RNFS.writeFile(STORE, JSON.stringify({ w_a: { name: { ...otherPurchase, unpaid: true } } }), 'utf8')

  await clearPending('name', 'ref-1')
  expect(JSON.parse(await RNFS.readFile(STORE, 'utf8'))).toMatchObject({
    w_a: { name: { reference: 'ref-2' } },
  })

  // And a record of its own is still its to drop, standing for no payment or not.
  await clearPending('name', 'ref-2')
  expect(await RNFS.exists(STORE)).toBe(false)
})

describe('the idempotency key a charge-paying send carries', () => {
  // The SDK returns the first payment when a key is re-used, and documents that the key must be a
  // valid UUID (breez_sdk_spark.d.ts). A charge reference is a payment hash, 64 hex characters, so
  // it is reshaped rather than invented: one charge always produces one key, on this device and on
  // any other that restores the same seed.
  const HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'

  it('turns a payment hash into a well formed v4, and does it the same way every time', () => {
    const key = idempotencyKeyFor(HASH)
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(idempotencyKeyFor(HASH)).toBe(key)
    // The same charge read back in a different case is the same charge.
    expect(idempotencyKeyFor(HASH.toUpperCase())).toBe(key)
  })

  it('two different charges never share a key', () => {
    const other = '5f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
    expect(idempotencyKeyFor(other)).not.toBe(idempotencyKeyFor(HASH))
  })

  it('refuses anything that is not hash-shaped, rather than sending a malformed key', () => {
    // The fallback is a send with no idempotency key, so the worst case is a send the SDK does not
    // deduplicate, and never one it turns away on the money path.
    for (const bad of ['', 'ref-1', 'not-hex-at-all', '9f86d081', 'zzzz'.repeat(16)]) {
      expect(idempotencyKeyFor(bad)).toBeUndefined()
    }
  })
})

// The gateway's last paid refusal is kept on the proof it is about, so a screen that cannot reach
// the gateway after a restart still says what it said. Keeping it is a mark on that one record and
// nothing more, since the record is the buyer's only pointer at money that already left.
describe('a paid refusal kept with its proof', () => {
  const kept = { ...purchase, refusedForGood: true }

  it('marks the record with that reference and takes the mark back, changing nothing else', async () => {
    await savePending(purchase)
    await recordRefusal('name', 'ref-1', true)
    expect(await loadPending('name')).toEqual(kept)

    await recordRefusal('name', 'ref-1', false)
    const held = await loadPending('name')
    expect(held).toEqual(purchase)
    expect(held).not.toHaveProperty('refusedForGood')
  })

  it('touches no other payment and invents none', async () => {
    await recordRefusal('name', 'ref-1', true)
    expect(await RNFS.exists(STORE)).toBe(false)

    await savePending(otherPurchase)
    await recordRefusal('name', 'ref-1', true)
    expect(await loadPending('name')).toEqual(otherPurchase)
  })

  it("leaves another wallet's record alone", async () => {
    await savePending(purchase)
    active.mockResolvedValue('w_b')
    await recordRefusal('name', 'ref-1', true)
    expect(await loadPending('name')).toBeNull()
    active.mockResolvedValue('w_a')
    expect(await loadPending('name')).toEqual(purchase)
  })

  // Writing the same reference again is a retry of one invoice or the recovery filing a charge it
  // was told about, and neither is an answer about the payment.
  it('survives the same reference being written again', async () => {
    await savePending(purchase)
    await recordRefusal('name', 'ref-1', true)
    expect(await savePending(purchase)).toEqual(kept)
    expect(await loadPending('name')).toEqual(kept)
  })

  it('never turns a paid record into one that stands for no payment', async () => {
    await savePending(purchase)
    await recordRefusal('name', 'ref-1', true)
    await recordRefusal('name', 'ref-1', false)
    expect(JSON.parse(await RNFS.readFile(STORE, 'utf8')).w_a.name).toEqual(purchase)
  })

  // A record from before the store was keyed is offered to whichever wallet holds none of its own,
  // and the mark goes on that record, where the next read finds it.
  it('marks the unkeyed record this wallet is offered', async () => {
    await RNFS.writeFile(UNKEYED, JSON.stringify(purchase), 'utf8')
    await recordRefusal('name', 'ref-1', true)
    expect(await loadPending('name')).toEqual(kept)
    expect(await RNFS.exists(STORE)).toBe(false)

    await recordRefusal('name', 'ref-1', false)
    expect(await loadPending('name')).toEqual(purchase)
  })

  it('leaves an unkeyed record with another reference alone', async () => {
    await RNFS.writeFile(UNKEYED, JSON.stringify(otherPurchase), 'utf8')
    await recordRefusal('name', 'ref-1', true)
    expect(JSON.parse(await RNFS.readFile(UNKEYED, 'utf8'))).toEqual(otherPurchase)
  })

  // A wallet holding a record of its own is never offered the unkeyed one, so an answer it heard is
  // not about that record.
  it('leaves the unkeyed record alone while the wallet holds one of its own', async () => {
    await RNFS.writeFile(UNKEYED, JSON.stringify(purchase), 'utf8')
    await RNFS.writeFile(STORE, JSON.stringify({ w_a: { name: otherPurchase } }), 'utf8')
    await recordRefusal('name', 'ref-1', true)
    expect(JSON.parse(await RNFS.readFile(UNKEYED, 'utf8'))).toEqual(purchase)
    expect(await loadPending('name')).toEqual(otherPurchase)
  })

  // Every proof already on a device was written without the mark.
  it('reads a record written without the mark as never refused', async () => {
    await RNFS.writeFile(STORE, JSON.stringify({ w_a: { name: purchase } }), 'utf8')
    const held = await loadPending('name')
    expect(held).toEqual(purchase)
    expect(held?.refusedForGood).toBeUndefined()
  })
})
