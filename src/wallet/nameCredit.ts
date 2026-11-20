import type { ProductId } from './store'
import type { StoreCredit } from './storePurchase'

// A name bought through a store arrives as a credit of the name's tier on one domain, and the register
// that follows spends it. Which tier a name is in is the gateway's pricing ladder, copied here so the
// screen shows the price of the product the gateway will accept; a copy that drifts sells one tier
// and spends another, which the gateway refuses.
export type NameTier = 'long' | 'standard' | 'five' | 'four' | 'short'

export function nameTier(username: string): NameTier {
  const length = username.length
  if (length >= 12) {
    return 'long'
  }
  if (length >= 6) {
    return 'standard'
  }
  if (length === 5) {
    return 'five'
  }
  if (length === 4) {
    return 'four'
  }
  return 'short'
}

export function nameProduct(username: string): ProductId {
  return `name_${nameTier(username)}`
}

export const NAME_PRODUCTS: readonly ProductId[] = [
  'name_long',
  'name_standard',
  'name_five',
  'name_four',
  'name_short',
]

const TIERS: readonly string[] = ['long', 'standard', 'five', 'four', 'short']

export function isNameTier(value: string): value is NameTier {
  return TIERS.includes(value)
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

// A credit the gateway would spend: available, and held by no withdrawal of its purchase, which the
// gateway marks and then spends the credit on nothing. A list without the mark offers as before.
export const spendable = (c: StoreCredit): boolean => c.state === 'available' && c.held === undefined

// The oldest available credit on `domain` that pays for `username`, the one the gateway's
// reservation takes. The list arrives oldest first.
export function creditFor(credits: readonly StoreCredit[], domain: string, username: string): StoreCredit | null {
  const tier = nameTier(username)
  return credits.find(c => spendable(c) && same(c.domain, domain) && c.tier === tier) ?? null
}

// The oldest available credit on `domain` whatever its tier, for saying which names it pays for.
// A tier this build does not know is left out, since nothing here can say which names it pays for.
export function availableCredit(
  credits: readonly StoreCredit[],
  domain: string,
): (StoreCredit & { tier: NameTier }) | null {
  const found = credits.find(c => spendable(c) && same(c.domain, domain) && isNameTier(c.tier))
  return found ? { ...found, tier: found.tier as NameTier } : null
}

// Whether this wallet's own credit is reserved for `username` on `domain`. Its register reached the
// gateway and the answer is still open, so the name reads as pending to everyone, this wallet
// included, until the gateway resolves it, within 30 minutes.
export function reservedFor(credits: readonly StoreCredit[], domain: string, username: string): boolean {
  return credits.some(c => c.state === 'reserved' && same(c.domain, domain) && c.name !== null && same(c.name, username))
}

// The name this wallet's credit on `domain` is reserved for, while its register is being resolved.
export function reservedName(credits: readonly StoreCredit[], domain: string): string | null {
  return credits.find(c => c.state === 'reserved' && same(c.domain, domain) && c.name !== null)?.name ?? null
}

// The credits a register of `username` on `domain` can spend, read before it is sent, by the
// gateway's id. These are every available one of its tier, since the gateway may pass over the oldest,
// and any already reserved for the name.
export function attemptCredits(credits: readonly StoreCredit[], domain: string, username: string): string[] {
  const tier = nameTier(username)
  return credits.flatMap(c =>
    same(c.domain, domain) &&
    ((spendable(c) && c.tier === tier) || (c.state === 'reserved' && c.name !== null && same(c.name, username)))
      ? [c.id]
      : [],
  )
}

// Whether one of the credits an attempt could spend is now spent on `username`, which only a register
// that reached the LNURL server and was answered 2xx produces. A credit an earlier register spent on
// the same name was never among them, so it does not read as this one having landed.
export function spentFrom(credits: readonly StoreCredit[], attempt: readonly string[], username: string): boolean {
  return credits.some(c => c.state === 'spent' && c.name !== null && same(c.name, username) && attempt.includes(c.id))
}
