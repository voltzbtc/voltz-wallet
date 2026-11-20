import { createHash } from 'crypto'
import {
  attemptCredits,
  availableCredit,
  creditFor,
  nameProduct,
  nameTier,
  reservedFor,
  reservedName,
  spentFrom,
} from '../src/wallet/nameCredit'
import type { StoreCredit } from '../src/wallet/storePurchase'

const DOMAIN = 'usevoltz.app'

// The id has the gateway's shape, the SHA-256 of a payment reference in hex, one per credit and the
// same through its states, so a fixture's id follows what makes it that credit and never its state.
function credit(over: Partial<StoreCredit> = {}): StoreCredit {
  const c = { domain: DOMAIN, tier: 'standard', state: 'available', name: null, grantedAt: 1_800_000_000, ...over }
  return { id: createHash('sha256').update(`${c.domain} ${c.tier} ${c.grantedAt}`).digest('hex'), ...c }
}

// The ladder copies the gateway's pricing ladder, so every edge of it is pinned here, since a copy one
// character off sells a product the register then refuses as tier_mismatch.
describe('which tier a name is in', () => {
  test.each([
    ['a', 'short'],
    ['abc', 'short'],
    ['abcd', 'four'],
    ['abcde', 'five'],
    ['abcdef', 'standard'],
    ['abcdefghijk', 'standard'],
    ['abcdefghijkl', 'long'],
    ['abcdefghijklmnopqrstuvwxyz', 'long'],
  ])('%p is %p', (name, tier) => {
    expect(nameTier(name)).toBe(tier)
  })

  test('the product is the tier the gateway sells under', () => {
    expect(nameProduct('abc')).toBe('name_short')
    expect(nameProduct('abcd')).toBe('name_four')
    expect(nameProduct('abcde')).toBe('name_five')
    expect(nameProduct('alice1')).toBe('name_standard')
    expect(nameProduct('abcdefghijkl')).toBe('name_long')
  })
})

describe('the credit that pays for a name', () => {
  test('is an available credit of the exact tier on this domain', () => {
    const own = credit({ tier: 'standard' })
    expect(creditFor([own], DOMAIN, 'alice1')).toBe(own)
  })

  // The reservation takes only a credit of the name's exact tier, so a screen that offered another
  // tier's credit would offer a register the gateway refuses.
  test('is never a credit of another tier', () => {
    expect(creditFor([credit({ tier: 'four' })], DOMAIN, 'alice1')).toBeNull()
    expect(creditFor([credit({ tier: 'long' })], DOMAIN, 'alice1')).toBeNull()
    expect(creditFor([credit({ tier: 'standard' })], DOMAIN, 'bob')).toBeNull()
  })

  test('is never one bought for another domain', () => {
    expect(creditFor([credit({ domain: 'pay.bakery.com' })], DOMAIN, 'alice1')).toBeNull()
  })

  test('reads the domain in any case, as the gateway stores it in one form', () => {
    expect(creditFor([credit({ domain: 'UseVoltz.App' })], DOMAIN, 'alice1')).not.toBeNull()
  })

  test.each(['reserved', 'spent', 'annulled'])('is never a %p one', state => {
    expect(creditFor([credit({ state, name: 'alice1' })], DOMAIN, 'alice1')).toBeNull()
  })

  test('is the oldest of two, the one the reservation takes', () => {
    const older = credit({ grantedAt: 1 })
    const newer = credit({ grantedAt: 2 })
    expect(creditFor([older, newer], DOMAIN, 'alice1')).toBe(older)
  })
})

// A credit a withdrawal holds is spent on nothing at the gateway, so nothing here offers or counts it;
// the same credit without the mark, as an older gateway lists it, is offered as before.
describe('a credit a withdrawal holds', () => {
  const held = credit({ held: 'withdrawal' })
  const free = credit()

  test('pays for no name, and is no spare', () => {
    expect(creditFor([held], DOMAIN, 'alice1')).toBeNull()
    expect(availableCredit([held], DOMAIN)).toBeNull()
    expect(creditFor([free], DOMAIN, 'alice1')).toBe(free)
    expect(availableCredit([free], DOMAIN)?.id).toBe(free.id)
  })

  test('is not among what a register could spend', () => {
    expect(attemptCredits([held], DOMAIN, 'alice1')).toEqual([])
    expect(attemptCredits([free], DOMAIN, 'alice1')).toEqual([free.id])
  })

  test('leaves the next credit to pay', () => {
    const later = credit({ grantedAt: 1_800_000_001 })
    expect(creditFor([held, later], DOMAIN, 'alice1')).toBe(later)
  })
})

describe('a spare credit', () => {
  test('names the tier it pays for', () => {
    expect(availableCredit([credit({ tier: 'four' })], DOMAIN)?.tier).toBe('four')
  })

  test('is nothing when every credit is used or elsewhere', () => {
    expect(availableCredit([credit({ state: 'spent', name: 'alice1' })], DOMAIN)).toBeNull()
    expect(availableCredit([credit({ domain: 'pay.bakery.com' })], DOMAIN)).toBeNull()
  })

  // A tier this build does not know cannot be described, so it is not offered as one it can.
  test('leaves out a tier this build does not know', () => {
    expect(availableCredit([credit({ tier: 'platinum' })], DOMAIN)).toBeNull()
  })
})

describe('what the gateway did with a credit', () => {
  test('a credit reserved for the name is this wallet still waiting on its register', () => {
    expect(reservedFor([credit({ state: 'reserved', name: 'alice1' })], DOMAIN, 'alice1')).toBe(true)
    expect(reservedFor([credit({ state: 'reserved', name: 'carol1' })], DOMAIN, 'alice1')).toBe(false)
    expect(reservedFor([credit({ state: 'spent', name: 'alice1' })], DOMAIN, 'alice1')).toBe(false)
    expect(reservedFor([credit({ state: 'reserved', name: 'alice1', domain: 'x.com' })], DOMAIN, 'alice1')).toBe(false)
  })

  // The sheet opens on one domain, and a register another domain's credit is waiting on is not its own.
  test('the name a credit is reserved for is read on its own domain only', () => {
    const elsewhere = credit({ state: 'reserved', name: 'bob123', domain: 'pay.bakery.com' })
    expect(reservedName([elsewhere], DOMAIN)).toBeNull()
    expect(reservedName([elsewhere, credit({ state: 'reserved', name: 'alice1' })], DOMAIN)).toBe('alice1')
  })

  test('a credit the attempt could spend, now spent on the name, is the register having landed', () => {
    const before = [credit()]
    const attempt = attemptCredits(before, DOMAIN, 'alice1')
    expect(spentFrom([credit({ state: 'spent', name: 'alice1' })], attempt, 'alice1')).toBe(true)
    expect(spentFrom([credit({ state: 'spent', name: 'carol1' })], attempt, 'alice1')).toBe(false)
    expect(spentFrom([credit({ state: 'reserved', name: 'alice1' })], attempt, 'alice1')).toBe(false)
    expect(spentFrom([credit()], attempt, 'alice1')).toBe(false)
  })

  // The gateway lists every credit for ever, so one spent on this name by an earlier register is
  // still there when a later register's answer is lost.
  test('a credit an earlier register spent on the same name is not this attempt landing', () => {
    const old = credit({ state: 'spent', name: 'alice1', grantedAt: 1_700_000_000 })
    const attempt = attemptCredits([old, credit()], DOMAIN, 'alice1')
    expect(attempt).toHaveLength(1)
    expect(spentFrom([old, credit()], attempt, 'alice1')).toBe(false)
    expect(spentFrom([old, credit({ state: 'spent', name: 'alice1' })], attempt, 'alice1')).toBe(true)
  })

  test('an attempt can spend every available credit of the tier and one reserved for the name', () => {
    const list = [
      credit({ grantedAt: 1 }),
      credit({ grantedAt: 2 }),
      credit({ grantedAt: 3, tier: 'four' }),
      credit({ grantedAt: 4, domain: 'pay.bakery.com' }),
      credit({ grantedAt: 5, state: 'reserved', name: 'alice1' }),
      credit({ grantedAt: 6, state: 'reserved', name: 'carol1' }),
      credit({ grantedAt: 7, state: 'spent', name: 'alice1' }),
    ]
    expect(attemptCredits(list, DOMAIN, 'alice1')).toEqual([list[0]!.id, list[1]!.id, list[4]!.id])
  })
})

describe('which credit is which', () => {
  // Two credits of one tier granted in the same second are told apart by the gateway's id alone, and
  // the list may answer them in either order.
  test('a credit is the one the gateway names, whatever its place in the list', () => {
    const [one, two] = ['ref-1', 'ref-2'].map(ref => createHash('sha256').update(ref).digest('hex'))
    const first = credit({ id: one })
    const second = credit({ id: two })
    const attempt = attemptCredits([first, second], DOMAIN, 'alice1')
    expect(attempt).toEqual([one, two])
    // The register could spend only the second, and the first is the one spent on the name.
    expect(spentFrom([second, { ...first, state: 'spent', name: 'alice1' }], [two!], 'alice1')).toBe(false)
    expect(spentFrom([{ ...second, state: 'spent', name: 'alice1' }, first], [two!], 'alice1')).toBe(true)
  })
})
