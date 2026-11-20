import { NativeModules } from 'react-native'

// Isolates the native NFC binding so screens never import react-native-nfc-manager directly.
//
// That package builds a NativeEventEmitter at module-init time, which throws when the native module
// is not linked, and try/catch around require() cannot catch it because Metro reports init-time
// throws straight to LogBox. Nothing here may reference the package statically, type imports
// included, since the bundler can emit those as an eager require.

// Only what this file reads. The record is passed opaquely to Ndef.isType, which inspects tnf/type.
type NdefRecordLike = { payload?: number[]; tnf?: number; type?: number[] }

type NfcApi = {
  manager: {
    start(): Promise<void>
    isSupported(): Promise<boolean>
    isEnabled(): Promise<boolean>
    requestTechnology(tech: unknown, options: { alertMessage: string }): Promise<unknown>
    getTag(): Promise<{ ndefMessage?: NdefRecordLike[] } | null>
    cancelTechnologyRequest(): Promise<void>
    // Android only; the iOS manager has no such method, since iOS has no NFC switch.
    goToNfcSetting?(): Promise<boolean>
  }
  Ndef: {
    TNF_WELL_KNOWN: number
    RTD_URI: string
    RTD_TEXT: string
    isType(record: NdefRecordLike, tnf: number, rtd: string): boolean
    uri: { decodePayload(data: Uint8Array): string }
    text: { decodePayload(data: Uint8Array): string }
  }
  tech: { Ndef: unknown }
  // What a Cancel on the iOS reading sheet rejects with. Read off the loaded module for the same
  // reason as the rest, and absent when the package does not export it.
  UserCancel?: new (...args: never[]) => Error
}

// undefined = not tried yet; null = tried and unavailable.
let cached: NfcApi | null | undefined
let startup: Promise<void> | null = null

function loadNfc(): NfcApi | null {
  if (cached !== undefined) {
    return cached
  }
  // Gate on the native module first, because requiring the wrapper without it throws
  // uncatchably (see file header).
  if (NativeModules.NfcManager == null) {
    cached = null
    return cached
  }
  try {
    const mod = require('react-native-nfc-manager')
    const manager = mod.default ?? mod
    cached = { manager, Ndef: mod.Ndef, tech: mod.NfcTech, UserCancel: mod.NfcError?.UserCancel }
  } catch {
    cached = null
  }
  return cached
}

function ensureStarted(nfc: NfcApi): Promise<void> {
  if (!startup) {
    startup = nfc.manager.start()
  }
  return startup
}

// What Send can offer by tapping. 'off' is hardware the person switched off, which only happens on
// Android: the library answers enabled on iOS. A failed check counts as no NFC, which hides the chip.
export type NfcState = 'unsupported' | 'off' | 'on'

export async function nfcState(): Promise<NfcState> {
  const nfc = loadNfc()
  if (!nfc) {
    return 'unsupported'
  }
  try {
    await ensureStarted(nfc)
    if (!(await nfc.manager.isSupported())) {
      return 'unsupported'
    }
    return (await nfc.manager.isEnabled()) ? 'on' : 'off'
  } catch {
    return 'unsupported'
  }
}

// Opens the system NFC setting. False when it could not be opened, and always on iOS, which has none.
export async function openNfcSettings(): Promise<boolean> {
  const nfc = loadNfc()
  if (!nfc?.manager.goToNfcSetting) {
    return false
  }
  try {
    return await nfc.manager.goToNfcSetting()
  } catch {
    return false
  }
}

function decodeRecord(nfc: NfcApi, record: NdefRecordLike): string | null {
  const payload = Uint8Array.from(record.payload ?? [])
  try {
    if (nfc.Ndef.isType(record, nfc.Ndef.TNF_WELL_KNOWN, nfc.Ndef.RTD_URI)) {
      return nfc.Ndef.uri.decodePayload(payload)
    }
    if (nfc.Ndef.isType(record, nfc.Ndef.TNF_WELL_KNOWN, nfc.Ndef.RTD_TEXT)) {
      return nfc.Ndef.text.decodePayload(payload)
    }
  } catch {
    return null
  }
  return null
}

// What a read came to. `noAddress` is a tag that was reached and carries nothing to pay, or one the
// reader could not connect to, which the library answers with no technology at all. `busy` is a read
// refused because another holds the reader, and that other read owns whatever is on screen.
export type NfcRead =
  | { kind: 'address'; value: string }
  | { kind: 'noAddress' }
  | { kind: 'cancelled' }
  | { kind: 'busy' }

const NO_ADDRESS: NfcRead = { kind: 'noAddress' }
const CANCELLED: NfcRead = { kind: 'cancelled' }
const BUSY: NfcRead = { kind: 'busy' }

type Session = { cancelled: boolean; aborted: Promise<void>; abort: () => void }

// The read that holds the reader. Android keeps one request and answers a second with an error, and
// it has no timeout or interface of its own, so the guard lives here, whatever a screen draws.
let reading: Session | null = null
// The reader's release, which Android holds for a second before it unregisters. A request made inside
// that second would be unregistered under its feet, so the next read waits for it.
let released: Promise<void> = Promise.resolve()

function openSession(): Session {
  let abort = () => {}
  const aborted = new Promise<void>(resolve => {
    abort = resolve
  })
  return { cancelled: false, aborted, abort }
}

function firstAddress(nfc: NfcApi, records: NdefRecordLike[]): string | null {
  for (const record of records) {
    const decoded = decodeRecord(nfc, record)
    if (decoded && decoded.trim().length > 0) {
      return decoded.trim()
    }
  }
  return null
}

// `alertMessage` is the line iOS prints on its reading sheet. Without it the library shows its own
// default, in English, whatever the app's language. Android draws nothing, so its screen brings its
// own sheet, and a Cancel there arrives through cancelNfcRead.
//
// A Cancel on the iOS sheet answers `cancelled`, because the person chose to stop and there is no
// failure to show. The rejection it arrives as carries no message, so it is told apart by its class
// and nothing else. A cancelled read answers `cancelled` whatever the tag says afterwards, and it
// does so at once: the request can stay out for good when a cancel reaches the native side first.
//
// The result does not wait for the release, or Android's second would keep the sheet up over a tag
// already read.
export async function readNfcDestination(alertMessage: string): Promise<NfcRead> {
  const nfc = loadNfc()
  if (!nfc) {
    return CANCELLED
  }
  if (reading) {
    return BUSY
  }
  const session = openSession()
  reading = session
  let requested = false
  try {
    await Promise.race([Promise.all([ensureStarted(nfc), released]), session.aborted])
    if (session.cancelled) {
      return CANCELLED
    }
    requested = true
    const request = nfc.manager.requestTechnology(nfc.tech.Ndef, { alertMessage })
    // A cancel can leave this behind, and its rejection then has nobody to go to.
    request.catch(() => undefined)
    const connected = await Promise.race([request, session.aborted])
    if (session.cancelled) {
      return CANCELLED
    }
    if (connected === null || connected === undefined) {
      return NO_ADDRESS
    }
    const tagRead = nfc.manager.getTag()
    tagRead.catch(() => undefined)
    const tag = await Promise.race([tagRead, session.aborted])
    if (session.cancelled || !tag) {
      return session.cancelled ? CANCELLED : NO_ADDRESS
    }
    const address = firstAddress(nfc, tag.ndefMessage ?? [])
    return address === null ? NO_ADDRESS : { kind: 'address', value: address }
  } catch (cause) {
    if (session.cancelled || (nfc.UserCancel && cause instanceof nfc.UserCancel)) {
      return CANCELLED
    }
    throw cause
  } finally {
    reading = null
    if (requested) {
      released = nfc.manager.cancelTechnologyRequest().catch(() => {})
    }
  }
}

// Ends the read in flight, if any, and answers nothing: the read itself resolves as cancelled and lets
// go of the reader.
export function cancelNfcRead(): void {
  if (reading) {
    reading.cancelled = true
    reading.abort()
  }
}
