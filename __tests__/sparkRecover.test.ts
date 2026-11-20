import {
  BitcoinNetwork,
  connect,
  CpfpFundingStrategy,
  RecoveryTxKind,
  SdkEvent_Tags,
  singleKeyCpfpSigner,
  type SdkEvent,
} from '@breeztech/breez-sdk-spark-react-native'
import {
  connectSpark,
  onSparkRecoverableFunds,
  sparkCheckRecoverFunds,
  sparkExitDestination,
  sparkExitFeeRate,
  sparkGetWalletInfo,
  sparkMissingFunding,
  sparkPrepareRecoverFunds,
  sparkRecoverFunds,
  sparkRecoveryFundingUtxos,
  sparkRecoveryRefused,
  sparkRecoverySteps,
  sparkSkippedReasons,
  sparkSyncedBalanceSat,
  type SparkRecoverQuote,
  type SparkRecovery,
} from '../src/wallet/spark'

const sdk = (
  jest.requireMock('@breeztech/breez-sdk-spark-react-native') as {
    __sdkInstance: Record<
      | 'addEventListener'
      | 'checkRecoverFunds'
      | 'getInfo'
      | 'parse'
      | 'prepareRecoverFunds'
      | 'receivePayment'
      | 'recommendedFees'
      | 'recoverFunds',
      jest.Mock
    >
  }
).__sdkInstance

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const TXID = 'ab'.repeat(32)
const PUBLIC_KEY = '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c'

const quote = (over: Partial<SparkRecoverQuote> = {}): SparkRecoverQuote =>
  ({ recoverableValueSats: 50_000n, totalFeeSats: 4_000n, funding: undefined, ...over }) as SparkRecoverQuote

const FUNDED = { singleUtxoSats: 20_000n, perBranch: [], strategy: CpfpFundingStrategy.PerBranch }

const funding = () => ({
  utxos: [{ txid: TXID, vout: 1, valueSat: 25_000 }],
  publicKey: PUBLIC_KEY,
  secretKey: new Uint8Array(32).fill(7),
})

jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => undefined,
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'primary'),
  ensureRegistered: jest.fn(),
}))
jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(async () => null),
  loadPassphraseFor: jest.fn(async () => undefined),
  PRIMARY_ID: 'primary',
}))
jest.mock('../src/wallet/fingerprint', () => ({
  fingerprintFromMnemonic: jest.fn(() => 'fp-spark'),
  fingerprintFromMnemonicAsync: jest.fn(async () => 'fp-spark'),
}))

let wallets = 0

// connectSpark keeps a connection to the wallet it already holds, so each case gets another wallet.
const connectAnother = () => connectSpark(MNEMONIC, `recover-test-${++wallets}`)

beforeEach(async () => {
  jest.clearAllMocks()
  jest.mocked(connect).mockResolvedValue(sdk as never)
  await connectAnother()
})

describe('funds outside the balance stay outside it', () => {
  beforeEach(() => {
    sdk.getInfo.mockResolvedValue({
      identityPubkey: '',
      balanceSats: 4_200n,
      recoverableFundsSats: 90_000n,
      tokenBalances: new Map(),
    })
  })

  test('the wallet read reports them apart from the balance', async () => {
    const info = await sparkGetWalletInfo()
    expect(info.balanceSat).toBe(4_200)
    expect(info.recoverableSat).toBe(90_000)
  })

  test('the balance a payment is decided on does not count them', async () => {
    const { onEvent } = sdk.addEventListener.mock.calls[0][0] as {
      onEvent: (event: unknown) => Promise<void>
    }
    await onEvent({ tag: SdkEvent_Tags.Synced })
    expect(await sparkSyncedBalanceSat()).toBe(4_200)
  })
})

describe('the RecoverableFunds event', () => {
  const event = {
    tag: SdkEvent_Tags.RecoverableFunds,
    inner: { recoverableFundsSats: 5_000n },
  } as unknown as SdkEvent

  const watcher = () =>
    sdk.addEventListener.mock.calls[0][0] as { onEvent: (event: SdkEvent) => Promise<void> }

  test('brings a read forward', async () => {
    const heard = jest.fn()
    const off = onSparkRecoverableFunds(heard)
    await watcher().onEvent(event)
    expect(heard).toHaveBeenCalledTimes(1)
    off()
    await watcher().onEvent(event)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  test('from a connection replaced meanwhile moves nothing', async () => {
    const old = watcher()
    sdk.addEventListener.mockClear()
    await connectAnother()
    const heard = jest.fn()
    const off = onSparkRecoverableFunds(heard)
    await old.onEvent(event)
    expect(heard).not.toHaveBeenCalled()
    off()
  })
})

describe('the fee rate of a recovery', () => {
  const fees = (halfHourFee: bigint) => ({
    fastestFee: 20n,
    halfHourFee,
    hourFee: 5n,
    economyFee: 2n,
    minimumFee: 1n,
  })

  test('is the half hour tier', async () => {
    sdk.recommendedFees.mockResolvedValue(fees(10n))
    expect(await sparkExitFeeRate()).toBe(10n)
  })

  test('a failed read gives no rate rather than a guess', async () => {
    sdk.recommendedFees.mockRejectedValue(new Error('offline'))
    expect(await sparkExitFeeRate()).toBeNull()
  })

  test('a zero rate is not a rate, since nodes would not relay it', async () => {
    sdk.recommendedFees.mockResolvedValue(fees(0n))
    expect(await sparkExitFeeRate()).toBeNull()
  })
})

describe('preparing a recovery', () => {
  const prepared = async (selection: Parameters<typeof sparkPrepareRecoverFunds>[0]['selection']) => {
    await sparkPrepareRecoverFunds({ feeRateSatPerVbyte: 3n, destination: ADDRESS, selection })
    return sdk.prepareRecoverFunds.mock.calls.at(-1)?.[0]
  }

  test('passes the rate and the destination, and funds with P2WPKH', async () => {
    const request = await prepared('recoverable')
    expect(request.feeRateSatPerVbyte).toBe(3n)
    expect(request.destination).toBe(ADDRESS)
    expect(request.fundingKind.tag).toBe('P2wpkh')
  })

  // Unset funds one UTXO per branch, the only way an exit was funded before the option existed.
  test('leaves the funding strategy unset for the SDK to default', async () => {
    const request = await prepared('recoverable')
    expect(Object.keys(request)).toContain('fundingStrategy')
    expect(request.fundingStrategy).toBeUndefined()
  })

  test('maps each selection', async () => {
    expect((await prepared('recoverable')).selection.tag).toBe('RecoverableOnly')
    expect((await prepared('all')).selection.tag).toBe('All')
    const named = (await prepared({ leafIds: ['leaf-1', 'leaf-2'] })).selection
    expect(named.tag).toBe('Specific')
    expect(named.inner.leafIds).toEqual(['leaf-1', 'leaf-2'])
  })

  test('an SDK refusal reaches the caller as it came', async () => {
    const refusal = Object.assign(new Error('SdkError.InvalidInput'), {
      tag: 'InvalidInput',
      inner: ['bad destination'],
    })
    sdk.prepareRecoverFunds.mockRejectedValueOnce(refusal)
    await expect(prepared('recoverable')).rejects.toBe(refusal)
  })
})

describe('building a recovery', () => {
  const built = () => sdk.recoverFunds.mock.calls.at(-1) as [
    { prepared: unknown; fundingInputs: { tag: string; inner: Record<string, unknown> }[] },
    unknown,
  ]

  test('a quote with no funding takes neither inputs nor a signer, whatever is at hand', async () => {
    const plain = quote()
    await sparkRecoverFunds(plain, funding())
    const [request, signer] = built()
    expect(request.prepared).toBe(plain)
    expect(request.fundingInputs).toEqual([])
    expect(signer).toBeUndefined()
    expect(singleKeyCpfpSigner).not.toHaveBeenCalled()
  })

  test('a funded quote takes the UTXOs as P2WPKH inputs and a signer of that key', async () => {
    const funded = quote({ funding: FUNDED })
    await sparkRecoverFunds(funded, funding())
    const [request, signer] = built()
    expect(request.prepared).toBe(funded)
    expect(request.fundingInputs).toHaveLength(1)
    expect(request.fundingInputs[0].tag).toBe('P2wpkh')
    expect(request.fundingInputs[0].inner).toEqual({
      txid: TXID,
      vout: 1,
      valueSats: 25_000n,
      pubkey: PUBLIC_KEY,
    })
    expect(signer).toBeDefined()
    expect(signer).toBe(jest.mocked(singleKeyCpfpSigner).mock.results[0].value)
  })

  test('the signer gets a copy of the bytes, wiped once the call ends', async () => {
    let during: number[] = []
    sdk.recoverFunds.mockImplementationOnce(async () => {
      const copy = jest.mocked(singleKeyCpfpSigner).mock.calls[0][0]
      during = [...new Uint8Array(copy)]
      return {} as SparkRecovery
    })
    const money = funding()
    await sparkRecoverFunds(quote({ funding: FUNDED }), money)
    expect(during).toEqual(new Array(32).fill(7))
    const copy = jest.mocked(singleKeyCpfpSigner).mock.calls[0][0]
    expect(new Uint8Array(copy).every(byte => byte === 0)).toBe(true)
    expect(money.secretKey.every(byte => byte === 7)).toBe(true)
  })

  test('a build that fails wipes the copy too, and the error reaches the caller', async () => {
    const short = Object.assign(new Error('SdkError.InsufficientCpfpFunds'), {
      tag: 'InsufficientCpfpFunds',
      inner: { requiredSats: 30_000n },
    })
    sdk.recoverFunds.mockRejectedValueOnce(short)
    await expect(sparkRecoverFunds(quote({ funding: FUNDED }), funding())).rejects.toBe(short)
    const copy = jest.mocked(singleKeyCpfpSigner).mock.calls[0][0]
    expect(new Uint8Array(copy).every(byte => byte === 0)).toBe(true)
  })

  test('following a recovery hands it back as it was kept', async () => {
    const recovery = { transactions: [] } as unknown as SparkRecovery
    const answer = await sparkCheckRecoverFunds(recovery)
    expect(sdk.checkRecoverFunds).toHaveBeenCalledWith({ recovery })
    expect(answer.recovery).toBe(recovery)
  })
})

describe('a verdict', () => {
  test.each([
    ['Valid', 'valid'],
    ['Done', 'done'],
    ['Redo', 'redo'],
  ])('%s reads as %s', async (tag, verdict) => {
    sdk.checkRecoverFunds.mockResolvedValueOnce({ recovery: {}, verdict: { tag } })
    expect((await sparkCheckRecoverFunds({} as SparkRecovery)).verdict).toBe(verdict)
  })
})

describe('the steps of a recovery', () => {
  const step = (status: unknown, kind = RecoveryTxKind.Node, cpfpTxHex?: string) =>
    sparkRecoverySteps({
      transactions: [{ kind, txid: 'ab', txHex: 'cd', cpfpTxHex, status }],
    } as unknown as SparkRecovery)[0]

  test.each([
    ['Confirmed', { tag: 'Confirmed', inner: { blockHeight: 9 } }, 'confirmed'],
    ['Ready', { tag: 'Ready' }, 'ready'],
    ['WaitingForDependencies', { tag: 'WaitingForDependencies' }, 'waiting'],
    ['Unverified', { tag: 'Unverified' }, 'unverified'],
  ])('%s', (_name, status, stage) => {
    expect(step(status).stage).toBe(stage)
  })

  test('a timelock keeps the block it can first be mined in', () => {
    const waiting = step({ tag: 'WaitingForTimelock', inner: { spendableAtHeight: 870_500 } })
    expect(waiting).toMatchObject({ stage: 'timelock', spendableAtHeight: 870_500 })
  })

  test('says which steps are cooperative recoveries, and carries the child', () => {
    expect(step({ tag: 'Ready' }, RecoveryTxKind.Cooperative).cooperative).toBe(true)
    expect(step({ tag: 'Ready' }, RecoveryTxKind.Refund, 'ef')).toMatchObject({ cooperative: false, cpfpTxHex: 'ef' })
  })
})

describe('a silent payment address at the end of an exit', () => {
  // recover_funds.rs refuses it, so the exit has to as well, before any fee is paid towards it.
  test('is no destination', async () => {
    sdk.parse.mockResolvedValueOnce({
      tag: 'SilentPaymentAddress',
      inner: [{ address: 'sp1qaddr', network: BitcoinNetwork.Bitcoin, source: {} }],
    })
    expect(await sparkExitDestination('sp1qaddr')).toEqual({ status: 'refused', reason: 'notAddress' })
  })
})

describe('why leaves stayed out of a quote', () => {
  const skipped = (...tags: string[]) =>
    sparkSkippedReasons({ skipped: tags.map(tag => ({ reason: { tag } })) } as unknown as SparkRecoverQuote)

  test('a fee too high for them', () => {
    expect(skipped('FeeExceedsValue')).toEqual({ feeTooHigh: true, noData: false, operators: false })
  })

  test.each(['FundsNotFound', 'Unverified', 'NotRecoverable'])('%s is what the device lacks', tag => {
    expect(skipped(tag)).toEqual({ feeTooHigh: false, noData: true, operators: false })
  })

  test('operators out of reach are neither a fee nor what the device lacks', () => {
    expect(skipped('OperatorsUnavailable')).toEqual({ feeTooHigh: false, noData: false, operators: true })
  })

  test('nothing skipped says neither', () => {
    expect(skipped()).toEqual({ feeTooHigh: false, noData: false, operators: false })
  })
})

describe('reading an SDK refusal', () => {
  test('the funding asked for comes from tag and inner', () => {
    const short = Object.assign(new Error('SdkError.InsufficientCpfpFunds'), {
      tag: 'InsufficientCpfpFunds',
      inner: { requiredSats: 30_000n, docsUrl: 'https://example.invalid' },
    })
    expect(sparkMissingFunding(short)).toBe(30_000)
  })

  test('another error, or the same words in a message, is no shortfall', () => {
    expect(sparkMissingFunding(new Error('Insufficient CPFP funding: need at least 30000 sats'))).toBeNull()
    expect(sparkMissingFunding({ tag: 'InvalidInput', inner: ['bad'] })).toBeNull()
    expect(sparkMissingFunding(null)).toBeNull()
  })

  test('only InvalidInput says the kept recovery was refused', () => {
    expect(sparkRecoveryRefused({ tag: 'InvalidInput', inner: ['bad'] })).toBe(true)
    expect(sparkRecoveryRefused({ tag: 'Generic', inner: ['down'] })).toBe(false)
    expect(sparkRecoveryRefused(null)).toBe(false)
  })
})

test('the utxos kept with a recovery come back as a build takes them', () => {
  const kept = {
    fundingInputs: [
      { tag: 'P2wpkh', inner: { txid: TXID, vout: 2, valueSats: 9_000n, pubkey: PUBLIC_KEY } },
      { tag: 'P2tr', inner: { txid: TXID, vout: 3, valueSats: 1n, pubkey: PUBLIC_KEY } },
    ],
  } as unknown as SparkRecovery
  expect(sparkRecoveryFundingUtxos(kept)).toEqual([{ txid: TXID, vout: 2, valueSat: 9_000 }])
})

describe('the signer double keeps what the real one refuses', () => {
  const raw = (fill: (bytes: Uint8Array) => void, length = 32) => {
    const bytes = new Uint8Array(length)
    fill(bytes)
    return bytes.buffer
  }

  test.each([
    ['all zeros', raw(() => undefined)],
    ['the curve order', raw(b => b.set(Buffer.from('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 'hex')))],
    ['over the order', raw(b => b.fill(0xff))],
    ['short', raw(b => b.fill(1), 31)],
  ])('%s', (_name, key) => {
    expect(() => singleKeyCpfpSigner(key)).toThrow('invalid secret key')
  })

  test('a key of one passes, the smallest there is', () => {
    expect(singleKeyCpfpSigner(raw(b => (b[31] = 1)))).toBeDefined()
  })
})

describe('the destination of an exit', () => {
  const OTHER = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
  const parsesAs = (network = BitcoinNetwork.Bitcoin, tag = 'BitcoinAddress', address = OTHER) =>
    sdk.parse.mockResolvedValue({ tag, inner: [{ address, network, source: {} }] })

  beforeEach(() => {
    sdk.receivePayment.mockResolvedValue({ paymentRequest: ADDRESS, fee: 0n })
  })

  test('a mainnet address of someone else passes as the SDK read it', async () => {
    parsesAs()
    expect(await sparkExitDestination(`  ${OTHER} `)).toEqual({ status: 'ok', address: OTHER })
  })

  test.each([
    ['bitcoin:' + OTHER],
    ['bitcoin:' + OTHER + '?amount=0.1'],
    [OTHER + '?lightning=lnbc1'],
    ['two ' + OTHER],
  ])('%s is refused unread, as anything around the address is', async text => {
    expect(await sparkExitDestination(text)).toEqual({ status: 'refused', reason: 'uri' })
    expect(sdk.parse).not.toHaveBeenCalled()
  })

  test.each([BitcoinNetwork.Testnet3, BitcoinNetwork.Testnet4, BitcoinNetwork.Signet, BitcoinNetwork.Regtest])(
    'an address of network %s is refused',
    async network => {
      parsesAs(network)
      expect(await sparkExitDestination(OTHER)).toEqual({ status: 'refused', reason: 'notAddress' })
    },
  )

  test.each(['SparkAddress', 'Bolt11Invoice', 'LightningAddress', 'Bip21'])('a %s is refused', async tag => {
    parsesAs(BitcoinNetwork.Bitcoin, tag)
    expect(await sparkExitDestination('text')).toEqual({ status: 'refused', reason: 'notAddress' })
  })

  test('text the SDK cannot parse is refused', async () => {
    sdk.parse.mockRejectedValue(Object.assign(new Error('SdkError.InvalidInput'), { inner: ['nope'] }))
    expect(await sparkExitDestination('nonsense')).toEqual({ status: 'refused', reason: 'notAddress' })
  })

  test("the wallet's own receive address is refused, in either case", async () => {
    parsesAs(BitcoinNetwork.Bitcoin, 'BitcoinAddress', ADDRESS.toUpperCase())
    expect(await sparkExitDestination(ADDRESS.toUpperCase())).toEqual({ status: 'refused', reason: 'own' })
  })

  test('an own address that never answers does not hold the exit past its wait', async () => {
    parsesAs()
    sdk.receivePayment.mockReturnValue(new Promise(() => undefined))
    jest.useFakeTimers()
    try {
      const asked = sparkExitDestination(OTHER)
      await jest.advanceTimersByTimeAsync(10_001)
      expect(await asked).toEqual({ status: 'unchecked', address: OTHER })
    } finally {
      jest.useRealTimers()
    }
  })

  test('with the own address out of reach, as with the operators gone, the address says it went unchecked', async () => {
    parsesAs()
    sdk.receivePayment.mockRejectedValue(new Error('operators unreachable'))
    expect(await sparkExitDestination(OTHER)).toEqual({ status: 'unchecked', address: OTHER })
  })
})
