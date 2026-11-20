import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Text, TextInput } from 'react-native'
import RNFS from 'react-native-fs'
import Clipboard from '@react-native-clipboard/clipboard'
import i18n from '../src/i18n'
import { Skeleton } from '../src/components/Skeleton'
import { EmergencyExitScreen } from '../src/screens/EmergencyExitScreen'
import { formatSats } from '../src/wallet/amount'
import { broadcastPackage, readFunding } from '../src/wallet/chainRelay'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { exitFeeAddress } from '../src/wallet/exitFeeKey'
import { forgetExitPlan, loadExitPlan, saveExitPlan } from '../src/wallet/exitPlan'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { loadSeedFor } from '../src/wallet/seed'
import {
  connectActiveSpark,
  sparkCheckRecoverFunds,
  sparkConnectedWalletId,
  sparkExitDestination,
  sparkExitFeeRate,
  sparkPrepareRecoverFunds,
  sparkRecoverFunds,
  sparkSyncState,
} from '../src/wallet/spark'
import {
  CONFIRMED,
  DESTINATION,
  FEE_ADDRESS,
  planOf,
  quoteOf,
  READY,
  recoveryOf,
  stepOf,
  UTXO_TXID,
} from './support/exitFixtures'

jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(async () => 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  loadPassphraseFor: jest.fn(async () => undefined),
  PRIMARY_ID: 'primary',
}))

jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
}))

jest.mock('../src/wallet/chainRelay', () => ({
  broadcastTx: jest.fn(async () => ({ status: 'sent', host: 'mempool.space' })),
  broadcastPackage: jest.fn(async () => ({ status: 'sent', host: 'mempool.space' })),
  readFunding: jest.fn(async () => ({ status: 'read', confirmed: [], pendingSat: 0 })),
}))

jest.mock('../src/wallet/exitFeeKey', () => {
  const actual = jest.requireActual('../src/wallet/exitFeeKey')
  return { ...actual, exitFeeAddress: jest.fn(actual.exitFeeAddress) }
})

jest.mock('../src/wallet/spark', () => {
  const actual = jest.requireActual('../src/wallet/spark')
  return {
    ...actual,
    connectActiveSpark: jest.fn(async () => undefined),
    sparkConnectedWalletId: jest.fn(() => 'primary'),
    sparkSyncState: jest.fn(() => 'stale'),
    sparkExitDestination: jest.fn(),
    sparkExitFeeRate: jest.fn(async () => 10n),
    sparkPrepareRecoverFunds: jest.fn(),
    sparkRecoverFunds: jest.fn(),
    sparkCheckRecoverFunds: jest.fn(),
    sparkStopSpendsOnItsOwn: jest.fn(async () => true),
  }
})

const mockNavigate = jest.fn()
const mockGoBack = jest.fn()
const mockRoute: { params: { selection: 'recoverable' | 'all' } } = { params: { selection: 'all' } }
const mockPrevent: { on?: boolean } = {}
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
    useRoute: () => mockRoute,
    useFocusEffect: (effect: () => void | (() => void)) => react.useEffect(effect, [effect]),
    usePreventRemove: (on: boolean) => {
      mockPrevent.on = on
    },
  }
})

const FILE = `${RNFS.DocumentDirectoryPath}/exit-plan-primary.json`
const t = (key: string, options?: Record<string, unknown>): string => i18n.t(`emergencyExit.${key}`, options)

const mocked = {
  prepare: jest.mocked(sparkPrepareRecoverFunds),
  recover: jest.mocked(sparkRecoverFunds),
  check: jest.mocked(sparkCheckRecoverFunds),
  destination: jest.mocked(sparkExitDestination),
  pair: jest.mocked(broadcastPackage),
  funding: jest.mocked(readFunding),
}

let tree: ReactTestRenderer.ReactTestRenderer | null = null

const flush = async (): Promise<void> => {
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
  })
}

// Key derivation takes real time, so a test that reaches it waits on what it shows.
async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries += 1) {
    await flush()
  }
  expect(check()).toBe(true)
}

async function mount(selection: 'recoverable' | 'all' = 'all'): Promise<ReactTestRenderer.ReactTestRenderer> {
  mockRoute.params = { selection }
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<EmergencyExitScreen />)
  })
  await flush()
  await flush()
  return tree as ReactTestRenderer.ReactTestRenderer
}

function shown(root: ReactTestRenderer.ReactTestRenderer): string {
  const flat = (children: unknown): string[] =>
    Array.isArray(children) ? children.flatMap(flat) : typeof children === 'string' ? [children] : []
  return root.root
    .findAllByType(Text)
    .flatMap(node => flat(node.props.children))
    .join(' ')
}

const button = (root: ReactTestRenderer.ReactTestRenderer, label: string) =>
  root.root
    .findAll(
      n =>
        typeof n.props.onPress === 'function' &&
        n.findAllByType(Text).some(text => text.props.children === label),
    )
    .at(-1)

async function tap(root: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const target = button(root, label)
  expect(target).toBeDefined()
  await ReactTestRenderer.act(async () => {
    target?.props.onPress()
  })
  await flush()
  await flush()
}

async function typeAddress(root: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    root.root.findByType(TextInput).props.onChangeText(DESTINATION)
  })
}

async function toReview(root: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await typeAddress(root)
  await tap(root, t('continue'))
}

beforeEach(async () => {
  __setEmergencyExitLiveForTests(true)
  jest.clearAllMocks()
  jest.mocked(sparkSyncState).mockReturnValue('stale')
  jest.mocked(sparkConnectedWalletId).mockReturnValue('primary')
  jest.mocked(sparkExitFeeRate).mockResolvedValue(10n)
  mocked.destination.mockResolvedValue({ status: 'ok', address: DESTINATION })
  mocked.prepare.mockResolvedValue(quoteOf())
  mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'valid' }))
  mocked.funding.mockResolvedValue({ status: 'read', confirmed: [], pendingSat: 0 })
  await forgetExitPlan('primary')
})

afterEach(() => {
  __setEmergencyExitLiveForTests(null)
  tree = null
})

describe('a live exit opens its follow-up, never another quote', () => {
  test.each(['all', 'recoverable'] as const)('from %s', async selection => {
    await saveExitPlan(planOf())
    const root = await mount(selection)
    expect(shown(root)).toContain(t('trackTitle'))
    expect(mocked.prepare).not.toHaveBeenCalled()
    expect(root.root.findAllByType(TextInput)).toHaveLength(0)
  })
})

describe('a torn plan', () => {
  afterEach(async () => {
    if (await RNFS.exists(`${FILE}.unreadable`)) {
      await RNFS.unlink(`${FILE}.unreadable`)
    }
  })

  test.each([
    ['the first screen', 'all', 'stale', 'introUnderstood'],
    ['the network screen', 'all', 'synced', 'networkUpBody'],
    ['the address', 'recoverable', 'stale', 'destinationLabel'],
  ] as const)('is named on %s, and the way on stays open', async (_name, selection, sync, line) => {
    jest.mocked(sparkSyncState).mockReturnValue(sync)
    await RNFS.writeFile(FILE, 'torn', 'utf8')
    const root = await mount(selection)
    expect(shown(root)).toContain(t('aside'))
    expect(shown(root)).toContain(t(line))
    expect(shown(root)).not.toContain(t('unreadable'))
  })

  test('with none set aside nothing is said', async () => {
    const root = await mount()
    expect(shown(root)).not.toContain(t('aside'))
  })

  test('with a live plan beside the old one the follow-up says nothing of it', async () => {
    await RNFS.writeFile(`${FILE}.unreadable`, 'torn', 'utf8')
    await saveExitPlan(planOf())
    const root = await mount()
    expect(shown(root)).toContain(t('trackTitle'))
    expect(shown(root)).not.toContain(t('aside'))
  })
})

describe('a read the platform refuses', () => {
  const refuse = () => jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('EACCES'))

  test('stops on the error with a way to try again, never on a form that goes nowhere', async () => {
    await saveExitPlan(planOf())
    const read = refuse()
    const root = await mount()
    expect(shown(root)).toContain(t('unreadable'))
    expect(root.root.findAllByType(TextInput)).toHaveLength(0)
    read.mockRestore()
    await tap(root, i18n.t('common.retry'))
    expect(shown(root)).toContain(t('trackTitle'))
  })

  test('with no wallet to read it for says the same', async () => {
    jest.mocked(getActiveWalletId).mockResolvedValueOnce(null)
    const root = await mount()
    expect(shown(root)).toContain(t('unreadable'))
    expect(root.root.findAllByType(TextInput)).toHaveLength(0)
  })

  test('at the quote stops there too, and nothing is quoted', async () => {
    const root = await mount('recoverable')
    await saveExitPlan(planOf())
    const read = refuse()
    await toReview(root)
    read.mockRestore()
    expect(shown(root)).toContain(t('unreadable'))
    expect(mocked.prepare).not.toHaveBeenCalled()
  })

  test('at the start stops there too, and nothing is built', async () => {
    mocked.prepare.mockResolvedValue(quoteOf({ funding: undefined }))
    const root = await mount('recoverable')
    await toReview(root)
    await saveExitPlan(planOf())
    const read = refuse()
    await tap(root, t('start'))
    read.mockRestore()
    expect(shown(root)).toContain(t('unreadable'))
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('in the middle of a pass stops there too', async () => {
    await saveExitPlan(planOf())
    let answer: (reply: never) => void = () => undefined
    mocked.check.mockReturnValueOnce(new Promise(resolve => (answer = resolve as never)))
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    try {
      const root = await mount()
      await until(() => mocked.check.mock.calls.length === 1)
      await ReactTestRenderer.act(async () => answer({ recovery: recoveryOf(), verdict: 'valid' } as never))
      await flush()
      const read = refuse()
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(30_000)
      })
      await until(() => shown(root).includes(t('unreadable')))
      read.mockRestore()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('the first screen', () => {
  test('with the network answering says Send works, and takes one tap more', async () => {
    jest.mocked(sparkSyncState).mockReturnValue('synced')
    const root = await mount()
    expect(shown(root)).toContain(t('networkUpBody'))
    expect(shown(root)).not.toContain(t('introAll'))
    await tap(root, t('networkUpSend'))
    expect(mockNavigate).toHaveBeenCalledWith('Send')
    await tap(root, t('networkUpContinue'))
    expect(shown(root)).toContain(t('introAll'))
  })

  test('with the network silent goes straight to what it costs', async () => {
    const root = await mount()
    expect(shown(root)).not.toContain(t('networkUpBody'))
    for (const line of ['introAll', 'introDays', 'introFee', 'introOpen', 'introDevice', 'introOtherDevice']) {
      expect(shown(root)).toContain(t(line))
    }
    await tap(root, t('introUnderstood'))
    expect(root.root.findAllByType(TextInput)).toHaveLength(1)
  })

  test('funds outside the balance start at the address', async () => {
    jest.mocked(sparkSyncState).mockReturnValue('synced')
    const root = await mount('recoverable')
    expect(root.root.findAllByType(TextInput)).toHaveLength(1)
  })
})

describe('the destination', () => {
  test.each([
    ['notAddress', 'destinationBad'],
    ['uri', 'destinationUri'],
    ['own', 'destinationOwn'],
  ] as const)('%s is refused with its line, and nothing is quoted', async (reason, line) => {
    mocked.destination.mockResolvedValue({ status: 'refused', reason })
    const root = await mount('recoverable')
    await toReview(root)
    expect(shown(root)).toContain(t(line))
    expect(mocked.prepare).not.toHaveBeenCalled()
  })
})

describe('an address the wallet could not compare with its own', () => {
  beforeEach(() => mocked.destination.mockResolvedValue({ status: 'unchecked', address: DESTINATION }))

  test('asks for a second tap with the line, and quotes nothing before it', async () => {
    const root = await mount('recoverable')
    await toReview(root)
    expect(shown(root)).toContain(t('destinationUnchecked'))
    expect(mocked.prepare).not.toHaveBeenCalled()
  })

  test('goes on with the second tap', async () => {
    const root = await mount('recoverable')
    await toReview(root)
    await tap(root, t('networkUpContinue'))
    expect(mocked.prepare).toHaveBeenCalledTimes(1)
    expect(shown(root)).toContain(t('reviewArrives'))
    // The value before fees is labelled as such, never as what moves.
    expect(shown(root)).toContain(t('reviewValueBeforeFees'))
  })

  test('another address starts the question over', async () => {
    const root = await mount('recoverable')
    await toReview(root)
    await ReactTestRenderer.act(async () => {
      root.root.findByType(TextInput).props.onChangeText('bc1qother')
    })
    expect(shown(root)).not.toContain(t('destinationUnchecked'))
    mocked.destination.mockResolvedValue({ status: 'unchecked', address: 'bc1qother' })
    await tap(root, t('continue'))
    expect(shown(root)).toContain(t('destinationUnchecked'))
    expect(mocked.prepare).not.toHaveBeenCalled()
  })
})

describe('the quote', () => {
  test('asks with the selection the screen opened with', async () => {
    const root = await mount('recoverable')
    await toReview(root)
    expect(mocked.prepare.mock.calls[0][0]).toMatchObject({ selection: 'recoverable', destination: DESTINATION })
  })

  test('in flight shows a skeleton, and a failure comes back with a line', async () => {
    let fail: (cause: Error) => void = () => undefined
    mocked.prepare.mockReturnValue(new Promise((_, reject) => (fail = reject)))
    const root = await mount('recoverable')
    await toReview(root)
    expect(root.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    await ReactTestRenderer.act(async () => fail(new Error('offline')))
    await flush()
    expect(shown(root)).toContain(t('quoteFailed'))
    expect(root.root.findAllByType(TextInput)).toHaveLength(1)
  })

  test('with no fee rate it says so and guesses nothing', async () => {
    jest.mocked(sparkExitFeeRate).mockResolvedValue(null)
    const root = await mount('recoverable')
    await toReview(root)
    expect(shown(root)).toContain(t('noRate'))
    expect(mocked.prepare).not.toHaveBeenCalled()
  })

  test.each([
    ['a fee too high', [{ tag: 'FeeExceedsValue' }], 'nothingFee'],
    ['missing data', [{ tag: 'Unverified' }], 'nothingData'],
    ['operators out of reach', [{ tag: 'OperatorsUnavailable' }], 'nothingOperators'],
    ['operators out of reach beside a fee too high', [{ tag: 'FeeExceedsValue' }, { tag: 'OperatorsUnavailable' }], 'nothingOperators'],
    ['operators out of reach beside missing data', [{ tag: 'FundsNotFound' }, { tag: 'OperatorsUnavailable' }], 'nothingOperators'],
    ['nothing at all', [], 'nothing'],
  ])('empty for %s says which', async (_name, reasons, line) => {
    mocked.prepare.mockResolvedValue(
      quoteOf({
        leaves: [],
        skipped: reasons.map(reason => ({ leafId: 'l', valueSats: 1n, reason })) as never,
      }),
    )
    const root = await mount('recoverable')
    await toReview(root)
    expect(shown(root)).toContain(t(line))
  })

  test('shows what arrives by the doc, not value less total fee', async () => {
    const root = await mount('recoverable')
    await toReview(root)
    expect(shown(root)).toContain(formatSats(97_000))
    expect(shown(root)).not.toContain(formatSats(88_000))
  })

  // The sweep pays back the funding the fees did not use (recover_funds.md), so the figure is a floor and
  // says so. The sweep can pay more than the review states.
  test('states what arrives as the floor it is when funding comes back in the sweep', async () => {
    const root = await mount('recoverable')
    await toReview(root)
    const floor = t('atLeast', { amount: i18n.t('send.sats', { amount: formatSats(97_000) }) })
    expect(shown(root)).toContain(floor)
  })

  test('with nothing to fund, the figure is what arrives and carries no floor', async () => {
    mocked.prepare.mockResolvedValue(
      quoteOf({ funding: undefined, cpfpFeeSats: 0n, fanoutFeeSats: 0n, totalFeeSats: 3_000n }),
    )
    const root = await mount('recoverable')
    await toReview(root)
    const plain = i18n.t('send.sats', { amount: formatSats(97_000) })
    expect(shown(root)).toContain(plain)
    expect(shown(root)).not.toContain(t('atLeast', { amount: plain }))
  })

  test('a leaf left out of the quote is said on the review, since the figures name only what moves', async () => {
    mocked.prepare.mockResolvedValue(
      quoteOf({ skipped: [{ leafId: 'l', valueSats: 900n, reason: { tag: 'FeeExceedsValue' } }] as never }),
    )
    const root = await mount('recoverable')
    await toReview(root)
    expect(shown(root)).toContain(t('trackFailedLeaves'))
  })

  test('a quote with nothing left out says nothing of it', async () => {
    const root = await mount('recoverable')
    await toReview(root)
    expect(shown(root)).not.toContain(t('trackFailedLeaves'))
  })

  test('a fee at the value stops it, with the reason', async () => {
    mocked.prepare.mockResolvedValue(quoteOf({ recoverableValueSats: 12_000n, totalFeeSats: 12_000n }))
    const root = await mount('recoverable')
    await toReview(root)
    expect(shown(root)).toContain(t('notWorth'))
    expect(button(root, t('continue'))).toBeUndefined()
    expect(button(root, t('start'))).toBeUndefined()
  })

  test('an amount nodes would not carry stops it, with its own reason', async () => {
    mocked.prepare.mockResolvedValue(
      quoteOf({
        leaves: [{ leafId: 'l', valueSats: 800n, method: 0 }] as never,
        recoverableValueSats: 800n,
        totalFeeSats: 300n,
        cooperativeFeeSats: 300n,
        sweepFeeSats: 0n,
        funding: undefined,
      }),
    )
    const root = await mount('recoverable')
    await toReview(root)
    expect(shown(root)).toContain(t('tooSmall'))
    expect(button(root, t('start'))).toBeUndefined()
    expect(button(root, i18n.t('common.back'))).toBeDefined()
  })

  test('a thin margin warns and lets it go on', async () => {
    mocked.prepare.mockResolvedValue(quoteOf({ recoverableValueSats: 50_000n, totalFeeSats: 12_000n }))
    const root = await mount('recoverable')
    await toReview(root)
    expect(shown(root)).toContain(t('thin'))
    expect(button(root, t('continue'))).toBeDefined()
  })
})

describe('with no funding in the quote', () => {
  beforeEach(() => {
    mocked.prepare.mockResolvedValue(
      quoteOf({ funding: undefined, cpfpFeeSats: 0n, fanoutFeeSats: 0n, totalFeeSats: 3_000n }),
    )
    mocked.recover.mockResolvedValue(recoveryOf({ fundingInputs: [] }))
  })

  test('the review starts it, with no fee step and no key', async () => {
    const root = await mount('recoverable')
    await toReview(root)
    expect(shown(root)).not.toContain(t('fundTitle'))
    await tap(root, t('start'))
    expect(mocked.recover).toHaveBeenCalledTimes(1)
    expect(mocked.recover.mock.calls[0]).toHaveLength(1)
    expect(loadSeedFor).not.toHaveBeenCalled()
    expect(shown(root)).toContain(t('trackTitle'))
  })

  test('a second tap while it builds starts nothing more', async () => {
    let finish: (recovery: never) => void = () => undefined
    mocked.recover.mockReturnValue(new Promise(resolve => (finish = resolve as never)))
    const root = await mount('recoverable')
    await toReview(root)
    const start = button(root, t('start'))
    await ReactTestRenderer.act(async () => {
      start?.props.onPress()
      start?.props.onPress()
    })
    await flush()
    expect(mockPrevent.on).toBe(true)
    await ReactTestRenderer.act(async () => finish(recoveryOf() as never))
    await flush()
    expect(mocked.recover).toHaveBeenCalledTimes(1)
  })

  test('a new quote with nothing left says so, and offers no start', async () => {
    const root = await mount('recoverable')
    await toReview(root)
    mocked.prepare.mockResolvedValue(quoteOf({ leaves: [], recoverableValueSats: 0n, totalFeeSats: 0n }))
    jest.mocked(sparkExitFeeRate).mockResolvedValue(11n)
    await tap(root, t('start'))
    expect(shown(root)).toContain(t('nothing'))
    expect(button(root, t('start'))).toBeUndefined()
    expect(mocked.recover).not.toHaveBeenCalled()
  })

  test('a build that fails writes nothing and stays on the review', async () => {
    mocked.recover.mockRejectedValue(new Error('boom'))
    const root = await mount('recoverable')
    await toReview(root)
    await tap(root, t('start'))
    expect(shown(root)).toContain(t('startFailedNoFee'))
    expect(await loadExitPlan('primary')).toBeNull()
  })
})

// The periodic read is the only way to a second read while the first is out, so the wait is skipped.
const readAgain = async (root: ReactTestRenderer.ReactTestRenderer): Promise<void> => {
  const [, every] = jest.mocked(setInterval).mock.calls.at(-1) ?? []
  expect(every).toBe(30_000)
  await ReactTestRenderer.act(async () => {
    ;(jest.mocked(setInterval).mock.calls.at(-1)?.[0] as () => void)()
  })
  await until(() => shown(root).includes(t('fundUnread')))
}

describe('copying an address', () => {
  test('says so to a screen reader and goes back after two seconds', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
    const root = await mount('recoverable')
    await toReview(root)
    await tap(root, t('continue'))
    await until(() => shown(root).includes(FEE_ADDRESS))

    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    try {
      const target = root.root.findAll(
        n => typeof n.props.onPress === 'function' && n.props.label === t('copyAddress'),
      )[0]
      await ReactTestRenderer.act(async () => target.props.onPress())
      expect(Clipboard.setString).toHaveBeenCalledWith(FEE_ADDRESS)
      expect(announce).toHaveBeenCalledWith(t('copied'))
      expect(shown(root)).toContain(t('copied'))

      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(2_000)
      })
      expect(shown(root)).not.toContain(t('copied'))
    } finally {
      jest.useRealTimers()
      announce.mockRestore()
    }
  })
})

describe('paying the fee', () => {
  const toFunding = async (): Promise<ReactTestRenderer.ReactTestRenderer> => {
    const root = await mount('recoverable')
    await toReview(root)
    await tap(root, t('continue'))
    await until(() => shown(root).includes(FEE_ADDRESS))
    return root
  }
  const utxo = { txid: UTXO_TXID, vout: 1, valueSat: 15_000 }

  test('names the amount and the address derived for this wallet', async () => {
    const root = await toFunding()
    expect(shown(root)).toContain(t('fundBody', { amount: formatSats(15_000) }))
    expect(exitFeeAddress).toHaveBeenCalled()
  })

  test('a skeleton stands in while the read is out, with no figure and no way to start', async () => {
    mocked.funding.mockReturnValue(new Promise(() => undefined))
    const root = await toFunding()
    expect(root.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    expect(shown(root)).not.toContain(t('fundFound', { amount: formatSats(0) }))
  })

  test('a failed read says so and offers to try again, and never reads as nothing arrived', async () => {
    mocked.funding.mockResolvedValueOnce({ status: 'failed' })
    const root = await toFunding()
    await until(() => shown(root).includes(t('fundUnread')))
    expect(shown(root)).not.toContain(t('fundFound', { amount: formatSats(0) }))
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: [utxo], pendingSat: 0 })
    await tap(root, i18n.t('common.retry'))
    await until(() => shown(root).includes(t('fundFound', { amount: formatSats(15_000) })))
    expect(shown(root)).not.toContain(t('fundUnread'))
  })

  test('a payment on its way is shown and starts nothing', async () => {
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: [], pendingSat: 15_000 })
    const root = await toFunding()
    await until(() => shown(root).includes(t('fundPending', { amount: formatSats(15_000) })))
    expect(button(root, t('start'))?.props.disabled).toBe(true)
  })

  test('enough confirmed lets it start, and the plan is saved before anything leaves', async () => {
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: [utxo], pendingSat: 0 })
    mocked.recover.mockResolvedValue(recoveryOf())
    let savedFirst = false
    mocked.pair.mockImplementation(async () => {
      savedFirst = (await loadExitPlan('primary')) !== null
      return { status: 'sent', host: 'mempool.space' }
    })
    const root = await toFunding()
    await until(() => shown(root).includes(t('fundFound', { amount: formatSats(15_000) })))
    await tap(root, t('start'))
    await until(() => shown(root).includes(t('trackTitle')))
    await until(() => mocked.pair.mock.calls.length > 0)
    expect(savedFirst).toBe(true)
  })

  test('InsufficientCpfpFunds shows what is missing, never its text', async () => {
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: [utxo], pendingSat: 0 })
    mocked.recover.mockRejectedValue(
      Object.assign(new Error('SdkError.InsufficientCpfpFunds'), {
        tag: 'InsufficientCpfpFunds',
        inner: { requiredSats: 21_000n, docsUrl: 'https://example.invalid' },
      }),
    )
    const root = await toFunding()
    await until(() => shown(root).includes(t('fundFound', { amount: formatSats(15_000) })))
    await tap(root, t('start'))
    await until(() => shown(root).includes(t('fundShort', { amount: formatSats(6_680) })))
    expect(shown(root)).not.toContain('InsufficientCpfpFunds')
  })

  // Taken away on each timed read, the figure and Start would blink out every 30 seconds.
  test('what a read found stays up while the next timed read is out', async () => {
    const timer = jest.spyOn(globalThis, 'setInterval')
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: [utxo], pendingSat: 0 })
    const root = await toFunding()
    const found = t('fundFound', { amount: formatSats(15_000) })
    await until(() => shown(root).includes(found))

    mocked.funding.mockReturnValue(new Promise(() => undefined))
    await ReactTestRenderer.act(async () => {
      ;(jest.mocked(setInterval).mock.calls.at(-1)?.[0] as () => void)()
    })
    await flush()
    expect(shown(root)).toContain(found)
    timer.mockRestore()
  })

  test('an older read answering late does not undo a newer one', async () => {
    const timer = jest.spyOn(globalThis, 'setInterval')
    let late: (read: never) => void = () => undefined
    mocked.funding.mockReturnValueOnce(new Promise(resolve => (late = resolve as never)))
    const root = await toFunding()
    await until(() => mocked.funding.mock.calls.length === 1)
    mocked.funding.mockResolvedValue({ status: 'failed' })
    await readAgain(root)
    await ReactTestRenderer.act(async () => late({ status: 'read', confirmed: [utxo], pendingSat: 0 } as never))
    await flush()
    expect(shown(root)).toContain(t('fundUnread'))
    expect(shown(root)).not.toContain(t('fundFound', { amount: formatSats(15_000) }))
    timer.mockRestore()
  })

  test('leaving the screen stops the reads, and the answer of one still out goes nowhere', async () => {
    let late: (read: never) => void = () => undefined
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    try {
      mocked.funding.mockReturnValue(new Promise(resolve => (late = resolve as never)))
      const root = await mount('recoverable')
      await toReview(root)
      await tap(root, t('continue'))
      await until(() => mocked.funding.mock.calls.length === 1)
      await ReactTestRenderer.act(async () => root.unmount())
      jest.advanceTimersByTime(120_000)
      await ReactTestRenderer.act(async () => late({ status: 'read', confirmed: [utxo], pendingSat: 0 } as never))
      await flush()
      expect(mocked.funding).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test('reads again every 30 seconds while the fee is awaited', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    try {
      const root = await mount('recoverable')
      await toReview(root)
      await tap(root, t('continue'))
      await until(() => mocked.funding.mock.calls.length === 1)
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(30_000)
      })
      await until(() => mocked.funding.mock.calls.length === 2)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('following an exit', () => {
  // The follow-up states what arrives from exitArriving, as the review and Home do: a floor with funding.
  test('says what arrives after fees, never the value before them', async () => {
    await saveExitPlan(planOf({ recovery: recoveryOf({ recoverableValueSats: 16_384n, sweepFeeSats: 3_000n }) }))
    mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'valid' }) as never)
    const root = await mount()
    await flush()
    expect(shown(root)).toContain(t('reviewArrives'))
    expect(shown(root)).toContain(t('atLeast', { amount: i18n.t('send.sats', { amount: formatSats(13_384) }) }))
    expect(shown(root)).not.toContain(formatSats(16_384))
  })

  // The operators' own version of a step landed, so the plan's figures are of transactions that will
  // not confirm.
  test('a plan kept as redo states no figure of what arrives while the check is out', async () => {
    await saveExitPlan(planOf({ verdict: 'redo' }))
    let answer: (reply: never) => void = () => undefined
    mocked.check.mockReturnValue(new Promise(resolve => (answer = resolve as never)))
    const root = await mount()
    try {
      expect(shown(root)).toContain(t('trackTitle'))
      expect(shown(root)).not.toContain(t('reviewArrives'))
      expect(shown(root)).not.toContain(formatSats(97_000))
    } finally {
      // A pass left waiting would answer every later test's pass for this wallet.
      await ReactTestRenderer.act(async () => answer({ recovery: recoveryOf(), verdict: 'valid' } as never))
      await flush()
    }
  })

  test('a redo that waits on the person shows its question and no figure of the old plan', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'redo' }))
    mocked.prepare.mockResolvedValue(quoteOf({ sweepFeeSats: 9_000n }))
    const root = await mount()
    await until(() => shown(root).includes(t('askNeeded')))
    expect(shown(root)).not.toContain(t('reviewArrives'))
    expect(shown(root)).not.toContain(formatSats(97_000))
  })

  test('the saved state shows while the check is out, with its time', async () => {
    await saveExitPlan(planOf({ recovery: recoveryOf({ transactions: [stepOf({ status: CONFIRMED }), stepOf({ status: READY, txid: 'b'.repeat(64) })] }) }))
    let answer: (reply: never) => void = () => undefined
    mocked.check.mockReturnValue(new Promise(resolve => (answer = resolve as never)))
    const root = await mount()
    expect(shown(root)).toContain(t('trackProgress', { done: 1, total: 2 }))
    expect(shown(root)).toContain(t('trackCheckedAt', { time: '' }).trim())
    await ReactTestRenderer.act(async () => answer({ recovery: recoveryOf(), verdict: 'valid' } as never))
    await flush()
  })

  test('a step waiting on a read of the chain says so', async () => {
    const waiting = recoveryOf({ transactions: [stepOf({ status: { tag: 'Unverified' } })] })
    await saveExitPlan(planOf({ recovery: waiting }))
    mocked.prepare.mockResolvedValue(
      quoteOf({
        exitChainState: {
          confirmedNodes: [],
          refunds: [],
          stoppedLeafIds: [],
          unverifiedNodeIds: ['n'],
          unverifiableConfirmedNodeIds: [],
        },
      }),
    )
    const root = await mount()
    await until(() => mocked.prepare.mock.calls.length > 0)
    await flush()
    expect(shown(root)).toContain(t('trackAwaitingRead'))
  })

  test('with the check failing it says the exit stays as it was', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockRejectedValue(new Error('offline'))
    const root = await mount()
    await until(() => shown(root).includes(t('trackOffline')))
    expect(shown(root)).toContain(t('trackTitle'))
  })

  test('everything confirmed without the verdict does not say finished', async () => {
    const confirmed = recoveryOf({ transactions: [stepOf({ status: CONFIRMED })] })
    await saveExitPlan(planOf({ recovery: confirmed }))
    const root = await mount()
    await flush()
    expect(shown(root)).not.toContain(t('doneTitle'))
    expect(shown(root)).toContain(t('trackProgress', { done: 1, total: 1 }))
  })

  test('the verdict says finished, and closing clears the plan', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'done' }))
    const root = await mount()
    await until(() => shown(root).includes(t('doneTitle')))
    await tap(root, i18n.t('common.close'))
    expect(await loadExitPlan('primary')).toBeNull()
    expect(mockGoBack).toHaveBeenCalled()
  })

  test('both hosts refusing shows the reason and copies the pair', async () => {
    await saveExitPlan(planOf())
    mocked.pair.mockResolvedValue({ status: 'refused', reason: 'TRUC-violation' })
    const root = await mount()
    await until(() => shown(root).includes(t('trackRefused', { reason: 'TRUC-violation' })))
    await tap(root, t('trackCopyPair'))
    expect(Clipboard.setString).toHaveBeenCalledWith(JSON.stringify(['aabb', 'ccdd']))
    expect(shown(root)).not.toContain(t('doneTitle'))
  })

  test('no host answering is a connection line, not a refusal', async () => {
    await saveExitPlan(planOf())
    mocked.pair.mockResolvedValue({ status: 'unreachable' })
    const root = await mount()
    await until(() => shown(root).includes(t('trackOffline')))
    expect(button(root, t('trackCopyPair'))).toBeUndefined()
  })

  test('a shortfall on a redo names what is missing and where to send it', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'redo' }))
    mocked.prepare.mockResolvedValue(quoteOf())
    mocked.recover.mockRejectedValue(
      Object.assign(new Error('SdkError.InsufficientCpfpFunds'), {
        tag: 'InsufficientCpfpFunds',
        inner: { requiredSats: 20_000n, docsUrl: 'https://example.invalid' },
      }),
    )
    const root = await mount()
    await until(() => shown(root).includes(t('fundShort', { amount: formatSats(20_680) })))
    expect(shown(root)).toContain(FEE_ADDRESS)
  })

  test('a read of the address that failed names no figure, and still shows where to pay', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'redo' }))
    mocked.funding.mockResolvedValue({ status: 'failed' })
    mocked.recover.mockRejectedValue(
      Object.assign(new Error('SdkError.InsufficientCpfpFunds'), {
        tag: 'InsufficientCpfpFunds',
        inner: { requiredSats: 20_000n, docsUrl: 'https://example.invalid' },
      }),
    )
    const root = await mount()
    await until(() => shown(root).includes(t('fundShortNoFigure')))
    expect(shown(root)).toContain(FEE_ADDRESS)
    expect(shown(root)).not.toContain(formatSats(20_000))
  })

  test('value on its way asks to wait, and names no figure', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'redo' }))
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: [], pendingSat: 3_000 })
    mocked.recover.mockRejectedValue(
      Object.assign(new Error('SdkError.InsufficientCpfpFunds'), {
        tag: 'InsufficientCpfpFunds',
        inner: { requiredSats: 20_000n, docsUrl: 'https://example.invalid' },
      }),
    )
    const root = await mount()
    await until(() => shown(root).includes(t('fundShortWait')))
    expect(shown(root)).not.toContain(formatSats(20_680))
  })

  test('with an exit alive nothing speaks of what is at the fee address, whatever is there', async () => {
    await saveExitPlan(planOf())
    mocked.funding.mockResolvedValue({
      status: 'read',
      confirmed: [{ txid: 'cd'.repeat(32), vout: 0, valueSat: 4_000 }],
      pendingSat: 2_000,
    })
    const root = await mount()
    await until(() => mocked.check.mock.calls.length > 0)
    await flush()
    expect(shown(root)).toContain(t('trackTitle'))
    expect(shown(root)).not.toContain('BIP84')
    expect(shown(root)).not.toContain(formatSats(4_000))
    expect(mocked.funding).not.toHaveBeenCalled()
  })

  describe('at the end, what stayed at the fee address', () => {
    const coin = { txid: 'cd'.repeat(32), vout: 0, valueSat: 4_000 }

    const finish = async (): Promise<ReactTestRenderer.ReactTestRenderer> => {
      await saveExitPlan(planOf())
      mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'done' }))
      const root = await mount()
      await until(() => shown(root).includes(t('doneTitle')))
      await flush()
      return root
    }

    test('names what is confirmed there and where it opens', async () => {
      mocked.funding.mockResolvedValue({ status: 'read', confirmed: [coin], pendingSat: 0 })
      const root = await finish()
      await until(() => shown(root).includes(t('doneLeft', { amount: formatSats(4_000) })))
    })

    test('gives what is on its way a line of its own', async () => {
      mocked.funding.mockResolvedValue({ status: 'read', confirmed: [coin], pendingSat: 700 })
      const root = await finish()
      await until(() => shown(root).includes(t('donePending', { amount: formatSats(700) })))
      expect(shown(root)).toContain(t('doneLeft', { amount: formatSats(4_000) }))
    })

    test('a failed read says it could not check, with no figure, and tries again', async () => {
      mocked.funding.mockResolvedValue({ status: 'failed' })
      const root = await finish()
      await until(() => shown(root).includes(t('doneUnread')))
      expect(shown(root)).not.toContain('BIP84')
      mocked.funding.mockResolvedValue({ status: 'read', confirmed: [coin], pendingSat: 0 })
      await tap(root, i18n.t('common.retry'))
      await until(() => shown(root).includes(t('doneLeft', { amount: formatSats(4_000) })))
    })

    test('nothing there says nothing', async () => {
      const root = await finish()
      await until(() => mocked.funding.mock.calls.length > 0)
      await flush()
      expect(shown(root)).not.toContain('BIP84')
      expect(shown(root)).not.toContain(t('doneUnread'))
    })

    test('a plan with no fee key reads nothing', async () => {
      await saveExitPlan(planOf({ feeKey: null }))
      mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'done' }))
      const root = await mount()
      await until(() => shown(root).includes(t('doneTitle')))
      await flush()
      expect(mocked.funding).not.toHaveBeenCalled()
    })
  })

  test('passes every 30 seconds with the screen open, and stops with it', async () => {
    await saveExitPlan(planOf())
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    try {
      const root = await mount()
      await until(() => mocked.check.mock.calls.length === 1)
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(29_000)
      })
      expect(mocked.check).toHaveBeenCalledTimes(1)
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(1_000)
      })
      await until(() => mocked.check.mock.calls.length === 2)
      await flush()
      await ReactTestRenderer.act(async () => root.unmount())
      jest.advanceTimersByTime(90_000)
      await flush()
      expect(mocked.check).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a connect that never answers does not hide the exit past its wait', async () => {
    await saveExitPlan(planOf())
    jest.mocked(connectActiveSpark).mockReturnValueOnce(new Promise(() => undefined))
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    try {
      const root = await mount()
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(10_001)
      })
      await until(() => shown(root).includes(t('trackTitle')))
    } finally {
      jest.useRealTimers()
    }
  })

  test('a plan that could not be written says it could not update, not that the network is down', async () => {
    await saveExitPlan(planOf())
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValue(new Error('disk full'))
    const root = await mount()
    await until(() => shown(root).includes(t('trackStuck')))
    write.mockRestore()
    expect(shown(root)).not.toContain(t('trackOffline'))
    expect(mocked.pair).not.toHaveBeenCalled()
  })

  test('a failed connect does not hide the exit', async () => {
    await saveExitPlan(planOf())
    jest.mocked(connectActiveSpark).mockRejectedValueOnce(new Error('operators down'))
    jest.mocked(sparkConnectedWalletId).mockReturnValue(null)
    const root = await mount()
    expect(shown(root)).toContain(t('trackTitle'))
    await until(() => shown(root).includes(t('trackOffline')))
  })

  describe('paying more', () => {
    const fast = quoteOf({ feeRateSatPerVbyte: 20n, totalFeeSats: 24_000n, sweepFeeSats: 5_000n })

    beforeEach(() => {
      jest.mocked(sparkExitFeeRate).mockResolvedValue(20n)
      mocked.prepare.mockResolvedValue(fast)
      mocked.recover.mockResolvedValue(recoveryOf({ feeRateSatPerVbyte: 20n }))
    })

    test('shows the new figures and spends nothing before the confirm', async () => {
      await saveExitPlan(planOf())
      const root = await mount()
      await until(() => mocked.pair.mock.calls.length > 0)
      mocked.pair.mockClear()
      await tap(root, t('payMore'))
      expect(shown(root)).toContain(t('askTitleRaise'))
      expect(shown(root)).toContain(formatSats(24_000))
      // A floor here too: the sweep of the new build pays back the funding it does not use.
      expect(shown(root)).toContain(
        t('atLeast', { amount: i18n.t('send.sats', { amount: formatSats(95_000) }) }),
      )
      expect(mocked.recover).not.toHaveBeenCalled()
      await tap(root, t('askConfirm'))
      expect(mocked.recover).toHaveBeenCalledTimes(1)
      await until(() => shown(root).includes(t('trackTitle')))
    })

    test('a thin margin carries its warning and can still go on', async () => {
      mocked.prepare.mockResolvedValue(quoteOf({ feeRateSatPerVbyte: 20n, recoverableValueSats: 50_000n, totalFeeSats: 12_000n }))
      await saveExitPlan(planOf())
      const root = await mount()
      await tap(root, t('payMore'))
      expect(shown(root)).toContain(t('thin'))
      expect(button(root, t('askConfirm'))).toBeDefined()
    })

    test('with no value in it there is no confirm, and Back returns to the exit', async () => {
      mocked.prepare.mockResolvedValue(quoteOf({ feeRateSatPerVbyte: 20n, recoverableValueSats: 10_000n, totalFeeSats: 25_000n }))
      await saveExitPlan(planOf())
      const root = await mount()
      await tap(root, t('payMore'))
      expect(shown(root)).toContain(t('notWorth'))
      expect(button(root, t('askConfirm'))).toBeUndefined()
      await tap(root, i18n.t('common.back'))
      expect(shown(root)).toContain(t('trackTitle'))
      expect(mocked.recover).not.toHaveBeenCalled()
    })

    test('a pass the timer asks while Pay more holds the wallet never says there is no connection', async () => {
      await saveExitPlan(planOf())
      mocked.pair.mockResolvedValue({ status: 'sent', host: 'mempool.space' })
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
      try {
        const root = await mount()
        await until(() => mocked.check.mock.calls.length === 1)
        await flush()
        jest.mocked(sparkExitFeeRate).mockReturnValue(new Promise<bigint>(() => undefined))
        await tap(root, t('payMore'))
        ReactTestRenderer.act(() => {
          jest.advanceTimersByTime(30_000)
        })
        await flush()
        await flush()
        expect(shown(root)).not.toContain(t('trackOffline'))
      } finally {
        jest.useRealTimers()
      }
    })

    test('no pass runs while the figures are open', async () => {
      await saveExitPlan(planOf())
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
      try {
        const root = await mount()
        await until(() => mocked.check.mock.calls.length === 1)
        await tap(root, t('payMore'))
        await ReactTestRenderer.act(async () => {
          jest.advanceTimersByTime(120_000)
        })
        await flush()
        expect(mocked.check).toHaveBeenCalledTimes(1)
      } finally {
        jest.useRealTimers()
      }
    })

    test('when the funding falls short names what is missing', async () => {
      await saveExitPlan(planOf())
      mocked.recover.mockRejectedValue(
        Object.assign(new Error('SdkError.InsufficientCpfpFunds'), {
          tag: 'InsufficientCpfpFunds',
          inner: { requiredSats: 30_000n, docsUrl: 'https://example.invalid' },
        }),
      )
      const root = await mount()
      await tap(root, t('payMore'))
      await tap(root, t('askConfirm'))
      await until(() => shown(root).includes(t('fundShort', { amount: formatSats(31_360) })))
      expect(shown(root)).toContain(FEE_ADDRESS)
    })

    test('figures that moved are shown again, with the note', async () => {
      await saveExitPlan(planOf())
      const root = await mount()
      await tap(root, t('payMore'))
      jest.mocked(sparkExitFeeRate).mockResolvedValue(30n)
      await tap(root, t('askConfirm'))
      expect(shown(root)).toContain(t('requoted'))
      expect(mocked.recover).not.toHaveBeenCalled()
    })
  })

  describe('a plan with no way forward', () => {
    test('a redo with nothing left ends with its line, Close clears it, and no pass follows', async () => {
      await saveExitPlan(planOf())
      mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'redo' }))
      mocked.prepare.mockResolvedValue(quoteOf({ leaves: [] }))
      const root = await mount()
      await until(() => shown(root).includes(t('nothing')))
      expect(shown(root)).not.toContain(t('doneTitle'))
      expect(shown(root)).not.toContain(t('trackTitle'))
      await tap(root, i18n.t('common.close'))
      expect(await loadExitPlan('primary')).toBeNull()
      expect(mockGoBack).toHaveBeenCalled()
    })

    test.each([
      ['fee', 'nothingFee'],
      ['data', 'nothingData'],
      ['later', 'closedLater'],
    ] as const)('reopened, a plan closed for %s says why, and runs no pass', async (closure, line) => {
      await saveExitPlan(planOf({ verdict: 'closed', closure }))
      const root = await mount()
      expect(shown(root)).toContain(t(line))
      await flush()
      expect(mocked.check).not.toHaveBeenCalled()
    })

    test('a redo with no value offers to leave it, which asks once more before ending it', async () => {
      await saveExitPlan(planOf())
      mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'redo' }))
      mocked.prepare.mockResolvedValue(quoteOf({ recoverableValueSats: 10_000n, totalFeeSats: 25_000n }))
      const root = await mount()
      await until(() => shown(root).includes(t('askNeeded')))
      await tap(root, t('askOpen'))
      expect(button(root, t('askConfirm'))).toBeUndefined()
      await tap(root, t('askLater'))
      expect(shown(root)).toContain(t('askLaterBody'))
      expect((await loadExitPlan('primary'))?.verdict).toBe('redo')
      await tap(root, t('askLater'))
      await until(() => shown(root).includes(t('closedLater')))
      expect((await loadExitPlan('primary'))?.closure).toBe('later')
    })

    describe('once closed, what stayed at the fee address', () => {
      const coin = { txid: 'cd'.repeat(32), vout: 0, valueSat: 4_000 }

      test('reopened, a closed plan names what is confirmed there and what is on its way, and runs no pass', async () => {
        mocked.funding.mockResolvedValue({ status: 'read', confirmed: [coin], pendingSat: 700 })
        await saveExitPlan(planOf({ verdict: 'closed', closure: 'later' }))
        const root = await mount()
        await until(() => shown(root).includes(t('doneLeft', { amount: formatSats(4_000) })))
        expect(shown(root)).toContain(t('closedLater'))
        expect(shown(root)).toContain(t('donePending', { amount: formatSats(700) }))
        expect(mocked.funding).toHaveBeenCalledWith(FEE_ADDRESS)
        expect(mocked.check).not.toHaveBeenCalled()
      })

      test('a pass that closes the plan reads the address only after it ended', async () => {
        await saveExitPlan(planOf())
        mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'redo' }))
        mocked.prepare.mockResolvedValue(quoteOf({ leaves: [] }))
        mocked.funding.mockImplementation(async () => {
          expect((await loadExitPlan('primary'))?.verdict).toBe('closed')
          return { status: 'read', confirmed: [coin], pendingSat: 0 }
        })
        const root = await mount()
        await until(() => shown(root).includes(t('doneLeft', { amount: formatSats(4_000) })))
        expect(shown(root)).toContain(t('nothing'))
      })

      test('a failed read says it could not check, with no figure, and tries again', async () => {
        mocked.funding.mockResolvedValue({ status: 'failed' })
        await saveExitPlan(planOf({ verdict: 'closed', closure: 'fee' }))
        const root = await mount()
        await until(() => shown(root).includes(t('doneUnread')))
        expect(shown(root)).not.toContain('BIP84')
        mocked.funding.mockResolvedValue({ status: 'read', confirmed: [coin], pendingSat: 0 })
        await tap(root, i18n.t('common.retry'))
        await until(() => shown(root).includes(t('doneLeft', { amount: formatSats(4_000) })))
      })

      test('a closed plan with no fee key reads nothing', async () => {
        await saveExitPlan(planOf({ verdict: 'closed', closure: 'nothing', feeKey: null }))
        const root = await mount()
        expect(shown(root)).toContain(t('nothing'))
        await flush()
        expect(mocked.funding).not.toHaveBeenCalled()
      })
    })

    test('Pay more with no value offers nothing of the kind, since the plan under way still runs', async () => {
      await saveExitPlan(planOf())
      jest.mocked(sparkExitFeeRate).mockResolvedValue(20n)
      mocked.prepare.mockResolvedValue(quoteOf({ feeRateSatPerVbyte: 20n, recoverableValueSats: 10_000n, totalFeeSats: 25_000n }))
      const root = await mount()
      await tap(root, t('payMore'))
      expect(button(root, t('askLater'))).toBeUndefined()
    })
  })

  test('a redo worse than the plan waits for the person, and goes out only on the confirm', async () => {
    await saveExitPlan(planOf())
    mocked.check.mockImplementation(async recovery => ({ recovery, verdict: 'redo' }))
    mocked.prepare.mockResolvedValue(quoteOf({ sweepFeeSats: 9_000n }))
    mocked.recover.mockResolvedValue(recoveryOf())
    const root = await mount()
    await until(() => shown(root).includes(t('askNeeded')))
    expect(mocked.recover).not.toHaveBeenCalled()
    await tap(root, t('askOpen'))
    expect(shown(root)).toContain(t('askTitleRedo'))
    expect(shown(root)).toContain(formatSats(91_000))
    await tap(root, t('askConfirm'))
    expect(mocked.recover).toHaveBeenCalledTimes(1)
  })
})

describe('a fee address with more coins than one child takes', () => {
  test('asks for one payment of what is missing, never for more of the same', async () => {
    const coins = Array.from({ length: 15 }, (_, vout) => ({ txid: 'cd'.repeat(32), vout, valueSat: 1_000 }))
    mocked.funding.mockResolvedValue({ status: 'read', confirmed: coins, pendingSat: 0 })
    mocked.recover.mockRejectedValue(
      Object.assign(new Error('SdkError.InsufficientCpfpFunds'), {
        tag: 'InsufficientCpfpFunds',
        inner: { requiredSats: 20_000n, docsUrl: 'https://example.invalid' },
      }),
    )
    const root = await mount('recoverable')
    await toReview(root)
    await tap(root, t('continue'))
    await until(() => shown(root).includes(t('fundFound', { amount: formatSats(15_000) })))
    await tap(root, t('start'))
    await until(() => shown(root).includes(t('fundShortOneCoin', { amount: formatSats(8_000) })))
    expect(shown(root)).not.toContain(t('fundShort', { amount: formatSats(8_000) }))
    expect(shown(root)).toContain(FEE_ADDRESS)
  })
})
