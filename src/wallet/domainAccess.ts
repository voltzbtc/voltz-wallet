import RNFS from 'react-native-fs'

// Letting another person hold an address on a domain the owner bought. The gateway rebuilds this
// statement to verify the signature, so the two must stay byte-identical or every request is
// rejected as an invalid signature. Its own namespace keeps a signature made here from being replayed against the LNURL
// server's `breez-lnurl:` routes.
const VERSION = 'voltz-domain:v1'

export type DomainAction = 'authorize' | 'revoke'

export function domainAccessMessage(
  action: DomainAction,
  domain: string,
  ownerPubkey: string,
  targetPubkey: string,
  timestamp: number,
): string {
  // The action and the target are both inside the signature: without the action, a grant could be
  // replayed as a revoke; without the target, a signature naming one wallet would admit another.
  return [VERSION, action, domain, ownerPubkey, targetPubkey, String(timestamp)].join('\n')
}

// Reading the list reveals which keys a business trusts, so it is signed like changing it. A form
// of its own, so a signature made to read can never grant.
export function domainListMessage(domain: string, ownerPubkey: string, timestamp: number): string {
  return [VERSION, 'list', domain, ownerPubkey, String(timestamp)].join('\n')
}

const PUBKEY = /^0[23][0-9a-f]{64}$/i

export function isWalletKey(value: string): boolean {
  return PUBKEY.test(value.trim())
}

// What a person reads out loud to check they are approving the right wallet. A pubkey is 66
// characters of hex that nobody verifies by eye, so both screens show this instead and the owner
// compares. It works like a Signal safety number, which does not add secrecy but makes a swapped
// key visible.
//
// Derived from the key itself, so the two devices arrive at it independently with nothing shared.
export function walletCode(pubkey: string): string {
  const key = pubkey.trim().toLowerCase()
  // FNV-1a over the key bytes. Not a security boundary, just a stable short digest; the signature is
  // what authorises, and this only has to make a substituted key look different.
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    // FNV-1a is defined in terms of xor and unsigned truncation; writing it without them would be
    // writing a different function.
    // eslint-disable-next-line no-bitwise
    hash ^= key.charCodeAt(i)
    // eslint-disable-next-line no-bitwise
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const text = hash.toString(16).toUpperCase().padStart(8, '0')
  return `${text.slice(0, 4)} ${text.slice(4)}`
}

// Accepts what a scan or a paste can produce, which is the bare key or the URI the other screen
// renders.
export function parseWalletKey(scanned: string): string | null {
  const text = scanned.trim()
  const withoutScheme = text.toLowerCase().startsWith('voltz:wallet:') ? text.slice(13) : text
  return isWalletKey(withoutScheme) ? withoutScheme.toLowerCase() : null
}

// What the guest's screen renders. A scheme rather than bare hex so a scanner can tell what it is.
export function walletKeyUri(pubkey: string): string {
  return `voltz:wallet:${pubkey.trim().toLowerCase()}`
}

export type AuthorizedWallet = { pubkey: string; grantedAt: number }

export type DomainAccessDeps = {
  gatewayUrl: string
  domain: string
  ownerPubkey: string
  sign: (message: string) => Promise<string>
  now?: () => number
  request?: typeof fetch
}

function endpoint(gatewayUrl: string, path: string): string {
  // /api is the prefix the edge routes to the gateway; a path at the root answers from the LNURL
  // server instead, which accepts the request and does nothing with it.
  return `${gatewayUrl.replace(/\/+$/, '')}${path}`
}

async function post(url: string, body: unknown, request: typeof fetch): Promise<Response> {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function refuse(response: Response): Promise<never> {
  // The gateway's reason is machine-readable and the screen maps it to a sentence; anything else is
  // reported by status so a failure is never silent.
  let reason = `status ${response.status}`
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') {
      reason = body.error
    }
  } catch {
    // Left as the status.
  }
  throw new Error(reason)
}

export async function changeDomainAccess(
  deps: DomainAccessDeps,
  action: DomainAction,
  targetPubkey: string,
): Promise<void> {
  const target = targetPubkey.trim().toLowerCase()
  if (!isWalletKey(target)) {
    throw new Error('invalid_wallet_key')
  }
  const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
  const signature = await deps.sign(
    domainAccessMessage(action, deps.domain, deps.ownerPubkey, target, timestamp),
  )
  const response = await post(
    endpoint(deps.gatewayUrl, '/api/domain/access'),
    { action, targetPubkey: target, ownerPubkey: deps.ownerPubkey, signature, timestamp },
    deps.request ?? fetch,
  )
  if (!response.ok) {
    await refuse(response)
  }
}

export async function listDomainWallets(deps: DomainAccessDeps): Promise<AuthorizedWallet[]> {
  const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
  const signature = await deps.sign(domainListMessage(deps.domain, deps.ownerPubkey, timestamp))
  const response = await post(
    endpoint(deps.gatewayUrl, '/api/domain/wallets'),
    { ownerPubkey: deps.ownerPubkey, signature, timestamp },
    deps.request ?? fetch,
  )
  if (!response.ok) {
    await refuse(response)
  }
  const body = (await response.json()) as { wallets?: unknown }
  return Array.isArray(body.wallets) ? (body.wallets as AuthorizedWallet[]) : []
}

// Names the owner gave the wallets they let in. They stay on this device only, because the gateway
// stores pubkeys and nothing else, so the feature adds no personal data to the service.
const LABELS = `${RNFS.DocumentDirectoryPath}/domain-wallet-labels.json`

export async function loadLabels(): Promise<Record<string, string>> {
  try {
    if (!(await RNFS.exists(LABELS))) {
      return {}
    }
    const parsed: unknown = JSON.parse(await RNFS.readFile(LABELS, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

// Drops every label. Only the owner of a domain names wallets on it, so the deletion cleanup calls this
// when the wallet that owned a domain leaves and no other wallet here owns one.
export async function forgetLabels(): Promise<void> {
  if (await RNFS.exists(LABELS)) {
    await RNFS.unlink(LABELS)
  }
}

export async function saveLabel(pubkey: string, label: string): Promise<void> {
  const labels = await loadLabels()
  const key = pubkey.trim().toLowerCase()
  const trimmed = label.trim().slice(0, 40)
  if (trimmed) {
    labels[key] = trimmed
  } else {
    delete labels[key]
  }
  await RNFS.writeFile(LABELS, JSON.stringify(labels), 'utf8')
}
