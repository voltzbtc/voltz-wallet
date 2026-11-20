// The pure choices behind the screens that move USD stablecoins to and from another chain.

export type ReceiveLanding = 'btc' | 'usdb'

// When a quote stops being good, in ms. The two providers differ: Orchestra answers RFC3339 and Boltz
// unix seconds as text, whatever the binding's comment says. Null means there is no moment to act
// on, and the SDK's own check at send stands.
export function quoteExpiryMs(expiresAt: string): number | null {
  const text = expiresAt.trim()
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1000
    return Number.isSafeInteger(ms) ? ms : null
  }
  if (!/^\d{4}-\d{2}-\d{2}T/i.test(text)) {
    return null
  }
  // RFC3339 allows any number of fractional digits, and an engine owes only the three of a Date.
  const ms = Date.parse(text.replace(/(\.\d{3})\d+/, '$1').toUpperCase())
  return Number.isNaN(ms) ? null : ms
}

// Early by this much, because the device's clock is the one the SDK checks against and a press takes
// time to arrive.
const QUOTE_MARGIN_MS = 10_000

export function quoteLapsed(expiresAt: string, nowMs: number): boolean {
  const at = quoteExpiryMs(expiresAt)
  return at !== null && nowMs >= at - QUOTE_MARGIN_MS
}

// How long a quote has left before it counts as lapsed, or null when it has no known end.
export function quoteLapsesInMs(expiresAt: string, nowMs: number): number | null {
  const at = quoteExpiryMs(expiresAt)
  return at === null ? null : Math.max(0, at - QUOTE_MARGIN_MS - nowMs)
}

// What lands on Spark follows the dollar wallet, so a receive never asks which asset to credit. A
// route that delivers only one of them decides alone.
export function pickReceiveLanding(
  accepts: { btc: boolean; usdb: boolean },
  dollarMode: boolean,
): ReceiveLanding | null {
  if (dollarMode && accepts.usdb) {
    return 'usdb'
  }
  if (accepts.btc) {
    return 'btc'
  }
  return accepts.usdb ? 'usdb' : null
}

export type CrossChainSource = 'usdb' | 'sats'

// A dollar wallet pays in USDB where the route takes it, because the SDK reads `amount` as the source
// asset's units there. Elsewhere the send is in sats, and on a dollar wallet the SDK converts on its
// own when the sats fall short.
export function crossChainSource(route: { accepts: { usdb: boolean } }, dollarMode: boolean): CrossChainSource {
  return dollarMode && route.accepts.usdb ? 'usdb' : 'sats'
}

// The SDK names chains by slug. The ones people know under another name are mapped; the provider
// adds networks without notice, so anything else is capitalised rather than hidden.
const CHAIN_NAMES: Record<string, string> = {
  bsc: 'BNB Chain',
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  optimism: 'OP Mainnet',
  zksync: 'zkSync',
  hypercore: 'HyperCore',
  hyperevm: 'HyperEVM',
}

export function chainDisplayName(slug: string): string {
  return CHAIN_NAMES[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1)
}

// Brand names, never translated, for the coins paid in from another chain.
const COIN_NAMES: Record<string, string> = { USDT: 'Tether USD', USDC: 'USD Coin' }

export function coinDisplayName(ticker: string): string {
  return COIN_NAMES[ticker] ?? ticker
}

// Where USDT and USDC mostly move, most common first. USDT on Tron leads because it carries most
// stablecoin transfers people are sent.
const COMMON_CHAINS = ['tron', 'ethereum', 'solana', 'bsc', 'base', 'polygon', 'arbitrum']

export function sortRoutes<T extends { chain: string; asset: string }>(routes: T[]): T[] {
  const rank = (r: T) => {
    const i = COMMON_CHAINS.indexOf(r.chain)
    return i === -1 ? COMMON_CHAINS.length : i
  }
  return [...routes].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === COMMON_CHAINS.length
        ? chainDisplayName(a.chain).localeCompare(chainDisplayName(b.chain))
        : 0) ||
      // USDT before USDC on the same chain.
      b.asset.localeCompare(a.asset),
  )
}

// One line per token, whoever delivers it. Which provider runs is not a question to ask before an
// amount can compare them, while which contract is: two contracts of one asset are two tokens, and
// the SDK keys its routes by chain, asset and contract for that reason.
export type RouteGroup<T> = { chain: string; asset: string; contractAddress?: string; routes: T[] }

// An EVM contract is hex, where case is only a checksum, so two providers can spell one token apart.
// Base58 contracts, on Solana and Tron, change meaning with case and stay as they are.
const contractKey = (contract: string | undefined): string =>
  contract?.startsWith('0x') ? contract.toLowerCase() : contract ?? ''

const chainKey = (chain: string): string => chain.toLowerCase()

// The one reading of 'the same token', so a list and the comparison of offers never disagree on it.
const tokenKey = (route: { chain: string; asset: string; contractAddress?: string }): string =>
  `${chainKey(route.chain)}|${route.asset}|${contractKey(route.contractAddress)}`

export function groupRoutes<T extends { chain: string; asset: string; contractAddress?: string }>(
  routes: T[],
): RouteGroup<T>[] {
  const groups = new Map<string, RouteGroup<T>>()
  for (const route of sortRoutes(routes)) {
    const key = tokenKey(route)
    const group = groups.get(key) ?? {
      chain: route.chain,
      asset: route.asset,
      contractAddress: route.contractAddress,
      routes: [],
    }
    group.routes.push(route)
    groups.set(key, group)
  }
  return [...groups.values()]
}

const CONTRACT_HEAD = 8
const CONTRACT_TAIL = 6

// What tells apart the lines a list would otherwise draw alike. A line alone on its chain and asset
// needs nothing, and the contract stays behind a fold on the review.
export function contractNote<T>(group: RouteGroup<T>, groups: RouteGroup<T>[]): string | undefined {
  const contract = group.contractAddress
  const alike = groups.some(
    other => other !== group && chainKey(other.chain) === chainKey(group.chain) && other.asset === group.asset,
  )
  if (!alike || contract === undefined) {
    return undefined
  }
  return contract.length > CONTRACT_HEAD + CONTRACT_TAIL
    ? `${contract.slice(0, CONTRACT_HEAD)}…${contract.slice(-CONTRACT_TAIL)}`
    : contract
}

type Contender = {
  id: string
  chain: string
  asset: string
  contractAddress?: string
  accepts: { usdb: boolean }
}

// The chosen route first, then the routes that deliver the same thing for the same typed amount. A
// USDB amount means nothing to a route that takes only sats, and another contract is another token.
export function routeContenders<T extends Contender>(available: T[], chosen: T, source: CrossChainSource): T[] {
  const rivals = available.filter(
    route =>
      route.id !== chosen.id &&
      tokenKey(route) === tokenKey(chosen) &&
      (source === 'sats' || route.accepts.usdb),
  )
  return [chosen, ...rivals]
}

// Who delivers more. Figures on different decimals are not the same unit, so the first offer stands.
export function bestOffer<T extends { estimatedOut: number; decimals: number }>(offers: T[]): T {
  const [first] = offers
  if (offers.some(offer => offer.decimals !== first.decimals)) {
    return first
  }
  return offers.reduce((best, offer) => (offer.estimatedOut > best.estimatedOut ? offer : best), first)
}

// Waits for every call or the limit, whichever comes first, and keeps the calls' order. What lands
// past the limit goes to `late`, since a quote nobody will read still holds a prepared send.
export async function answersWithin<T>(
  calls: Promise<T>[],
  limitMs: number,
  late: (answer: T) => void,
): Promise<{ answers: T[]; failures: unknown[] }> {
  const answers: Array<{ value: T } | undefined> = calls.map(() => undefined)
  const failures: Array<{ cause: unknown } | undefined> = calls.map(() => undefined)
  let closed = false
  let limit: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.all(
      calls.map((call, index) =>
        call.then(
          value => {
            if (closed) {
              late(value)
            } else {
              answers[index] = { value }
            }
          },
          cause => {
            failures[index] = { cause }
          },
        ),
      ),
    ),
    new Promise(resolve => {
      limit = setTimeout(resolve, limitMs)
    }),
  ])
  closed = true
  clearTimeout(limit)
  return {
    answers: answers.flatMap(answer => (answer ? [answer.value] : [])),
    failures: failures.flatMap(failure => (failure ? [failure.cause] : [])),
  }
}

// Names as the providers go by, never the SDK's slugs. Brand names, so never translated.
const PROVIDER_NAMES = { orchestra: 'Orchestra', boltz: 'Boltz' }

export function providerDisplayName(provider: keyof typeof PROVIDER_NAMES): string {
  return PROVIDER_NAMES[provider]
}

type Limits = {
  minAmount: bigint | undefined
  maxAmount: bigint | undefined
  minUsdCents: bigint | undefined
  maxUsdCents: bigint | undefined
}

// A receive is bounded in the asset paid in (base units) and in dollars of order value; the tighter
// of each pair binds. The result stays in the asset's base units, on integers alone, since a token
// can hold 18 places and a double strays past about 15 digits. Cents are read as a USD stablecoin's
// dollars, the floor rounded up and the ceiling down where its places cannot hold a cent.
export function receiveBounds(
  limits: Limits | undefined,
  decimals: number,
): { min?: bigint; max?: bigint } {
  const scale = 10n ** BigInt(decimals)
  const usd = (cents: bigint | undefined, direction: 'up' | 'down') =>
    cents === undefined ? undefined : (cents * scale + (direction === 'up' ? 99n : 0n)) / 100n
  const larger = (a: bigint, b: bigint) => (a > b ? a : b)
  const smaller = (a: bigint, b: bigint) => (a < b ? a : b)
  type Pick = (x: bigint, y: bigint) => bigint
  const pick = (a: bigint | undefined, b: bigint | undefined, f: Pick) =>
    a === undefined ? b : b === undefined ? a : f(a, b)
  return {
    min: pick(limits?.minAmount, usd(limits?.minUsdCents, 'up'), larger),
    max: pick(limits?.maxAmount, usd(limits?.maxUsdCents, 'down'), smaller),
  }
}
