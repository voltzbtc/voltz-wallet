import RNFS from 'react-native-fs'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { ReceiveHeldByExit, SpendHeldByExit, classifyWalletError, walletErrorKey } from '../src/wallet/errors'
import { forgetExitPlan, saveExitPlan } from '../src/wallet/exitPlan'
import {
  connectActiveSpark,
  connectSpark,
  disconnectSpark,
  sparkClaimDeposit,
  sparkConfirmConvert,
  sparkConfirmConvertLeg,
  sparkConfirmLnurlPay,
  sparkConfirmLnurlWithdraw,
  sparkConfirmSend,
  sparkListReceiveRoutes,
  sparkOwnSparkAddress,
  sparkParseLnurlPay,
  sparkParseLnurlWithdraw,
  sparkPrepareConvert,
  sparkPrepareLnurlPay,
  sparkPrepareSend,
  sparkReceive,
  sparkReceiveStable,
  sparkBuyBitcoinUrl,
  sparkClaimLnAddressTransfer,
  sparkEnsureLnAddress,
  sparkGetLnAddress,
  sparkRecoverFunds,
  sparkRefundDeposit,
  sparkRegisterLnAddress,
  sparkSetStableBalance,
  sparkTakeLnAddress,
  sparkStopSpendsOnItsOwn,
  sparkConnectedWalletId,
} from '../src/wallet/spark'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { domainFor } from '../src/wallet/lnurlDomainPref'

import { DESTINATION, planOf, quoteOf } from './support/exitFixtures'

// spark.ts is the one place every spend passes, so the exit's hold is held there for every screen.

jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => 'usevoltz.app',
}))
jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(async () => 'abandon '.repeat(11) + 'about'),
  loadPassphraseFor: jest.fn(async () => undefined),
  PRIMARY_ID: 'primary',
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'primary'),
  ensureRegistered: jest.fn(),
}))
jest.mock('../src/wallet/fingerprint', () => ({
  fingerprintFromMnemonic: jest.fn(() => 'fp'),
  fingerprintFromMnemonicAsync: jest.fn(async () => 'fp'),
}))
jest.mock('../src/wallet/lnurlDomainPref', () => ({
  ...jest.requireActual('../src/wallet/lnurlDomainPref'),
  domainFor: jest.fn(async () => undefined),
}))

const PUB = `02${'b'.repeat(64)}`
const MNEMONIC = `${'abandon '.repeat(11)}about`

type Sdk = Record<
  | 'getInfo'
  | 'parse'
  | 'prepareSendPayment'
  | 'sendPayment'
  | 'lnurlPay'
  | 'lnurlWithdraw'
  | 'claimDeposit'
  | 'refundDeposit'
  | 'receivePayment'
  | 'recoverFunds'
  | 'updateUserSettings'
  | 'getCrossChainRoutes'
  | 'buyBitcoin'
  | 'getLightningAddress'
  | 'checkLightningAddressAvailable'
  | 'registerLightningAddress'
  | 'claimLightningAddressTransfer',
  jest.Mock
>
const sdk = (jest.requireMock('@breeztech/breez-sdk-spark-react-native') as { __sdkInstance: Sdk })
  .__sdkInstance

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

// Waits macrotask by macrotask, so every chained promise runs, until `reached` holds.
async function until(reached: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !reached(); i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(reached()).toBe(true)
}

// Holds the next domain read, which a connect makes after it read the hold and before it drops the
// live connection, and tells when the connect of `walletId` has reached it.
function holdDomainRead(walletId: string): { reached: () => Promise<void>; release: () => void } {
  const domain = deferred<string | undefined>()
  const before = jest.mocked(domainFor).mock.calls.length
  jest.mocked(domainFor).mockImplementationOnce(() => domain.promise)
  return {
    reached: () => until(() => jest.mocked(domainFor).mock.calls.slice(before).some(([id]) => id === walletId)),
    release: () => domain.resolve(undefined),
  }
}

// The platform refuses the plan's read, and only that read, until the spy handed back is restored.
function planUnread(): jest.SpyInstance {
  const real = RNFS.readFile
  return jest
    .spyOn(RNFS, 'readFile')
    .mockImplementation((path: string, encoding?: string) =>
      path.includes('exit-plan-') ? Promise.reject(new Error('EACCES')) : real(path, encoding),
    )
}

beforeEach(async () => {
  __setEmergencyExitLiveForTests(true)
  await disconnectSpark()
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  jest.mocked(connect).mockResolvedValue(sdk as never)
  sdk.getInfo.mockResolvedValue({ identityPubkey: PUB, balanceSats: 0n, tokenBalances: new Map() })
  await forgetExitPlan('primary')
  await connectSpark(MNEMONIC)
})

afterEach(() => {
  jest.restoreAllMocks()
  __setEmergencyExitLiveForTests(null)
})

async function lnurlQuote(): Promise<string> {
  sdk.parse.mockResolvedValueOnce({
    tag: 'LightningAddress',
    inner: [{ payRequest: { minSendable: 1000n, maxSendable: 1_000_000n, commentAllowed: 0, domain: 'x.io' } }],
  })
  const pay = await sparkParseLnurlPay('someone@x.io')
  return (await sparkPrepareLnurlPay(pay.handle, 10)).handle
}

// How each spend path reaches its signing call, and the SDK method that would sign.
const spends: [string, () => Promise<() => Promise<unknown>>, keyof Sdk][] = [
  ['a send', async () => {
    const { handle } = await sparkPrepareSend('lnbc1')
    return () => sparkConfirmSend(handle)
  }, 'sendPayment'],
  ['a lightning address pay', async () => {
    const handle = await lnurlQuote()
    return () => sparkConfirmLnurlPay(handle)
  }, 'lnurlPay'],
  ['a conversion leg', async () => {
    const { handle } = await sparkPrepareConvert(undefined, 'btkn1usdb', 1000)
    return () => sparkConfirmConvertLeg(handle)
  }, 'sendPayment'],
  ['a conversion', async () => {
    const { handle } = await sparkPrepareConvert('btkn1usdb', undefined, 1000)
    return () => sparkConfirmConvert(handle)
  }, 'sendPayment'],
  ['turning the dollar balance on', async () => () => sparkSetStableBalance(true), 'updateUserSettings'],
]

describe.each(spends)('%s', (_name, reach, method) => {
  test('goes on with no plan', async () => {
    const spend = await reach()
    await spend()
    expect(sdk[method]).toHaveBeenCalledTimes(1)
  })

  test('is refused while the signing wallet has a live exit, before the SDK is called', async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    const spend = await reach()
    const refusal = await spend().catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(SpendHeldByExit)
    expect(classifyWalletError(refusal)).toBe('exitHeld')
    expect(sdk[method]).not.toHaveBeenCalled()
  })

  test('is refused while the plan cannot be read', async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    const spend = await reach()
    planUnread()
    const refusal = await spend().catch((e: unknown) => e)
    expect(classifyWalletError(refusal)).toBe('exitHeldUnread')
    expect(sdk[method]).not.toHaveBeenCalled()
  })

  test("goes on when the live plan is another wallet's", async () => {
    await saveExitPlan(planOf({ walletId: 'other' }))
    const spend = await reach()
    await spend()
    expect(sdk[method]).toHaveBeenCalledTimes(1)
  })

  // A switch without reconnecting leaves the active wallet apart from the one that signs.
  test('asks the wallet that signs, not the active one', async () => {
    jest.mocked(getActiveWalletId).mockResolvedValue('other')
    await saveExitPlan(planOf({ walletId: 'primary' }))
    const spend = await reach()
    const refusal = await spend().catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(SpendHeldByExit)
    expect(sdk[method]).not.toHaveBeenCalled()

    await forgetExitPlan('primary')
    await saveExitPlan(planOf({ walletId: 'other' }))
    const next = await reach()
    await next()
    expect(sdk[method]).toHaveBeenCalledTimes(1)
  })

  test('goes on with the exit switched off, without reading the plan', async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    __setEmergencyExitLiveForTests(false)
    const spend = await reach()
    const read = jest.spyOn(RNFS, 'readFile')
    await spend()
    expect(sdk[method]).toHaveBeenCalledTimes(1)
    expect(read.mock.calls.some(([path]) => String(path).includes('exit-plan-'))).toBe(false)
  })
})

// The optimizer swaps leaves after a payment (guide/optimize.html), and can swap one an exit is spending.
describe('leaf optimization while an exit is alive', () => {
  const lastConfig = () => {
    const calls = jest.mocked(connect).mock.calls as unknown as [{ config: Record<string, unknown> }][]
    return calls[calls.length - 1][0].config
  }

  test('a wallet with no plan connects with the SDK default', () => {
    expect(lastConfig().leafOptimizationConfig).toEqual({ autoEnabled: true, multiplicity: 1 })
  })

  test('a live plan connects its wallet with automatic optimization off, the multiplicity kept', async () => {
    await saveExitPlan(planOf({ walletId: 'other' }))
    await connectSpark(MNEMONIC, 'other')
    expect(lastConfig().leafOptimizationConfig).toEqual({ autoEnabled: false, multiplicity: 1 })
    await forgetExitPlan('other')
  })

  test('a plan the platform will not read counts as alive', async () => {
    await saveExitPlan(planOf({ walletId: 'other' }))
    planUnread()
    await connectSpark(MNEMONIC, 'other')
    expect(lastConfig().leafOptimizationConfig).toEqual({ autoEnabled: false, multiplicity: 1 })
    jest.restoreAllMocks()
    await forgetExitPlan('other')
  })

  test("another wallet's plan leaves this one's optimizer on", async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    await connectSpark(MNEMONIC, 'other')
    expect(lastConfig().leafOptimizationConfig).toEqual({ autoEnabled: true, multiplicity: 1 })
  })

  test('a connection opened before the exit started is replaced at the next connect, and only once', async () => {
    const before = jest.mocked(connect).mock.calls.length
    await connectSpark(MNEMONIC)
    expect(connect).toHaveBeenCalledTimes(before)

    await saveExitPlan(planOf({ walletId: 'primary' }))
    await connectSpark(MNEMONIC)
    expect(connect).toHaveBeenCalledTimes(before + 1)
    expect(lastConfig().leafOptimizationConfig).toEqual({ autoEnabled: false, multiplicity: 1 })

    await connectSpark(MNEMONIC)
    expect(connect).toHaveBeenCalledTimes(before + 1)
  })

  // Home and every focus connect through the fast path, which once kept such a connection until the
  // process ended.
  test('the fast path of the active wallet replaces a connection that still optimizes', async () => {
    await disconnectSpark()
    await connectActiveSpark()
    const opened = jest.mocked(connect).mock.calls.length
    await connectActiveSpark()
    expect(connect).toHaveBeenCalledTimes(opened)

    await saveExitPlan(planOf({ walletId: 'primary' }))
    await connectActiveSpark()
    expect(connect).toHaveBeenCalledTimes(opened + 1)
    expect(lastConfig().leafOptimizationConfig).toEqual({ autoEnabled: false, multiplicity: 1 })

    // A connection without the optimizer stays while the plan is alive.
    await connectActiveSpark()
    expect(connect).toHaveBeenCalledTimes(opened + 1)
  })

  test('the fast path keeps a connection that optimizes while no exit holds the wallet', async () => {
    await disconnectSpark()
    await connectActiveSpark()
    const opened = jest.mocked(connect).mock.calls.length
    await saveExitPlan(planOf({ walletId: 'other' }))
    await connectActiveSpark()
    expect(connect).toHaveBeenCalledTimes(opened)
    await forgetExitPlan('other')
  })

  test("the exit's stop replaces a connection that optimizes once the plan is written", async () => {
    expect(await sparkStopSpendsOnItsOwn('primary')).toBe(false)
    const opened = jest.mocked(connect).mock.calls.length
    await saveExitPlan(planOf({ walletId: 'primary' }))
    expect(await sparkStopSpendsOnItsOwn('primary')).toBe(true)
    expect(connect).toHaveBeenCalledTimes(opened + 1)
    expect(lastConfig().leafOptimizationConfig).toEqual({ autoEnabled: false, multiplicity: 1 })
    expect(await sparkStopSpendsOnItsOwn('primary')).toBe(true)
    expect(connect).toHaveBeenCalledTimes(opened + 1)
  })

  test("the exit's stop answers false for a connection of another wallet, and replaces nothing", async () => {
    await saveExitPlan(planOf({ walletId: 'other' }))
    const opened = jest.mocked(connect).mock.calls.length
    expect(await sparkStopSpendsOnItsOwn('other')).toBe(false)
    expect(connect).toHaveBeenCalledTimes(opened)
    await forgetExitPlan('other')
  })

  // A pass asks for the stop on its own timer, so a switch the person asked first is not cut by it: the
  // switch lands, and the stop answers false for a connection that is no longer the plan's wallet.
  test("the exit's stop waits for a switch to another wallet asked first, and answers false", async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    const opened = jest.mocked(connect).mock.calls.length
    const read = holdDomainRead('other')
    const switching = connectSpark(MNEMONIC, 'other')
    await read.reached()
    const stopping = sparkStopSpendsOnItsOwn('primary')
    read.release()
    await expect(switching).resolves.toBeDefined()
    expect(await stopping).toBe(false)
    expect(sparkConnectedWalletId()).toBe('other')
    expect(connect).toHaveBeenCalledTimes(opened + 1)
  })

  // The pass still never sends on a connection that spends on its own: a switch asked after the stop
  // cuts it, and the stop answers false.
  test("a switch to another wallet asked after the exit's stop cuts it, and the stop answers false", async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    const read = holdDomainRead('primary')
    const stopping = sparkStopSpendsOnItsOwn('primary')
    await read.reached()
    const switching = connectSpark(MNEMONIC, 'other')
    expect(await stopping).toBe(false)
    read.release()
    await switching
    expect(sparkConnectedWalletId()).toBe('other')
  })

  test('with the exit switched off nothing is read and the default stays', async () => {
    await saveExitPlan(planOf({ walletId: 'other' }))
    __setEmergencyExitLiveForTests(false)
    const read = jest.spyOn(RNFS, 'readFile')
    await connectSpark(MNEMONIC, 'other')
    expect(lastConfig().leafOptimizationConfig).toEqual({ autoEnabled: true, multiplicity: 1 })
    expect(read.mock.calls.some(([path]) => String(path).includes('exit-plan-'))).toBe(false)
    __setEmergencyExitLiveForTests(true)
    await forgetExitPlan('other')
  })
})

// An active stable balance converts excess sats on receive on its own (guide/stable_balance.html, "On
// receive"), spending Available leaves an All plan may be taking. With no stable balance in the config
// the SDK builds neither the middleware nor its worker (build_stable_balance in sdk_builder.rs).
describe('the stable balance while an exit is alive', () => {
  const lastConfig = () => {
    const calls = jest.mocked(connect).mock.calls as unknown as [{ config: Record<string, unknown> }][]
    return calls[calls.length - 1][0].config
  }
  const usdbOnly = { tokens: [{ label: 'USD', tokenIdentifier: expect.any(String) }] }

  test('a wallet with no plan connects with the stable balance configured', () => {
    expect(lastConfig().stableBalanceConfig).toMatchObject(usdbOnly)
  })

  test('a live plan connects its wallet with no stable balance', async () => {
    await saveExitPlan(planOf({ walletId: 'other' }))
    await connectSpark(MNEMONIC, 'other')
    expect(lastConfig().stableBalanceConfig).toBeUndefined()
    await forgetExitPlan('other')
  })

  test('a plan the platform will not read connects its wallet with no stable balance', async () => {
    await saveExitPlan(planOf({ walletId: 'other' }))
    planUnread()
    await connectSpark(MNEMONIC, 'other')
    expect(lastConfig().stableBalanceConfig).toBeUndefined()
    jest.restoreAllMocks()
    await forgetExitPlan('other')
  })

  test("another wallet's plan leaves this one's stable balance configured", async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    await connectSpark(MNEMONIC, 'other')
    expect(lastConfig().stableBalanceConfig).toMatchObject(usdbOnly)
  })

  // Every path that hands back a connection: connectSpark, the fast path of the active wallet, and the
  // stop a pass asks before it transmits.
  test('a connection opened before the exit started is replaced by one with no stable balance', async () => {
    await disconnectSpark()
    await connectActiveSpark()
    expect(lastConfig().stableBalanceConfig).toMatchObject(usdbOnly)
    const opened = jest.mocked(connect).mock.calls.length
    await saveExitPlan(planOf({ walletId: 'primary' }))
    await connectActiveSpark()
    expect(connect).toHaveBeenCalledTimes(opened + 1)
    expect(lastConfig().stableBalanceConfig).toBeUndefined()

    await disconnectSpark()
    await forgetExitPlan('primary')
    await connectSpark(MNEMONIC)
    expect(lastConfig().stableBalanceConfig).toMatchObject(usdbOnly)
    await saveExitPlan(planOf({ walletId: 'primary' }))
    await connectSpark(MNEMONIC)
    expect(lastConfig().stableBalanceConfig).toBeUndefined()

    await disconnectSpark()
    await forgetExitPlan('primary')
    await connectSpark(MNEMONIC)
    await saveExitPlan(planOf({ walletId: 'primary' }))
    expect(await sparkStopSpendsOnItsOwn('primary')).toBe(true)
    expect(lastConfig().stableBalanceConfig).toBeUndefined()
  })

})

// Once the wallet's hold reads none, the next connection request for it, on any path, hands back a
// connection with the stable balance configured and the optimizer on, with no restart and no switch.
// Without them Home reads the dollar mode as off, receives stay in sats, and turning it on is
// refused ("Stable balance is not configured", sdk/api.rs).
describe('the first connection request after the hold ends', () => {
  const calls = () => jest.mocked(connect).mock.calls as unknown as [{ config: Record<string, unknown> }][]
  const opened = () => calls().length
  const expectRestored = () => {
    const { config } = calls()[opened() - 1][0]
    expect(config.stableBalanceConfig).toMatchObject({
      tokens: [{ label: 'USD', tokenIdentifier: expect.any(String) }],
    })
    expect(config.leafOptimizationConfig).toEqual({ autoEnabled: true, multiplicity: 1 })
  }
  const expectHeld = () => {
    const { config } = calls()[opened() - 1][0]
    expect(config.stableBalanceConfig).toBeUndefined()
    expect(config.leafOptimizationConfig).toEqual({ autoEnabled: false, multiplicity: 1 })
  }
  const ended = () => saveExitPlan(planOf({ walletId: 'primary', verdict: 'done' }))

  test('a connect of the wallet replaces the held connection, and only once', async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    await connectSpark(MNEMONIC)
    expectHeld()
    const held = opened()
    await ended()
    await connectSpark(MNEMONIC)
    expect(opened()).toBe(held + 1)
    expectRestored()
    await connectSpark(MNEMONIC)
    expect(opened()).toBe(held + 1)
  })

  test('the fast path of the active wallet replaces the held connection, and only once', async () => {
    await disconnectSpark()
    await saveExitPlan(planOf({ walletId: 'primary' }))
    await connectActiveSpark()
    await connectActiveSpark()
    expectHeld()
    const held = opened()
    await ended()
    await connectActiveSpark()
    expect(opened()).toBe(held + 1)
    expectRestored()
    await connectActiveSpark()
    expect(opened()).toBe(held + 1)
  })

  test('a connection opened while the plan could not be read is replaced once it reads as ended', async () => {
    await disconnectSpark()
    await ended()
    const refusing = planUnread()
    await connectActiveSpark()
    expectHeld()
    const held = opened()
    refusing.mockRestore()
    await connectActiveSpark()
    expect(opened()).toBe(held + 1)
    expectRestored()
    await saveExitPlan(planOf({ walletId: 'primary' }))
    const refusingAgain = planUnread()
    await connectSpark(MNEMONIC)
    expectHeld()
    refusingAgain.mockRestore()
    await ended()
    await connectSpark(MNEMONIC)
    expect(opened()).toBe(held + 3)
    expectRestored()
  })

  // A dropped instance takes the call it runs down with it, so the held connection stays while a
  // prepare runs on it and the first request after it ends replaces it.
  test('a held connection stays while a prepare runs on it, and is replaced at the next request', async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    await connectSpark(MNEMONIC)
    const held = opened()
    let answer!: (quote: unknown) => void
    const quote = await sdk.prepareSendPayment()
    sdk.prepareSendPayment.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    const preparing = sparkPrepareSend('lnbc1')
    await ended()
    await connectSpark(MNEMONIC)
    await connectActiveSpark()
    expect(opened()).toBe(held)
    answer(quote)
    await preparing
    await connectActiveSpark()
    expect(opened()).toBe(held + 1)
    expectRestored()
  })

  // The connect checks again in the step that drops, since a prepare can start during its reads, after
  // the first check found nothing in flight.
  test('a prepare that starts during the reads of a connect keeps the held connection', async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    await connectSpark(MNEMONIC)
    const held = opened()
    await ended()
    const read = holdDomainRead('primary')
    const connecting = connectSpark(MNEMONIC)
    await read.reached()
    let answer!: (quote: unknown) => void
    const quote = await sdk.prepareSendPayment()
    sdk.prepareSendPayment.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    const preparing = sparkPrepareSend('lnbc1')
    read.release()
    await connecting
    expect(opened()).toBe(held)
    answer(quote)
    await preparing
    await connectActiveSpark()
    expect(opened()).toBe(held + 1)
    expectRestored()
  })
})

// The wallet asked about is the one that signs: a connection replaced during the read signs nothing.
test('a connection replaced while the plan is read signs nothing', async () => {
  const { handle } = await sparkPrepareSend('lnbc1')
  const confirming = sparkConfirmSend(handle).catch((e: unknown) => e)
  await disconnectSpark()
  await connectSpark(MNEMONIC, 'other')
  expect(await confirming).toEqual(new Error('spark not connected'))
  expect(sdk.sendPayment).not.toHaveBeenCalled()
})

// The exit's own calls, a refund of a deposit and the dollar balance switched off never wait on it.
describe('with a live exit and a plan that cannot be read', () => {
  const unheld: [string, () => Promise<unknown>, keyof Sdk][] = [
    ['a refund of a deposit, which spends no leaf', () => sparkRefundDeposit('tx', 0, DESTINATION, 300), 'refundDeposit'],
    ["the exit's own build", () => sparkRecoverFunds(quoteOf({ funding: undefined })), 'recoverFunds'],
    ['turning the dollar balance off', () => sparkSetStableBalance(false), 'updateUserSettings'],
  ]

  test.each(unheld)('%s goes on with a live plan', async (_name, run, method) => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    await run()
    expect(sdk[method]).toHaveBeenCalledTimes(1)
  })

  test.each(unheld)('%s goes on with a plan that cannot be read', async (_name, run, method) => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    planUnread()
    await run()
    expect(sdk[method]).toHaveBeenCalledTimes(1)
  })
})

function voucher(): void {
  sdk.parse.mockResolvedValueOnce({
    tag: 'LnurlWithdraw',
    inner: [{ minWithdrawable: 1000n, maxWithdrawable: 100_000n, defaultDescription: '' }],
  })
}

async function stableRoute(): Promise<string> {
  sdk.getCrossChainRoutes.mockResolvedValueOnce([
    {
      provider: 1,
      chain: 'solana',
      asset: 'USDC',
      decimals: 6,
      contractAddress: undefined,
      acceptedAssets: [{ asset: { tag: 'Bitcoin' }, limits: undefined }],
    },
  ])
  sdk.receivePayment.mockResolvedValueOnce({
    paymentRequest: 'solana:addr',
    fee: 0n,
    crossChainInfo: { depositAddress: 'addr', depositAmount: 10_000_000n, expectedReceivedAmount: 9_000n, expiresAt: 0n },
  })
  return (await sparkListReceiveRoutes(false))[0].id
}

// How each receive reaches the SDK, and the SDK method that would make or claim it. The parts of a
// path that make no receive (the voucher's read, the route list) run before the plan is written.
const receives: [string, () => Promise<() => Promise<unknown>>, keyof Sdk][] = [
  ['a Lightning invoice', async () => () => sparkReceive('lightning', 1000), 'receivePayment'],
  ['a Bitcoin address', async () => () => sparkReceive('onchain'), 'receivePayment'],
  ['a Spark address', async () => () => sparkReceive('spark'), 'receivePayment'],
  ['a token invoice', async () => () => sparkReceive('spark', 10n, undefined, 'btkn1usdb'), 'receivePayment'],
  ['the address a refund lands at', async () => () => sparkOwnSparkAddress(PUB), 'receivePayment'],
  ['a cross-chain receive', async () => {
    const id = await stableRoute()
    return () => sparkReceiveStable(id, '10')
  }, 'receivePayment'],
  ['reading a voucher', async () => () => {
    voucher()
    return sparkParseLnurlWithdraw('lnurl1withdraw')
  }, 'parse'],
  ['pulling a voucher in', async () => {
    voucher()
    const { handle } = await sparkParseLnurlWithdraw('lnurl1withdraw')
    return () => sparkConfirmLnurlWithdraw(handle, 10)
  }, 'lnurlWithdraw'],
  ['claiming a deposit', async () => () => sparkClaimDeposit('tx', 0), 'claimDeposit'],
  // The SDK hands Moonpay the wallet's static deposit address (buy.rs in SDK 0.28.0).
  ['buying bitcoin', async () => () => sparkBuyBitcoinUrl(50_000), 'buyBitcoin'],
]

describe.each(receives)('%s', (_name, reach, method) => {
  test('goes on with no plan', async () => {
    const receive = await reach()
    sdk[method].mockClear()
    await receive()
    expect(sdk[method]).toHaveBeenCalledTimes(1)
  })

  test('is refused while the wallet has a live exit, before the SDK is called', async () => {
    const receive = await reach()
    sdk[method].mockClear()
    await saveExitPlan(planOf({ walletId: 'primary' }))
    const refusal = await receive().catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(ReceiveHeldByExit)
    expect(classifyWalletError(refusal)).toBe('receiveHeld')
    expect(walletErrorKey(classifyWalletError(refusal))).toBe('emergencyExit.receiveHeld')
    expect(sdk[method]).not.toHaveBeenCalled()
  })

  test('is refused while the plan cannot be read', async () => {
    const receive = await reach()
    sdk[method].mockClear()
    await saveExitPlan(planOf({ walletId: 'primary' }))
    planUnread()
    const refusal = await receive().catch((e: unknown) => e)
    expect(classifyWalletError(refusal)).toBe('receiveHeldUnread')
    expect(walletErrorKey(classifyWalletError(refusal))).toBe('emergencyExit.receiveHeldUnread')
    expect(sdk[method]).not.toHaveBeenCalled()
  })

  test("goes on when the live plan is another wallet's", async () => {
    const receive = await reach()
    sdk[method].mockClear()
    await saveExitPlan(planOf({ walletId: 'other' }))
    await receive()
    expect(sdk[method]).toHaveBeenCalledTimes(1)
  })

  // The SDK receives into the connected wallet, which a switch without reconnecting leaves apart.
  test('asks the wallet that receives, not the active one', async () => {
    jest.mocked(getActiveWalletId).mockResolvedValue('other')
    const receive = await reach()
    sdk[method].mockClear()
    await saveExitPlan(planOf({ walletId: 'primary' }))
    expect(await receive().catch((e: unknown) => e)).toBeInstanceOf(ReceiveHeldByExit)
    expect(sdk[method]).not.toHaveBeenCalled()
  })

  test('goes on with the exit switched off, without reading the plan', async () => {
    const receive = await reach()
    sdk[method].mockClear()
    await saveExitPlan(planOf({ walletId: 'primary' }))
    __setEmergencyExitLiveForTests(false)
    const read = jest.spyOn(RNFS, 'readFile')
    await receive()
    expect(sdk[method]).toHaveBeenCalledTimes(1)
    expect(read.mock.calls.some(([path]) => String(path).includes('exit-plan-'))).toBe(false)
  })
})

// A lightning address made, claimed or handed to a screen is a way to receive into the wallet. Each
// is refused before the SDK is asked anything, its read of the current address included; the paths
// that go on with no plan are held by the address suites.
const addresses: [string, () => Promise<unknown>][] = [
  ['the address a screen asks for', () => sparkEnsureLnAddress()],
  ['the address a screen reads', () => sparkGetLnAddress()],
  ['registering a chosen name', () => sparkRegisterLnAddress('alice')],
  ['taking a paid name', () => sparkTakeLnAddress('alice', 'primary')],
  ['claiming a name another wallet gave', () =>
    sparkClaimLnAddressTransfer({ username: 'alice', pubkey: PUB, signature: 'sig' } as never, 'other')],
]
const addressCalls: (keyof Sdk)[] = [
  'getLightningAddress',
  'checkLightningAddressAvailable',
  'registerLightningAddress',
  'claimLightningAddressTransfer',
]

describe.each(addresses)('%s', (_name, run) => {
  test('is refused while the wallet has a live exit, before the SDK is called', async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    const refusal = await run().catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(ReceiveHeldByExit)
    expect(classifyWalletError(refusal)).toBe('receiveHeld')
    addressCalls.forEach(method => expect(sdk[method]).not.toHaveBeenCalled())
  })

  test('is refused while the plan cannot be read', async () => {
    await saveExitPlan(planOf({ walletId: 'primary' }))
    planUnread()
    const refusal = await run().catch((e: unknown) => e)
    expect(classifyWalletError(refusal)).toBe('receiveHeldUnread')
    addressCalls.forEach(method => expect(sdk[method]).not.toHaveBeenCalled())
  })

  test("is not refused for another wallet's plan", async () => {
    await saveExitPlan(planOf({ walletId: 'other' }))
    const answer = await run().catch((e: unknown) => e)
    expect(answer).not.toBeInstanceOf(ReceiveHeldByExit)
    await forgetExitPlan('other')
  })
})

test('a connection replaced while the plan is read receives nothing', async () => {
  const receiving = sparkReceive('lightning', 1000).catch((e: unknown) => e)
  await disconnectSpark()
  await connectSpark(MNEMONIC, 'other')
  expect(await receiving).toEqual(new Error('spark not connected'))
  expect(sdk.receivePayment).not.toHaveBeenCalled()
})
