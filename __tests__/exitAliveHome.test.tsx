import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { HomeScreen } from '../src/screens/HomeScreen'
import { formatSats } from '../src/wallet/amount'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { forgetExitPlan, saveExitPlan } from '../src/wallet/exitPlan'
import { runExitPass, type PassOutcome } from '../src/wallet/exitPass'
import { exitOnItsWay } from '../src/wallet/exitQuote'
import { USDB } from '../src/wallet/tokens'
import { planOf, recoveryOf } from './support/exitFixtures'
import { RecoveryMethod } from '@breeztech/breez-sdk-spark-react-native'
import {
  connectActiveSpark,
  sparkGetFiatRates,
  sparkGetWalletInfo,
  type SparkWalletInfo,
} from '../src/wallet/spark'

jest.mock('../src/wallet/spark', () => ({
  sparkLeafIsCooperative: jest.requireActual('../src/wallet/spark').sparkLeafIsCooperative,
  sparkConnectedWalletId: () => 'primary',
  sparkSetStableBalance: jest.fn(async () => undefined),
  sparkConversionLimits: jest.fn(async () => ({})),
  sparkPrepareConvertBySpend: jest.fn(),
  sparkDiscardConvertQuote: jest.fn(),
  onSparkSynced: () => () => undefined,
  onSparkRecoverableFunds: jest.fn(() => () => undefined),
  sparkSyncWaitLeftMs: () => 0,
  sparkRefreshWallet: jest.fn(async () => undefined),
  sparkSyncState: jest.fn(() => 'synced'),
  connectActiveSpark: jest.fn(),
  onSparkConnected: (cb: () => void) => {
    cb()
    return () => undefined
  },
  sparkGetWalletInfo: jest.fn(),
  sparkGetFiatRates: jest.fn(),
  sparkSubscribeToPayments: jest.fn().mockResolvedValue(() => undefined),
  sparkListUnclaimedDeposits: jest.fn(async () => []),
  sparkClaimDeposit: jest.fn(),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))

jest.mock('../src/wallet/exitPass', () => ({
  ...jest.requireActual('../src/wallet/exitPass'),
  runExitPass: jest.fn(async () => ({ kind: 'idle' })),
}))

jest.mock('../src/wallet/updateNotice', () => ({
  ...jest.requireActual('../src/wallet/updateNotice'),
  readUpdateNotice: jest.fn(async () => null),
}))

jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useDollarMode: () => false,
    useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }),
  }
})

const mockNavigation = { navigate: jest.fn() }
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => mockNavigation,
    useFocusEffect: (callback: () => void | (() => void)) => react.useEffect(callback, [callback]),
  }
})


const texts = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
  tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })

const info = (over: Partial<SparkWalletInfo> = {}): SparkWalletInfo => ({
  sync: 'synced',
  balanceSat: 24_575,
  recoverableSat: 0,
  tokens: [],
  ...over,
})

async function settle(ms = 20): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

async function home(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<HomeScreen />)
  })
  await settle()
  return tree
}


const leaf = (leafId: string, valueSats: bigint, method = RecoveryMethod.Unilateral) => ({
  leafId,
  valueSats,
  method,
})

// Two leaves on their way out of a balance one sat short of three of them, from an All exit.
// recoveryOf takes 3,000 of sweep fee off the value and has funding, so what arrives is a floor.
const exiting = planOf({
  selection: 'all',
  recovery: recoveryOf({
    leaves: [leaf('a', 8_192n), leaf('b', 8_192n)],
    recoverableValueSats: 16_384n,
  }),
})

const arrives = (sat: number): string =>
  i18n.t('emergencyExit.homeArrivesAtLeast', { amount: i18n.t('send.sats', { amount: formatSats(sat) }) })

const shown = (tree: ReactTestRenderer.ReactTestRenderer): string => texts(tree).join(' ')

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  __setEmergencyExitLiveForTests(true)
  jest.clearAllMocks()
  jest.mocked(connectActiveSpark).mockResolvedValue(undefined as never)
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(info())
  // No rate, so the hero is the bitcoin balance in sats and the figure on trial is the one drawn.
  jest.mocked(sparkGetFiatRates).mockResolvedValue({})
  await forgetExitPlan('primary')
})

afterEach(() => {
  jest.restoreAllMocks()
  __setEmergencyExitLiveForTests(null)
})

const heldLine = (): string => i18n.t('emergencyExit.balanceHeld')

describe('Home while an exit is alive', () => {
  // Once a branch's first step confirms and a sync runs, the SDK's balance already leaves those leaves
  // out, and the binding gives no status per leaf, so Home draws the SDK's figure as it answers.
  test('an All exit draws the SDK figure, never as the total, under the held line, and says what arrives', async () => {
    await saveExitPlan(exiting)
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 100_000 })
    const tree = await home()
    expect(shown(tree)).toContain(formatSats(24_575))
    expect(shown(tree)).not.toContain(formatSats(8_191))
    expect(shown(tree)).not.toContain(i18n.t('home.balance'))
    expect(shown(tree)).toContain(i18n.t('home.bitcoinBalance'))
    expect(shown(tree)).toContain(heldLine())
    expect(shown(tree)).toContain(arrives(16_384 - 3_000))
    // The value before fees is never stated as what moves or arrives.
    expect(shown(tree)).not.toContain(formatSats(16_384))
  })

  test('a RecoverableOnly exit draws the same figure and line', async () => {
    await saveExitPlan({ ...exiting, selection: 'recoverable' })
    const tree = await home()
    expect(shown(tree)).toContain(formatSats(24_575))
    expect(shown(tree)).toContain(heldLine())
    expect(shown(tree)).toContain(arrives(16_384 - 3_000))
  })

  // After the first confirmation the SDK already answers the balance without the leaves, and taking
  // the plan's leaves off again would draw 0.
  test('once the SDK took the leaves out itself, the figure is what the SDK says and never less', async () => {
    await saveExitPlan(exiting)
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ balanceSat: 8_191 }))
    const tree = await home()
    expect(shown(tree)).toContain(formatSats(8_191))
    expect(shown(tree)).not.toMatch(/(^|\s)0 sats/)
    expect(shown(tree)).toContain(heldLine())
    expect(shown(tree)).toContain(arrives(16_384 - 3_000))
  })

  // A token has a value, so without an exit this wallet's figure is the total.
  test('with tokens the figure is still the bitcoin balance and never the total', async () => {
    await saveExitPlan(exiting)
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 100_000 })
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(
      info({ tokens: [{ identifier: USDB.identifier, ticker: 'USDB', name: 'USDB', decimals: 6, balanceBaseUnits: 10_000_000 }] }),
    )
    const tree = await home()
    expect(shown(tree)).not.toContain(i18n.t('home.balance'))
    expect(shown(tree)).toContain(i18n.t('home.bitcoinBalance'))
    expect(shown(tree)).toContain(heldLine())
  })

  test('without funding what arrives stands plain, no floor', async () => {
    await saveExitPlan(
      planOf({
        selection: 'recoverable',
        feeKey: null,
        recovery: recoveryOf({
          leaves: [leaf('c', 5_000n, RecoveryMethod.Cooperative)],
          recoverableValueSats: 5_000n,
          cooperativeFeeSats: 400n,
          sweepFeeSats: 0n,
          fundingInputs: [],
        }),
      }),
    )
    const tree = await home()
    expect(shown(tree)).toContain(
      i18n.t('emergencyExit.homeArrives', { amount: i18n.t('send.sats', { amount: formatSats(4_600) }) }),
    )
  })

  test('with no plan the balance is the SDK figure and nothing is said of an exit', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 100_000 })
    const tree = await home()
    expect(shown(tree)).toContain(formatSats(24_575))
    expect(shown(tree)).not.toContain(arrives(16_384 - 3_000))
    expect(shown(tree)).toContain(i18n.t('home.balance'))
    expect(shown(tree)).not.toContain(heldLine())
  })

  test('a plan that ended says nothing of a hold', async () => {
    await saveExitPlan({ ...exiting, verdict: 'done' })
    const tree = await home()
    expect(shown(tree)).toContain(formatSats(24_575))
    expect(shown(tree)).not.toContain(heldLine())
  })

  test('a plan the platform will not read draws the SDK figure, not as the total, under the held line', async () => {
    await saveExitPlan(exiting)
    const real = RNFS.readFile
    jest
      .spyOn(RNFS, 'readFile')
      .mockImplementation((path: string, encoding?: string) =>
        path.includes('exit-plan-') ? Promise.reject(new Error('EACCES')) : real(path, encoding),
      )
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 100_000 })
    const tree = await home()
    expect(shown(tree)).toContain(formatSats(24_575))
    expect(shown(tree)).not.toContain(i18n.t('home.balance'))
    expect(shown(tree)).toContain(i18n.t('home.bitcoinBalance'))
    expect(shown(tree)).toContain(heldLine())
    expect(shown(tree)).toContain(i18n.t('emergencyExit.balanceUnread'))
  })

  test('a read of the plan that never answers falls back to the unread figure', async () => {
    await saveExitPlan(exiting)
    const real = RNFS.readFile
    const held: (() => void)[] = []
    jest.spyOn(RNFS, 'readFile').mockImplementation((path: string, encoding?: string) =>
      path.includes('exit-plan-')
        ? new Promise<string>((resolve, reject) => held.push(() => real(path, encoding).then(resolve, reject)))
        : real(path, encoding),
    )
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    try {
      const answer = exitOnItsWay('primary')
      await jest.advanceTimersByTimeAsync(5_000)
      expect(await answer).toBe('unread')
    } finally {
      jest.useRealTimers()
      // The plan file's queue waits on the read, so it answers before the next test writes.
      held.splice(0).forEach(release => release())
    }
  })

  test('with the exit switched off nothing is read and nothing is said of a hold', async () => {
    await saveExitPlan(exiting)
    __setEmergencyExitLiveForTests(false)
    const tree = await home()
    expect(shown(tree)).toContain(formatSats(24_575))
    expect(shown(tree)).not.toContain(heldLine())
  })
})

describe('an exit whose last check diverged, or whose pass waits on the person', () => {
  // What a pass leaves on disk when the check answers redo: the same plan, marked, and alive.
  const diverged = { ...exiting, verdict: 'redo' as const }
  const underWay = (): string => i18n.t('emergencyExit.homeUnderWay')
  const waits = (): string => i18n.t('emergencyExit.homeWaits')
  const ask = { quoted: { quote: {}, quotedAt: 0 }, tier: 'medium', reason: 'forced', verdict: 'fine', planTxids: [] }

  const pressable = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
    tree.root
      .findAll(
        node =>
          typeof node.props.onPress === 'function' &&
          node.findAllByType(Text).some(text => text.props.children === label),
      )
      .slice(-1)

  afterEach(() => {
    jest.mocked(runExitPass).mockImplementation(async () => ({ kind: 'idle' }))
  })

  test('a plan whose last check answered redo states no floor while its pass finds nothing for the person', async () => {
    await saveExitPlan(diverged)
    jest.mocked(runExitPass).mockResolvedValue({ kind: 'stuck', plan: diverged })
    const tree = await home()
    expect(shown(tree)).toContain(underWay())
    expect(shown(tree)).not.toContain(arrives(16_384 - 3_000))
    expect(shown(tree)).not.toContain(waits())
    expect(shown(tree)).toContain(heldLine())
  })

  test.each<[string, PassOutcome]>([
    ['new figures to confirm', { kind: 'ask', plan: diverged, ask } as never],
    ['more money at the fee address', { kind: 'short', plan: diverged, address: 'bc1q', missingSat: 1_000, pending: false }],
  ])('a pass that needs %s says the exit waits, with no figure, and the card opens its follow-up', async (_what, outcome) => {
    await saveExitPlan(diverged)
    jest.mocked(runExitPass).mockResolvedValue(outcome)
    const tree = await home()
    expect(shown(tree)).toContain(waits())
    expect(shown(tree)).not.toContain(underWay())
    expect(shown(tree)).not.toContain(arrives(16_384 - 3_000))
    const [row] = pressable(tree, i18n.t('emergencyExit.title'))
    await ReactTestRenderer.act(async () => row.props.onPress())
    expect(mockNavigation.navigate).toHaveBeenCalledWith('EmergencyExit', { selection: 'recoverable' })
  })

  // A question from a tree step built on a failed read leaves the plan valid on disk, and still has
  // figures the person has to answer, so the card states none.
  test('a pass that asks over a plan still valid states no figure either', async () => {
    await saveExitPlan(exiting)
    jest.mocked(runExitPass).mockResolvedValue({ kind: 'ask', plan: exiting, ask } as never)
    const tree = await home()
    expect(shown(tree)).toContain(waits())
    expect(shown(tree)).not.toContain(arrives(16_384 - 3_000))
  })

  // Nothing of the question is kept: a Home mounted again, as after the app was closed, holds no
  // memory of it, finds the plan alive on disk, and its own pass says it again.
  test('after a restart the next pass shows the wait again', async () => {
    await saveExitPlan(diverged)
    jest.mocked(runExitPass).mockResolvedValue({ kind: 'ask', plan: diverged, ask } as never)
    const before = await home()
    expect(shown(before)).toContain(waits())
    await ReactTestRenderer.act(async () => before.unmount())
    jest.mocked(runExitPass).mockClear()
    const after = await home()
    expect(runExitPass).toHaveBeenCalledWith('primary')
    expect(shown(after)).toContain(waits())
    expect(shown(after)).not.toContain(arrives(16_384 - 3_000))
  })

  test('a pass that goes on says the exit is under way again, with the floor of the plan it wrote', async () => {
    await saveExitPlan(exiting)
    jest.mocked(runExitPass).mockResolvedValue({ kind: 'followed', plan: exiting, sent: 1, refused: [] })
    const tree = await home()
    expect(shown(tree)).toContain(underWay())
    expect(shown(tree)).toContain(arrives(16_384 - 3_000))
    expect(shown(tree)).not.toContain(waits())
  })
})
