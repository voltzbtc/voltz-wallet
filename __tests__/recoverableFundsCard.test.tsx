import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { ScrollView, Text } from 'react-native'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { AssetList } from '../src/components/AssetList'
import { RecoverableFundsCard } from '../src/components/RecoverableFundsCard'
import { HomeScreen } from '../src/screens/HomeScreen'
import { formatSats } from '../src/wallet/amount'
import { USDB } from '../src/wallet/tokens'
import { __setEmergencyExitLiveForTests, EMERGENCY_EXIT_LIVE } from '../src/wallet/emergencyExit'
import { forgetExitPlan, saveExitPlan } from '../src/wallet/exitPlan'
import * as exitPass from '../src/wallet/exitPass'
import { planOf } from './support/exitFixtures'
import * as chainRelay from '../src/wallet/chainRelay'
import * as exitFeeKey from '../src/wallet/exitFeeKey'
import {
  connectActiveSpark,
  onSparkRecoverableFunds,
  sparkGetFiatRates,
  sparkGetWalletInfo,
  sparkSyncState,
  type BalanceSync,
  type SparkWalletInfo,
} from '../src/wallet/spark'

jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: () => 'primary',
  sparkLeafIsCooperative: jest.requireActual('../src/wallet/spark').sparkLeafIsCooperative,
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

// Wrapped so a call shows, and still the real modules.
jest.mock('../src/wallet/chainRelay', () => {
  const actual = jest.requireActual('../src/wallet/chainRelay')
  return {
    ...actual,
    readFunding: jest.fn(actual.readFunding),
    broadcastTx: jest.fn(actual.broadcastTx),
    broadcastPackage: jest.fn(actual.broadcastPackage),
  }
})
jest.mock('../src/wallet/exitFeeKey', () => {
  const actual = jest.requireActual('../src/wallet/exitFeeKey')
  return {
    ...actual,
    exitFeeAddress: jest.fn(actual.exitFeeAddress),
    withExitFeeSecret: jest.fn(actual.withExitFeeSecret),
  }
})

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

const SAT = 90_000
const amount = formatSats(SAT)
const title = (): string => i18n.t('recoverableFunds.title')
const hedged = (): string => i18n.t('recoverableFunds.body', { amount })
const aged = (): string => i18n.t('recoverableFunds.staleBody', { amount })

const texts = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
  tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })

const info = (over: Partial<SparkWalletInfo> = {}): SparkWalletInfo => ({
  sync: 'synced',
  balanceSat: 5_000,
  recoverableSat: SAT,
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

async function card(
  props: Partial<React.ComponentProps<typeof RecoverableFundsCard>> = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <RecoverableFundsCard recoverableSat={SAT} sync="synced" {...props} />,
    )
  })
  await settle()
  return tree
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  __setEmergencyExitLiveForTests(true)
  jest.clearAllMocks()
  jest.mocked(connectActiveSpark).mockResolvedValue(undefined as never)
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(info())
  // Every currency Home asks for has a rate, so the hero is the total and the total is on trial.
  jest.mocked(sparkGetFiatRates).mockImplementation(async coins =>
    Object.fromEntries(coins.map(coin => [coin, 100_000])),
  )
})

afterEach(() => __setEmergencyExitLiveForTests(null))

describe('what the card states', () => {
  test('a synced read only says there may be that much', async () => {
    expect(texts(await card())).toEqual([title(), hedged()])
  })

  test('a stale read says it may be old', async () => {
    expect(texts(await card({ sync: 'stale' }))).toEqual([title(), aged()])
  })

  test('waiting draws nothing', async () => {
    expect((await card({ sync: 'waiting' })).toJSON()).toBeNull()
  })

  test.each([0, Number.NaN, -1])('%s sats draw nothing', async recoverableSat => {
    expect((await card({ recoverableSat })).toJSON()).toBeNull()
  })

  test.each<BalanceSync>(['synced', 'stale'])('a hidden balance hides the figure, %s', async sync => {
    const tree = await card({ hidden: true, sync })
    expect(texts(tree).join(' ')).toContain('••••')
    expect(texts(tree).join(' ')).not.toContain(amount)
  })

  describe('with an exit under way', () => {
    const floor = { arriving: { sat: 13_384, floor: true } }
    const atLeast = (): string =>
      i18n.t('emergencyExit.homeArrivesAtLeast', { amount: i18n.t('send.sats', { amount: formatSats(13_384) }) })

    test('states the floor of a plan that states one', async () => {
      const tree = await card({ exitUnderWay: true, exit: floor })
      expect(texts(tree).join(' ')).toContain(atLeast())
    })

    test('a plan that states nothing leaves the line without a figure', async () => {
      const tree = await card({ exitUnderWay: true, exit: { arriving: null } })
      expect(texts(tree)).toEqual([i18n.t('emergencyExit.title'), i18n.t('emergencyExit.homeUnderWay')])
    })

    test('an exit that waits on the person says so, and states no figure', async () => {
      const tree = await card({ exitUnderWay: true, exitWaits: true, exit: floor })
      expect(texts(tree)).toEqual([i18n.t('emergencyExit.title'), i18n.t('emergencyExit.homeWaits')])
    })
  })
})

describe('on the Home', () => {
  test('sits there with the figure, and subscribes to the event', async () => {
    const tree = await home()
    expect(texts(tree)).toContain(hedged())
    expect(onSparkRecoverableFunds).toHaveBeenCalledTimes(1)
  })

  test('nothing to recover, no card', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ recoverableSat: 0 }))
    const tree = await home()
    expect(tree.root.findAllByType(RecoverableFundsCard)).toHaveLength(0)
  })

  test('a stale read says so', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ sync: 'stale' }))
    expect(texts(await home())).toContain(aged())
  })

  test('a pull that heard no sync marks the card as it marks the balance', async () => {
    const tree = await home()
    expect(texts(tree)).toContain(hedged())
    jest.mocked(sparkSyncState).mockReturnValue('stale')
    // The load after the pull never answers, so the mark the pull put up is what the card shows.
    jest.mocked(sparkGetWalletInfo).mockReturnValue(new Promise(() => undefined))
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(ScrollView).props.refreshControl.props.onRefresh()
    })
    await settle()
    expect(texts(tree)).toContain(aged())
    jest.mocked(sparkSyncState).mockReturnValue('synced')
  })

  test('a waiting read draws no card', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ sync: 'waiting' }))
    const tree = await home()
    expect(tree.root.findAllByType(RecoverableFundsCard)).toHaveLength(0)
  })

  test('the event brings a read that moves the figure, and a waiting read takes the card down', async () => {
    const tree = await home()
    const reread = jest.mocked(onSparkRecoverableFunds).mock.calls[0][0]

    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ recoverableSat: 120_000 }))
    ReactTestRenderer.act(() => reread())
    await settle(650)
    expect(texts(tree)).toContain(i18n.t('recoverableFunds.body', { amount: formatSats(120_000) }))

    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ sync: 'waiting' }))
    ReactTestRenderer.act(() => reread())
    await settle(650)
    expect(texts(tree)).not.toContain(title())
  })

  test('funds that leave the total take the card with them on the next read', async () => {
    const tree = await home()
    expect(tree.root.findAllByType(RecoverableFundsCard)).toHaveLength(1)
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ recoverableSat: 0 }))
    const reread = jest.mocked(onSparkRecoverableFunds).mock.calls[0][0]
    ReactTestRenderer.act(() => reread())
    await settle(650)
    expect(tree.root.findAllByType(RecoverableFundsCard)).toHaveLength(0)
  })
})

describe('the way into the exit', () => {
  const pressable = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
    tree.root
      .findAll(
        node =>
          typeof node.props.onPress === 'function' &&
          node.findAllByType(Text).some(text => text.props.children === label),
      )
      .slice(-1)

  test('the card opens the flow for these funds', async () => {
    const tree = await home()
    const [row] = pressable(tree, title())
    await ReactTestRenderer.act(async () => row.props.onPress())
    expect(mockNavigation.navigate).toHaveBeenCalledWith('EmergencyExit', { selection: 'recoverable' })
  })

  test('with no onOpen the card is a notice', async () => {
    expect(pressable(await card(), title())).toHaveLength(0)
  })

  describe('with an exit under way', () => {
    const exitTitle = (): string => i18n.t('emergencyExit.title')
    const underWay = (): string => i18n.t('emergencyExit.homeUnderWay')

    beforeEach(() => saveExitPlan(planOf()))
    afterEach(() => forgetExitPlan('primary'))

    test('the card says so instead of offering the funds again', async () => {
      const tree = await home()
      expect(texts(tree).join(' ')).toContain(underWay())
      expect(texts(tree)).not.toContain(hedged())
    })

    test('it stands with nothing outside the balance yet', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ recoverableSat: 0 }))
      const tree = await home()
      expect(texts(tree).join(' ')).toContain(underWay())
      const [row] = pressable(tree, exitTitle())
      await ReactTestRenderer.act(async () => row.props.onPress())
      expect(mockNavigation.navigate).toHaveBeenCalledWith('EmergencyExit', { selection: 'recoverable' })
    })

    test('focus runs one pass for the wallet of the plan', async () => {
      await home()
      expect(exitPass.runExitPass).toHaveBeenCalledTimes(1)
      expect(exitPass.runExitPass).toHaveBeenCalledWith('primary')
    })

    test('the end of a pass reads the Home again, since funds leaving emit nothing', async () => {
      let finish: (outcome: never) => void = () => undefined
      jest
        .mocked(exitPass.runExitPass)
        .mockImplementationOnce(() => new Promise(resolve => (finish = resolve as never)))
      const tree = await home()
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ recoverableSat: 12_000 }))
      const reads = jest.mocked(sparkGetWalletInfo).mock.calls.length
      // A pass that ends the exit writes the plan as done before it answers.
      await saveExitPlan(planOf({ verdict: 'done' }))
      await ReactTestRenderer.act(async () => finish({ kind: 'done', plan: planOf({ verdict: 'done' }) } as never))
      await settle(700)
      expect(jest.mocked(sparkGetWalletInfo).mock.calls.length).toBeGreaterThan(reads)
      expect(texts(tree).join(' ')).not.toContain(underWay())
      expect(texts(tree).join(' ')).toContain(formatSats(12_000))
    })

    test('a plan that ended on a pass takes the line down too', async () => {
      // A pass that closes the plan writes it as closed before it answers.
      jest.mocked(exitPass.runExitPass).mockImplementationOnce(async () => {
        const closed = planOf({ verdict: 'closed', closure: 'nothing' })
        await saveExitPlan(closed)
        return { kind: 'closed', plan: closed }
      })
      const tree = await home()
      await settle(10)
      expect(texts(tree).join(' ')).not.toContain(underWay())
    })

    // Not known to be under way, only that the balance may still count what it moves.
    test('a plan the platform will not read says so and still leads to its screen', async () => {
      const read = jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('EACCES'))
      const tree = await home()
      read.mockRestore()
      expect(texts(tree)).toContain(i18n.t('emergencyExit.balanceUnread'))
      expect(texts(tree).join(' ')).not.toContain(underWay())
      const [row] = pressable(tree, exitTitle())
      await ReactTestRenderer.act(async () => row.props.onPress())
      expect(mockNavigation.navigate).toHaveBeenCalledWith('EmergencyExit', { selection: 'recoverable' })
    })

    test('a torn plan goes aside and the line comes down', async () => {
      const file = `${RNFS.DocumentDirectoryPath}/exit-plan-primary.json`
      await forgetExitPlan('primary')
      await RNFS.writeFile(file, 'torn', 'utf8')
      const tree = await home()
      expect(texts(tree)).not.toContain(underWay())
      await RNFS.unlink(`${file}.unreadable`)
    })
  })

  test('with no plan no pass runs', async () => {
    await home()
    expect(exitPass.runExitPass).not.toHaveBeenCalled()
  })
})

describe('funds outside the balance join no figure', () => {
  const withoutCard = (tree: ReactTestRenderer.ReactTestRenderer): string[] => {
    const inCard = tree.root.findAllByType(RecoverableFundsCard).flatMap(node =>
      node.findAllByType(Text).map(text => String(text.props.children)),
    )
    return texts(tree).filter(text => !inCard.includes(text))
  }
  const assetsOf = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(AssetList).props.assets

  test('the Home with them reads exactly as the Home without them', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ recoverableSat: 0 }))
    const plain = await home()
    const figures = withoutCard(plain)
    const assets = assetsOf(plain)
    expect(figures).toContain(i18n.t('home.balance'))
    ReactTestRenderer.act(() => plain.unmount())

    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info())
    const tree = await home()
    expect(tree.root.findAllByType(RecoverableFundsCard)).toHaveLength(1)
    expect(withoutCard(tree)).toEqual(figures)
    expect(assetsOf(tree)).toEqual(assets)
    expect(texts(tree).join(' ')).toContain(formatSats(5_000))
    expect(figures.join(' ')).not.toContain(formatSats(95_000))
  })

  // Only a wallet that also holds a token shows the total as such, which is where walletFiatTotal lands.
  test('the total of bitcoin and a token leaves them out', async () => {
    const tokens = [
      {
        identifier: USDB.identifier,
        ticker: USDB.ticker,
        name: USDB.ticker,
        decimals: 6,
        balanceBaseUnits: 2_000_000,
      },
    ]
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ recoverableSat: 0, tokens }))
    const plain = await home()
    const figures = withoutCard(plain)
    ReactTestRenderer.act(() => plain.unmount())
    expect(figures).toContain(i18n.t('home.balance'))

    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ tokens }))
    expect(withoutCard(await home())).toEqual(figures)
  })

  test('a holding the total cannot value is still not filled in by them', async () => {
    jest.mocked(sparkGetFiatRates).mockReset()
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info({ recoverableSat: 0 }))
    const plain = await home()
    const figures = withoutCard(plain)
    ReactTestRenderer.act(() => plain.unmount())
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info())
    expect(withoutCard(await home())).toEqual(figures)
  })
})

describe('as shipped', () => {
  beforeEach(() => __setEmergencyExitLiveForTests(null))

  test('the switch ships on, and the Home draws the card and hears the event', async () => {
    expect(EMERGENCY_EXIT_LIVE).toBe(true)
    const tree = await home()
    expect(tree.root.findAllByType(RecoverableFundsCard)).toHaveLength(1)
    expect(texts(tree)).toContain(hedged())
    expect(onSparkRecoverableFunds).toHaveBeenCalledTimes(1)
  })

  test('the seam cannot turn it off in a release bundle', async () => {
    Object.assign(globalThis, { __DEV__: false })
    __setEmergencyExitLiveForTests(false)
    Object.assign(globalThis, { __DEV__: true })
    const tree = await home()
    expect(tree.root.findAllByType(RecoverableFundsCard)).toHaveLength(1)
  })
})

describe('with the switch off', () => {
  beforeEach(() => __setEmergencyExitLiveForTests(false))

  test('the Home draws no card, hears no event, and leaves the relay and the key alone', async () => {
    const realFetch = globalThis.fetch
    const fetching = jest.fn(async () => {
      throw new TypeError('Network request failed')
    })
    globalThis.fetch = fetching as unknown as typeof fetch
    const tree = await home()
    expect(texts(tree).join(' ')).toContain(formatSats(5_000))
    expect(tree.root.findAllByType(RecoverableFundsCard)).toHaveLength(0)
    expect(texts(tree)).not.toContain(title())
    expect(onSparkRecoverableFunds).not.toHaveBeenCalled()
    expect(exitPass.runExitPass).not.toHaveBeenCalled()
    for (const reader of [
      chainRelay.readFunding,
      chainRelay.broadcastTx,
      chainRelay.broadcastPackage,
      exitFeeKey.exitFeeAddress,
      exitFeeKey.withExitFeeSecret,
    ]) {
      expect(reader).not.toHaveBeenCalled()
    }
    const chainCalls = (fetching.mock.calls as unknown[][]).filter(([url]) =>
      /mempool\.space|blockstream\.info/.test(String(url)),
    )
    expect(chainCalls).toEqual([])
    globalThis.fetch = realFetch
  })
})
