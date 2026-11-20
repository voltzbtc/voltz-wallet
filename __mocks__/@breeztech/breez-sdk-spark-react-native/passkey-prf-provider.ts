/* eslint-env jest */
// The real PasskeyProvider over a fake authenticator, and a stand-in for the Rust client that treats a
// provider the way the generated bridge does. A double that took whatever the provider answers would
// pass a flow the bridge refuses, so this one keeps the bridge's rules:
//   a rejection that is not a PrfProviderError panics, as the SDK has no conversion for it
//   a value the converters cannot lower never answers, as the throw lands after the promise settled
import { NativeModules, Platform } from 'react-native'
import { entropyToMnemonic } from 'bip39'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  DomainAssociation_Tags,
  PasskeyAvailability_Tags,
  PasskeyError,
  PrfProviderError,
  PrfProviderError_Tags,
  Seed_Tags,
} from '@breeztech/breez-sdk-spark-react-native'

const LIB = '../../../node_modules/@breeztech/breez-sdk-spark-react-native/lib/commonjs'

jest.mock('../../../node_modules/@breeztech/breez-sdk-spark-react-native/lib/commonjs/generated/breez_sdk_spark.js', () => ({
  PasskeyClient: class {},
  PasskeyProviderOptions: { create: (fields: object) => fields },
}))

// The salt of the label directory (derivation.rs).
const DIRECTORY_SALT = '4e594f415354525453414f594e'

type Credential = {
  id: Uint8Array
  rpId: string
  userName: string
  secret: string
  backupEligible: boolean | null
}

type Scripted = { code: string; message: string }

const b64 = (raw: Uint8Array): string => btoa(String.fromCharCode(...raw))
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

// Stands in for the authenticator and for the native module over it, with the module's own argument
// lists and its own answers: base64 strings, null for an absent field, and a rejection with a code.
export const __authenticator = {
  credentials: [] as Credential[],
  supported: true,
  // What createPasskey reports. null is the authenticator that says nothing.
  backupEligible: true as boolean | null,
  // Whether the create ceremony evaluates PRF. Without it the SDK runs a second ceremony to derive.
  prfAtCreate: true,
  failures: { deriveSeeds: [] as Scripted[], createPasskey: [] as Scripted[] },
  // A failure of the SDK itself after the create, which never crossed the provider.
  afterCreate: [] as Error[],
  // Left unanswered when set, as a device that never replies.
  silent: false,
  // Held open until this settles, as a sheet the person has not answered.
  gate: null as Promise<unknown> | null,
  calls: { deriveSeeds: 0, createPasskey: 0, isSupported: 0, checkDomainAssociation: 0 },
  // Set by a call the real native module would end the app on.
  aborted: false,
  lastAllow: [] as string[],
  lastPrefer: undefined as boolean | null | undefined,
  rpIdsAsked: [] as string[],
  reset() {
    releaseSilence()
    this.credentials = []
    this.supported = true
    this.backupEligible = true
    this.prfAtCreate = true
    this.failures = { deriveSeeds: [], createPasskey: [] }
    this.afterCreate = []
    this.silent = false
    this.gate = null
    this.calls = { deriveSeeds: 0, createPasskey: 0, isSupported: 0, checkDomainAssociation: 0 }
    this.aborted = false
    this.lastAllow = []
    this.lastPrefer = undefined
    this.rpIdsAsked = []
    clients.length = 0
    panics.length = 0
    hangs.length = 0
    labelsPublished.length = 0
  },
}

// Answers a silent check at the end of a test, so its three second timer does not outlive the suite.
let releaseSilence: () => void = () => undefined

function evaluate(credential: Credential, salt: string): string {
  return b64(sha256(text(`${credential.rpId}|${credential.secret}|${salt}`)))
}

const fakeNative = {
  isSupported: async () => {
    __authenticator.calls.isSupported++
    return __authenticator.supported
  },
  // iOS declares (rpId, teamId, resolve, reject). Given rpId alone, the TurboModule passes the resolve
  // block as teamId and the app ends on an Objective-C exception (measured on the iOS 26.5 simulator),
  // which no JS catch sees. Android declares (rpId, promise).
  checkDomainAssociation: async (...args: unknown[]) => {
    __authenticator.calls.checkDomainAssociation++
    if (Platform.OS === 'ios' && args.length < 2) {
      __authenticator.aborted = true
      throw new Error('NSInvalidArgumentException: the app would have ended here')
    }
    return { kind: 'Associated' }
  },
  deriveSeeds: async (
    salts: string[],
    rpId: string,
    _rpName: string,
    _userName: string,
    _displayName: string,
    _register: boolean,
    allow: string[],
    prefer: boolean | null,
  ) => {
    __authenticator.calls.deriveSeeds++
    __authenticator.lastAllow = allow
    __authenticator.lastPrefer = prefer
    __authenticator.rpIdsAsked.push(rpId)
    await __authenticator.gate
    const failure = __authenticator.failures.deriveSeeds.shift()
    if (failure) {
      throw failure
    }
    const found = __authenticator.credentials.find(
      c => c.rpId === rpId && (allow.length === 0 || allow.includes(b64(c.id))),
    )
    if (!found) {
      throw { code: 'ERR_NO_CREDENTIAL', message: 'no credential available' }
    }
    return { seeds: salts.map(salt => evaluate(found, salt)), credentialId: b64(found.id) }
  },
  createPasskey: async (
    rpId: string,
    _rpName: string,
    userName: string,
    _displayName: string,
    exclude: string[],
    salts: string[],
  ) => {
    __authenticator.calls.createPasskey++
    __authenticator.rpIdsAsked.push(rpId)
    await __authenticator.gate
    const failure = __authenticator.failures.createPasskey.shift()
    if (failure) {
      throw failure
    }
    if (__authenticator.credentials.some(c => exclude.includes(b64(c.id)))) {
      throw { code: 'ERR_CREDENTIAL_ALREADY_EXISTS', message: 'already registered' }
    }
    const index = __authenticator.credentials.length + 1
    const credential: Credential = {
      id: text(`credential-${index}`),
      rpId,
      userName,
      secret: `secret-${index}`,
      backupEligible: __authenticator.backupEligible,
    }
    __authenticator.credentials.push(credential)
    return {
      credentialId: b64(credential.id),
      userId: null,
      aaguid: null,
      backupEligible: credential.backupEligible,
      seeds: __authenticator.prfAtCreate ? salts.map(salt => evaluate(credential, salt)) : null,
    }
  },
}

let touched = 0

export function __nativeModuleTouched(): number {
  return touched
}

Object.defineProperty(NativeModules, 'BreezSdkSparkPasskey', {
  configurable: true,
  get() {
    touched++
    return fakeNative
  },
})

const actual = jest.requireActual(`${LIB}/passkey-prf-provider.js`)

export const PasskeyProvider = actual.PasskeyProvider
export const PasskeyPrfException = actual.PasskeyPrfException

export const __panics: string[] = []
export const __hangs: string[] = []
export const __labelsPublished: string[] = []
const panics = __panics
const hangs = __hangs
const labelsPublished = __labelsPublished

type Config = { defaultLabel?: string; providerOptions?: { rpId?: string; rpName?: string; userName?: string } }

export const __clients: { apiKey: string | undefined; config: Config | undefined }[] = []
const clients = __clients

function bytes(value: unknown): void {
  if (typeof (value as ArrayBuffer | null)?.byteLength !== 'number') {
    throw new TypeError('cannot read byteLength')
  }
}

function optional(value: unknown, item: (v: unknown) => void): void {
  if (value !== undefined) {
    item(value)
  }
}

// A rejection crossing the callback, and the values crossing back, by the generated converters.
function cross<T>(method: string, call: () => Promise<T>, lower: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    call().then(
      value => {
        try {
          lower(value)
        } catch {
          hangs.push(method)
          return
        }
        resolve(value)
      },
      (err: Error) => {
        if (PrfProviderError.instanceOf(err as never)) {
          reject(err)
          return
        }
        panics.push(`${method}: ${err.message}`)
        reject(Object.assign(new Error(err.message), { name: 'RustPanic' }))
      },
    )
  })
}

type Provider = {
  deriveSeeds: (request: {
    salts: string[]
    allowCredentials: ArrayBuffer[]
    preferImmediatelyAvailableCredentials?: boolean
  }) => Promise<{ seeds: ArrayBuffer[]; credentialId?: ArrayBuffer }>
  isSupported: () => Promise<boolean>
  createPasskey: (
    exclude: ArrayBuffer[],
    salts: string[],
  ) => Promise<{
    credential: { credentialId: ArrayBuffer; userId?: ArrayBuffer; aaguid?: ArrayBuffer; backupEligible?: boolean }
    seeds?: ArrayBuffer[]
  }>
  checkDomainAssociation: () => Promise<{ tag?: string; inner?: { source: string; reason: string } }>
}

const prfOf = (err: unknown): unknown =>
  PrfProviderError.instanceOf(err as never) ? new PasskeyError.Prf(err as never) : err

// The twelve words of derivation.rs: the first sixteen bytes of the label's output.
function seedOf(output: ArrayBuffer): { tag: Seed_Tags; inner: { mnemonic: string; passphrase: undefined } } {
  const entropy = Buffer.from(new Uint8Array(output).slice(0, 16)).toString('hex')
  return { tag: Seed_Tags.Mnemonic, inner: { mnemonic: entropyToMnemonic(entropy), passphrase: undefined } }
}

class FakeRustClient {
  constructor(
    private provider: Provider,
    apiKey: string | undefined,
    private config: Config | undefined,
  ) {
    clients.push({ apiKey, config })
  }

  private derive(
    label: string,
    allow: ArrayBuffer[],
    prefer: boolean | undefined,
  ): Promise<{ seeds: ArrayBuffer[]; credentialId?: ArrayBuffer }> {
    return cross(
      'deriveSeeds',
      () =>
        this.provider.deriveSeeds({
          salts: [DIRECTORY_SALT, label],
          allowCredentials: allow,
          preferImmediatelyAvailableCredentials: prefer,
        }),
      value => {
        value.seeds.forEach(bytes)
        optional(value.credentialId, bytes)
      },
    )
  }

  async checkAvailability() {
    if (__authenticator.silent) {
      return new Promise(resolve => {
        releaseSilence = () => resolve({ tag: PasskeyAvailability_Tags.PrfUnsupported })
      })
    }
    const supported = await cross('isSupported', () => this.provider.isSupported(), () => undefined)
    if (!supported) {
      return { tag: PasskeyAvailability_Tags.PrfUnsupported }
    }
    const association = await cross('checkDomainAssociation', () => this.provider.checkDomainAssociation(), value => {
      if (!Object.values(DomainAssociation_Tags).includes(value.tag as DomainAssociation_Tags)) {
        throw new Error('UnexpectedEnumCase')
      }
    })
    return association.tag === DomainAssociation_Tags.NotAssociated
      ? { tag: PasskeyAvailability_Tags.NotAssociated, inner: association.inner }
      : {
          tag:
            association.tag === DomainAssociation_Tags.Skipped
              ? PasskeyAvailability_Tags.Skipped
              : PasskeyAvailability_Tags.Available,
        }
  }

  async signIn(request: {
    label?: string
    allowCredentials?: ArrayBuffer[]
    preferImmediatelyAvailableCredentials?: boolean
  }) {
    const label = request.label ?? this.config?.defaultLabel ?? 'Default'
    try {
      const output = await this.derive(
        label,
        request.allowCredentials ?? [],
        request.preferImmediatelyAvailableCredentials,
      )
      return {
        wallet: { seed: seedOf(output.seeds[1]), label },
        labels: [],
        credential: output.credentialId
          ? { credentialId: output.credentialId, userId: undefined, aaguid: undefined, backupEligible: undefined }
          : undefined,
      }
    } catch (err) {
      throw prfOf(err)
    }
  }

  async register(request: { label?: string; excludeCredentials?: ArrayBuffer[] }) {
    const label = request.label ?? this.config?.defaultLabel ?? 'Default'
    const salts = [DIRECTORY_SALT, label]
    let created
    try {
      created = await cross(
        'createPasskey',
        () => this.provider.createPasskey(request.excludeCredentials ?? [], salts),
        value => {
          bytes(value.credential.credentialId)
          optional(value.credential.userId, bytes)
          optional(value.credential.aaguid, bytes)
          optional(value.seeds, seeds => (seeds as ArrayBuffer[]).forEach(bytes))
        },
      )
    } catch (err) {
      throw prfOf(err)
    }
    const after = __authenticator.afterCreate.shift()
    if (after) {
      throw after
    }
    labelsPublished.push(label)
    if (created.seeds?.length === salts.length) {
      return { wallet: { seed: seedOf(created.seeds[1]), label }, credential: created.credential }
    }
    try {
      const output = await this.derive(label, [created.credential.credentialId], undefined)
      return { wallet: { seed: seedOf(output.seeds[1]), label }, credential: created.credential }
    } catch (err) {
      if (PrfProviderError.instanceOf(err as never)) {
        throw new PasskeyError.CreatedButNotDerived({
          credentialId: created.credential.credentialId,
          source: err as never,
        })
      }
      throw err
    }
  }

  async connectWithPasskey(request: { label?: string; allowCredentials?: ArrayBuffer[] }) {
    try {
      return await this.signIn({
        label: request.label,
        allowCredentials: request.allowCredentials,
        preferImmediatelyAvailableCredentials: true,
      })
    } catch (err) {
      const prf = (err as { inner?: [{ tag?: string }] }).inner?.[0]
      if (prf?.tag !== PrfProviderError_Tags.CredentialNotFound) {
        throw err
      }
    }
    const registered = await this.register({ label: request.label })
    return { ...registered, labels: [] }
  }
}

export class PasskeyClientBuilder {
  private provider?: Provider

  constructor(
    private readonly apiKey?: string,
    private readonly config?: Config,
  ) {}

  withPrfProvider(provider: Provider): this {
    this.provider = provider
    return this
  }

  build(): FakeRustClient {
    return new FakeRustClient(
      this.provider ?? (new PasskeyProvider(this.config?.providerOptions ?? {}) as unknown as Provider),
      this.apiKey,
      this.config,
    )
  }
}

export const PasskeyClient = function (apiKey?: string, config?: Config) {
  return new PasskeyClientBuilder(apiKey, config).build()
} as unknown as new (apiKey?: string, config?: Config) => FakeRustClient
