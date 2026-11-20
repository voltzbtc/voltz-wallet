import { Buffer } from 'buffer'
import { ed25519 } from '@noble/curves/ed25519.js'
import { Platform } from 'react-native'
import { answerWithin } from './answerWithin'
import { APP_VERSION } from './appVersion'

// A file of versions on the site, signed offline, so the day the SDK or the gateway is the problem
// still has a way to say "update". The one reader of that file. It carries no text and no link: the
// banner's words are fixed strings and its link is the constant below, so whoever holds the key can
// raise one of two banners and nothing else. Silence is the answer to every doubt, and no answer is
// kept: an old file says nothing about today.
const NOTICE_URL = 'https://www.usevoltz.app/app-notice.json'

// Raw Ed25519 key, base64. A rotation is a new version of the app.
const NOTICE_PUBLIC_KEY = 'j3jbF8qnDOab7QTM/EzhnA44vXi7opLfc42p0v8Di2o='

// Keeps a signature made for this file from being replayed as a statement about anything else.
const SIGNED_PREFIX = 'voltz-notice:v1\n'

const ANSWER_WAIT_MS = 5_000

// A real file is a few hundred bytes. Ed25519 in pure JS hashes on the JS thread, so a larger answer
// is refused before it is hashed.
const MAX_FILE_CHARS = 4_096

// Each store app's own scheme, so a tap hands over to the store and no web page opens.
const STORE_URL = {
  ios: 'itms-apps://apps.apple.com/app/id6825551866',
  android: 'market://details?id=app.usevoltz',
}

// `latest` names what a dismissal of the normal banner is about.
export type UpdateNotice = { level: 'critical' } | { level: 'normal'; latest: string }

export function storeUrl(): string {
  return Platform.OS === 'ios' ? STORE_URL.ios : STORE_URL.android
}

const VERSION = /^\d{1,9}(\.\d{1,9}){0,3}$/

function versionParts(version: unknown): number[] | null {
  return typeof version === 'string' && VERSION.test(version) ? version.split('.').map(Number) : null
}

// Part by part as numbers, since 1.0.10 sorts before 1.0.9 as text. A missing part counts as zero.
function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

export function isOlderVersion(version: string, than: string): boolean {
  const [a, b] = [versionParts(version), versionParts(than)]
  return a !== null && b !== null && compareParts(a, b) < 0
}

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const bytesOf = (text: string, encoding: 'base64' | 'utf8'): Uint8Array =>
  Uint8Array.from(Buffer.from(text, encoding))

// The curve's module is evaluated on this first call: Metro's inlineRequires turns the import above
// into a require at the line that uses it, so its constants never run before Home's first frame.
function signedBy(publicKey: string, payload: Uint8Array, signature: Uint8Array): boolean {
  const prefix = bytesOf(SIGNED_PREFIX, 'utf8')
  const message = new Uint8Array(prefix.length + payload.length)
  message.set(prefix)
  message.set(payload, prefix.length)
  try {
    return ed25519.verify(signature, message, bytesOf(publicKey, 'base64'), { zip215: false })
  } catch {
    return false
  }
}

type Reading = { installed: string; platform: string; publicKey: string }

// What the file says to this install, or null for anything short of a signed, readable answer.
export function noticeFromFile(text: string, reading?: Partial<Reading>): UpdateNotice | null {
  const { installed, platform, publicKey }: Reading = {
    installed: APP_VERSION,
    platform: Platform.OS,
    publicKey: NOTICE_PUBLIC_KEY,
    ...reading,
  }
  if (text.length > MAX_FILE_CHARS) {
    return null
  }
  const file = parsedObject(text)
  if (typeof file?.payload !== 'string' || typeof file.sig !== 'string') {
    return null
  }
  const payload = bytesOf(file.payload, 'base64')
  if (!signedBy(publicKey, payload, bytesOf(file.sig, 'base64'))) {
    return null
  }
  const body = parsedObject(Buffer.from(payload).toString('utf8'))
  if (body?.v !== 1) {
    return null
  }
  const versions = body[platform]
  if (typeof versions !== 'object' || versions === null) {
    return null
  }
  const { latest, critical } = versions as { latest?: unknown; critical?: unknown }
  if (versionParts(installed) === null || versionParts(latest) === null || versionParts(critical) === null) {
    return null
  }
  if (isOlderVersion(installed, critical as string)) {
    return { level: 'critical' }
  }
  return isOlderVersion(installed, latest as string) ? { level: 'normal', latest: latest as string } : null
}

async function fetchNotice(signal: AbortSignal, reading?: Partial<Reading>): Promise<UpdateNotice | null> {
  try {
    // No `cache` option: the fetch polyfill answers no-store with a timestamp in the query string,
    // and the GET carries nothing of the install. The file's own max-age bounds how old it can be.
    const response = await fetch(NOTICE_URL, { method: 'GET', credentials: 'omit', signal })
    return response.ok ? noticeFromFile(await response.text(), reading) : null
  } catch {
    return null
  }
}

export async function readUpdateNotice(reading?: Partial<Reading>): Promise<UpdateNotice | null> {
  const controller = new AbortController()
  const answer = await answerWithin(fetchNotice(controller.signal, reading), ANSWER_WAIT_MS)
  controller.abort()
  return answer
}
