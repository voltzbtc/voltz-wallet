/* eslint-env jest */
// Native binding, absent in Jest; auto-mocked for the whole package. __sdkInstance is exported so
// tests can drive per-call returns (jest.mocked(__sdkInstance.receivePayment).mockResolvedValue(...)).

// A register or a claim with no description reaches the deployed LNURL server signed over an empty
// field and sent as null, which it refuses.
function refuseWithoutDescription(description: string | undefined): void {
  if (description === undefined) {
    throw new Error('server refused the request with 401: invalid signature')
  }
}

// Connected SDK instance. balanceSats and fees are bigint, matching the real binding.
export const __sdkInstance = {
  getInfo: jest.fn(async () => ({
    identityPubkey: '',
    balanceSats: 0n,
    recoverableFundsSats: 0n,
    tokenBalances: new Map(),
    // A failed sync's reason, gone after each connect, and when a sync last worked, kept across connects.
    lastSyncError: undefined as { tag: SyncError_Tags; inner: { message: string } } | undefined,
    lastSyncedAt: undefined as bigint | undefined,
  })),
  addEventListener: jest.fn(async () => 'listener_1'),
  // Answers Ok whatever the sync did: a failure rides in lastSyncError, as in the real binding.
  syncWallet: jest.fn(async () => ({
    lastSyncError: undefined as { tag: SyncError_Tags; inner: { message: string } } | undefined,
    lastSyncedAt: undefined as bigint | undefined,
  })),
  removeEventListener: jest.fn(async () => undefined),
  receivePayment: jest.fn(async () => ({ paymentRequest: 'lnbc0', fee: 0n })),
  parse: jest.fn(async () => ({ tag: 'Bolt11Invoice' })),
  prepareSendPayment: jest.fn(async () => ({
    paymentMethod: { tag: 'Bolt11Invoice', inner: { lightningFeeSats: 0n, sparkTransferFeeSats: 0n } },
    amount: 0n,
  })),
  sendPayment: jest.fn(async () => ({ payment: { status: 0 } })),
  getTokensMetadata: jest.fn(async () => ({ tokensMetadata: [] })),
  fetchConversionLimits: jest.fn(async () => ({ minFromAmount: undefined, minToAmount: undefined })),
  listPayments: jest.fn(async () => ({ payments: [] })),
  getPayment: jest.fn(async () => ({
    payment: { id: 'p0', paymentType: 1, status: 0, amount: 0n, fees: 0n, timestamp: 0n, method: 5 },
  })),
  listFiatRates: jest.fn(async () => ({ rates: [] })),
  listFiatCurrencies: jest.fn(async () => ({ currencies: [] })),
  buyBitcoin: jest.fn(async () => ({ url: 'https://buy.moonpay/session' })),
  getLightningAddress: jest.fn(async () => undefined),
  checkLightningAddressAvailable: jest.fn(async () => true),
  registerLightningAddress: jest.fn(async (req: { username: string; description?: string }) => {
    refuseWithoutDescription(req.description)
    return {
      username: req.username,
      lightningAddress: `${req.username}@breez.tips`,
      lnurl: { url: 'https://breez.tips/.well-known/lnurlp', bech32: 'lnurl1registered' },
      description: req.description,
    }
  }),
  claimLightningAddressTransfer: jest.fn(
    async (req: { authorization: { username: string }; description?: string }) => {
      refuseWithoutDescription(req.description)
      return {
        username: req.authorization.username,
        lightningAddress: `${req.authorization.username}@breez.tips`,
        lnurl: { url: 'https://breez.tips/.well-known/lnurlp', bech32: 'lnurl1claimed' },
        description: req.description,
      }
    },
  ),
  deleteLightningAddress: jest.fn(async () => undefined),
  prepareLnurlPay: jest.fn(async () => ({
    amountSats: 0n,
    feeSats: 0n,
    payRequest: {},
    invoiceDetails: { description: undefined },
    successAction: undefined,
    conversionEstimate: undefined,
    feePolicy: undefined,
  })),
  lnurlPay: jest.fn(async () => ({ payment: { status: 0 }, successAction: undefined })),
  lnurlWithdraw: jest.fn(async () => ({ paymentRequest: 'lnbc0', payment: { status: 0 } })),
  listUnclaimedDeposits: jest.fn(async () => ({ deposits: [] })),
  claimDeposit: jest.fn(async () => ({ outcome: { tag: 'Settled', inner: { payment: { status: 0 } } } })),
  refundDeposit: jest.fn(async () => ({ txId: 'refundtx', txHex: '00' })),
  recommendedFees: jest.fn(async () => ({
    fastestFee: 20n,
    halfHourFee: 10n,
    hourFee: 5n,
    economyFee: 2n,
    minimumFee: 1n,
  })),
  // Nothing to recover, as the SDK answers: no leaves rather than an error.
  prepareRecoverFunds: jest.fn(async () => ({
    leaves: [],
    skipped: [],
    recoverableValueSats: 0n,
    totalFeeSats: 0n,
    cooperativeFeeSats: 0n,
    cpfpFeeSats: 0n,
    fanoutFeeSats: 0n,
    refundFeeSats: 0n,
    sweepFeeSats: 0n,
    funding: undefined,
    feeRateSatPerVbyte: 1n,
    destination: '',
    exitChainState: {
      confirmedNodes: [],
      refunds: [],
      stoppedLeafIds: [],
      unverifiedNodeIds: [],
      unverifiableConfirmedNodeIds: [],
    },
  })),
  // The shape of RecoverFundsResponse, which the SDK fills from the request.
  recoverFunds: jest.fn(
    async (request: { prepared: { feeRateSatPerVbyte: bigint; destination: string }; fundingInputs: unknown[] }) => ({
      recoverableValueSats: 0n,
      totalFeeSats: 0n,
      cooperativeFeeSats: 0n,
      cpfpFeeSats: 0n,
      fanoutFeeSats: 0n,
      refundFeeSats: 0n,
      sweepFeeSats: 0n,
      leaves: [],
      failed: [],
      transactions: [],
      fundingInputs: request.fundingInputs,
      feeRateSatPerVbyte: request.prepared.feeRateSatPerVbyte,
      destination: request.prepared.destination,
    }),
  ),
  checkRecoverFunds: jest.fn(async (request: { recovery: unknown }) => ({
    recovery: request.recovery,
    verdict: { tag: 'Valid' },
  })),
  listContacts: jest.fn(async () => []),
  addContact: jest.fn(async (req: { name: string; paymentIdentifier: string }) => ({
    id: 'c1',
    name: req.name,
    paymentIdentifier: req.paymentIdentifier,
    createdAt: 0n,
    updatedAt: 0n,
  })),
  updateContact: jest.fn(async () => undefined),
  deleteContact: jest.fn(async () => undefined),
  listWebhooks: jest.fn(async () => []),
  registerWebhook: jest.fn(async () => undefined),
  unregisterWebhook: jest.fn(async () => undefined),
  // An undefined stableBalanceActiveLabel means the stable balance is deactivated, not just unset.
  getUserSettings: jest.fn(async () => ({
    sparkPrivateModeEnabled: false,
    stableBalanceActiveLabel: undefined as string | undefined,
  })),
  updateUserSettings: jest.fn(async () => undefined),
  getCrossChainRoutes: jest.fn(async () => []),
  disconnect: jest.fn(async () => undefined),
}

// Union variants are constructed with `new` and keep whatever the real binding carries, a tag or
// constructor fields, so tests can assert what the boundary passed.
export const WebhookEventType = {
  LightningReceiveFinished: class {
    readonly tag = 'LightningReceiveFinished'
  },
  LightningSendFinished: class {
    readonly tag = 'LightningSendFinished'
  },
  CoopExitFinished: class {
    readonly tag = 'CoopExitFinished'
  },
  StaticDepositFinished: class {
    readonly tag = 'StaticDepositFinished'
  },
  Unknown: class {
    readonly tag = 'Unknown'
    readonly inner: readonly [string]
    constructor(name: string) {
      this.inner = [name]
    }
  },
}

export enum WebhookEventType_Tags {
  LightningReceiveFinished = 'LightningReceiveFinished',
  LightningSendFinished = 'LightningSendFinished',
  CoopExitFinished = 'CoopExitFinished',
  StaticDepositFinished = 'StaticDepositFinished',
  Unknown = 'Unknown',
}

export const ExitLeafSelection = {
  All: class {
    readonly tag = 'All'
  },
  RecoverableOnly: class {
    readonly tag = 'RecoverableOnly'
  },
  Specific: class {
    readonly tag = 'Specific'
    readonly inner: Readonly<{ leafIds: string[] }>
    constructor(inner: { leafIds: string[] }) {
      this.inner = Object.freeze({ ...inner })
    }
  },
}

export const CpfpFundingKind = {
  P2wpkh: class {
    readonly tag = 'P2wpkh'
  },
}

export enum CpfpFundingStrategy {
  PerBranch = 0,
  PerNode = 1,
}

export enum CpfpInput_Tags {
  P2wpkh = 'P2wpkh',
  P2tr = 'P2tr',
  Custom = 'Custom',
}

export const CpfpInput = {
  P2wpkh: class {
    readonly tag = 'P2wpkh'
    readonly inner: Readonly<{ txid: string; vout: number; valueSats: bigint; pubkey: string }>
    constructor(inner: { txid: string; vout: number; valueSats: bigint; pubkey: string }) {
      this.inner = Object.freeze({ ...inner })
    }
  },
}

const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

// The real one lowers an ArrayBuffer and goes through SecretKey::from_slice, which refuses anything
// but 32 bytes holding a scalar from 1 to the curve order less one, so a Uint8Array, a short key, an
// all-zero key and a key at or over the order fail here too.
export const singleKeyCpfpSigner = jest.fn((secretKeyBytes: ArrayBuffer) => {
  if (!(secretKeyBytes instanceof ArrayBuffer) || secretKeyBytes.byteLength !== 32) {
    throw new Error('invalid secret key')
  }
  const scalar = [...new Uint8Array(secretKeyBytes)].reduce((sum, byte) => sum * 256n + BigInt(byte), 0n)
  if (scalar === 0n || scalar >= CURVE_ORDER) {
    throw new Error('invalid secret key')
  }
  return { signPsbt: jest.fn(async (psbt: ArrayBuffer) => psbt) }
})

export enum RecoveryMethod {
  Cooperative = 0,
  Unilateral = 1,
}

export enum RecoveryRedoReason {
  OnChainStateDiverged = 0,
}

export enum RecoveryTxKind {
  Cooperative = 0,
  FanOut = 1,
  Node = 2,
  Refund = 3,
  Sweep = 4,
}

export enum ExitTransactionStatus_Tags {
  Confirmed = 'Confirmed',
  Ready = 'Ready',
  WaitingForDependencies = 'WaitingForDependencies',
  WaitingForTimelock = 'WaitingForTimelock',
  Unverified = 'Unverified',
}

export enum RecoveryVerdict_Tags {
  Valid = 'Valid',
  Done = 'Done',
  Redo = 'Redo',
}

export enum SkippedLeafReason_Tags {
  FeeExceedsValue = 'FeeExceedsValue',
  FundsNotFound = 'FundsNotFound',
  Unverified = 'Unverified',
  OperatorsUnavailable = 'OperatorsUnavailable',
  NotRecoverable = 'NotRecoverable',
}

export enum SyncError_Tags {
  Network = 'Network',
  Generic = 'Generic',
}

export enum SdkError_Tags {
  InsufficientCpfpFunds = 'InsufficientCpfpFunds',
  InvalidInput = 'InvalidInput',
}

export const Fee = {
  Fixed: class {
    constructor(public fields?: unknown) {}
  },
  Rate: class {
    constructor(public fields?: unknown) {}
  },
}

export enum MaxOnchainFee_Tags {
  Fixed = 'Fixed',
  Rate = 'Rate',
  NetworkRecommended = 'NetworkRecommended',
}

// MaxFee is the ceiling for auto-claiming on-chain deposits: a record, not a union, whose on-chain part
// is one of these. The real binding freezes inner, so nothing can edit a ceiling after it is built.
export const MaxOnchainFee = {
  Fixed: class {
    readonly tag = MaxOnchainFee_Tags.Fixed
    readonly inner: Readonly<{ amount: bigint }>
    constructor(inner: { amount: bigint }) {
      this.inner = Object.freeze({ ...inner })
    }
  },
  Rate: class {
    readonly tag = MaxOnchainFee_Tags.Rate
    readonly inner: Readonly<{ satPerVbyte: bigint }>
    constructor(inner: { satPerVbyte: bigint }) {
      this.inner = Object.freeze({ ...inner })
    }
  },
  NetworkRecommended: class {
    readonly tag = MaxOnchainFee_Tags.NetworkRecommended
    readonly inner: Readonly<{ leewaySatPerVbyte: bigint }>
    constructor(inner: { leewaySatPerVbyte: bigint }) {
      this.inner = Object.freeze({ ...inner })
    }
  },
}

export const MaxFee = {
  create: (fields: object) => Object.freeze({ proportionalPpm: undefined, ...fields }),
  new: (fields: object) => Object.freeze({ proportionalPpm: undefined, ...fields }),
  defaults: () => ({ proportionalPpm: undefined }),
}

// The fee variant carries the amount the operator asked for, which the manual claim has to clear.
export enum DepositClaimError_Tags {
  MaxDepositClaimFeeExceeded = 'MaxDepositClaimFeeExceeded',
  MissingUtxo = 'MissingUtxo',
  DepositTooSmall = 'DepositTooSmall',
  Generic = 'Generic',
}

export type DepositClaimError = {
  tag: DepositClaimError_Tags
  inner: { requiredFeeSats?: bigint }
}

// A claim answers with one of three outcomes; only a settled one carries the payment.
export enum ClaimDepositOutcome_Tags {
  Settled = 'Settled',
  Submitted = 'Submitted',
  Deferred = 'Deferred',
}

export enum SparkAsset_Tags {
  Bitcoin = 'Bitcoin',
  Token = 'Token',
}

export enum SendPaymentMethod_Tags {
  BitcoinAddress = 'BitcoinAddress',
  Bolt11Invoice = 'Bolt11Invoice',
  SparkAddress = 'SparkAddress',
  SparkInvoice = 'SparkInvoice',
  CrossChainAddress = 'CrossChainAddress',
}

// A deposit credited early stays listed as Claimed until the provider spends its output.
export enum FeePolicy {
  FeesExcluded = 0,
  FeesIncluded = 1,
}

export enum RefundState_Tags {
  BroadcastPending = 'BroadcastPending',
  Broadcast = 'Broadcast',
}

export enum InstantClaimStatus_Tags {
  Declined = 'Declined',
  Submitted = 'Submitted',
  Claimed = 'Claimed',
}

export const connect = jest.fn(async () => __sdkInstance)
// The SDK's own default carries a proportional part, so a config that keeps any of it shows here.
export const defaultConfig = jest.fn(() => ({
  lnurlDomain: 'breez.tips',
  maxDepositClaimFee: { onchain: new MaxOnchainFee.Rate({ satPerVbyte: 1n }), proportionalPpm: 1000 },
  // The SDK's defaults (LeafOptimizationConfig in the binding): on, multiplicity 1.
  leafOptimizationConfig: { autoEnabled: true, multiplicity: 1 },
}))

export const Network = { Mainnet: 0, Regtest: 1 } as const

export enum BitcoinNetwork {
  Bitcoin = 0,
  Testnet3 = 1,
  Testnet4 = 2,
  Signet = 3,
  Regtest = 4,
}
export const PaymentStatus = { Completed: 0, Pending: 1, Failed: 2 } as const
export const PaymentType = { Send: 0, Receive: 1 } as const
export const PaymentMethod = {
  Lightning: 0,
  Spark: 1,
  Token: 2,
  Deposit: 3,
  Withdraw: 4,
  Unknown: 5,
} as const

// String enum in the real binding, unlike the numeric enums above.
// Which direction a conversion runs. The token -> BTC leg is what lets a dollar-only wallet
// pay a sats invoice, so the send code branches on it.
export const ConversionType_Tags = {
  ToBitcoin: 'ToBitcoin',
  FromBitcoin: 'FromBitcoin',
}

// Numeric in the real binding. Only an AMM step is the wallet converting its own balance.
export const ConversionProvider = { Amm: 0, Orchestra: 1, Boltz: 2 } as const
export const ConversionStatus = { Pending: 0, Completed: 1, Failed: 2, RefundNeeded: 3, Refunded: 4 } as const

export enum ConversionInfo_Tags {
  Amm = 'Amm',
  Orchestra = 'Orchestra',
  Boltz = 'Boltz',
}

export enum SuccessActionProcessed_Tags {
  Aes = 'Aes',
  Message = 'Message',
  Url = 'Url',
}

export enum AesSuccessActionDataResult_Tags {
  Decrypted = 'Decrypted',
  ErrorStatus = 'ErrorStatus',
}

export enum ConversionPurpose_Tags {
  OngoingPayment = 'OngoingPayment',
  SelfTransfer = 'SelfTransfer',
  AutoConversion = 'AutoConversion',
}

export const SdkEvent_Tags = {
  Synced: 'Synced',
  UnclaimedDeposits: 'UnclaimedDeposits',
  ClaimedDeposits: 'ClaimedDeposits',
  PaymentSucceeded: 'PaymentSucceeded',
  PaymentPending: 'PaymentPending',
  PaymentFailed: 'PaymentFailed',
  AutoOptimization: 'AutoOptimization',
  LightningAddressChanged: 'LightningAddressChanged',
  NewDeposits: 'NewDeposits',
  PaymentMetadataUpdated: 'PaymentMetadataUpdated',
  UnilateralExitStateChanged: 'UnilateralExitStateChanged',
  StableBalanceConversionFailed: 'StableBalanceConversionFailed',
  RecoverableFunds: 'RecoverableFunds',
} as const

export enum StableBalanceConversionKind {
  PerReceive = 0,
  AutoConvert = 1,
  Deactivation = 2,
}

export const ReceivePaymentMethod = {
  Bolt11Invoice: class {
    constructor(public fields?: unknown) {}
  },
  BitcoinAddress: class {
    constructor(public fields?: unknown) {}
  },
  SparkAddress: class {
    constructor(public fields?: unknown) {}
  },
  // SparkInvoice amounts are sats, or the token's base units when tokenIdentifier is set.
  SparkInvoice: class {
    constructor(public fields?: unknown) {}
  },
  // A stablecoin paid in on another chain, delivered to this wallet's Spark address.
  CrossChain: class {
    constructor(public fields?: unknown) {}
  },
}

export const PaymentRequest = {
  Input: class {
    constructor(public fields?: unknown) {}
  },
  CrossChain: class {
    constructor(public fields?: unknown) {}
  },
}

export const OnchainConfirmationSpeed = { Fast: 0, Medium: 1, Slow: 2 } as const

export const SendPaymentOptions = {
  BitcoinAddress: class {
    constructor(public fields?: unknown) {}
  },
  Bolt11Invoice: class {
    constructor(public fields?: unknown) {}
  },
}

export enum DeliveryMethod {
  Spark = 0,
  Lightning = 1,
  Bitcoin = 2,
}

export const CrossChainRouteFilter = {
  Send: class {
    constructor(public fields?: unknown) {}
  },
  Receive: class {
    constructor(public fields?: unknown) {}
  },
}

// The Spark-side asset a cross-chain receive lands as.
export const SparkAsset = {
  Bitcoin: class {
    readonly tag = 'Bitcoin'
  },
  Token: class {
    readonly tag = 'Token'
    constructor(public inner: { tokenIdentifier: string }) {}
  },
}

export const AssetFilter = {
  Bitcoin: class {
    readonly tag = 'Bitcoin'
  },
  Token: class {
    readonly tag = 'Token'
    constructor(public inner: { tokenIdentifier: string | undefined }) {}
  },
}

export const StableBalanceActiveLabel = {
  Set: class {
    readonly tag = 'Set'
    constructor(public inner: { label: string }) {}
  },
  Unset: class {
    readonly tag = 'Unset'
  },
}

export const BuyBitcoinRequest = {
  Moonpay: class {
    constructor(public fields?: unknown) {}
  },
}

export enum MoonpayDelivery_Tags {
  Bitcoin = 'Bitcoin',
  CrossChain = 'CrossChain',
}

export const MoonpayDelivery = {
  Bitcoin: class {
    readonly tag = MoonpayDelivery_Tags.Bitcoin
    readonly inner: Readonly<{ amountSat: bigint | undefined }>
    constructor(inner: { amountSat: bigint | undefined }) {
      this.inner = Object.freeze({ ...inner })
    }
  },
  CrossChain: class {
    readonly tag = MoonpayDelivery_Tags.CrossChain
    readonly inner: Readonly<{ amount: bigint; feeMode: unknown }>
    constructor(inner: { amount: bigint; feeMode: unknown }) {
      this.inner = Object.freeze({ ...inner })
    }
  },
}

export const ConversionType = {
  FromBitcoin: class {
    readonly tag = 'FromBitcoin'
  },
  ToBitcoin: class {
    readonly tag = 'ToBitcoin'
    constructor(public inner: { fromTokenIdentifier: string }) {}
  },
}
export const ConversionOptions = {
  create: jest.fn((fields: unknown) => fields),
}

export const Seed = {
  Mnemonic: {
    new: jest.fn((fields: unknown) => fields),
  },
}

// The passkey half of the binding, in the shapes the generated code gives them: a tagged class whose
// text is in `inner`, and an `instanceOf` that reads a type name a plain Error does not carry.
const TYPE_NAME = Symbol('uniffiTypeName')

function taggedError(typeName: string, tag: string, inner: unknown) {
  const err = new Error(`${typeName}.${tag}`) as Error & { tag: string; inner: unknown; [TYPE_NAME]: string }
  err.tag = tag
  err.inner = inner
  err[TYPE_NAME] = typeName
  return err
}

export enum SdkError_Tags {
  DepositTooSmall = 'DepositTooSmall',
  StorageError = 'StorageError',
  Generic = 'Generic',
}

// Only the variant the app reads by its tag. Like the real one, its message names the class alone.
export const SdkError = {
  instanceOf: (obj: { [TYPE_NAME]?: string }) => obj[TYPE_NAME] === 'SdkError',
  DepositTooSmall: function (inner: { tx: string; vout: number; docsUrl: string }) {
    return taggedError('SdkError', SdkError_Tags.DepositTooSmall, inner)
  } as unknown as new (inner: { tx: string; vout: number; docsUrl: string }) => Error,
  StorageError: function (text: string) {
    return taggedError('SdkError', SdkError_Tags.StorageError, [text])
  } as unknown as new (text: string) => Error,
  Generic: function (text: string) {
    return taggedError('SdkError', SdkError_Tags.Generic, [text])
  } as unknown as new (text: string) => Error,
}

export enum PrfProviderError_Tags {
  PrfNotSupported = 'PrfNotSupported',
  UserCancelled = 'UserCancelled',
  UserTimedOut = 'UserTimedOut',
  CredentialNotFound = 'CredentialNotFound',
  AuthenticationFailed = 'AuthenticationFailed',
  PrfEvaluationFailed = 'PrfEvaluationFailed',
  Configuration = 'Configuration',
  CredentialAlreadyExists = 'CredentialAlreadyExists',
  Generic = 'Generic',
}

const prfError = (tag: PrfProviderError_Tags) =>
  function (this: unknown, text?: string) {
    return taggedError('PrfProviderError', tag, text === undefined ? undefined : [text])
  } as unknown as new (text?: string) => Error

export const PrfProviderError = {
  instanceOf: (obj: { [TYPE_NAME]?: string }) => obj[TYPE_NAME] === 'PrfProviderError',
  PrfNotSupported: prfError(PrfProviderError_Tags.PrfNotSupported),
  UserCancelled: prfError(PrfProviderError_Tags.UserCancelled),
  UserTimedOut: prfError(PrfProviderError_Tags.UserTimedOut),
  CredentialNotFound: prfError(PrfProviderError_Tags.CredentialNotFound),
  AuthenticationFailed: prfError(PrfProviderError_Tags.AuthenticationFailed),
  PrfEvaluationFailed: prfError(PrfProviderError_Tags.PrfEvaluationFailed),
  Configuration: prfError(PrfProviderError_Tags.Configuration),
  CredentialAlreadyExists: prfError(PrfProviderError_Tags.CredentialAlreadyExists),
  Generic: prfError(PrfProviderError_Tags.Generic),
}

export enum PasskeyError_Tags {
  Prf = 'Prf',
  RelayConnectionFailed = 'RelayConnectionFailed',
  NostrWriteFailed = 'NostrWriteFailed',
  NostrReadFailed = 'NostrReadFailed',
  KeyDerivationError = 'KeyDerivationError',
  InvalidPrfOutput = 'InvalidPrfOutput',
  MnemonicError = 'MnemonicError',
  InvalidSalt = 'InvalidSalt',
  CreatedButNotDerived = 'CreatedButNotDerived',
  InvalidConfig = 'InvalidConfig',
  Generic = 'Generic',
}

export const PasskeyError = {
  instanceOf: (obj: { [TYPE_NAME]?: string }) => obj[TYPE_NAME] === 'PasskeyError',
  Prf: function (source: Error) {
    return taggedError('PasskeyError', PasskeyError_Tags.Prf, [source])
  } as unknown as new (source: Error) => Error,
  CreatedButNotDerived: function (inner: { credentialId: ArrayBuffer; source: Error }) {
    return taggedError('PasskeyError', PasskeyError_Tags.CreatedButNotDerived, inner)
  } as unknown as new (inner: { credentialId: ArrayBuffer; source: Error }) => Error,
  InvalidConfig: function (text: string) {
    return taggedError('PasskeyError', PasskeyError_Tags.InvalidConfig, [text])
  } as unknown as new (text: string) => Error,
  Generic: function (text: string) {
    return taggedError('PasskeyError', PasskeyError_Tags.Generic, [text])
  } as unknown as new (text: string) => Error,
}

export enum DomainAssociation_Tags {
  Associated = 'Associated',
  NotAssociated = 'NotAssociated',
  Skipped = 'Skipped',
}

export const DomainAssociation = {
  Associated: function () {
    return { tag: DomainAssociation_Tags.Associated }
  } as unknown as new () => { tag: DomainAssociation_Tags },
  NotAssociated: function (inner: { source: string; reason: string }) {
    return { tag: DomainAssociation_Tags.NotAssociated, inner }
  } as unknown as new (inner: { source: string; reason: string }) => { tag: DomainAssociation_Tags },
  Skipped: function (inner: { reason: string }) {
    return { tag: DomainAssociation_Tags.Skipped, inner }
  } as unknown as new (inner: { reason: string }) => { tag: DomainAssociation_Tags },
}

export enum PasskeyAvailability_Tags {
  Available = 'Available',
  PrfUnsupported = 'PrfUnsupported',
  NotAssociated = 'NotAssociated',
  Skipped = 'Skipped',
}

export enum Seed_Tags {
  Mnemonic = 'Mnemonic',
  Entropy = 'Entropy',
}

export const PasskeyProviderOptions = { create: (fields: object) => Object.freeze({ ...fields }) }
export const PasskeyConfig = { create: (fields: object) => Object.freeze({ proxy: undefined, ...fields }) }
