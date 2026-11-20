import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, AppState, Dimensions, ScrollView, StyleSheet, Text } from 'react-native'
// Rendering in isolation bypasses App.tsx, so i18n must be initialized or t() returns raw keys.
import i18n from '../src/i18n'
import { HomeScreen } from '../src/screens/HomeScreen'
import { PriceStrip } from '../src/components/PriceStrip'
import { Screen } from '../src/components/Screen'
import { BITCOIN_ASSET_ID, buildSparkAssetList } from '../src/wallet/assets'
import { connectActiveSpark, sparkGetFiatRates, sparkGetWalletInfo, sparkRefreshWallet } from '../src/wallet/spark'
import { saveHeroUnit } from '../src/wallet/settings'
import { formatFiat } from '../src/wallet/fiat'
import { DEFAULT_TOKENS, USDB } from '../src/wallet/tokens'
import { Touch } from '../src/components/Touch'
import { AssetList } from '../src/components/AssetList'
import { CrossFade } from '../src/components/CrossFade'
import { Reenter } from '../src/components/Reenter'
import { Skeleton } from '../src/components/Skeleton'
import { LIVE_READ_EVERY_MS } from '../src/hooks/useLiveFigures'
import { RecoveredPurchaseCard } from '../src/components/RecoveredPurchaseCard'
import { recoverPurchases } from '../src/wallet/recover'
import { loadRegistry } from '../src/wallet/walletRegistry'
import { colors, font, space, stroke, touch } from '../src/theme'

// spark.ts is replaced whole, so a test decides what each read answers and when, and fires the
// sources Home listens to.
const mockSynced: Array<() => void> = []
const mockResumed: Array<() => void> = []
const mockEvents: Array<() => void> = []
let mockConnectedWallet = 'wallet-a'
let mockHeroUnit: string | null = null
jest.mock('../src/wallet/spark', () => ({
  SYNC_WAIT_MS: 12_000,
  sparkConnectedWalletId: () => mockConnectedWallet,
  onSparkSynced: (cb: () => void) => {
    mockSynced.push(cb)
    return () => mockSynced.splice(mockSynced.indexOf(cb), 1)
  },
  sparkSyncWaitLeftMs: () => 0,
  sparkSyncState: jest.fn(() => 'synced'),
  sparkRefreshWallet: jest.fn(async () => undefined),
  connectActiveSpark: jest.fn(async () => undefined),
  onSparkConnected: (cb: () => void) => {
    cb()
    return () => undefined
  },
  onSparkRecoverableFunds: () => () => undefined,
  sparkGetWalletInfo: jest.fn(),
  sparkGetFiatRates: jest.fn(),
  sparkSubscribeToPayments: jest.fn(async (cb: () => void) => {
    mockEvents.push(cb)
    return () => mockEvents.splice(mockEvents.indexOf(cb), 1)
  }),
  sparkListUnclaimedDeposits: jest.fn(async () => []),
  sparkClaimDeposit: jest.fn(),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))
jest.mock('../src/wallet/resumeNotice', () => ({
  onSparkResumed: (cb: () => void) => {
    mockResumed.push(cb)
    return () => mockResumed.splice(mockResumed.indexOf(cb), 1)
  },
}))
const mockSwitch: Array<() => void> = []
jest.mock('../src/wallet/wallet', () => ({
  onActiveWalletChanged: (cb: () => void) => {
    mockSwitch.push(cb)
    return () => mockSwitch.splice(mockSwitch.indexOf(cb), 1)
  },
}))
jest.mock('../src/wallet/walletRegistry', () => ({ loadRegistry: jest.fn(async () => ({ wallets: [], active: null })) }))
jest.mock('../src/wallet/recover', () => ({
  recoverPurchases: jest.fn(async () => null),
  putBackCard: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/deletion', () => ({ readDeletionOnFocus: jest.fn(async () => undefined) }))
jest.mock('../src/wallet/settings', () => ({
  ...jest.requireActual('../src/wallet/settings'),
  loadDisplayCurrency: jest.fn(async () => 'BRL'),
  loadDollarInviteSeen: jest.fn(async () => 0),
  loadHeroUnit: jest.fn(async () => mockHeroUnit),
  saveHeroUnit: jest.fn(async (unit: string) => {
    mockHeroUnit = unit
  }),
}))
// The dollar offer shows only on a synced figure, so it would come and go with the not updated mark;
// it stays out of a file that measures the figures' own layout. Its rules are in dollarOffer.test.ts.
jest.mock('../src/wallet/dollarOffer', () => ({
  ...jest.requireActual('../src/wallet/dollarOffer'),
  dollarOffer: () => ({ line: false, invite: false }),
}))
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useDollarMode: () => false,
    useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }),
  }
})

// Whatever the screen and its hooks registered, since Home's strip listens as well.
let appListeners: Array<(state: string) => void> = []

const mockNavigation = { navigate: jest.fn(), isFocused: jest.fn(() => true) }
let mockFocused = true
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => mockNavigation,
    useFocusEffect: (callback: () => void | (() => void)) =>
      react.useEffect(() => (mockFocused ? callback() : undefined), [callback, mockFocused]),
  }
})

const USDB_HELD = {
  identifier: USDB.identifier,
  ticker: 'USDB',
  name: 'Bitcoin USD',
  decimals: 6,
  balanceBaseUnits: 10_000_000,
}
const UNPEGGED = { identifier: 'btkn1other', ticker: 'XYZ', name: 'Xyz', decimals: 0, balanceBaseUnits: 7 }

type Token = typeof USDB_HELD
const info = (balanceSat: number, tokens: Token[] = []) => ({
  balanceSat,
  recoverableSat: 0,
  tokens,
  sync: 'synced' as const,
})

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<HomeScreen />)
  })
  await settle()
  return tree
}

async function blur(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  mockFocused = false
  await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
  await settle()
}

beforeEach(() => {
  jest.clearAllMocks()
  mockFocused = true
  mockConnectedWallet = 'wallet-a'
  mockHeroUnit = null
  appListeners = []
  ;(AppState as { currentState: string }).currentState = 'active'
  jest.mocked(AppState.addEventListener).mockImplementation(((_: string, cb: (state: string) => void) => {
    appListeners.push(cb)
    return { remove: () => appListeners.splice(appListeners.indexOf(cb), 1) }
  }) as never)
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000))
  jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 600_000, USD: 100_000 })
})

describe('the price strip', () => {
  test('sits under the scroll, so the content ends above it', async () => {
    const tree = await render()
    const strip = tree.root.findByType(PriceStrip)
    const scroll = tree.root.findByType(ScrollView)

    expect(scroll.findAllByType(PriceStrip)).toHaveLength(0)
    const order = (strip.parent?.children ?? []).map(child => (typeof child === 'string' ? child : child.type))
    expect(order.indexOf(PriceStrip)).toBeGreaterThan(order.indexOf(Screen))
  })

  test('a tap opens the Bitcoin asset screen', async () => {
    const tree = await render()

    ReactTestRenderer.act(() => tree.root.findByType(PriceStrip).props.onOpen())

    expect(mockNavigation.navigate).toHaveBeenCalledWith('AssetDetail', { assetId: BITCOIN_ASSET_ID, name: 'Bitcoin' })
  })

  test('hears that Home is no longer in front', async () => {
    const tree = await render()
    expect(tree.root.findByType(PriceStrip).props.focused).toBe(true)

    await blur(tree)

    expect(tree.root.findByType(PriceStrip).props.focused).toBe(false)
  })

  test('the content leaves its own air and no second bottom inset, which the tab bar holds', async () => {
    const insets = jest.spyOn(require('react-native-safe-area-context'), 'useSafeAreaInsets')
    insets.mockReturnValue({ top: 0, right: 0, bottom: 34, left: 0 })
    const tree = await render()
    insets.mockRestore()
    const style = StyleSheet.flatten(tree.root.findByType(ScrollView).props.contentContainerStyle)

    expect(style.paddingBottom).toBe(space.xl)
  })
})

describe('the unit of the big balance', () => {
  const TOTAL = i18n.t('home.balance')
  const BITCOIN = i18n.t('home.bitcoinBalance')
  const hero = (tree: ReactTestRenderer.ReactTestRenderer) => {
    const found = tree.root
      .findAllByType(Touch)
      .filter(node => [TOTAL, BITCOIN].some(label => String(node.props.label).startsWith(`${label},`)))
    expect(found).toHaveLength(1)
    return found[0]
  }
  const said = (tree: ReactTestRenderer.ReactTestRenderer) => hero(tree).props.label as string
  const line = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(Text).map(node => [node.props.children].flat().join(''))
  async function tap(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    await ReactTestRenderer.act(async () => hero(tree).props.onPress())
    await settle()
  }

  test('a wallet holding only bitcoin leads with sats and walks BTC, the total, and back', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000))
    const tree = await render()
    const money = formatFiat(30, 'BRL')

    expect(said(tree)).toBe(`${TOTAL}, 5\u00a0000 sats`)
    expect(line(tree)).toContain(money)

    await tap(tree)
    expect(said(tree)).toBe(`${TOTAL}, 0.00005000 BTC`)
    expect(line(tree)).toContain(money)

    await tap(tree)
    expect(said(tree)).toBe(`${TOTAL}, ${money}`)
    expect(line(tree)).toContain('5\u00a0000 sats')

    await tap(tree)
    expect(said(tree)).toBe(`${TOTAL}, 5\u00a0000 sats`)
  })

  test('nothing is written until the person taps', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000))
    await render()

    expect(saveHeroUnit).not.toHaveBeenCalled()
  })

  test('a total chosen on a bitcoin wallet holds after a restart', async () => {
    mockHeroUnit = 'fiat'
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000))

    const tree = await render()

    expect(said(tree)).toBe(`${TOTAL}, ${formatFiat(30, 'BRL')}`)
  })

  test('with tokens the sats and BTC figures are the total at the rate, with the approximate mark', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000, [USDB_HELD]))
    const tree = await render()

    expect(said(tree)).toBe(`${TOTAL}, ${formatFiat(90, 'BRL')}`)

    await tap(tree)
    expect(said(tree)).toBe(`${TOTAL}, ≈ 15\u00a0000 sats`)
    expect(line(tree)).toContain(i18n.t('home.inBitcoin', { amount: '5\u00a0000 sats' }))

    await tap(tree)
    expect(said(tree)).toBe(`${TOTAL}, ≈ 0.00015000 BTC`)
    expect(line(tree)).toContain(i18n.t('home.inBitcoin', { amount: '0.00005000 BTC' }))
  })

  test('with a token nothing values, it states the bitcoin alone and skips the total', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000, [UNPEGGED]))
    const tree = await render()

    expect(said(tree)).toBe(`${BITCOIN}, 5\u00a0000 sats`)
    await tap(tree)
    expect(said(tree)).toBe(`${BITCOIN}, 0.00005000 BTC`)
    await tap(tree)
    expect(said(tree)).toBe(`${BITCOIN}, 5\u00a0000 sats`)
  })

  test('without rates a bitcoin wallet walks sats and BTC, and the total comes back with the rates', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000))
    mockHeroUnit = 'fiat'
    const tree = await render()

    expect(said(tree)).toBe(`${BITCOIN}, 5\u00a0000 sats`)
    expect(saveHeroUnit).not.toHaveBeenCalled()
    expect(mockHeroUnit).toBe('fiat')
  })

  test('the choice is written, and a new start draws it', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000))
    const first = await render()
    await tap(first)
    expect(saveHeroUnit).toHaveBeenLastCalledWith('btc')
    ReactTestRenderer.act(() => first.unmount())

    const second = await render()

    expect(said(second)).toBe(`${TOTAL}, 0.00005000 BTC`)
  })

  test('a hidden balance stays hidden and a tap moves nothing', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000))
    const tree = await render()
    const eye = tree.root.findAllByType(Touch).find(node => node.props.label === i18n.t('passphrase.hide'))
    await ReactTestRenderer.act(async () => eye?.props.onPress())

    await tap(tree)

    expect(said(tree)).toBe(i18n.t('home.balanceHiddenLabel', { label: TOTAL }))
    expect(saveHeroUnit).not.toHaveBeenCalled()
    expect(line(tree)).not.toContain('5\u00a0000 sats')
  })
})

describe('the figures with no pull', () => {
  const NOT_UPDATED = i18n.t('home.notUpdated')
  const reads = () => jest.mocked(sparkGetWalletInfo).mock.calls.length
  const allText = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(Text).map(node => [node.props.children].flat().join(''))
  const said = (tree: ReactTestRenderer.ReactTestRenderer) =>
    String(tree.root.findAllByType(Touch).find(node => String(node.props.label).startsWith(i18n.t('home.balance')))?.props.label)
  const beat = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAllByType(Reenter)[0].props.beat

  async function pass(ms: number): Promise<void> {
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(ms)
    })
    await settleFake()
  }
  async function settleFake(): Promise<void> {
    for (let i = 0; i < 12; i++) {
      await ReactTestRenderer.act(async () => {
        await jest.advanceTimersByTimeAsync(0)
      })
    }
  }
  async function start(): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<HomeScreen />)
    })
    await settleFake()
    return tree
  }
  async function fire(sources: Array<() => void>): Promise<void> {
    await ReactTestRenderer.act(async () => {
      ;[...sources].forEach(source => source())
    })
    await settleFake()
  }
  async function toApp(state: string): Promise<void> {
    ;(AppState as { currentState: string }).currentState = state
    await ReactTestRenderer.act(async () => {
      ;[...appListeners].forEach(listener => listener(state))
    })
    await settleFake()
  }
  // A read that answers only when the test says.
  function holdNextRead(): (figure: ReturnType<typeof info>) => void {
    let answer!: (figure: ReturnType<typeof info>) => void
    jest.mocked(sparkGetWalletInfo).mockImplementationOnce(() => new Promise(resolve => (answer = resolve)) as never)
    return figure => answer(figure)
  }

  beforeEach(() => {
    jest.useFakeTimers()
    // The figure these tests watch is the total, chosen here since a bitcoin wallet leads with sats.
    mockHeroUnit = 'fiat'
    mockEvents.length = 0
    mockSynced.length = 0
    mockResumed.length = 0
    mockSwitch.length = 0
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('on the clock', () => {
    test('rates and the balance are read every 30 s, and a new figure lands', async () => {
      const tree = await start()
      const before = reads()
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(6_000))
      jest.mocked(sparkGetFiatRates).mockClear()

      await pass(LIVE_READ_EVERY_MS - 1)
      expect(reads()).toBe(before)

      await pass(1)
      expect(reads()).toBe(before + 1)
      expect(sparkGetFiatRates).toHaveBeenCalled()
      expect(said(tree)).toContain(formatFiat(36, 'BRL'))
    })

    test('a rate alone moves the total on screen', async () => {
      const tree = await start()
      jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 700_000, USD: 100_000 })

      await pass(LIVE_READ_EVERY_MS)

      expect(said(tree)).toContain(formatFiat(35, 'BRL'))
    })

    test('stops on blur and starts again with the screen', async () => {
      const tree = await start()
      await blur(tree)
      const before = reads()

      await pass(3 * LIVE_READ_EVERY_MS)
      expect(reads()).toBe(before)

      mockFocused = true
      await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
      await settleFake()
      const focused = reads()
      await pass(LIVE_READ_EVERY_MS)
      expect(reads()).toBe(focused + 1)
    })

    test('stops in the background and starts again on return', async () => {
      await start()
      await toApp('background')
      const before = reads()

      await pass(3 * LIVE_READ_EVERY_MS)
      expect(reads()).toBe(before)

      await toApp('active')
      await pass(LIVE_READ_EVERY_MS)
      expect(reads()).toBe(before + 1)
    })

    test('reads nothing over a skeleton', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue({ ...info(5_000), sync: 'waiting' } as never)
      await start()
      const before = reads()

      await pass(LIVE_READ_EVERY_MS)

      expect(reads()).toBe(before)
    })

    test('leaves the sweep and the cards to a read with a reason', async () => {
      await start()
      await pass(1)
      jest.mocked(loadRegistry).mockClear()

      await pass(LIVE_READ_EVERY_MS)
      expect(loadRegistry).not.toHaveBeenCalled()

      await fire(mockEvents)
      expect(loadRegistry).toHaveBeenCalled()
    })
  })

  describe('from the sources', () => {
    test('an SDK event reads at once, with no timer gone by', async () => {
      await start()
      const before = reads()

      await fire(mockEvents)

      expect(reads()).toBe(before + 1)
    })

    test('a sync reads at once', async () => {
      await start()
      const before = reads()

      await fire(mockSynced)

      expect(reads()).toBe(before + 1)
    })

    test('a return from the background reads at once', async () => {
      await start()
      const before = reads()

      await fire(mockResumed)

      expect(reads()).toBe(before + 1)
    })
  })

  describe('one read at a time', () => {
    test('a burst during a read comes to one more read, with the last answer', async () => {
      const tree = await start()
      const answer = holdNextRead()
      await fire(mockEvents)
      const out = reads()
      await fire(mockEvents)
      await fire(mockEvents)
      await fire(mockSynced)
      expect(reads()).toBe(out)
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(7_000))

      await ReactTestRenderer.act(async () => answer(info(6_000)))
      await settleFake()

      expect(reads()).toBe(out + 1)
      expect(said(tree)).toContain(formatFiat(42, 'BRL'))
    })

    test('a read asked for during the last one is dropped once the screen is gone', async () => {
      const tree = await start()
      const answer = holdNextRead()
      await fire(mockEvents)
      await fire(mockEvents)
      const out = reads()

      await ReactTestRenderer.act(async () => tree.unmount())
      await ReactTestRenderer.act(async () => answer(info(6_000)))
      await settleFake()

      expect(reads()).toBe(out)
    })

    test('a read that never answers frees the line at the bound', async () => {
      await start()
      holdNextRead()
      await fire(mockEvents)
      await fire(mockEvents)
      const out = reads()

      await pass(12_000)

      expect(reads()).toBeGreaterThan(out)
    })
  })

  describe('with a pull or an explicit load out', () => {
    async function pull(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
      await ReactTestRenderer.act(async () => {
        tree.root.findByType(ScrollView).props.refreshControl.props.onRefresh()
      })
      await settleFake()
    }
    // One second before the clock's turn, with the sweep of the first load out of the count.
    async function pullBeforeTheTick(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
      await pass(LIVE_READ_EVERY_MS - 1_000)
      jest.mocked(loadRegistry).mockClear()
      await pull(tree)
    }

    test('a pull that landed tells a screen reader, and a read nobody asked for does not', async () => {
      const heard = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
      const tree = await start()

      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(6_000))
      await fire(mockEvents)
      expect(heard).not.toHaveBeenCalled()

      await pull(tree)
      expect(heard.mock.calls).toEqual([[i18n.t('home.updatedNow')]])
      heard.mockRestore()
    })

    test('the clock waits for the read, and the read does its own work', async () => {
      const tree = await start()
      const land = holdNextRead()
      await pullBeforeTheTick(tree)
      const before = reads()

      await pass(2_000)
      expect(reads()).toBe(before)
      expect(loadRegistry).not.toHaveBeenCalled()

      await ReactTestRenderer.act(async () => land(info(6_000)))
      await settleFake()
      expect(loadRegistry).toHaveBeenCalled()
      expect(said(tree)).toContain(formatFiat(36, 'BRL'))
    })

    test('the clock waits through the sync that comes first, too', async () => {
      const tree = await start()
      jest.mocked(sparkRefreshWallet).mockReturnValueOnce(new Promise(() => undefined))
      await pullBeforeTheTick(tree)
      const before = reads()

      await pass(2_000)

      expect(reads()).toBe(before)
    })

    test('the clock reads again once the load has answered', async () => {
      const tree = await start()
      await pullBeforeTheTick(tree)
      const before = reads()

      await pass(2_000)

      expect(reads()).toBe(before + 1)
    })

    test('a load that never answers stops the clock for no longer than the bound', async () => {
      const tree = await start()
      holdNextRead()
      await pullBeforeTheTick(tree)
      const before = reads()

      await pass(LIVE_READ_EVERY_MS + 2_000)

      expect(reads()).toBe(before + 1)
    })

    test('a read that takes the place of a load past the bound does the work it was owed', async () => {
      const tree = await start()
      holdNextRead()
      await pullBeforeTheTick(tree)
      expect(loadRegistry).not.toHaveBeenCalled()

      await pass(LIVE_READ_EVERY_MS + 2_000)

      expect(loadRegistry).toHaveBeenCalledTimes(1)
    })
  })

  describe('what the screen shows meanwhile', () => {
    test('no skeleton, and the figure stays until the new one lands', async () => {
      const tree = await start()
      const answer = holdNextRead()

      await fire(mockEvents)
      expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
      expect(said(tree)).toContain(formatFiat(30, 'BRL'))

      await ReactTestRenderer.act(async () => answer(info(6_000)))
      await settleFake()
      expect(said(tree)).toContain(formatFiat(36, 'BRL'))
    })

    test('a read that lands fades the figure across', async () => {
      const tree = await start()
      const answer = holdNextRead()

      await fire(mockEvents)
      expect(tree.root.findByType(CrossFade).props.armed).toBe(true)

      await ReactTestRenderer.act(async () => answer(info(5_000)))
      await settleFake()
      await pass(1_000)
      expect(tree.root.findByType(CrossFade).props.armed).toBe(false)
    })

    describe('a tap during a read', () => {
      const leavingCopies = (tree: ReactTestRenderer.ReactTestRenderer) =>
        tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'cross-fade-leaving')
      const eye = (tree: ReactTestRenderer.ReactTestRenderer) =>
        tree.root.findAllByType(Touch).find(node => node.props.label === i18n.t('passphrase.hide'))
      const balance = (tree: ReactTestRenderer.ReactTestRenderer) =>
        tree.root.findAllByType(Touch).find(node => String(node.props.label).startsWith(i18n.t('home.balance')))

      test('hide answers at once', async () => {
        const tree = await start()
        holdNextRead()
        await fire(mockEvents)

        await ReactTestRenderer.act(async () => eye(tree)?.props.onPress())

        expect(leavingCopies(tree)).toHaveLength(0)
        expect(allText(tree)).not.toContain(formatFiat(30, 'BRL'))
      })

      test('hide takes down a fade already under way, so no figure stays over the dots', async () => {
        const tree = await start()
        jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(6_000))
        await fire(mockEvents)
        expect(leavingCopies(tree).length).toBeGreaterThan(0)

        await ReactTestRenderer.act(async () => eye(tree)?.props.onPress())

        expect(leavingCopies(tree)).toHaveLength(0)
        expect(allText(tree)).not.toContain(formatFiat(30, 'BRL'))
        expect(allText(tree)).not.toContain(formatFiat(36, 'BRL'))
      })

      test('the unit answers at once', async () => {
        const tree = await start()
        holdNextRead()
        await fire(mockEvents)

        await ReactTestRenderer.act(async () => balance(tree)?.props.onPress())

        expect(leavingCopies(tree)).toHaveLength(0)
      })
    })

    test('a read that reports a failed sync marks the figure at once, with no timer gone by', async () => {
      const tree = await start()
      expect(allText(tree)).not.toContain(NOT_UPDATED)
      jest.mocked(sparkGetWalletInfo).mockResolvedValue({ ...info(5_000), sync: 'stale' } as never)

      await fire(mockEvents)

      expect(allText(tree)).toContain(NOT_UPDATED)
    })

    test('a return that waits for its sync keeps a marked figure, with no skeleton', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue({ ...info(5_000), sync: 'stale' } as never)
      const tree = await start()
      jest.mocked(sparkGetWalletInfo).mockResolvedValue({ ...info(9_000), sync: 'waiting' } as never)

      await fire(mockResumed)

      expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
      expect(said(tree)).toContain(formatFiat(30, 'BRL'))
      expect(allText(tree)).toContain(NOT_UPDATED)
    })

    test('a read that lands after a wallet switch is dropped', async () => {
      const tree = await start()
      const answer = holdNextRead()
      await fire(mockEvents)

      await ReactTestRenderer.act(async () => mockSwitch.forEach(cb => cb()))
      await ReactTestRenderer.act(async () => answer(info(9_000)))
      await settleFake()

      expect(allText(tree).join()).not.toContain(formatFiat(54, 'BRL'))
    })
  })

  describe('the rows', () => {
    const rows = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findByType(AssetList).props.assets.map((asset: { assetId: string }) => asset.assetId)

    test('an unasked read leaves the editor open, and an order chosen stays after it', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000, [USDB_HELD]))
      const tree = await start()
      const list = () => tree.root.findByType(AssetList)
      const shown = rows(tree)
      const flipped = [...shown].reverse()
      await ReactTestRenderer.act(async () => list().props.onEnterEdit())
      await ReactTestRenderer.act(async () => list().props.onReorder(flipped))

      await pass(LIVE_READ_EVERY_MS)
      expect(list().props.editing).toBe(true)
      expect(rows(tree)).toEqual(flipped)

      await ReactTestRenderer.act(async () => list().props.onEnterEdit())
      await fire(mockEvents)
      expect(rows(tree)).toEqual(flipped)
    })

    test('Done brings the balances the rows held still for, with no timer gone by', async () => {
      const tree = await start()
      const list = () => tree.root.findByType(AssetList)
      const bitcoin = () =>
        list().props.assets.find((asset: { assetId: string }) => asset.assetId === BITCOIN_ASSET_ID).amount
      const before = bitcoin()
      await ReactTestRenderer.act(async () => list().props.onEnterEdit())
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(6_000))
      await fire(mockEvents)
      expect(bitcoin()).toBe(before)

      const done = tree.root
        .findAllByType(Touch)
        .find(node => node.findAllByType(Text).some(text => text.props.children === i18n.t('home.done')))!
      await ReactTestRenderer.act(async () => done.props.onPress())
      await settleFake()

      expect(list().props.editing).toBe(false)
      expect(bitcoin()).not.toBe(before)
      expect(bitcoin()).toBe(buildSparkAssetList(6_000, [], DEFAULT_TOKENS).find(a => a.assetId === BITCOIN_ASSET_ID)!.amount)
    })
  })

  describe('the page answering', () => {
    test('re-enters when the wallet moved, and not when only a rate did', async () => {
      const tree = await start()

      jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 700_000, USD: 100_000 })
      await pass(LIVE_READ_EVERY_MS)
      expect(beat(tree)).toBe(0)

      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(6_000))
      await fire(mockEvents)
      expect(beat(tree)).toBe(1)
    })

    test('the same holdings in another order are the same holdings', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000, [USDB_HELD, UNPEGGED]))
      const tree = await start()

      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(5_000, [UNPEGGED, USDB_HELD]))
      await pass(LIVE_READ_EVERY_MS)

      expect(reads()).toBeGreaterThan(1)
      expect(beat(tree)).toBe(0)
    })

    test('nothing moves while the page scrolls, whatever the touch said', async () => {
      const tree = await start()
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(6_000))
      ReactTestRenderer.act(() => tree.root.findByType(ScrollView).props.onScrollBeginDrag())

      await fire(mockEvents)
      expect(beat(tree)).toBe(0)

      ReactTestRenderer.act(() => tree.root.findByType(ScrollView).props.onScrollEndDrag())
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(7_000))
      await fire(mockEvents)
      expect(beat(tree)).toBe(1)
    })

    test('a figure from a sync that failed moves nothing', async () => {
      const tree = await start()
      jest.mocked(sparkGetWalletInfo).mockResolvedValue({ ...info(6_000), sync: 'stale' } as never)

      await fire(mockEvents)

      expect(beat(tree)).toBe(0)
    })

    test('nothing moves under a finger, and the figure still lands', async () => {
      const tree = await start()
      const page = tree.root.findAll(node => typeof node.props.onTouchCancel === 'function')[0]
      ReactTestRenderer.act(() => page.props.onTouchStart())
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(info(6_000))

      await fire(mockEvents)

      expect(beat(tree)).toBe(0)
      expect(said(tree)).toContain(formatFiat(36, 'BRL'))
    })
  })
})

describe('the page as drawn', () => {
  const flat = (node: ReactTestRenderer.ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {}
  const { fontScale } = Dimensions.get('window')

  test('the Convert link reads as an action, not as a section label', async () => {
    const tree = await render()
    const convert = tree.root.findAllByType(Text).find(node => node.props.children === i18n.t('home.convert'))

    expect(flat(convert!).color).toBe(colors.primary)
    expect(flat(convert!).textTransform).toBeUndefined()
  })

  test('the skeleton draws the rows the catalog holds, at the real rows height and divider', async () => {
    jest.mocked(sparkGetWalletInfo).mockReturnValue(new Promise(() => undefined))
    const tree = await render()
    const bars = tree.root.findAllByType(Skeleton).filter(node => node.props.width === 120)
    const rows = bars.map(bar => bar.parent as ReactTestRenderer.ReactTestInstance)

    expect(rows).toHaveLength(buildSparkAssetList(0, [], DEFAULT_TOKENS).length)
    expect(rows.map(row => flat(row).height)).toEqual(rows.map(() => expect.any(Number)))
    expect(flat(rows[1]).borderTopWidth).toBe(stroke.hair)
    expect(flat(rows[1]).borderTopColor).toBe(colors.divider)
  })

  test('the header of the assets is as tall while it waits as when it is ready', async () => {
    jest.mocked(sparkGetWalletInfo).mockReturnValue(new Promise(() => undefined))
    const waiting = await render()
    const bar = waiting.root.findAllByType(Skeleton).find(node => node.props.width === 72)

    expect(flat(bar!.parent as ReactTestRenderer.ReactTestInstance).minHeight).toBe(touch.min)
    expect(bar!.props.height).toBe(font.leading.sm)
  })

  test('the line under the hero is held when the wallet has nothing to put in it', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    const tree = await render()
    const held = tree.root
      .findAll(node => typeof node.type === 'string')
      .filter(node => flat(node).minHeight === font.leading.lg * fontScale)

    // Under the figure, the last box of that height, and empty.
    expect(held.at(-1)!.findAllByType(Text)).toHaveLength(0)
  })

  test('the mark takes the held line when there is no other', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ ...info(5_000), sync: 'stale' } as never)
    const tree = await render()
    const held = tree.root
      .findAll(node => typeof node.type === 'string')
      .filter(node => flat(node).minHeight === font.leading.lg * fontScale)

    expect(held.at(-1)!.findAllByType(Text).map(node => node.props.children)).toEqual([i18n.t('home.notUpdated')])
  })

  describe('the not updated mark', () => {
    const allWords = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAllByType(Text).map(node => [node.props.children].flat().join(''))
    // Every box in the flow, in order, leaving out what sits outside it, so a mark that took room
    // shows as a box more or as a margin that changed. A box of fixed height counts as one: what
    // comes and goes inside it, such as the price band's "out of date" word, moves nothing around it.
    const flow = (node: ReactTestRenderer.ReactTestInstance): unknown[] => {
      if (typeof node.type === 'string' && flat(node).position === 'absolute') {
        return []
      }
      const { marginTop, marginBottom, minHeight, height, gap } = flat(node)
      const own = typeof node.type === 'string' ? [{ marginTop, marginBottom, minHeight, height, gap }] : []
      if (typeof node.type === 'string' && typeof height === 'number') {
        return own
      }
      return [...own, ...node.children.flatMap(child => (typeof child === 'string' ? [] : flow(child)))]
    }

    test('takes no room in the flow, so its coming and going moves nothing', async () => {
      const fresh = await render()
      const before = flow(fresh.root)
      jest.mocked(sparkGetWalletInfo).mockResolvedValue({ ...info(5_000), sync: 'stale' } as never)
      const marked = await render()

      expect(allWords(marked)).toContain(i18n.t('home.notUpdated'))
      expect(flow(marked.root)).toEqual(before)
    })

    test('stays inside the gap under the hero at the default text size', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue({ ...info(5_000), sync: 'stale' } as never)
      const tree = await render()
      const held = tree.root.findAll(node => typeof node.type === 'string' && flat(node).position === 'absolute')
      const slot = held.find(node => flat(node).top === '100%')!

      expect(2 * Number(flat(slot).marginTop) + font.leading.sm).toBe(space.xxl)
    })
  })

  test('a failed connect keeps the page rule: no second gap above, 32 to its action', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValueOnce(new Error('offline'))
    const tree = await render()
    const title = tree.root.findAllByType(Text).find(node => node.props.children === i18n.t('home.connectionError'))
    const button = tree.root.findAll(node => typeof node.type === 'string').map(flat)

    expect(flat(title!).marginTop).toBeUndefined()
    expect(button.some(style => style.marginTop === space.xxl)).toBe(true)
  })
})

describe('the recovered purchase card', () => {
  test('stands a section away from what is above it', async () => {
    jest.mocked(recoverPurchases).mockResolvedValueOnce({
      kind: 'name',
      status: 'stuck',
      subject: 'name',
      reference: 'ref',
      pubkey: '02aa',
    } as never)
    jest.mocked(loadRegistry).mockResolvedValue({ wallets: [{ id: 'wallet-a' }], active: 'wallet-a' } as never)
    const tree = await render()

    const card = tree.root.findByType(RecoveredPurchaseCard)
    expect(StyleSheet.flatten(card.props.style).marginTop).toBe(space.xxl)
  })
})
