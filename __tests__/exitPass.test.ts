import { CpfpFundingStrategy, RecoveryTxKind } from '@breeztech/breez-sdk-spark-react-native'
import RNFS from 'react-native-fs'
import * as chainRelay from '../src/wallet/chainRelay'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { exitFeeAddress, withExitFeeSecret } from '../src/wallet/exitFeeKey'
import { forgetExitPlan, isLivePlan, loadExitPlan, saveExitPlan, type ExitPlan } from '../src/wallet/exitPlan'
import {
  confirmAsk,
  leaveExit,
  payMore,
  prepareExit,
  runExitPass,
  startExit,
  stepsToSend,
  waitsOnPerson,
  type ExitAsk,
  type ExitQuote,
  type PassOutcome,
} from '../src/wallet/exitPass'
import { loadPassphraseFor, loadSeedFor } from '../src/wallet/seed'
import {
  sparkCheckRecoverFunds,
  sparkConnectedWalletId,
  sparkExitFeeRate,
  sparkPrepareRecoverFunds,
  sparkRecoverFunds,
  sparkRecoverySteps,
  sparkStopSpendsOnItsOwn,
  type SparkRecoverQuote,
  type SparkRecovery,
} from '../src/wallet/spark'
import {
  CONFIRMED,
  cpfpChildHex,
  DESTINATION,
  FEE_ADDRESS,
  FEE_PUBLIC_KEY,
  planOf,
  quoteOf,
  READY,
  recoveryOf,
  stepOf,
  UTXO_TXID,
} from './support/exitFixtures'

jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(),
  loadPassphraseFor: jest.fn(async () => undefined),
  PRIMARY_ID: 'primary',
}))

jest.mock('../src/wallet/chainRelay', () => ({
  broadcastTx: jest.fn(async () => ({ status: 'sent', host: 'mempool.space' })),
  broadcastPackage: jest.fn(async () => ({ status: 'sent', host: 'mempool.space' })),
  readFunding: jest.fn(async () => ({ status: 'read', confirmed: [], pendingSat: 0 })),
}))

jest.mock('../src/wallet/exitFeeKey', () => {
  const actual = jest.requireActual('../src/wallet/exitFeeKey')
  return {
    ...actual,
    exitFeeAddress: jest.fn(actual.exitFeeAddress),
    withExitFeeSecret: jest.fn(actual.withExitFeeSecret),
  }
})

jest.mock('../src/wallet/spark', () => {
  const actual = jest.requireActual('../src/wallet/spark')
  return {
    ...actual,
    sparkConnectedWalletId: jest.fn(() => 'primary'),
    sparkExitFeeRate: jest.fn(async () => 10n),
    sparkPrepareRecoverFunds: jest.fn(),
    sparkRecoverFunds: jest.fn(),
    sparkCheckRecoverFunds: jest.fn(),
    sparkStopSpendsOnItsOwn: jest.fn(async () => true),
  }
})

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const NOW = 5_000_000
const clock = () => NOW
const FILE = `${RNFS.DocumentDirectoryPath}/exit-plan-primary.json`
// The txid stepOf gives a step, which goes out with it.
const STEP_TXID = 'aa'.repeat(32)

const mocked = {
  prepare: jest.mocked(sparkPrepareRecoverFunds),
  recover: jest.mocked(sparkRecoverFunds),
  check: jest.mocked(sparkCheckRecoverFunds),
  rate: jest.mocked(sparkExitFeeRate),
  connected: jest.mocked(sparkConnectedWalletId),
  ownSpendsOff: jest.mocked(sparkStopSpendsOnItsOwn),
  tx: jest.mocked(chainRelay.broadcastTx),
  pair: jest.mocked(chainRelay.broadcastPackage),
  funding: jest.mocked(chainRelay.readFunding),
}

const quoted = (quote: SparkRecoverQuote = quoteOf()): ExitQuote => ({
  quote,
  quotedAt: NOW - 1_000,
  selection: 'all',
})

const utxo = { txid: UTXO_TXID, vout: 1, valueSat: 20_000 }

const verdict = (recovery: SparkRecovery, answer: 'valid' | 'done' | 'redo' = 'valid') => ({
  recovery,
  verdict: answer,
})

// A one input, one output transaction paying `sats`.
const payoutOf = (sats: number): string => {
  const value = (sats.toString(16).padStart(16, '0').match(/../g) as string[]).reverse().join('')
  return `02000000010${'0'.repeat(63)}00000000` + `00ffffffff01${value}0100` + '00000000'
}

const insufficient = (requiredSats: bigint) =>
  Object.assign(new Error('SdkError.InsufficientCpfpFunds'), {
    tag: 'InsufficientCpfpFunds',
    inner: { requiredSats, docsUrl: 'https://sdk-doc-spark.breez.technology' },
  })

beforeEach(async () => {
  __setEmergencyExitLiveForTests(true)
  jest.clearAllMocks()
  mocked.connected.mockReturnValue('primary')
  mocked.ownSpendsOff.mockResolvedValue(true)
  mocked.rate.mockResolvedValue(10n)
  mocked.funding.mockResolvedValue({ status: 'read', confirmed: [utxo], pendingSat: 0 })
  mocked.tx.mockResolvedValue({ status: 'sent', host: 'mempool.space' })
  mocked.pair.mockResolvedValue({ status: 'sent', host: 'mempool.space' })
  jest.mocked(loadSeedFor).mockImplementation(async id => (id === 'primary' ? WORDS : null))
  jest.mocked(loadPassphraseFor).mockResolvedValue(undefined)
  await forgetExitPlan('primary')
})

afterEach(() => __setEmergencyExitLiveForTests(null))

describe('one live exit per wallet', () => {
  test('a live plan answers a prepare, and the SDK is not asked', async () => {
    await saveExitPlan(planOf())
    const answer = await prepareExit('primary', DESTINATION, 'recoverable', clock)
    expect(answer.kind).toBe('live')
    expect(mocked.prepare).not.toHaveBeenCalled()
  })

  test('a live plan answers a start too, and nothing is built', async () => {
    await saveExitPlan(planOf())
    const answer = await startExit('primary', DESTINATION, quoted(), clock)
    expect(answer.kind).toBe('live')
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('a plan the platform will not read stops a prepare rather than opening a second exit', async () => {
    await saveExitPlan(planOf())
    const read = jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('EACCES'))
    const asked = prepareExit('primary', DESTINATION, 'all', clock)
    await expect(asked).rejects.toMatchObject({ name: 'ExitPlanUnread' })
    read.mockRestore()
    expect(mocked.prepare).not.toHaveBeenCalled()
  })

  test('a torn plan went aside, so a new exit can be quoted', async () => {
    await RNFS.writeFile(FILE, 'torn', 'utf8')
    mocked.prepare.mockResolvedValue(quoteOf())
    expect((await prepareExit('primary', DESTINATION, 'all', clock)).kind).toBe('quoted')
    await RNFS.unlink(`${FILE}.unreadable`)
  })

  test('a finished plan leaves the way open', async () => {
    await saveExitPlan(planOf({ verdict: 'done' }))
    mocked.prepare.mockResolvedValue(quoteOf())
    expect((await prepareExit('primary', DESTINATION, 'all', clock)).kind).toBe('quoted')
  })

  test('two passes at once share one, and one check goes out', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockImplementation(async recovery => verdict(recovery))
    const [first, second] = [runExitPass('primary', clock), runExitPass('primary', clock)]
    expect(first).toBe(second)
    await first
    expect(mocked.check).toHaveBeenCalledTimes(1)
  })
})

describe('the fee rate', () => {
  test('with no rate nothing is prepared on a guess', async () => {
    mocked.rate.mockResolvedValue(null)
    expect((await prepareExit('primary', DESTINATION, 'all', clock)).kind).toBe('noRate')
    expect(mocked.prepare).not.toHaveBeenCalled()
  })

  test('a rate that never comes reads as no rate after its wait', async () => {
    jest.useFakeTimers()
    try {
      mocked.rate.mockReturnValue(new Promise(() => undefined))
      const asked = prepareExit('primary', DESTINATION, 'all', clock)
      await jest.advanceTimersByTimeAsync(30_001)
      expect((await asked).kind).toBe('noRate')
    } finally {
      jest.useRealTimers()
    }
  })

  test('a quote that never answers counts as failed', async () => {
    jest.useFakeTimers()
    try {
      mocked.prepare.mockReturnValue(new Promise(() => undefined))
      const asked = prepareExit('primary', DESTINATION, 'all', clock)
      await jest.advanceTimersByTimeAsync(30_001)
      expect((await asked).kind).toBe('failed')
    } finally {
      jest.useRealTimers()
    }
  })

  test('a quote past 30 minutes is taken again and nothing is built on the old one', async () => {
    const fresh = quoteOf({ totalFeeSats: 13_000n })
    mocked.prepare.mockResolvedValue(fresh)
    const answer = await startExit(
      'primary',
      DESTINATION,
      { quote: quoteOf(), quotedAt: NOW - 30 * 60_000 - 1, selection: 'all' },
      clock,
    )
    expect(answer).toMatchObject({ kind: 'requoted', quoted: { quote: fresh, quotedAt: NOW } })
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('a rate that rose takes the quote again', async () => {
    mocked.rate.mockResolvedValue(11n)
    mocked.prepare.mockResolvedValue(quoteOf())
    const answer = await startExit('primary', DESTINATION, quoted(), clock)
    expect(answer.kind).toBe('requoted')
    expect(mocked.prepare.mock.calls[0][0].feeRateSatPerVbyte).toBe(11n)
  })
})

describe('building an exit', () => {
  test('a quote with no funding asks for neither inputs nor a signer, nor the words', async () => {
    const plain = quoteOf({ funding: undefined })
    mocked.recover.mockResolvedValue(recoveryOf({ fundingInputs: [] }))
    const answer = await startExit('primary', DESTINATION, quoted(plain), clock)
    expect(answer.kind).toBe('started')
    expect(mocked.recover).toHaveBeenCalledWith(plain)
    expect(chainRelay.readFunding).not.toHaveBeenCalled()
    expect(withExitFeeSecret).not.toHaveBeenCalled()
    expect(exitFeeAddress).not.toHaveBeenCalled()
    expect(loadSeedFor).not.toHaveBeenCalled()
  })

  test('the plan records the strategy the funding was computed for', async () => {
    const funding = { ...quoteOf().funding!, strategy: CpfpFundingStrategy.PerNode }
    mocked.recover.mockResolvedValue(recoveryOf())
    await startExit('primary', DESTINATION, quoted(quoteOf({ funding })), clock)
    expect((await loadExitPlan('primary'))?.fundingStrategy).toBe(CpfpFundingStrategy.PerNode)
  })

  test.each(['recoverable', 'all'] as const)('the plan records the selection %s it was started with', async selection => {
    mocked.recover.mockResolvedValue(recoveryOf())
    await startExit('primary', DESTINATION, { ...quoted(quoteOf()), selection }, clock)
    expect((await loadExitPlan('primary'))?.selection).toBe(selection)
  })

  test('a funded quote goes with the confirmed UTXOs and the key of this wallet', async () => {
    mocked.recover.mockResolvedValue(recoveryOf())
    await startExit('primary', DESTINATION, quoted(), clock)
    const [, funding] = mocked.recover.mock.calls[0]
    expect(funding?.utxos).toEqual([utxo])
    expect(funding?.publicKey).toBe(FEE_PUBLIC_KEY)
    expect(funding?.secretKey).toHaveLength(32)
  })

  test('the key is wiped once the build ends', async () => {
    mocked.recover.mockResolvedValue(recoveryOf())
    await startExit('primary', DESTINATION, quoted(), clock)
    expect(mocked.recover.mock.calls[0][1]?.secretKey.every(byte => byte === 0)).toBe(true)
  })

  test('the read of the fee address failing stops the build', async () => {
    mocked.funding.mockResolvedValue({ status: 'failed' })
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('unread')
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('nothing confirmed at the fee address asks the quote, with the new coin paying for itself', async () => {
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: [], pendingSat: 0 })
    expect(await startExit('primary', DESTINATION, quoted(), clock)).toEqual({
      kind: 'short',
      missingSat: 15_680,
      pending: false,
    })
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('a payment on its way gives no figure, since the address no longer lists what a child spent', async () => {
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: [], pendingSat: 15_000 })
    expect(await startExit('primary', DESTINATION, quoted(), clock)).toEqual({
      kind: 'short',
      missingSat: null,
      pending: true,
    })
  })

  test('InsufficientCpfpFunds reads as what is missing, from its tag and inner', async () => {
    mocked.recover.mockRejectedValue(insufficient(32_000n))
    expect(await startExit('primary', DESTINATION, quoted(), clock)).toEqual({
      kind: 'short',
      missingSat: 12_680,
      pending: false,
    })
  })

  test('the build still gets what it was asked to spend when the second read fails', async () => {
    mocked.funding
      .mockResolvedValueOnce({ status: 'read', confirmed: [utxo], pendingSat: 0 })
      .mockResolvedValue({ status: 'failed' })
    mocked.recover.mockRejectedValue(insufficient(32_000n))
    expect(await startExit('primary', DESTINATION, quoted(), clock)).toEqual({
      kind: 'short',
      missingSat: null,
      pending: false,
    })
  })

  test('the same error text without the tag is no shortfall', async () => {
    mocked.recover.mockRejectedValue(new Error('Insufficient CPFP funding: need at least 32000 sats'))
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('failed')
  })

  test.each([
    ['no leaves, with nothing in its totals', quoteOf({ leaves: [], recoverableValueSats: 0n, totalFeeSats: 0n }), 'empty'],
    ['a fee at the value', quoteOf({ recoverableValueSats: 12_000n, totalFeeSats: 12_000n }), 'notWorth'],
  ])('%s is refused here too, whatever a screen let through', async (_name, quote, judged) => {
    expect(await startExit('primary', DESTINATION, quoted(quote), clock)).toEqual({ kind: 'refused', verdict: judged })
    expect(mocked.recover).not.toHaveBeenCalled()
    expect(await loadExitPlan('primary')).toBeNull()
  })

  test('a build whose totals the real coins pushed past the value is discarded, with no plan', async () => {
    mocked.recover.mockResolvedValue(recoveryOf({ recoverableValueSats: 12_000n, totalFeeSats: 12_500n }))
    expect(await startExit('primary', DESTINATION, quoted(), clock)).toEqual({ kind: 'refused', verdict: 'notWorth' })
    expect(await loadExitPlan('primary')).toBeNull()
  })

  test.each([
    ['cooperative', RecoveryTxKind.Cooperative],
    ['sweep', RecoveryTxKind.Sweep],
  ])('a %s output under what nodes relay is discarded, with no plan', async (_name, kind) => {
    mocked.recover.mockResolvedValue(
      recoveryOf({ transactions: [stepOf({ status: READY, kind, txHex: payoutOf(545) })] }),
    )
    expect(await startExit('primary', DESTINATION, quoted(), clock)).toEqual({ kind: 'refused', verdict: 'tooSmall' })
    expect(await loadExitPlan('primary')).toBeNull()
  })

  test('an output at what nodes relay passes', async () => {
    mocked.recover.mockResolvedValue(
      recoveryOf({ transactions: [stepOf({ status: READY, kind: RecoveryTxKind.Sweep, txHex: payoutOf(546) })] }),
    )
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('started')
  })

  test('a build that fails writes no plan', async () => {
    mocked.recover.mockRejectedValue(new Error('boom'))
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('failed')
    expect(await loadExitPlan('primary')).toBeNull()
  })

  test('a build with nothing to send writes no plan', async () => {
    mocked.recover.mockResolvedValue(recoveryOf({ transactions: [] }))
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('empty')
    expect(await loadExitPlan('primary')).toBeNull()
  })

  // The connection that built still swaps leaves on its own (guide/optimize.html), and can swap one the
  // plan names before the first pass replaces it.
  test('once the plan is written, the connection is asked to stop spending on its own', async () => {
    mocked.recover.mockResolvedValue(recoveryOf())
    let planAtStop: Promise<ExitPlan | null> | null = null
    mocked.ownSpendsOff.mockImplementation(() => {
      planAtStop = loadExitPlan('primary')
      return planAtStop.then(() => true)
    })
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('started')
    expect(mocked.ownSpendsOff).toHaveBeenCalledTimes(1)
    expect(mocked.ownSpendsOff).toHaveBeenCalledWith('primary')
    expect(await planAtStop).not.toBeNull()
  })

  // The stop runs a native connect, which may never answer, while Start holds the screen.
  test('Start does not wait for the stop to answer', async () => {
    mocked.recover.mockResolvedValue(recoveryOf())
    mocked.ownSpendsOff.mockReturnValue(new Promise(() => undefined))
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('started')
    expect(mocked.ownSpendsOff).toHaveBeenCalledWith('primary')
  }, 2_000)

  test('a stop that fails or answers no still starts the exit, which the pass asks again', async () => {
    mocked.recover.mockResolvedValue(recoveryOf())
    mocked.ownSpendsOff.mockRejectedValue(new Error('connect failed'))
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('started')
    await forgetExitPlan('primary')
    mocked.ownSpendsOff.mockResolvedValue(false)
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('started')
    expect(isLivePlan(await loadExitPlan('primary'))).toBe(true)
  })

  test('a build that writes no plan asks for no stop', async () => {
    mocked.recover.mockRejectedValue(new Error('boom'))
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('failed')
    expect(mocked.ownSpendsOff).not.toHaveBeenCalled()
  })

  test('nothing is sent by the build itself', async () => {
    mocked.recover.mockResolvedValue(recoveryOf())
    await startExit('primary', DESTINATION, quoted(), clock)
    expect(mocked.tx).not.toHaveBeenCalled()
    expect(mocked.pair).not.toHaveBeenCalled()
  })

  test('the saved file holds neither the words nor the key', async () => {
    mocked.recover.mockResolvedValue(recoveryOf())
    await startExit('primary', DESTINATION, quoted(), clock)
    let secretHex = ''
    await withExitFeeSecret(WORDS, undefined, 0, async secret => {
      secretHex = Buffer.from(secret).toString('hex')
    })
    expect(secretHex).toHaveLength(64)
    const saved = await RNFS.readFile(FILE, 'utf8')
    expect(saved).toContain(FEE_PUBLIC_KEY)
    expect(saved).toContain(FEE_ADDRESS)
    expect(saved).not.toContain(secretHex)
    expect(saved).not.toContain(Buffer.from(secretHex, 'hex').toString('base64'))
    expect(saved.match(/\babandon\b/)).toBeNull()
    expect(saved.match(/\babout\b/)).toBeNull()
  })
})

describe('whose exit a pass follows', () => {
  test('another wallet connected: nothing is read, built or sent', async () => {
    await saveExitPlan(planOf())
    mocked.connected.mockReturnValue('other')
    expect(await runExitPass('primary', clock)).toEqual({ kind: 'idle' })
    expect(mocked.check).not.toHaveBeenCalled()
    expect(mocked.pair).not.toHaveBeenCalled()
  })

  test('no build starts for a wallet that is not connected', async () => {
    mocked.connected.mockReturnValue('other')
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('failed')
    expect((await prepareExit('primary', DESTINATION, 'all', clock)).kind).toBe('failed')
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('a switch while the words were read signs nothing', async () => {
    mocked.connected.mockReturnValueOnce('primary').mockReturnValue('other')
    const answer = await startExit('primary', DESTINATION, quoted(), clock)
    expect(answer.kind).toBe('failed')
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('the key comes from the words and passphrase of the wallet the plan is for', async () => {
    jest.mocked(loadSeedFor).mockImplementation(async id => (id === 'second' ? WORDS : 'wrong words'))
    jest.mocked(loadPassphraseFor).mockImplementation(async id => (id === 'second' ? 'its passphrase' : undefined))
    mocked.connected.mockReturnValue('second')
    mocked.recover.mockResolvedValue(recoveryOf())
    await startExit('second', DESTINATION, quoted(), clock)
    expect(loadSeedFor).toHaveBeenCalledWith('second')
    expect(withExitFeeSecret).toHaveBeenCalledWith(WORDS, 'its passphrase', 0, expect.any(Function))
    await forgetExitPlan('second')
  })
})

describe('a pass', () => {
  // The optimizer swaps leaves after a payment (guide/optimize.html), and can swap one this exit spends.
  test('sends only once the connection spends no leaf on its own, and asks it for the plan\'s wallet', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockImplementation(async recovery => verdict(recovery))
    mocked.ownSpendsOff.mockImplementation(async () => {
      expect(mocked.pair).not.toHaveBeenCalled()
      return true
    })
    await runExitPass('primary', clock)
    expect(mocked.ownSpendsOff).toHaveBeenCalledWith('primary')
    expect(mocked.pair).toHaveBeenCalled()
  })

  test('a connection that still spends on its own and cannot be replaced sends nothing', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockImplementation(async recovery => verdict(recovery))
    mocked.ownSpendsOff.mockResolvedValue(false)
    const outcome = await runExitPass('primary', clock)
    expect(outcome.kind).toBe('offline')
    expect(mocked.pair).not.toHaveBeenCalled()
    expect(mocked.tx).not.toHaveBeenCalled()
  })

  test('writes what the check answered before anything goes out', async () => {
    await saveExitPlan(planOf({ checkedAt: 1 }))
    const answered = recoveryOf({
      transactions: [stepOf({ status: READY, txHex: 'eeff', cpfpTxHex: '0011' })],
    })
    mocked.check.mockResolvedValue(verdict(answered))
    let seen: ExitPlan | null = null
    mocked.pair.mockImplementation(async () => {
      seen = await loadExitPlan('primary')
      return { status: 'sent', host: 'mempool.space' }
    })
    await runExitPass('primary', clock)
    expect(mocked.pair).toHaveBeenCalledWith('eeff', '0011', STEP_TXID)
    expect((seen as unknown as ExitPlan).recovery.transactions[0].txHex).toBe('eeff')
    expect((seen as unknown as ExitPlan).checkedAt).toBe(NOW)
  })

  test('a write that fails sends nothing', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockImplementation(async recovery => verdict(recovery))
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
    await expect(runExitPass('primary', clock)).rejects.toThrow('disk full')
    write.mockRestore()
    expect(mocked.pair).not.toHaveBeenCalled()
    expect(mocked.tx).not.toHaveBeenCalled()
  })

  test('a check with no answer leaves the plan as it was and sends nothing', async () => {
    const plan = planOf({ checkedAt: 7 })
    await saveExitPlan(plan)
    mocked.check.mockRejectedValue(new Error('offline'))
    const answer = await runExitPass('primary', clock)
    expect(answer.kind).toBe('offline')
    expect(await loadExitPlan('primary')).toEqual(plan)
    expect(mocked.pair).not.toHaveBeenCalled()
  })

  test('a check that never answers reads as offline after its wait', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockReturnValue(new Promise(() => undefined))
    jest.useFakeTimers()
    try {
      const asked = runExitPass('primary', clock)
      await jest.advanceTimersByTimeAsync(30_001)
      expect((await asked).kind).toBe('offline')
    } finally {
      jest.useRealTimers()
    }
  })

  test('done comes only from the verdict, however many steps confirmed', async () => {
    const allConfirmed = recoveryOf({ transactions: [stepOf({ status: CONFIRMED })] })
    await saveExitPlan(planOf({ recovery: allConfirmed }))
    mocked.check.mockResolvedValueOnce(verdict(allConfirmed, 'valid'))
    expect((await runExitPass('primary', clock)).kind).toBe('followed')
    expect((await loadExitPlan('primary'))?.verdict).toBe('valid')
    mocked.check.mockResolvedValueOnce(verdict(allConfirmed, 'done'))
    expect((await runExitPass('primary', clock)).kind).toBe('done')
    expect((await loadExitPlan('primary'))?.verdict).toBe('done')
  })

  test('a finished plan runs no pass', async () => {
    await saveExitPlan(planOf({ verdict: 'done' }))
    expect(await runExitPass('primary', clock)).toEqual({ kind: 'idle' })
    expect(mocked.check).not.toHaveBeenCalled()
  })
})

describe('what goes out', () => {
  const steps = (status: unknown, over = {}) =>
    sparkRecoverySteps(recoveryOf({ transactions: [stepOf({ status, ...over })] }))

  test.each([
    ['Ready', { tag: 'Ready' }, 1],
    ['Confirmed', { tag: 'Confirmed', inner: { blockHeight: 1 } }, 0],
    ['WaitingForDependencies', { tag: 'WaitingForDependencies' }, 0],
    ['WaitingForTimelock', { tag: 'WaitingForTimelock', inner: { spendableAtHeight: 9 } }, 0],
    ['Unverified on a tree step', { tag: 'Unverified' }, 0],
  ])('%s', (_name, status, count) => {
    expect(stepsToSend(steps(status))).toHaveLength(count)
  })

  test('Unverified goes out on a cooperative recovery', () => {
    expect(stepsToSend(steps({ tag: 'Unverified' }, { kind: 0 }))).toHaveLength(1)
  })

  const follow = async (transactions: SparkRecovery['transactions']) => {
    const recovery = recoveryOf({ transactions })
    await saveExitPlan(planOf({ recovery }))
    mocked.check.mockResolvedValue(verdict(recovery))
    return runExitPass('primary', clock)
  }

  test('a step with a child goes as a pair', async () => {
    await follow([stepOf({ status: READY, txHex: 'aa11', cpfpTxHex: 'bb22' })])
    expect(mocked.pair).toHaveBeenCalledWith('aa11', 'bb22', STEP_TXID)
    expect(mocked.tx).not.toHaveBeenCalled()
  })

  test('a step without one goes alone', async () => {
    await follow([stepOf({ status: READY, txHex: 'aa11', cpfpTxHex: undefined })])
    expect(mocked.tx).toHaveBeenCalledWith('aa11', STEP_TXID)
    expect(mocked.pair).not.toHaveBeenCalled()
  })

  test('both hosts refusing keeps the reason and the pair, and never counts as sent', async () => {
    mocked.pair.mockResolvedValue({ status: 'refused', reason: 'TRUC-violation' })
    const step = stepOf({ status: READY, txHex: 'aa11', cpfpTxHex: 'bb22' })
    const answer = await follow([step])
    expect(answer).toMatchObject({
      kind: 'followed',
      sent: 0,
      refused: [{ txid: step.txid, reason: 'TRUC-violation', txHex: 'aa11', cpfpTxHex: 'bb22' }],
    })
    expect((await loadExitPlan('primary'))?.refused).toEqual([{ txid: step.txid, reason: 'TRUC-violation' }])
  })

  test('hosts that do not answer leave no reason', async () => {
    mocked.tx.mockResolvedValue({ status: 'unreachable' })
    const answer = await follow([stepOf({ status: READY })])
    expect(answer).toMatchObject({ sent: 0, refused: [{ reason: '' }] })
  })
})

describe('starting over', () => {
  const keptUtxo = { txid: UTXO_TXID, vout: 1, valueSat: 15_000 }
  const rebuilt = recoveryOf({ transactions: [stepOf({ status: READY, txHex: 'feed', cpfpTxHex: 'beef' })] })

  beforeEach(async () => {
    await saveExitPlan(planOf())
    mocked.check.mockImplementation(async recovery => verdict(recovery, 'redo'))
    mocked.prepare.mockResolvedValue(quoteOf())
    mocked.recover.mockResolvedValue(rebuilt)
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: [], pendingSat: 0 })
  })

  test('names the same leaves, never All', async () => {
    await runExitPass('primary', clock)
    expect(mocked.prepare).toHaveBeenCalledWith({
      feeRateSatPerVbyte: 10n,
      destination: DESTINATION,
      selection: { leafIds: ['leaf-1', 'leaf-2'] },
    })
  })

  // A record of what the person chose, which a rebuild naming the same leaves must not lose.
  test('the plan records its selection, and a rebuild keeps it', async () => {
    await saveExitPlan(planOf({ selection: 'recoverable' }))
    mocked.prepare.mockResolvedValue(quoteOf())
    await runExitPass('primary', clock)
    expect(mocked.recover).toHaveBeenCalled()
    expect((await loadExitPlan('primary'))?.selection).toBe('recoverable')
  })

  test('hands back the funding kept with the plan', async () => {
    await runExitPass('primary', clock)
    expect(mocked.recover.mock.calls[0][1]?.utxos).toEqual([keptUtxo])
  })

  // The funding sits on the chain as the first build asked for it, so a new quote has to ask the same.
  test('asks for the funding strategy the plan was built with, and keeps the one that answers', async () => {
    await saveExitPlan(planOf({ fundingStrategy: CpfpFundingStrategy.PerNode }))
    const funding = { ...quoteOf().funding!, strategy: CpfpFundingStrategy.PerNode }
    mocked.prepare.mockResolvedValue(quoteOf({ funding }))
    await runExitPass('primary', clock)
    expect(mocked.prepare.mock.calls[0][0].fundingStrategy).toBe(CpfpFundingStrategy.PerNode)
    expect((await loadExitPlan('primary'))?.fundingStrategy).toBe(CpfpFundingStrategy.PerNode)
  })

  test('a rebuild funded for the first time records what that funding was computed for', async () => {
    const funding = { ...quoteOf().funding!, strategy: CpfpFundingStrategy.PerNode }
    mocked.prepare.mockResolvedValue(quoteOf({ funding }))
    await runExitPass('primary', clock)
    expect((await loadExitPlan('primary'))?.fundingStrategy).toBe(CpfpFundingStrategy.PerNode)
  })

  test('a plan from before the option asks with it unset, which the SDK reads as per branch', async () => {
    await runExitPass('primary', clock)
    expect(mocked.prepare.mock.calls[0][0].fundingStrategy).toBeUndefined()
  })

  test('a rebuild with nothing to fund keeps the fee address, which the end of the exit reads', async () => {
    mocked.prepare.mockResolvedValue(quoteOf({ funding: undefined }))
    mocked.recover.mockResolvedValue(recoveryOf({ fundingInputs: [] }))
    await runExitPass('primary', clock)
    const plan = await loadExitPlan('primary')
    expect(plan?.recovery.fundingInputs).toEqual([])
    expect(plan?.feeKey?.address).toBe(FEE_ADDRESS)
  })

  test('adds what arrived at the fee address, once each', async () => {
    const fresh = { txid: 'cd'.repeat(32), vout: 0, valueSat: 5_000 }
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: [keptUtxo, fresh], pendingSat: 0 })
    await runExitPass('primary', clock)
    expect(mocked.recover.mock.calls[0][1]?.utxos).toEqual([keptUtxo, fresh])
  })

  test('writes the new plan, then sends from it', async () => {
    let seen: ExitPlan | null = null
    mocked.pair.mockImplementation(async () => {
      seen = await loadExitPlan('primary')
      return { status: 'sent', host: 'mempool.space' }
    })
    await runExitPass('primary', clock)
    expect(mocked.pair).toHaveBeenCalledWith('feed', 'beef', STEP_TXID)
    expect((seen as unknown as ExitPlan).recovery.transactions[0].txHex).toBe('feed')
    expect((seen as unknown as ExitPlan).verdict).toBe('valid')
  })

  test('with no rate the plan stands, marked to start over', async () => {
    mocked.rate.mockResolvedValue(null)
    expect((await runExitPass('primary', clock)).kind).toBe('stuck')
    expect(mocked.prepare).not.toHaveBeenCalled()
    expect((await loadExitPlan('primary'))?.verdict).toBe('redo')
  })

  test('funding gone short says what is missing and keeps the plan', async () => {
    mocked.recover.mockRejectedValue(insufficient(30_000n))
    expect(await runExitPass('primary', clock)).toMatchObject({
      kind: 'short',
      missingSat: 30_680,
      pending: false,
      address: FEE_ADDRESS,
    })
    expect((await loadExitPlan('primary'))?.recovery.transactions[0].txHex).toBe('aabb')
  })

  describe('what is missing, once funding was spent', () => {
    const change = { txid: 'cd'.repeat(32), vout: 0, valueSat: 9_000 }

    test.each([
      ['required below what the list counts', 20_000n, 11_680],
      ['required above what the list counts', 30_000n, 21_680],
    ])('%s counts the change at the address, not the coin it replaced', async (_name, required, missing) => {
      mocked.funding.mockResolvedValue({ status: 'read', confirmed: [change], pendingSat: 0 })
      mocked.recover.mockRejectedValue(insufficient(required))
      expect(await runExitPass('primary', clock)).toMatchObject({ kind: 'short', missingSat: missing })
    })

    test('a read that failed goes on with the kept funding, and states no figure', async () => {
      mocked.funding.mockResolvedValue({ status: 'failed' })
      mocked.recover.mockRejectedValue(insufficient(30_000n))
      expect(await runExitPass('primary', clock)).toMatchObject({
        kind: 'short',
        missingSat: null,
        pending: false,
        address: FEE_ADDRESS,
      })
      expect(mocked.recover.mock.calls[0][1]?.utxos).toEqual([keptUtxo])
    })

    test('value on its way states no figure and says so', async () => {
      mocked.funding.mockResolvedValue({ status: 'read', confirmed: [change], pendingSat: 1_000 })
      mocked.recover.mockRejectedValue(insufficient(30_000n))
      expect(await runExitPass('primary', clock)).toMatchObject({ kind: 'short', missingSat: null, pending: true })
    })

    test('confirmed above what is required gives no figure at all', async () => {
      const large = { ...change, valueSat: 40_000 }
      mocked.funding.mockResolvedValue({ status: 'read', confirmed: [large], pendingSat: 0 })
      mocked.recover.mockRejectedValue(insufficient(30_000n))
      expect(await runExitPass('primary', clock)).toMatchObject({ kind: 'short', missingSat: null, pending: false })
    })
  })

  test('a recovery with no fee key yet derives one for the funding it now needs', async () => {
    await forgetExitPlan('primary')
    await saveExitPlan(planOf({ feeKey: null, recovery: recoveryOf({ fundingInputs: [] }) }))
    await runExitPass('primary', clock)
    expect(mocked.funding).toHaveBeenCalledWith(FEE_ADDRESS)
    expect((await runExitPass('primary', clock)).kind).toBe('short')
  })

  describe('with nothing left to build', () => {
    const skip = (tag: string) => [{ leafId: 'l', valueSats: 1n, reason: { tag } }] as never

    test.each([
      ['no reason given, as after another device finished', [], 'nothing'],
      ['a fee too high', skip('FeeExceedsValue'), 'fee'],
      ['data the device lacks', skip('FundsNotFound'), 'data'],
    ])('%s ends the plan, sends nothing, and frees the wallet', async (_name, skipped, closure) => {
      mocked.prepare.mockResolvedValue(quoteOf({ leaves: [], skipped }))
      expect(await runExitPass('primary', clock)).toMatchObject({
        kind: 'closed',
        plan: { verdict: 'closed', closure },
      })
      expect(mocked.recover).not.toHaveBeenCalled()
      expect(mocked.pair).not.toHaveBeenCalled()
      const kept = await loadExitPlan('primary')
      expect(kept?.closure).toBe(closure)
      expect(isLivePlan(kept)).toBe(false)
    })

    test.each(['Unverified', 'OperatorsUnavailable'])(
      'a leaf left out as %s stays stuck, since nothing is known of it',
      async tag => {
        mocked.prepare.mockResolvedValue(quoteOf({ leaves: [], skipped: skip(tag) }))
        expect((await runExitPass('primary', clock)).kind).toBe('stuck')
        expect((await loadExitPlan('primary'))?.verdict).toBe('redo')
      },
    )

    test('an SDK error on the quote stays stuck too', async () => {
      mocked.prepare.mockRejectedValue(new Error('SparkError'))
      expect((await runExitPass('primary', clock)).kind).toBe('stuck')
      expect((await loadExitPlan('primary'))?.verdict).toBe('redo')
    })

    test('an ended plan runs no more passes', async () => {
      mocked.prepare.mockResolvedValue(quoteOf({ leaves: [] }))
      await runExitPass('primary', clock)
      mocked.check.mockClear()
      expect(await runExitPass('primary', clock)).toEqual({ kind: 'idle' })
      expect(mocked.check).not.toHaveBeenCalled()
    })

    test('a build with no transactions ends the plan the same way', async () => {
      mocked.recover.mockResolvedValue(recoveryOf({ transactions: [] }))
      expect(await runExitPass('primary', clock)).toMatchObject({ kind: 'closed', plan: { closure: 'nothing' } })
    })

    test('a build with no transactions and failed leaves is the operators gone, and stays stuck', async () => {
      mocked.recover.mockResolvedValue(recoveryOf({ transactions: [], failed: [{ leafId: 'l' }] as never }))
      expect((await runExitPass('primary', clock)).kind).toBe('stuck')
      expect((await loadExitPlan('primary'))?.verdict).toBe('redo')
    })

    test('the old Ready steps do not go out with the plan that ended', async () => {
      await saveExitPlan(
        planOf({
          recovery: recoveryOf({
            transactions: [stepOf({ status: READY, txHex: 'aa11', cpfpTxHex: 'bb22' }), stepOf({ status: { tag: 'Unverified' } })],
          }),
        }),
      )
      mocked.check.mockImplementation(async recovery => verdict(recovery))
      mocked.prepare.mockResolvedValue(quoteOf({ leaves: [] }))
      expect((await runExitPass('primary', clock)).kind).toBe('closed')
      expect(mocked.pair).not.toHaveBeenCalled()
    })

    test('a plan that ended leaves the way open to a new exit', async () => {
      mocked.prepare.mockResolvedValue(quoteOf({ leaves: [] }))
      await runExitPass('primary', clock)
      mocked.prepare.mockResolvedValue(quoteOf())
      expect((await prepareExit('primary', DESTINATION, 'all', clock)).kind).toBe('quoted')
    })
  })

  describe('leaving it for later', () => {
    test('ends the plan with its own reason, and sends nothing', async () => {
      expect(await leaveExit('primary', clock)).toMatchObject({ verdict: 'closed', closure: 'later' })
      expect(isLivePlan(await loadExitPlan('primary'))).toBe(false)
      expect(mocked.pair).not.toHaveBeenCalled()
    })

    test('with no plan alive does nothing', async () => {
      await saveExitPlan(planOf({ verdict: 'done' }))
      expect(await leaveExit('primary', clock)).toBeNull()
      expect((await loadExitPlan('primary'))?.verdict).toBe('done')
    })
  })

  describe('the same door as the first quote', () => {
    const costly = quoteOf({ recoverableValueSats: 10_000n, totalFeeSats: 25_000n })
    const refusedByCheck = () =>
      mocked.check.mockRejectedValue(Object.assign(new Error('SdkError.InvalidInput'), { tag: 'InvalidInput' }))

    const nothingMoved = async () => {
      expect(mocked.recover).not.toHaveBeenCalled()
      expect(mocked.pair).not.toHaveBeenCalled()
      expect(mocked.tx).not.toHaveBeenCalled()
      expect((await loadExitPlan('primary'))?.recovery.transactions[0].txHex).toBe('aabb')
    }

    test.each([
      ['a redo', () => undefined],
      ['a recovery the SDK refused', refusedByCheck],
    ])('%s worth less than it costs asks, and builds nothing', async (_name, arrange) => {
      arrange()
      mocked.prepare.mockResolvedValue(costly)
      expect(await runExitPass('primary', clock)).toMatchObject({ kind: 'ask', ask: { verdict: 'notWorth' } })
      await nothingMoved()
    })

    test('a redo that costs more than it returns never asks for more money', async () => {
      mocked.prepare.mockResolvedValue(costly)
      mocked.recover.mockRejectedValue(insufficient(25_000n))
      const answer = await runExitPass('primary', clock)
      expect(answer.kind).toBe('ask')
    })

    test('an amount nodes would not carry asks too', async () => {
      mocked.prepare.mockResolvedValue(
        quoteOf({ recoverableValueSats: 3_100n, totalFeeSats: 2_000n, sweepFeeSats: 99_500n }),
      )
      expect(await runExitPass('primary', clock)).toMatchObject({ kind: 'ask', ask: { verdict: 'tooSmall' } })
      await nothingMoved()
    })

    test('a build that came back past the quote is discarded, shows what came back, and nothing goes out', async () => {
      mocked.recover.mockResolvedValue(recoveryOf({ recoverableValueSats: 12_000n, totalFeeSats: 12_500n }))
      const answer = await runExitPass('primary', clock)
      expect(answer).toMatchObject({
        kind: 'ask',
        ask: { verdict: 'notWorth', quoted: { quote: { recoverableValueSats: 12_000n, totalFeeSats: 12_500n } } },
      })
      expect(mocked.pair).not.toHaveBeenCalled()
      expect((await loadExitPlan('primary'))?.recovery.transactions[0].txHex).toBe('aabb')
    })
  })

  describe('what counts as worse', () => {
    const asks = async () => {
      expect((await runExitPass('primary', clock)).kind).toBe('ask')
      expect(mocked.recover).not.toHaveBeenCalled()
      expect(mocked.pair).not.toHaveBeenCalled()
    }

    test('a higher rate than the plan paid', async () => {
      mocked.rate.mockResolvedValue(11n)
      mocked.prepare.mockResolvedValue(quoteOf({ feeRateSatPerVbyte: 11n }))
      await asks()
    })

    test('less arriving than the plan promised, by one sat', async () => {
      mocked.prepare.mockResolvedValue(quoteOf({ sweepFeeSats: 3_001n }))
      await asks()
    })

    test('a leaf left out', async () => {
      mocked.prepare.mockResolvedValue(
        quoteOf({ skipped: [{ leafId: 'l', valueSats: 1n, reason: { tag: 'FeeExceedsValue' } }] as never }),
      )
      await asks()
    })

    test('a new coin at the fee address does not make it better', async () => {
      mocked.funding.mockResolvedValue({ status: 'read', confirmed: [utxo], pendingSat: 0 })
      mocked.prepare.mockResolvedValue(quoteOf({ sweepFeeSats: 3_001n }))
      await asks()
    })

    test('the same figures go ahead', async () => {
      expect((await runExitPass('primary', clock)).kind).toBe('followed')
      expect(mocked.recover).toHaveBeenCalledTimes(1)
    })

    test('more arriving goes ahead too', async () => {
      mocked.prepare.mockResolvedValue(quoteOf({ sweepFeeSats: 2_999n }))
      expect((await runExitPass('primary', clock)).kind).toBe('followed')
    })

    // The question lives in memory only, so an app closed on it finds it again from the plan on disk.
    test('the question is not kept: the plan stays alive marked redo, and the next pass asks it again', async () => {
      mocked.prepare.mockResolvedValue(quoteOf({ sweepFeeSats: 3_001n }))
      expect((await runExitPass('primary', clock)).kind).toBe('ask')
      const kept = await loadExitPlan('primary')
      expect(kept?.verdict).toBe('redo')
      expect(isLivePlan(kept)).toBe(true)
      const again = await runExitPass('primary', clock)
      expect(again).toMatchObject({ kind: 'ask', ask: { quoted: { quote: { sweepFeeSats: 3_001n } } } })
      expect(waitsOnPerson(again)).toBe(true)
      expect(mocked.recover).not.toHaveBeenCalled()
      expect(mocked.pair).not.toHaveBeenCalled()
    })
  })

  test('the rate never drops under the plan, or the new version would lose on the network', async () => {
    await forgetExitPlan('primary')
    await saveExitPlan(planOf({ recovery: recoveryOf({ feeRateSatPerVbyte: 25n }) }))
    await runExitPass('primary', clock)
    expect(mocked.prepare.mock.calls[0][0].feeRateSatPerVbyte).toBe(25n)
  })

  test('a kept recovery the SDK refuses as input is built again the same way', async () => {
    mocked.check.mockRejectedValue(Object.assign(new Error('SdkError.InvalidInput'), { tag: 'InvalidInput' }))
    expect((await runExitPass('primary', clock)).kind).toBe('followed')
    expect(mocked.prepare.mock.calls[0][0].selection).toEqual({ leafIds: ['leaf-1', 'leaf-2'] })
  })
})

describe('a tree step built on a failed read', () => {
  const UNVERIFIED = { tag: 'Unverified' }
  const stuckStep = stepOf({ status: UNVERIFIED, txid: 'd'.repeat(64), txHex: 'dead' })
  const readyStep = stepOf({ status: READY, txHex: 'aa11', cpfpTxHex: 'bb22' })
  const planned = recoveryOf({ transactions: [readyStep, stuckStep] })
  const clean = recoveryOf({
    transactions: [stepOf({ status: READY, txid: 'e'.repeat(64), txHex: 'feed', cpfpTxHex: 'beef' })],
  })
  const chain = (over: object) => ({
    exitChainState: {
      confirmedNodes: [],
      refunds: [],
      stoppedLeafIds: [],
      unverifiedNodeIds: [],
      unverifiableConfirmedNodeIds: [],
      ...over,
    },
  })

  beforeEach(async () => {
    await saveExitPlan(planOf({ recovery: planned }))
    mocked.check.mockImplementation(async recovery => verdict(recovery))
    mocked.prepare.mockResolvedValue(quoteOf())
    mocked.recover.mockResolvedValue(clean)
  })

  test('with a good read of the chain builds again and sends that, not the old steps', async () => {
    expect((await runExitPass('primary', clock)).kind).toBe('followed')
    expect(mocked.prepare.mock.calls[0][0].selection).toEqual({ leafIds: ['leaf-1', 'leaf-2'] })
    expect(mocked.pair.mock.calls).toEqual([['feed', 'beef', 'e'.repeat(64)]])
    expect((await loadExitPlan('primary'))?.recovery.transactions[0].txHex).toBe('feed')
  })

  test.each([
    ['a node it could not verify', quoteOf(chain({ unverifiedNodeIds: ['n'] }))],
    ['a confirmed node it could not place', quoteOf(chain({ unverifiableConfirmedNodeIds: ['n'] }))],
    ['a leaf skipped as unverified', quoteOf({ skipped: [{ leafId: 'l', valueSats: 1n, reason: { tag: 'Unverified' } }] as never })],
    ['a leaf skipped with the operators out of reach', quoteOf({ skipped: [{ leafId: 'l', valueSats: 1n, reason: { tag: 'OperatorsUnavailable' } }] as never })],
  ])('with %s nothing is built, and the Ready steps still go', async (_name, quote) => {
    mocked.prepare.mockResolvedValue(quote)
    expect((await runExitPass('primary', clock)).kind).toBe('followed')
    expect(mocked.recover).not.toHaveBeenCalled()
    expect(mocked.pair.mock.calls).toEqual([['aa11', 'bb22', STEP_TXID]])
    expect((await loadExitPlan('primary'))?.recovery.transactions[1].txHex).toBe('dead')
  })

  test('with no rate or no quote the Ready steps still go', async () => {
    mocked.rate.mockResolvedValue(null)
    expect((await runExitPass('primary', clock)).kind).toBe('followed')
    expect(mocked.pair.mock.calls).toEqual([['aa11', 'bb22', STEP_TXID]])
  })

  test('a new build with a step like it does not replace the plan', async () => {
    mocked.recover.mockResolvedValue(recoveryOf({ transactions: [stuckStep] }))
    expect((await runExitPass('primary', clock)).kind).toBe('followed')
    expect((await loadExitPlan('primary'))?.recovery.transactions).toHaveLength(2)
    expect(mocked.pair.mock.calls).toEqual([['aa11', 'bb22', STEP_TXID]])
  })

  test('a worse build asks, and the Ready steps of the plan still go', async () => {
    mocked.prepare.mockResolvedValue(quoteOf({ sweepFeeSats: 9_000n }))
    expect((await runExitPass('primary', clock)).kind).toBe('ask')
    expect(mocked.recover).not.toHaveBeenCalled()
    expect(mocked.pair.mock.calls).toEqual([['aa11', 'bb22', STEP_TXID]])
  })

  test('a new build worth less than it costs goes through the same door, and nothing is built', async () => {
    mocked.prepare.mockResolvedValue(quoteOf({ recoverableValueSats: 10_000n, totalFeeSats: 25_000n }))
    expect(await runExitPass('primary', clock)).toMatchObject({ kind: 'ask', ask: { verdict: 'notWorth' } })
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('a new build short of funding says so, and the Ready steps still go', async () => {
    mocked.recover.mockRejectedValue(insufficient(40_000n))
    expect((await runExitPass('primary', clock)).kind).toBe('short')
    expect(mocked.pair.mock.calls).toEqual([['aa11', 'bb22', STEP_TXID]])
  })

  test('a redo with a step like it in the build keeps the plan too', async () => {
    mocked.check.mockImplementation(async recovery => verdict(recovery, 'redo'))
    mocked.recover.mockResolvedValue(recoveryOf({ transactions: [stuckStep] }))
    expect((await runExitPass('primary', clock)).kind).toBe('stuck')
    expect((await loadExitPlan('primary'))?.recovery.transactions).toHaveLength(2)
    expect(mocked.pair).not.toHaveBeenCalled()
  })

  test('a cooperative step like it goes out and asks for no build', async () => {
    const cooperative = stepOf({ status: UNVERIFIED, kind: RecoveryTxKind.Cooperative, txHex: 'c0c0' })
    await saveExitPlan(planOf({ recovery: recoveryOf({ transactions: [cooperative] }) }))
    await runExitPass('primary', clock)
    expect(mocked.tx).toHaveBeenCalledWith('c0c0', STEP_TXID)
    expect(mocked.prepare).not.toHaveBeenCalled()
  })
})

describe('what waits on the person', () => {
  const plan = planOf()
  const ask = { quoted: { quote: quoteOf(), quotedAt: NOW }, tier: 'medium', reason: 'forced', verdict: 'fine', planTxids: [] }
  test.each<[string, PassOutcome, boolean]>([
    ['ask', { kind: 'ask', plan, ask } as PassOutcome, true],
    ['short', { kind: 'short', plan, address: FEE_ADDRESS, missingSat: 1_000, pending: false }, true],
    ['idle', { kind: 'idle' }, false],
    ['done', { kind: 'done', plan }, false],
    ['offline', { kind: 'offline', plan }, false],
    ['followed', { kind: 'followed', plan, sent: 1, refused: [] }, false],
    ['closed', { kind: 'closed', plan }, false],
    ['stuck', { kind: 'stuck', plan }, false],
  ])('%s: %s', (_kind, outcome, waits) => {
    expect(waitsOnPerson(outcome)).toBe(waits)
  })
})

describe('paying more', () => {
  const fast = quoteOf({ feeRateSatPerVbyte: 20n, totalFeeSats: 24_000n })
  const after = recoveryOf({
    feeRateSatPerVbyte: 20n,
    transactions: [stepOf({ status: READY, txid: 'e'.repeat(64), txHex: 'feed', cpfpTxHex: 'beef' })],
  })

  const askedFor = async (): Promise<ExitAsk> => {
    const answer = await payMore('primary', clock)
    if (answer.kind !== 'ask') {
      throw new Error(`no ask: ${answer.kind}`)
    }
    return answer.ask
  }

  beforeEach(async () => {
    await saveExitPlan(planOf())
    mocked.prepare.mockResolvedValue(fast)
    mocked.recover.mockResolvedValue(after)
    mocked.rate.mockImplementation(async tier => (tier === 'fast' ? 20n : 10n))
  })

  test('the tap takes the figures at the fast rate, naming the same leaves, and spends nothing', async () => {
    const ask = await askedFor()
    expect(ask).toMatchObject({ reason: 'raise', tier: 'fast', verdict: 'thin', quoted: { quote: fast } })
    expect(mocked.prepare.mock.calls[0][0]).toMatchObject({
      feeRateSatPerVbyte: 20n,
      selection: { leafIds: ['leaf-1', 'leaf-2'] },
    })
    expect(mocked.recover).not.toHaveBeenCalled()
    expect(mocked.pair).not.toHaveBeenCalled()
  })

  test('a value under the fee comes back with a verdict that has no confirm, and a confirm still builds nothing', async () => {
    mocked.prepare.mockResolvedValue(quoteOf({ recoverableValueSats: 10_000n, totalFeeSats: 25_000n, feeRateSatPerVbyte: 20n }))
    const ask = await askedFor()
    expect(ask.verdict).toBe('notWorth')
    expect((await confirmAsk('primary', ask, clock)).kind).toBe('failed')
    expect(mocked.recover).not.toHaveBeenCalled()
    expect(mocked.pair).not.toHaveBeenCalled()
  })

  test('the confirm builds on the figures shown, writes, then sends', async () => {
    const ask = await askedFor()
    let seen: ExitPlan | null = null
    mocked.pair.mockImplementation(async () => {
      seen = await loadExitPlan('primary')
      return { status: 'sent', host: 'mempool.space' }
    })
    expect((await confirmAsk('primary', ask, clock)).kind).toBe('paid')
    expect(mocked.recover.mock.calls[0][0]).toBe(fast)
    expect(mocked.pair).toHaveBeenCalledWith('feed', 'beef', 'e'.repeat(64))
    expect((seen as unknown as ExitPlan).recovery.transactions[0].txHex).toBe('feed')
  })

  test('the plan a confirm answers is the one after the send, so a refusal reaches the screen', async () => {
    mocked.pair.mockResolvedValue({ status: 'refused', reason: 'TRUC-violation' })
    const answer = await confirmAsk('primary', await askedFor(), clock)
    expect(answer).toMatchObject({ kind: 'paid', plan: { refused: [{ reason: 'TRUC-violation' }] } })
  })

  test('figures gone old are taken again and shown, and nothing is built on them', async () => {
    const ask = await askedFor()
    const aged = { ...ask, quoted: { ...ask.quoted, quotedAt: NOW - 30 * 60_000 - 1 } }
    expect(await confirmAsk('primary', aged, clock)).toMatchObject({ kind: 'ask', ask: { quoted: { quotedAt: NOW } } })
    expect(mocked.prepare).toHaveBeenCalledTimes(2)
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('a rate that rose takes the figures again', async () => {
    const ask = await askedFor()
    mocked.rate.mockResolvedValue(30n)
    expect((await confirmAsk('primary', ask, clock)).kind).toBe('ask')
    expect(mocked.prepare.mock.calls[1][0].feeRateSatPerVbyte).toBe(30n)
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('a plan that changed transactions takes the figures again', async () => {
    const ask = await askedFor()
    await saveExitPlan(planOf({ recovery: recoveryOf({ transactions: [stepOf({ status: READY, txid: 'c'.repeat(64) })] }) }))
    expect((await confirmAsk('primary', ask, clock)).kind).toBe('ask')
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('a plan that ended meanwhile takes no build', async () => {
    const ask = await askedFor()
    await saveExitPlan(planOf({ verdict: 'done' }))
    expect((await confirmAsk('primary', ask, clock)).kind).toBe('failed')
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('a higher rate the funding cannot pay says what is missing', async () => {
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: [], pendingSat: 0 })
    mocked.recover.mockRejectedValue(insufficient(25_000n))
    const answer = await confirmAsk('primary', await askedFor(), clock)
    expect(answer).toMatchObject({ kind: 'short', missingSat: 25_000 + 68 * 20, pending: false, address: FEE_ADDRESS })
    expect((await loadExitPlan('primary'))?.recovery.feeRateSatPerVbyte).toBe(10n)
  })

  test('a build that came back past the figures asks again and sends nothing', async () => {
    mocked.recover.mockResolvedValue(recoveryOf({ recoverableValueSats: 12_000n, totalFeeSats: 12_500n }))
    const answer = await confirmAsk('primary', await askedFor(), clock)
    expect(answer).toMatchObject({ kind: 'ask', ask: { verdict: 'notWorth' } })
    expect(mocked.pair).not.toHaveBeenCalled()
  })

  test('the question of a pass goes through the same confirm', async () => {
    mocked.rate.mockResolvedValue(11n)
    mocked.prepare.mockResolvedValue(quoteOf({ feeRateSatPerVbyte: 11n }))
    mocked.check.mockImplementation(async recovery => verdict(recovery, 'redo'))
    const pass = await runExitPass('primary', clock)
    if (pass.kind !== 'ask') {
      throw new Error(pass.kind)
    }
    expect((await confirmAsk('primary', pass.ask, clock)).kind).toBe('paid')
    expect(mocked.pair).toHaveBeenCalledWith('feed', 'beef', 'e'.repeat(64))
  })

  test('figures with no leaves left end the plan, by the tap or by the confirm', async () => {
    const ask = await askedFor()
    mocked.prepare.mockResolvedValue(quoteOf({ leaves: [] }))
    const aged = { ...ask, quoted: { ...ask.quoted, quotedAt: NOW - 30 * 60_000 - 1 } }
    expect((await confirmAsk('primary', aged, clock)).kind).toBe('closed')
    await saveExitPlan(planOf())
    expect((await payMore('primary', clock)).kind).toBe('closed')
  })

  test('a plan already at the fast rate is left alone', async () => {
    mocked.rate.mockResolvedValue(10n)
    expect((await payMore('primary', clock)).kind).toBe('top')
    expect(mocked.prepare).not.toHaveBeenCalled()
  })

  test('waits for a pass under way', async () => {
    let release = (_value: never) => undefined as void
    mocked.check.mockReturnValue(new Promise(resolve => (release = resolve as never)))
    const pass = runExitPass('primary', clock)
    const paying = payMore('primary', clock)
    await Promise.resolve()
    expect(mocked.prepare).not.toHaveBeenCalled()
    release(verdict(recoveryOf()) as never)
    await pass
    await paying
    expect(mocked.prepare).toHaveBeenCalledTimes(1)
  })

  test('two confirms take one turn each, and only the first builds on the figures', async () => {
    const ask = await askedFor()
    const [first, second] = await Promise.all([confirmAsk('primary', ask, clock), confirmAsk('primary', ask, clock)])
    expect(mocked.recover).toHaveBeenCalledTimes(1)
    expect(first.kind).toBe('paid')
    expect(second.kind).toBe('ask')
  })
})

describe('with the switch off', () => {
  beforeEach(() => __setEmergencyExitLiveForTests(false))

  test('no pass, no quote, no build and no chain read', async () => {
    expect(await runExitPass('primary', clock)).toEqual({ kind: 'idle' })
    expect((await prepareExit('primary', DESTINATION, 'all', clock)).kind).toBe('failed')
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('failed')
    expect((await payMore('primary', clock)).kind).toBe('failed')
    expect((await confirmAsk('primary', {} as ExitAsk, clock)).kind).toBe('failed')
    for (const reached of [
      mocked.check,
      mocked.prepare,
      mocked.recover,
      mocked.rate,
      mocked.tx,
      mocked.pair,
      mocked.funding,
      loadSeedFor,
      exitFeeAddress,
      withExitFeeSecret,
    ]) {
      expect(reached).not.toHaveBeenCalled()
    }
  })
})

// BIP431 caps a TRUC child at 1,000 vbytes, and the first child of a branch spends every coin it is handed.
describe('a child the network takes', () => {
  const coinsOf = (values: number[]) =>
    values.map((valueSat, vout) => ({ txid: 'cd'.repeat(32), vout, valueSat }))
  const withChild = (coins: number) =>
    recoveryOf({ transactions: [stepOf({ status: READY, txHex: 'feed', cpfpTxHex: cpfpChildHex(coins) })] })

  test('a build is handed at most 13 coins, the largest', async () => {
    const values = Array.from({ length: 20 }, (_, index) => (index + 1) * 1_000)
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: coinsOf(values), pendingSat: 0 })
    mocked.recover.mockResolvedValue(recoveryOf())
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('started')
    const handed = mocked.recover.mock.calls[0][1]?.utxos.map(coin => coin.valueSat)
    expect(handed).toEqual(values.slice(7).reverse())
  })

  test('with the child full and the fee short, it asks for one coin that covers what the smallest paid', async () => {
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: coinsOf(Array(15).fill(1_000)), pendingSat: 0 })
    mocked.recover.mockRejectedValue(insufficient(20_000n))
    expect(await startExit('primary', DESTINATION, quoted(), clock)).toEqual({
      kind: 'short',
      missingSat: 8_000,
      pending: false,
      oneCoin: true,
    })
    expect(mocked.recover.mock.calls[0][1]?.utxos).toHaveLength(13)
    expect(await loadExitPlan('primary')).toBeNull()
    expect(mocked.tx).not.toHaveBeenCalled()
    expect(mocked.pair).not.toHaveBeenCalled()
  })

  test('with room for another coin the figure stays what is missing, a coin of its own included', async () => {
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: coinsOf(Array(12).fill(1_000)), pendingSat: 0 })
    mocked.recover.mockRejectedValue(insufficient(20_000n))
    expect(await startExit('primary', DESTINATION, quoted(), clock)).toEqual({
      kind: 'short',
      missingSat: 8_680,
      pending: false,
    })
  })

  test('a first build with a child over the limit is discarded, and nothing is written or sent', async () => {
    mocked.recover.mockResolvedValue(withChild(14))
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('failed')
    expect(await loadExitPlan('primary')).toBeNull()
    mocked.recover.mockResolvedValue(withChild(13))
    expect((await startExit('primary', DESTINATION, quoted(), clock)).kind).toBe('started')
    expect(mocked.tx).not.toHaveBeenCalled()
    expect(mocked.pair).not.toHaveBeenCalled()
  })

  describe('on a new build', () => {
    beforeEach(async () => {
      await saveExitPlan(planOf())
      mocked.check.mockImplementation(async recovery => verdict(recovery, 'redo'))
      mocked.prepare.mockResolvedValue(quoteOf())
    })

    test('a child over the limit leaves the plan as it was, and sends nothing', async () => {
      mocked.recover.mockResolvedValue(withChild(14))
      expect((await runExitPass('primary', clock)).kind).toBe('stuck')
      expect((await loadExitPlan('primary'))?.recovery.transactions[0].txHex).toBe('aabb')
      expect(mocked.tx).not.toHaveBeenCalled()
      expect(mocked.pair).not.toHaveBeenCalled()
    })

    test('a child at the limit replaces the plan and goes out', async () => {
      mocked.recover.mockResolvedValue(withChild(13))
      expect((await runExitPass('primary', clock)).kind).toBe('followed')
      expect(mocked.pair).toHaveBeenCalledWith('feed', cpfpChildHex(13), STEP_TXID)
    })

    test('the same rule holds on what is kept and what arrived, and a full child asks for one coin', async () => {
      mocked.funding.mockResolvedValue({ status: 'read', confirmed: coinsOf(Array(14).fill(1_000)), pendingSat: 0 })
      mocked.recover.mockRejectedValue(insufficient(20_000n))
      expect(await runExitPass('primary', clock)).toMatchObject({ kind: 'short', missingSat: 8_000, oneCoin: true })
      expect(mocked.recover.mock.calls[0][1]?.utxos).toHaveLength(13)
      expect((await loadExitPlan('primary'))?.recovery.transactions[0].txHex).toBe('aabb')
    })
  })
})
