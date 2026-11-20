import { USDB } from './tokens'
import type { SparkToken } from './spark'

// USDB under a cent is what a conversion leaves behind, and no reason to bring the dollar wallet up.
const LEAST_WORTH_OFFERING = 10 ** (USDB.decimals - 2)

// By identifier, since anyone can issue a token called USDB.
export function usdbBaseUnits(tokens: readonly Pick<SparkToken, 'identifier' | 'balanceBaseUnits'>[]): number {
  return tokens.find(token => token.identifier === USDB.identifier)?.balanceBaseUnits ?? 0
}

export type DollarOffer = {
  // The small line under the balance.
  line: boolean
  // The invitation back to the dollar wallet.
  invite: boolean
}

// The cached mode can be wrong while offline, so nothing here shows on a figure that is not synced.
export function dollarOffer({
  available,
  modeOn,
  synced,
  balanceSat,
  usdb,
  seen,
}: {
  available: boolean
  modeOn: boolean
  synced: boolean
  balanceSat: number
  usdb: number
  // Null while the remembered value is being read.
  seen: number | null
}): DollarOffer {
  if (!available || modeOn || !synced) {
    return { line: false, invite: false }
  }
  return {
    line: balanceSat > 0 || usdb > 0,
    invite: seen !== null && usdb > seen && usdb >= LEAST_WORTH_OFFERING,
  }
}
