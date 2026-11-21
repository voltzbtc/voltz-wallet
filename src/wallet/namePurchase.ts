import { getBreezLnurlDomain } from '../config'
import { connectedLnurlDomain } from './spark'
import { identitySigner } from './identitySigner'
import { finalOf, PAID_AGAIN, paidAgainOf, repaidOf, retryAtOf } from './lnRefusal'
import { deletedError, deletionRefusal, noteGatewayDeleted } from './deletionMark'

// Buying a chosen name. The handle assigned on first use keeps working for free, so this is the
// price of being memorable, not of being able to receive.
export type NameQuote = {
  username: string
  priceUsdCents: number
  amountSats: number
  invoice: string
  reference: string
  /** Unix seconds after which the held price lapses. */
  expiresAt: number
}

export type PurchaseDeps = {
  gatewayUrl: string
  domain: string
  pubkey: string
  sign: (message: string) => Promise<string>
  now?: () => number
  request?: typeof fetch
}

// The domain the session is actually on, which is the wallet's own once it has bought one. The
// build's domain is only the fallback. Quoting against the shared domain while the address lives on
// the customer's would charge for a name that is free there, since the gateway decides from the Host
// it is asked on. It needs no read, so a screen can read the book before the identity answers.
export function currentDomain(): string {
  return connectedLnurlDomain() ?? getBreezLnurlDomain() ?? ''
}

// Built from what the app already knows, so a screen does not assemble a credential itself. The
// signer signs only as the identity read here (identitySigner).
//
// Every request goes to the build's domain, and the domain it is about travels in the signed body
// (`host`), as the name and domain state reads do. A customer domain's own hostname is the customer's
// to keep: once it lapses or its DNS changes hands, whoever answers there would receive the wallet's
// signed statements and answer a store confirm or a quote with whatever it likes. A frozen domain is
// also off the edge, so a renewal sent there reaches nobody.
export async function currentDeps(): Promise<PurchaseDeps> {
  const domain = currentDomain()
  const { pubkey, sign } = await identitySigner()
  return { gatewayUrl: `https://${getBreezLnurlDomain() ?? domain}`, domain, pubkey, sign }
}

// Statement the wallet signs to be quoted a price for a name. The gateway rebuilds its own name
// quote message to verify the signature, and that message is the specification; this is a copy and
// follows it. Changing the format here alone leaves both suites green and every quote rejected as
// an invalid signature.
//
// Its own namespace, matching voltz-domain:v1, rather than the LNURL server's. The Spark SDK
// refuses to sign anything beginning `breez-lnurl:`, so asking the wallet for that form fails with
// InvalidInput before a request is ever made, and a signature made to be quoted must not be
// replayable against the LNURL server's routes either.
const QUOTE_VERSION = 'voltz-name:v1'

export function nameQuoteMessage(
  domain: string,
  pubkey: string,
  username: string,
  timestamp: number,
): string {
  return [QUOTE_VERSION, 'quote', domain, pubkey, username, String(timestamp)].join('\n')
}

function endpoint(gatewayUrl: string, path: string): string {
  // /api is the prefix the edge routes to the gateway; a path at the root answers from the LNURL
  // server instead, which accepts the request and does nothing with it.
  return `${gatewayUrl.replace(/\/+$/, '')}${path}`
}

// A refusal of the gateway's throws its code as the message, with `retryAt`, the unix second a
// refusal that clears on its own clears, when the gateway sends it as `retry_at`, and `final` as the
// gateway sends it beside a paid refusal, `repaid` when it says this charge's sats were given back and
// `paidAgain` when it says the charge was paid again for a name the wallet held (all read through
// paidRefusal in lnRefusal.ts). A 409 `deleted` is also noted against the key the call carried, for
// the status read (deletionMark.ts).
export type RefusalError = Error & { retryAt?: number; final?: boolean; repaid?: boolean; paidAgain?: boolean }

async function refuse(response: Response, pubkey: string): Promise<never> {
  let reason = `status ${response.status}`
  let retryAt: number | undefined
  let final: boolean | undefined
  let repaid: boolean | undefined
  let paidAgain: boolean | undefined
  try {
    const body = (await response.json()) as Record<string, unknown>
    if (typeof body.error === 'string') {
      reason = body.error
    }
    retryAt = retryAtOf(body)
    final = finalOf(body)
    repaid = repaidOf(body)
    paidAgain = paidAgainOf(body)
  } catch {
    // Left as the status.
  }
  if (response.status === 409 && reason === 'deleted') {
    noteGatewayDeleted({ pubkey })
  }
  const refusal: RefusalError = Object.assign(new Error(reason), { retryAt, final, repaid, paidAgain })
  throw refusal
}

export async function quoteName(deps: PurchaseDeps, username: string): Promise<NameQuote> {
  // Refused here as the gateway refuses it, so a wallet that asked for its data to be deleted opens
  // no purchase until it asks for its address back. An address given up here has its own code, whose
  // words point at the way back.
  const stop = await deletionRefusal({ pubkey: deps.pubkey })
  if (stop) {
    throw deletedError(stop)
  }
  // The signature binds the quote to one wallet, name and domain, so the wallet that pays is the one
  // that will own the name and a quote cannot park a name under somebody else's key.
  const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
  const signature = await deps.sign(nameQuoteMessage(deps.domain, deps.pubkey, username, timestamp))
  const response = await (deps.request ?? fetch)(endpoint(deps.gatewayUrl, '/api/quote'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: deps.domain, username, pubkey: deps.pubkey, signature, timestamp }),
  })
  if (!response.ok) {
    await refuse(response, deps.pubkey)
  }
  return (await response.json()) as NameQuote
}

export async function confirmName(
  deps: PurchaseDeps,
  username: string,
  reference: string,
): Promise<boolean> {
  const response = await (deps.request ?? fetch)(endpoint(deps.gatewayUrl, '/api/quote/confirm'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: deps.domain, username, pubkey: deps.pubkey, reference }),
  })
  if (response.status === 402) {
    // Not an error. The payment has simply not been seen yet, and the caller keeps waiting.
    return false
  }
  if (!response.ok) {
    await refuse(response, deps.pubkey)
  }
  const body = (await response.json()) as Record<string, unknown>
  // Answered as the holder, since the wallet already had the name, while this payment bought nothing.
  // Thrown as the refusal it is for this payment, so no reader takes it for the payment that bought
  // the name, and a reader that knows nothing of it falls into its catch rather than its grant.
  if (paidAgainOf(body)) {
    const again: RefusalError = Object.assign(new Error(PAID_AGAIN), {
      final: true,
      repaid: repaidOf(body),
      paidAgain: true,
    })
    throw again
  }
  // The gateway distinguishes a grant that happened from one that did not, so believing `paid`
  // alone would call a blocked purchase a completed one.
  return body.entitled === true
}
