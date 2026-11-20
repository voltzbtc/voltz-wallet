import { formatBtcTrim } from './amount'

export type Bip21Parts = {
  address: string
  // The on-chain amount is a request the payer's wallet may still edit; an attached invoice locks the
  // Lightning leg. Emitted in decimal BTC, as BIP-21 requires. Zero or undefined omits the param,
  // leaving an amountless request.
  amountSat?: number
  // Bolt11 invoice in the `lightning=` param, the de-facto unified-QR convention. Omitted for an
  // on-chain-only request.
  lightning?: string
  // Static Spark address in the `spark=` param. Non-standard, but per BIP-21 a param without the
  // `req-` prefix must be ignored by wallets that do not know it, so the on-chain and Lightning legs
  // stay valid. Being reusable (unlike a one-time bolt11), it is the instant rail an amountless QR
  // can still carry.
  spark?: string
}

// Unified BIP-21 URI so a single QR pays over whichever rail the payer supports. bech32(m) addresses
// and bolt11 invoices contain no URI-reserved characters, so no percent-encoding is applied.
export function buildBip21({ address, amountSat, lightning, spark }: Bip21Parts): string {
  const params: string[] = []
  if (amountSat !== undefined && amountSat > 0) {
    params.push(`amount=${formatBtcTrim(amountSat)}`)
  }
  if (lightning) {
    params.push(`lightning=${lightning}`)
  }
  if (spark) {
    params.push(`spark=${spark}`)
  }
  const query = params.length > 0 ? `?${params.join('&')}` : ''
  return `bitcoin:${address}${query}`
}

// The address alone, for a field or a wallet that takes no URI. It sits between the scheme and the
// query in any URI buildBip21 writes.
export function bip21Address(uri: string): string {
  return uri.replace(/^bitcoin:/, '').split('?')[0]
}
