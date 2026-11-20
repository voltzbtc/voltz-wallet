// Text a person pastes, scans or opens as a link, in the form the SDK takes. Wallets show an invoice,
// an LNURL or a lightning address as a `lightning:` URI, which the SDK's parse reads and its prepare
// refuses, so every call that hands such text to the SDK goes through here. A `bitcoin:` URI keeps its
// scheme, since its query can carry legs the SDK reads.
const LIGHTNING_SCHEME = /^lightning:(?:\/\/)?/i

// Without the u flag, /i never folds a non-ASCII letter onto an ASCII one, as eq_ignore_ascii_case.
const BITCOIN_SCHEME = /^bitcoin:/i

export function paymentInput(text: string): string {
  return text.trim().replace(LIGHTNING_SCHEME, '').trim()
}

// Whether the SDK reads the text as a `bitcoin:` URI. It does so before any address, offline, and
// answers a URI or an error, so an @ in its query never sends the text to a domain (parse_core in
// the SDK's input parser).
export function isBitcoinUri(text: string): boolean {
  return BITCOIN_SCHEME.test(paymentInput(text))
}
