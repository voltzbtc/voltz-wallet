// The Spark network's known tokens (BTKN protocol). Its own module because the identifier is needed
// alike by the converter, the Home catalog, the SDK's stable-balance config and the asset icons, and
// leaving it in sparkConvert.ts would make wallet/spark.ts depend on the converter's asset model.
export type SparkKnownToken = {
  /** The bech32m `btkn1...` identifier the SDK's token APIs expect (NOT the hex form). */
  identifier: string
  ticker: string
  name: string
  decimals: number
  /** Fiat peg, for the live estimate. Absent on non-pegged tokens (memecoins). */
  fiatId?: string
}

// USDB (Brale/Flashnet), backed 1:1 by T-bills. The Flashnet token list (flashnet.xyz/api/tokenlist)
// carries only this entry, and Tether's "native USDT on Bitcoin" rides RGB rather than Spark.
export const USDB: SparkKnownToken = {
  identifier: 'btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87',
  ticker: 'USDB',
  name: 'Bitcoin USD',
  decimals: 6,
  fiatId: 'USD',
}

// DePix, pegged to the real, issued by Eulen; identifier per Eulen's Spark guide (docs.eulen.app).
// Anyone can issue a token named DePix on Spark, so the identifier, never the name, makes it this one.
export const DEPIX: SparkKnownToken = {
  identifier: 'btkn1sdqgp9904d620fmgs6p9669fghzfq06hvpqmy2wg8c9xtw4qms3qpf4aty',
  ticker: 'DePix',
  name: 'Decentralized PIX',
  decimals: 8,
  fiatId: 'BRL',
}

// Every token the app knows by identifier, for its peg, its mark and the lookalike check. Knowing a
// token does not list it; DEFAULT_TOKENS does.
export const KNOWN_TOKENS: SparkKnownToken[] = [USDB, DEPIX]

// Listed on every wallet at zero balance, so the Home can show a token before any arrives, a BTC->token
// convert has a destination and the receive screen can bill in one. DePix stays out because the app is
// international; it is one tap away in the suggestions and lists itself once held or added.
export const DEFAULT_TOKENS: SparkKnownToken[] = [USDB]

export function knownToken(identifier: string): SparkKnownToken | undefined {
  return KNOWN_TOKENS.find(token => token.identifier === identifier)
}

// A token that takes a known token's ticker or name under another identifier, which is how a fake
// passes for the real one in a list that shows only those two.
export function lookalikeOf(token: {
  identifier: string
  ticker: string
  name: string
}): SparkKnownToken | undefined {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  return KNOWN_TOKENS.find(
    known =>
      known.identifier !== token.identifier &&
      (same(known.ticker, token.ticker) || same(known.name, token.name)),
  )
}

// After bitcoin, which each list puts first itself, every list shows the dollars (USDB, then the coins
// paid in from other chains) and then the real. Anything else follows in the order it came, since the
// sort is stable. Keys are token identifiers or cross-chain tickers.
const ASSET_ORDER = [USDB.identifier, 'USDT', 'USDC', DEPIX.identifier]

export function byAssetOrder(a: string, b: string): number {
  const rank = (key: string) => {
    const index = ASSET_ORDER.indexOf(key)
    return index === -1 ? ASSET_ORDER.length : index
  }
  return rank(a) - rank(b)
}

// Integrator-defined display label for the stable balance token (the SDK keys the active choice by
// this label, not by ticker). The stable balance is USDB alone, so one label.
export const STABLE_BALANCE_LABEL = 'USD'
