import { secureBytes } from './secureRandom'
import type { SparkDestinationKind } from './spark'

// Non-custodial LN Address. The server (breez-lnurl) stores only a username -> device pubkey
// mapping, holds no key and no balance, and the invoice is always built on the device.

// LUD-16 usernames are case-insensitive and breez-lnurl caps them at 64, so handles are lowercased.
const USERNAME_MAX = 64
const USERNAME_REGEX = /^[a-z0-9._-]+$/

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

export function validateUsername(username: string): boolean {
  const normalized = normalizeUsername(username)
  return (
    normalized.length > 0 && normalized.length <= USERNAME_MAX && USERNAME_REGEX.test(normalized)
  )
}

// The authority the SDK names for a configured domain (signed_domain in its lnurl.rs): no scheme, path,
// query or userinfo, in lower case, a non-ASCII host in punycode as its URL parser writes it, and no
// port the scheme already implies.
function authorityOf(configured: string): string {
  const parts = configured.toLowerCase().split('://')
  const scheme = parts.length > 1 ? parts[0] : 'https'
  const [authority] = parts[parts.length - 1].split(/[/?#]/)
  const host = asciiHost(authority.slice(authority.lastIndexOf('@') + 1))
  const implied = scheme === 'http' ? ':80' : ':443'
  return host.endsWith(implied) ? host.slice(0, -implied.length) : host
}

// React Native's URL polyfill reads the hostname with a regex and never punycodes it, so the encoding
// is done here. It covers what a typed domain carries (NFC, case and the ideographic full stops) and
// leaves out the rest of the UTS 46 mapping table.
function asciiHost(authority: string): string {
  const [, host = '', port = ''] = /^(.*?)(:\d+)?$/.exec(authority) ?? []
  const labels = host.normalize('NFC').replace(/[。．｡]/g, '.').split('.')
  // eslint-disable-next-line no-control-regex
  return labels.map(label => (/^[\x00-\x7f]*$/.test(label) ? label : `xn--${punycode(label)}`)).join('.') + port
}

// RFC 3492, section 6.3.
const BASE = 36
const TMIN = 1
const TMAX = 26

function adapt(delta: number, points: number, first: boolean): number {
  let d = first ? Math.floor(delta / 700) : Math.floor(delta / 2)
  d += Math.floor(d / points)
  let k = 0
  while (d > ((BASE - TMIN) * TMAX) / 2) {
    d = Math.floor(d / (BASE - TMIN))
    k += BASE
  }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + 38))
}

function digit(d: number): string {
  return String.fromCharCode(d < 26 ? 97 + d : 22 + d)
}

function punycode(label: string): string {
  const input = Array.from(label, c => c.codePointAt(0)!)
  const basic = input.filter(c => c < 0x80).map(c => String.fromCharCode(c)).join('')
  let output = basic.length > 0 ? `${basic}-` : ''
  let handled = basic.length
  let n = 128
  let delta = 0
  let bias = 72
  while (handled < input.length) {
    const m = Math.min(...input.filter(c => c >= n))
    delta += (m - n) * (handled + 1)
    n = m
    for (const c of input) {
      if (c < n) {
        delta++
      }
      if (c === n) {
        let q = delta
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias
          if (q < t) {
            break
          }
          output += digit(t + ((q - t) % (BASE - t)))
          q = Math.floor((q - t) / (BASE - t))
        }
        output += digit(q)
        bias = adapt(delta, handled + 1, handled === basic.length)
        delta = 0
        handled++
      }
    }
    delta++
    n++
  }
  return output
}

// The text a payer sees for an address, the same the SDK wrote by itself until 0.28 (default_description
// in sdk/lightning_address.rs at 0.26.0).
export function defaultAddressDescription(username: string, configuredDomain: string): string {
  return `Pay to ${normalizeUsername(username)}@${authorityOf(configuredDomain)}`
}

// What an LNURL-pay service says of itself, the text/plain entry of its LUD-06 metadata, which is a
// JSON array of [type, content] pairs. Undefined when the service wrote none or the metadata is not JSON.
export function lnurlText(metadata: string): string | undefined {
  let items: unknown
  try {
    items = JSON.parse(metadata)
  } catch {
    return undefined
  }
  if (!Array.isArray(items)) {
    return undefined
  }
  const entry = items.find(
    (item): item is [string, string] =>
      Array.isArray(item) && item[0] === 'text/plain' && typeof item[1] === 'string',
  )
  const text = entry?.[1].trim()
  return text ? text : undefined
}

// Validating the host as well rejects junk like "alice@!!!" that a username-only check accepts.
const DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i

export function isLightningAddress(value: string): boolean {
  const v = value.trim()
  const at = v.indexOf('@')
  if (at <= 0 || at >= v.length - 1) {
    return false
  }
  return validateUsername(v.slice(0, at)) && DOMAIN_REGEX.test(v.slice(at + 1))
}

// An address may open with ₿, and Send's own filter takes what the SDK's parser takes: any character
// in the name it would keep, and any host that holds a dot. Only a request tells the rest apart, which
// is why this stays wider than isLightningAddress, the rule for a name the app registers.
const SDK_ADDRESS_PART = /^[^\s@/?#]+$/

function withoutBitcoinSign(address: string): string {
  return address.trim().replace(/^₿/, '')
}

export function couldBeAddress(value: string): boolean {
  const [user, domain, ...rest] = withoutBitcoinSign(value).split('@')
  return (
    rest.length === 0 &&
    domain !== undefined &&
    SDK_ADDRESS_PART.test(user) &&
    SDK_ADDRESS_PART.test(domain) &&
    /[^.]\.[^.]/.test(domain)
  )
}

// Whether a text under the keyboard is long enough to judge: the shape of a whole address, with a
// top-level part no shorter than any real one. Everything before that is an address on its way, so
// `alice@x.c` on the way to `alice@x.com` draws no error for one keystroke.
export function couldBeWholeAddress(value: string): boolean {
  return couldBeAddress(value) && /\.[^.]{2,}$/.test(value.trim())
}

export type AddressCheck = 'ok' | 'wrong' | 'unreachable'

const CHECK_LIMIT_MS = 5_000

function withinLimit<T>(work: Promise<T>): Promise<T> {
  let limit: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      limit = setTimeout(() => reject(new Error('timeout')), CHECK_LIMIT_MS)
    }),
  ]).finally(() => clearTimeout(limit))
}

// The answers that say this address is not there. A 200 or a redirect says it may be, and a block, a
// rate limit or a server error says nothing about it.
const NO_SUCH_ADDRESS = [400, 404, 410]

// What an address's own server says of it, at the URL the SDK itself asks (LUD-16). The SDK's parse
// answers the same for an address that does not exist and for a network that is down, so a refusal is
// taken there, and only a server that denies the address calls it wrong.
export async function probeLightningAddress(address: string): Promise<'wrong' | 'unreachable'> {
  const [user, domain] = withoutBitcoinSign(address).toLowerCase().split('@')
  const scheme = domain.endsWith('.onion') ? 'http' : 'https'
  try {
    const answer = await withinLimit(
      fetch(`${scheme}://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`),
    )
    return NO_SUCH_ADDRESS.includes(answer.status) ? 'wrong' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

// Whether an address can be paid, as far as anyone can tell before paying. `classify` comes in because
// spark.ts imports this module.
export async function verifyLightningAddress(
  address: string,
  classify: (destination: string) => Promise<SparkDestinationKind>,
): Promise<AddressCheck> {
  const trimmed = address.trim()
  if (!isLightningAddress(trimmed)) {
    return 'wrong'
  }
  try {
    const kind = await withinLimit(classify(trimmed))
    if (kind === 'lightningAddress') {
      return 'ok'
    }
    // Short of a lightning address, the SDK reads text of this shape as nothing, or as the BIP-353 record
    // it looks up once the LNURL read failed. Either way that read may have met a server that is down.
    return await probeLightningAddress(trimmed)
  } catch {
    return 'unreachable'
  }
}

// ~92k combinations, which is why sparkEnsureLnAddress retries on a name already taken.
export const USERNAME_ADJECTIVES = [
  'swift', 'brave', 'calm', 'bright', 'clever', 'bold', 'cosmic', 'lucky',
  'mellow', 'noble', 'quiet', 'rapid', 'sunny', 'vivid', 'wild', 'zesty',
  'amber', 'azure', 'crisp', 'eager', 'fancy', 'gentle', 'humble', 'jolly',
  'keen', 'lively', 'merry', 'nimble', 'proud', 'spry', 'witty', 'cozy',
]
export const USERNAME_ANIMALS = [
  'otter', 'puma', 'finch', 'heron', 'lynx', 'koala', 'gecko', 'raven',
  'tapir', 'bison', 'crane', 'ferret', 'jaguar', 'marten', 'ocelot', 'panda',
  'quokka', 'robin', 'seal', 'tiger', 'walrus', 'badger', 'cobra', 'dingo',
  'eagle', 'falcon', 'gopher', 'hawk', 'ibex', 'moose', 'newt', 'orca',
]

// The SDK assigns no LN address, so the wallet claims a random valid one and renames later.
export function randomUsername(): string {
  const bytes = secureBytes(3, 'a lightning name')
  const adjective = USERNAME_ADJECTIVES[bytes[0] % USERNAME_ADJECTIVES.length]
  const animal = USERNAME_ANIMALS[bytes[1] % USERNAME_ANIMALS.length]
  const number = 10 + (bytes[2] % 90) // 10-99, always two digits
  return `${adjective}${animal}${number}`
}

// The availability statement in the SDK's v2 signed message format, byte-identical to the one the
// gateway rebuilds to verify the signature. Nothing in the app calls this. The SDK builds and signs
// the statement itself when it checks a username, and signMessage refuses the reserved
// breez-lnurl: namespace, so the app cannot sign it directly. Statements the app signs for the
// gateway use a voltz-* prefix instead.
const LNURL_MESSAGE_VERSION = 'breez-lnurl:v2'

export function availableMessage(
  domain: string,
  pubkey: string,
  username: string,
  timestamp: number,
): string {
  return [LNURL_MESSAGE_VERSION, 'available', domain, pubkey, username, String(timestamp)].join('\n')
}

// Exact message breez-lnurl verifies, "<time>-<webhook_url>" plus "-<username>" when named. Time is
// unix seconds and the server rejects anything more than 60s off, as an anti-replay guard.
export function buildRegistrationMessage(
  time: number,
  webhookUrl: string,
  username?: string,
): string {
  const base = `${time}-${webhookUrl}`
  return username ? `${base}-${normalizeUsername(username)}` : base
}

export type RegistrationBody = {
  time: number
  webhook_url: string
  username?: string
  signature: string
}

// Body of POST /lnurlpay/{pubkey}. Field names match breez-lnurl's json tags (webhook_url in
// snake_case) and a wrong name is a silent 400. The username must match the one signed.
export function buildRegistrationBody(
  time: number,
  webhookUrl: string,
  signature: string,
  username?: string,
): RegistrationBody {
  const body: RegistrationBody = { time, webhook_url: webhookUrl, signature }
  if (username) {
    body.username = normalizeUsername(username)
  }
  return body
}
