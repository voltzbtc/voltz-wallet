// The app's one reader of the SDK's passkey provider, and of the file that remembers which wallets
// came from a passkey. A passkey only ever produces twelve words: from there they are a seed like any
// other, stored by the same add as typed words, so nothing here connects, stores a seed or goes to a
// server. See docs/passkey.md.

import { Platform } from 'react-native'
import RNFS from 'react-native-fs'
import {
  DomainAssociation,
  PasskeyAvailability_Tags,
  PasskeyConfig,
  PasskeyError,
  PasskeyError_Tags,
  PasskeyProviderOptions,
  PrfProviderError,
  PrfProviderError_Tags,
  Seed_Tags,
  type CreatePasskeyOutput,
  type DeriveSeedsOutput,
  type DeriveSeedsRequest,
  type PasskeyClientInterface,
  type PrfProvider,
  type Wallet,
} from '@breeztech/breez-sdk-spark-react-native'
import { getBreezSparkApiKey } from '../config'
import { isUnconfirmed } from './backupMark'
import { isUnreadableFile, readDurable, serialQueue, writeDurable } from './durableFile'
import { fingerprintFromMnemonicAsync } from './fingerprint'
import { asOwnActivity } from './relock'
import { PRIMARY_ID } from './seed'
import { getActiveWalletId, loadRegistry } from './walletRegistry'

type ProviderModule = typeof import('@breeztech/breez-sdk-spark-react-native/passkey-prf-provider')

// On in the same commit that lists webcredentials:usevoltz.app in VoltzWallet.entitlements. Without
// the entitlement every ceremony fails with a configuration error, whatever the availability check
// said (docs/passkey.md).
export const PASSKEY_LIVE = true

// Each of these goes into what the passkey derives or what the system asks for it. A credential only
// answers for its relying party, and the label is a salt of the derivation, so changing any of them
// leaves every existing passkey without its wallet.
export const PASSKEY_RP_ID = 'usevoltz.app'
export const PASSKEY_RP_NAME = 'Voltz'
export const PASSKEY_LABEL = 'Default'

const USER_DISPLAY_NAME = 'Voltz Wallet'

// iOS has the PRF extension from 18, and Android's Credential Manager path from API 28. Below that
// the provider is never loaded.
const MIN_IOS = 18
const MIN_ANDROID_API = 28

const AVAILABILITY_TIMEOUT_MS = 3000

const FILE = `${RNFS.DocumentDirectoryPath}/passkey-wallets.json`

let forcedLive: boolean | null = null
let availability: Promise<boolean> | null = null
let unclaimed: Unclaimed | null = null

export function passkeyLive(): boolean {
  return forcedLive ?? PASSKEY_LIVE
}

// Whether a screen offers a passkey, known on its first frame. Below the minimums a screen draws what it
// drew before any passkey code, with no skeleton waiting on a check that cannot say yes.
export function passkeyOffered(): boolean {
  return passkeyLive() && meetsMinimum()
}

// For the suite alone, which needs both paths whichever way the switch stands; null goes back to the
// switch. __DEV__ is false in a release bundle and Metro writes NODE_ENV into every bundle it builds,
// so outside Jest this leaves the switch as it is. Each call also forgets the availability answer and
// the unclaimed credential, which a suite would otherwise carry from one test to the next and which a
// killed process does not keep.
export function __setPasskeyLiveForTests(on: boolean | null): void {
  forcedLive = __DEV__ && process.env.NODE_ENV === 'test' ? on : null
  availability = null
  unclaimed = null
}

// Reached only from a function, because this module loads with the app and the provider reads its
// native module as it loads, which a device below the minimum must never do. An import rather than a
// require: Metro resolves a plain require by the package's commonjs condition, which loads a second copy
// of the generated bindings, and a provider handed to that copy lands in a handle map Rust never reads.
function providerModule(): Promise<ProviderModule> {
  return import('@breeztech/breez-sdk-spark-react-native/passkey-prf-provider')
}

function meetsMinimum(): boolean {
  if (Platform.OS === 'ios') {
    return parseFloat(String(Platform.Version)) >= MIN_IOS
  }
  return Platform.OS === 'android' && Number(Platform.Version) >= MIN_ANDROID_API
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer

const toBase64 = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes)))

function fromBase64(text: string): ArrayBuffer {
  return Uint8Array.from(atob(text), char => char.charCodeAt(0)).buffer
}

// The provider rejects with its own exception, which the generated bridge does not take for the
// declared error type. Anything else crossing to Rust is an unexpected callback error, which
// PrfProviderError has no conversion for, so it panics there, and the SDK's release profile aborts
// on panic. It has to cross as the declared type or a dismissed sheet can take the app down.
function declaredError(err: unknown): PrfProviderError {
  if (PrfProviderError.instanceOf(err)) {
    return err
  }
  const { code, message } = err as { code?: string; message?: string }
  const text = message ?? 'passkey provider failed'
  switch (code) {
    case 'userCancelled':
      return new PrfProviderError.UserCancelled()
    case 'userTimedOut':
      return new PrfProviderError.UserTimedOut()
    case 'prfNotSupported':
      return new PrfProviderError.PrfNotSupported()
    case 'noCredential':
      return new PrfProviderError.CredentialNotFound(text)
    case 'configuration':
      return new PrfProviderError.Configuration(text)
    case 'credentialAlreadyExists':
      return new PrfProviderError.CredentialAlreadyExists(text)
    case 'authenticationFailed':
      return new PrfProviderError.AuthenticationFailed(text)
    case 'prfEvaluationFailed':
      return new PrfProviderError.PrfEvaluationFailed(text)
    default:
      return new PrfProviderError.Generic(text)
  }
}

// What the last ceremony created, kept beside the client that ran it, since a sign-in afterwards
// returns only the credential's id.
type Created = {
  credentialId: ArrayBuffer
  aaguid: ArrayBuffer | undefined
  backupEligible: boolean | undefined
}

type Ceremony = { userName: string; created: Created | null }

// A credential the system created that no stored wallet answers for yet, whatever came after it: a
// derive that failed, a Keychain that refused, an answer that landed after the screen left. It sits
// here rather than in a screen because leaving a screen does not undo a registration, and only in
// memory because after a kill Welcome's next tap finds the credential by signing in. Add wallet
// registers directly, so there the credential stays behind a wallet nobody saw.
type Unclaimed = Ceremony & { created: Created }

// The SDK's provider as the generated PrfProvider interface takes it. Besides the errors above, three
// shapes differ from what the bridge lifts and lowers, read in the generated converters: Rust hands
// credential ids as ArrayBuffers, which the provider iterates as Uint8Arrays; the provider answers
// absent fields with null, and the optional converters only take undefined for absent; and it answers
// the domain check with a plain `kind` where the bridge reads `.tag`. A value that cannot be lowered
// throws after the promise settled, so the Rust call would never answer.
function bridgedProvider(inner: InstanceType<ProviderModule['PasskeyProvider']>, ceremony: Ceremony): PrfProvider {
  return {
    async deriveSeeds(request: DeriveSeedsRequest): Promise<DeriveSeedsOutput> {
      try {
        // The system's passkey sheet is the app's own prompt; Android pauses the app under it.
        const output = await asOwnActivity(() =>
          inner.deriveSeeds({
            salts: [...request.salts],
            allowCredentials: request.allowCredentials.map(id => new Uint8Array(id)),
            preferImmediatelyAvailableCredentials: request.preferImmediatelyAvailableCredentials,
          }),
        )
        return {
          seeds: output.seeds.map(toArrayBuffer),
          credentialId: output.credentialId ? toArrayBuffer(output.credentialId) : undefined,
        }
      } catch (err) {
        throw declaredError(err)
      }
    },
    async isSupported(): Promise<boolean> {
      try {
        return await inner.isSupported()
      } catch (err) {
        throw declaredError(err)
      }
    },
    async createPasskey(excludeCredentials: ArrayBuffer[], salts: string[]): Promise<CreatePasskeyOutput> {
      try {
        const output = await asOwnActivity(() =>
          inner.createPasskey(
            excludeCredentials.map(id => new Uint8Array(id)),
            salts,
          ),
        )
        const { credential } = output
        const created: Created = {
          credentialId: toArrayBuffer(credential.credentialId),
          aaguid: credential.aaguid ? toArrayBuffer(credential.aaguid) : undefined,
          backupEligible: credential.backupEligible ?? undefined,
        }
        ceremony.created = created
        unclaimed = { ...ceremony, created }
        return {
          credential: {
            ...created,
            userId: credential.userId ? toArrayBuffer(credential.userId) : undefined,
          },
          seeds: output.seeds ? output.seeds.map(toArrayBuffer) : undefined,
        }
      } catch (err) {
        throw declaredError(err)
      }
    },
    async checkDomainAssociation(): Promise<DomainAssociation> {
      // The iOS module declares (rpId, teamId) and the package passes rpId alone, so the TurboModule
      // hands the resolve block over as teamId and Swift's string bridge raises an Objective-C
      // exception that ends the app. iOS answers Skipped without crossing, and a wrong association
      // file shows at the ceremony as a configuration error (docs/passkey.md).
      if (Platform.OS === 'ios') {
        return new DomainAssociation.Skipped({ reason: 'not asked on iOS' })
      }
      const found = await inner.checkDomainAssociation()
      switch (found.kind) {
        case 'Associated':
          return new DomainAssociation.Associated()
        case 'NotAssociated':
          return new DomainAssociation.NotAssociated({ source: found.source, reason: found.reason })
        default:
          return new DomainAssociation.Skipped({ reason: found.reason })
      }
    },
  }
}

// Unique per registration, because Apple's Passwords treats two passkeys of one domain and user.name
// as one. Never a person's name: the system shows it in its picker and nothing here needs one.
function uniqueUserName(): string {
  return `voltz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// A client per ceremony, since the provider takes the user name when it is built.
async function clientFor(ceremony: Ceremony): Promise<PasskeyClientInterface> {
  const { PasskeyClientBuilder, PasskeyProvider } = await providerModule()
  const providerOptions = PasskeyProviderOptions.create({
    rpId: PASSKEY_RP_ID,
    rpName: PASSKEY_RP_NAME,
    userName: ceremony.userName,
    userDisplayName: USER_DISPLAY_NAME,
  })
  const config = PasskeyConfig.create({ defaultLabel: PASSKEY_LABEL, providerOptions })
  return new PasskeyClientBuilder(getBreezSparkApiKey(), config)
    .withPrfProvider(bridgedProvider(new PasskeyProvider(providerOptions), ceremony))
    .build()
}

// Whether this device can use a passkey at all, asked once for each opening of the app and never
// rejecting. The answer is a yes only for Available and for Skipped, which is what iOS always answers
// (docs/passkey.md). A device that stays silent past the ceiling counts as a no until the next opening.
export function passkeyAvailable(): Promise<boolean> {
  if (!passkeyLive() || !meetsMinimum()) {
    return Promise.resolve(false)
  }
  availability ??= askAvailability()
  return availability
}

async function askAvailability(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const silence = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), AVAILABILITY_TIMEOUT_MS)
  })
  const answer = (async () => {
    const client = await clientFor({ userName: uniqueUserName(), created: null })
    const found = await client.checkAvailability()
    if (found.tag === PasskeyAvailability_Tags.NotAssociated && __DEV__) {
      console.warn(`passkey domain not associated: ${found.inner.source}, ${found.inner.reason}`)
    }
    return found.tag === PasskeyAvailability_Tags.Available || found.tag === PasskeyAvailability_Tags.Skipped
  })().catch(() => false)
  const available = await Promise.race([answer, silence])
  clearTimeout(timer)
  return available
}

// A ceremony that says the device cannot do this outranks an earlier yes.
export function markPasskeyUnavailable(): void {
  availability = Promise.resolve(false)
}

// What a screen acts on, and nothing the SDK said in its own words, which a screen never shows.
//   refused       the sheet was dismissed or timed out, or on iOS a sign-in that found nothing ran past
//                 the package's 300 ms clock (docs/passkey.md); nothing repeats until a new tap
//   noCredential  a sign-in found no passkey
//   unavailable   this device or build cannot do it, so the button goes
//   failed        anything else, which a new tap may get past
export type PasskeyFailureKind = 'refused' | 'noCredential' | 'unavailable' | 'failed'

export class PasskeyFailure extends Error {
  constructor(readonly kind: PasskeyFailureKind) {
    super(`passkey ceremony ended as ${kind}`)
    this.name = 'PasskeyFailure'
  }
}

export function passkeyFailureKind(err: unknown): PasskeyFailureKind {
  return (err as Error | null)?.name === 'PasskeyFailure' ? (err as PasskeyFailure).kind : 'failed'
}

function kindOfPrf(err: PrfProviderError): PasskeyFailureKind {
  switch (err.tag) {
    case PrfProviderError_Tags.UserCancelled:
    case PrfProviderError_Tags.UserTimedOut:
      return 'refused'
    case PrfProviderError_Tags.CredentialNotFound:
      return 'noCredential'
    case PrfProviderError_Tags.PrfNotSupported:
    case PrfProviderError_Tags.Configuration:
      return 'unavailable'
    default:
      return 'failed'
  }
}

function kindOf(err: unknown): PasskeyFailureKind {
  if (!PasskeyError.instanceOf(err)) {
    return 'failed'
  }
  switch (err.tag) {
    case PasskeyError_Tags.Prf:
      return kindOfPrf(err.inner[0])
    case PasskeyError_Tags.CreatedButNotDerived:
      return kindOfPrf(err.inner.source)
    case PasskeyError_Tags.InvalidConfig:
      return 'unavailable'
    default:
      return 'failed'
  }
}

// What the app keeps about a passkey, none of it secret and none of it able to rebuild the words.
export type PasskeyNote = {
  credentialId: string | null
  // Whether the passkey was registered for this wallet here, rather than found by signing in.
  created: boolean
  // Whether a way to create brought the wallet in, sign-in or not, rather than the restore button. A
  // sign-in cannot tell a passkey cut off before its write from a new phone, so only the restore
  // button leaves the words unowed without an authenticator that says the passkey syncs.
  fromCreate: boolean
  // What the authenticator reported at registration, which a sign-in does not carry.
  backupEligible: boolean | null
  aaguid: string | null
  userName: string | null
}

export type PasskeyWallet = { mnemonic: string; note: PasskeyNote }

// A passkey wallet has twelve words and no passphrase. A seed in any other shape is not what the
// derivation promises, and opening it would be a wallet the passkey can no longer reopen.
function wordsOf(wallet: Wallet): string {
  const { seed } = wallet
  if (seed.tag !== Seed_Tags.Mnemonic || seed.inner.passphrase) {
    throw new PasskeyFailure('failed')
  }
  return seed.inner.mnemonic
}

function walletFrom(
  wallet: Wallet,
  credentialId: ArrayBuffer | undefined,
  ceremony: Ceremony,
  mode: PasskeyMode,
): PasskeyWallet {
  const { created, userName } = ceremony
  const id = created?.credentialId ?? credentialId
  return {
    mnemonic: wordsOf(wallet),
    note: {
      credentialId: id ? toBase64(id) : null,
      created: created !== null,
      fromCreate: mode !== 'restore',
      backupEligible: created?.backupEligible ?? null,
      aaguid: created?.aaguid ? toBase64(created.aaguid) : null,
      userName: created ? userName : null,
    },
  }
}

// Welcome's button enters a passkey already here and registers one otherwise, and after a refusal on
// iOS Welcome also offers an explicit register. Add wallet always registers, since signing in would
// land on a wallet this device already holds, and a restore only signs in, showing the system's own way
// to reach another device.
export type PasskeyMode = 'connect' | 'register' | 'restore'

async function firstCeremony(mode: PasskeyMode, ceremony: Ceremony): Promise<PasskeyWallet> {
  const client = await clientFor(ceremony)
  switch (mode) {
    case 'connect': {
      const response = await client.connectWithPasskey({
        label: PASSKEY_LABEL,
        allowCredentials: undefined,
        excludeCredentials: undefined,
      })
      return walletFrom(response.wallet, response.credential?.credentialId, ceremony, mode)
    }
    case 'register': {
      // Left empty on purpose, since listing an existing credential would make the system refuse the wallet.
      const response = await client.register({ label: PASSKEY_LABEL, excludeCredentials: undefined })
      return walletFrom(response.wallet, response.credential?.credentialId, ceremony, mode)
    }
    case 'restore': {
      const response = await client.signIn({
        label: PASSKEY_LABEL,
        allowCredentials: undefined,
        preferImmediatelyAvailableCredentials: false,
      })
      return walletFrom(response.wallet, response.credential?.credentialId, ceremony, mode)
    }
  }
}

// One tap's ceremony, run once per tap. Every tap on a way to make a wallet signs in pinned to an
// unclaimed credential and never registers another, which would strand that one owning a wallet
// nothing points to. A restore takes no pin, since it would hide the passkey the person came for.
export function passkeyAttempt(mode: PasskeyMode): () => Promise<PasskeyWallet> {
  return async function run(): Promise<PasskeyWallet> {
    if (!passkeyLive()) {
      throw new PasskeyFailure('unavailable')
    }
    const pinned = mode === 'restore' ? null : unclaimed
    const ceremony: Ceremony = pinned ?? { userName: uniqueUserName(), created: null }
    try {
      if (!pinned) {
        return await firstCeremony(mode, ceremony)
      }
      const client = await clientFor(ceremony)
      const response = await client.signIn({
        label: PASSKEY_LABEL,
        allowCredentials: [pinned.created.credentialId],
        preferImmediatelyAvailableCredentials: undefined,
      })
      return walletFrom(response.wallet, response.credential?.credentialId, ceremony, mode)
    } catch (err) {
      if (err instanceof PasskeyFailure) {
        throw err
      }
      throw new PasskeyFailure(kindOf(err))
    }
  }
}

// A stored wallet claims the credential it came from, and only that one: another passkey's wallet
// leaves it waiting, and a claimed one left here would pin the next new wallet to this one's words.
export function passkeyWalletStored(note: PasskeyNote): void {
  if (unclaimed && toBase64(unclaimed.created.credentialId) === note.credentialId) {
    unclaimed = null
  }
}

export type PasskeyEntry = PasskeyNote & {
  rpId: string
  label: string
  // Of the words the passkey gave, which is what a test of the passkey compares against.
  fingerprint: string
  at: number
}

type Entries = Record<string, PasskeyEntry>

const valid = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value)

const serial = serialQueue()

// Written before the seed, so a cut first write stands behind no wallet.
const read = async (): Promise<Entries> => ((await readDurable(FILE, valid, 'nothing')) as Entries | null) ?? {}

const save = (entries: Entries): Promise<void> =>
  writeDurable(FILE, JSON.stringify(entries), valid, 'replace', 'nothing')

// What a writer starts from. Losing the file costs a row in Edit wallet and no key, since the passkey
// still derives the same words, so a torn file is written over. A read the platform refused says
// nothing about the file, and writing then would lose the other entries.
async function forWriting(): Promise<Entries> {
  try {
    return await read()
  } catch (err) {
    if (!isUnreadableFile(err)) {
      throw err
    }
    return {}
  }
}

// Goes in before the seed, for the reason the backup mark does: a kill between the two leaves an entry
// no wallet answers to, which `passkeyEntryFor` ignores by its fingerprint, and never a wallet that
// owes its words with nothing saying so. A sign-in carries no attestation, so what an earlier write
// recorded for the same words stays.
export async function notePasskeyWallet(id: string, fingerprint: string, note: PasskeyNote): Promise<void> {
  await serial(async () => {
    const entries = await forWriting()
    const earlier = entries[id]?.fingerprint === fingerprint ? entries[id] : undefined
    entries[id] = {
      ...note,
      credentialId: note.credentialId ?? earlier?.credentialId ?? null,
      created: note.created || (earlier?.created ?? false),
      fromCreate: note.fromCreate || (earlier?.fromCreate ?? false),
      backupEligible: note.backupEligible ?? earlier?.backupEligible ?? null,
      aaguid: note.aaguid ?? earlier?.aaguid ?? null,
      userName: note.userName ?? earlier?.userName ?? null,
      rpId: PASSKEY_RP_ID,
      label: PASSKEY_LABEL,
      fingerprint,
      at: earlier?.at ?? Date.now(),
    }
    await save(entries)
  })
}

export async function forgetPasskeyWallet(id: string): Promise<void> {
  await serial(async () => {
    const entries = await forWriting()
    if (id in entries) {
      delete entries[id]
      await save(entries)
    }
  })
}

// The entry of a listed wallet, or null. An entry whose fingerprint is not the listed wallet's was left
// by a write the seed never followed, and the id has since gone to other words.
export async function passkeyEntryFor(id: string): Promise<PasskeyEntry | null> {
  const entry = (await serial(read))[id]
  if (!entry) {
    return null
  }
  const { wallets } = await loadRegistry()
  return wallets.find(wallet => wallet.id === id)?.fingerprint === entry.fingerprint ? entry : null
}

// Without an authenticator that says the passkey syncs, this device may hold the only way back to the
// wallet, so the words are owed until they are proved, apart from the restore button, which keeps only
// the mark. Read from the mark rather than kept here, so a confirmation from any screen settles it.
// This never rejects, so the mark's own card stays for a read that fails.
export async function passkeyWordsOwed(id: string): Promise<boolean> {
  if (!passkeyLive()) {
    return false
  }
  const entry = await passkeyEntryFor(id).catch(() => null)
  return entry !== null && entry.fromCreate && entry.backupEligible !== true && (await isUnconfirmed(id))
}

// The active wallet when it owes its words, for a boot that was cut before they were proved.
export async function activeWalletOwingWords(): Promise<string | null> {
  if (!passkeyLive()) {
    return null
  }
  const id = (await getActiveWalletId().catch(() => null)) ?? PRIMARY_ID
  return (await passkeyWordsOwed(id)) ? id : null
}

// The line that says where a passkey is deleted, for a wallet that has one, since removing a wallet
// cannot reach it. The key is the one a screen translates.
export async function passkeyRemovalNote(id: string): Promise<'passkey.deleteIos' | 'passkey.deleteAndroid' | null> {
  if (!passkeyLive() || !(await passkeyEntryFor(id).catch(() => null))) {
    return null
  }
  return Platform.OS === 'ios' ? 'passkey.deleteIos' : 'passkey.deleteAndroid'
}

export type PasskeyCheck = 'same' | 'other' | 'unknown'

// Answers the one question the app cannot settle alone, whether the passkey still opens this wallet.
// Only a fingerprint read back from the words says so, and a failed ceremony says nothing either way.
export async function checkPasskey(entry: PasskeyEntry): Promise<PasskeyCheck> {
  // The note can arrive on a device below the minimum in a backup, and loading the provider there is
  // what the minimum exists to prevent.
  if (!passkeyLive() || !meetsMinimum()) {
    return 'unknown'
  }
  try {
    const ceremony: Ceremony = { userName: uniqueUserName(), created: null }
    const client = await clientFor(ceremony)
    const response = await client.signIn({
      label: PASSKEY_LABEL,
      allowCredentials: entry.credentialId ? [fromBase64(entry.credentialId)] : undefined,
      preferImmediatelyAvailableCredentials: undefined,
    })
    const fingerprint = await fingerprintFromMnemonicAsync(wordsOf(response.wallet))
    return fingerprint === entry.fingerprint ? 'same' : 'other'
  } catch {
    return 'unknown'
  }
}
