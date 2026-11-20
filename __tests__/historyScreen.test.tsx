import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Dimensions, Linking, ScrollView, StyleSheet, Text } from 'react-native'
import { Txt } from '../src/components/Txt'
import { figuresHeldOut, figuresIn, flat, hostParent } from './support/figureFit'
import { FigureRow } from '../src/components/FigureRow'
import Clipboard from '@react-native-clipboard/clipboard'
import i18n from '../src/i18n'
import { HistoryScreen } from '../src/screens/HistoryScreen'
import { GradientButton } from '../src/components/GradientButton'
import { PendingDepositRows } from '../src/components/PendingDepositRows'
import { FadeInLine } from '../src/components/FadeInLine'
import { Reenter } from '../src/components/Reenter'
import { EmptyState } from '../src/components/EmptyState'
import { SectionLabel } from '../src/components/SectionLabel'
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs'
import { USDB } from '../src/wallet/tokens'
import * as settings from '../src/wallet/settings'
import { DirectionBadge } from '../src/components/DirectionBadge'
import {
  DepositDetailSheet,
  TransactionDetailSheet,
} from '../src/components/TransactionDetailSheet'
import { Skeleton } from '../src/components/Skeleton'
import {
  connectActiveSpark,
  onSparkConnected,
  sparkListContacts,
  sparkListHistory,
  sparkListUnclaimedDeposits,
  sparkRefreshWallet,
  sparkSubscribeToPayments,
  sparkSyncState,
  sparkSyncWaitLeftMs,
  type SparkDeposit,
} from '../src/wallet/spark'
import type { HistoryConversionSide, HistoryItem } from '../src/wallet/payment'
import { colors, font, space } from '../src/theme'
import { formatSats } from '../src/wallet/amount'

jest.mock('../src/wallet/spark', () => ({
  SYNC_WAIT_MS: 12_000,
  connectActiveSpark: jest.fn(),
  onSparkConnected: jest.fn(),
  sparkListContacts: jest.fn(async () => []),
  sparkListHistory: jest.fn(),
  sparkListUnclaimedDeposits: jest.fn(),
  sparkRefreshWallet: jest.fn(),
  sparkSubscribeToPayments: jest.fn(),
  sparkSyncState: jest.fn(),
  sparkSyncWaitLeftMs: jest.fn(),
  onSparkSynced: jest.fn((cb: () => void) => {
    mockSynced.fire = cb
    return () => undefined
  }),
}))

const mockSynced: { fire?: () => void } = {}
const mockSwitch: { fire?: () => void } = {}
jest.mock('../src/wallet/wallet', () => ({
  onActiveWalletChanged: (cb: () => void) => {
    const previous = mockSwitch.fire
    mockSwitch.fire = () => {
      previous?.()
      cb()
    }
    return () => undefined
  },
}))

// A focus the tests can take away and give back, as the tab bar does when another tab opens and the
// History tab stays mounted underneath.
const mockFocus: { set?: (on: boolean) => void } = {}
const mockNavigate = jest.fn()
// The rest is the real module, which the tab navigator's entry reads when HistoryScreen imports the
// tab bar's height from it.
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    ...jest.requireActual('@react-navigation/native'),
    useFocusEffect: (cb: () => void | (() => void)) => {
      const [on, setOn] = react.useState(true)
      mockFocus.set = setOn
      react.useEffect(() => (on ? cb() : undefined), [cb, on])
    },
    useNavigation: () => ({ navigate: mockNavigate }),
  }
})

const NOW = Math.floor(Date.now() / 1000)

const btcReceive: HistoryItem = {
  id: 'tx-btc',
  direction: 'received',
  status: 'complete',
  amountSat: 12000,
  feesSat: 0,
  timestamp: NOW,
  method: 'lightning',
  asset: null,
  txId: 'sparktxhash',
  destination: 'lnbc120u1pexampleinvoice',
}

const btcSend: HistoryItem = {
  id: 'tx-btc-2',
  direction: 'sent',
  status: 'complete',
  amountSat: 3000,
  feesSat: 5,
  timestamp: NOW,
  method: 'lightning',
  asset: null,
  txId: 'sparktxhash2',
}

// A read that never answers while the test runs, refused once it is over. The screen bounds such a read
// with a 12 s timer that only its answer clears, so one left hanging keeps Jest from exiting.
const hanging: Array<(reason: Error) => void> = []
function hung<T>(): Promise<T> {
  const read = new Promise<T>((_, refuse) => {
    hanging.push(refuse)
  })
  read.catch(() => undefined)
  return read
}

afterEach(async () => {
  const left = hanging.splice(0)
  if (left.length > 0) {
    await ReactTestRenderer.act(async () => {
      left.forEach(refuse => refuse(new Error('test over')))
    })
  }
})

let firePayment: (() => void) | null = null
// What spark.ts calls on each new connection.
let fireConnected: (() => void) | null = null

beforeEach(() => {
  jest.clearAllMocks()
  firePayment = null
  fireConnected = null
  jest.mocked(connectActiveSpark).mockReset()
  jest.mocked(connectActiveSpark).mockResolvedValue(undefined)
  jest.mocked(sparkSyncState).mockReturnValue('synced')
  jest.mocked(sparkSyncWaitLeftMs).mockReturnValue(0)
  jest.mocked(sparkRefreshWallet).mockReset()
  jest.mocked(sparkRefreshWallet).mockResolvedValue(undefined)
  jest.mocked(onSparkConnected).mockImplementation(cb => {
    fireConnected = cb
    return () => {}
  })
  // Reset rather than cleared, since a queued once-answer a test left unread would reach the next test.
  jest.mocked(sparkListHistory).mockReset()
  jest.mocked(sparkListHistory).mockResolvedValue([btcReceive, btcSend])
  jest.mocked(sparkListUnclaimedDeposits).mockReset()
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([])
  mockSwitch.fire = undefined
  jest.mocked(sparkSubscribeToPayments).mockImplementation(async cb => {
    firePayment = cb
    return () => {}
  })
})

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function drain(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<HistoryScreen />)
  })
  await drain()
  return tree
}

const sheetOf = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(TransactionDetailSheet)

async function tapRow(tree: ReactTestRenderer.ReactTestRenderer, contains: string): Promise<void> {
  const row = tree.root
    .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => String(txt.props.children).includes(contains)))
  if (!row) {
    throw new Error(`row not found: ${contains}`)
  }
  await ReactTestRenderer.act(async () => {
    row.props.onPress()
  })
  await drain()
}

test('a token amount takes the comma in Portuguese', async () => {
  const tokenReceive: HistoryItem = {
    ...btcReceive,
    id: 'tx-depix',
    asset: { assetId: 'btkn1depix', ticker: 'DePix', amount: '0.5' },
  }
  jest.mocked(sparkListHistory).mockResolvedValue([tokenReceive])
  await ReactTestRenderer.act(async () => {
    await i18n.changeLanguage('pt-BR')
  })
  try {
    const shown = texts(await render()).join(' ')
    expect(shown).toContain('0,5 DePix')
  } finally {
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('en-US')
    })
  }
})

test('shows the wallet payments in sats, both directions', async () => {
  const tree = await render()
  const shown = texts(tree).join('\n')
  expect(shown).toContain('sats')
  expect(shown).toContain('Received')
  expect(shown).toContain('Sent')
})

test('a sent amount takes the minus sign, never the hyphen, and a received one the plus', async () => {
  const shown = texts(await render())
  expect(shown).toContain(`\u2212${i18n.t('home.sats', { amount: formatSats(3000) })}`)
  expect(shown).toContain(`+${i18n.t('home.sats', { amount: formatSats(12000) })}`)
  expect(shown.some(line => line.startsWith('-'))).toBe(false)
})

// The sign, the time and the status are placed by the locale, so a language can order them.
test("the row's sign and its time and status line come from the locale", async () => {
  // Read raw, since the store holds the locale file itself and an override writes into it.
  const saved = ['rowMeta', 'amountIn', 'amountOut'].map(key => [
    key,
    i18n.getResource('en-US', 'translation', `history.${key}`) as string,
  ])
  i18n.addResource('en-US', 'translation', 'history.rowMeta', '{{status}} @ {{time}}')
  i18n.addResource('en-US', 'translation', 'history.amountIn', 'in {{amount}}')
  i18n.addResource('en-US', 'translation', 'history.amountOut', 'out {{amount}}')
  try {
    const shown = texts(await render())
    expect(shown.some(line => line.startsWith(`${i18n.t('history.completed')} @ `))).toBe(true)
    expect(shown).toContain(`in ${i18n.t('home.sats', { amount: formatSats(12000) })}`)
    expect(shown).toContain(`out ${i18n.t('home.sats', { amount: formatSats(3000) })}`)
  } finally {
    saved.forEach(([key, value]) => i18n.addResource('en-US', 'translation', `history.${key}`, value))
  }
})

test('each row leads with the direction arrow, not an asset logo', async () => {
  const tree = await render()
  const badges = tree.root.findAllByType(DirectionBadge)

  expect(badges.map(b => b.props.direction)).toEqual(['received', 'sent'])
})

// The bolt glyph is a text-less TabIcon, so it is located by its name prop.
const bolts = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAll(n => n.props.name === 'bolt')

test('a received zap shows a bolt + "Zap" on the row and the badge + comment in the detail', async () => {
  const zap: HistoryItem = { ...btcReceive, id: 'tx-zap', zap: { comment: 'gm from nostr' } }
  jest.mocked(sparkListHistory).mockResolvedValue([zap])
  const tree = await render()
  const list = texts(tree).join('\n')
  expect(list).toContain('Zap')
  expect(list).not.toContain('Received')
  expect(bolts(tree)).toHaveLength(1)

  await tapRow(tree, 'Zap')
  const shown = texts(tree).join('\n')
  expect(shown).toContain('gm from nostr')
  expect(bolts(tree)).toHaveLength(2)
})

test('the zapper comment is rendered verbatim, never through t()', async () => {
  // The comment is set to a real i18n key, so passing it through t() would turn it into "Received".
  const zap: HistoryItem = { ...btcReceive, id: 'tx-zap-v', zap: { comment: 'history.received' } }
  jest.mocked(sparkListHistory).mockResolvedValue([zap])
  const tree = await render()
  await tapRow(tree, 'Zap')
  expect(texts(tree).join('\n')).toContain('history.received')
})

test('a non-zap payment reads "Received", never "Zap", and has no badge', async () => {
  const tree = await render()
  expect(bolts(tree)).toHaveLength(0)
  await tapRow(tree, 'Received')
  const shown = texts(tree).join('\n')
  expect(shown).not.toContain('Zap')
  expect(bolts(tree)).toHaveLength(0)
})

test('a conversion row is titled by where it landed, draws what arrived and what left, and no sign', async () => {
  const conversion: HistoryItem = {
    id: 'c1',
    direction: 'converted',
    status: 'complete',
    amountSat: 31_473,
    feesSat: 0,
    timestamp: NOW,
    method: 'spark',
    asset: null,
    conversion: {
      status: 'complete',
      automatic: true,
      from: { ticker: 'USDB', amount: '25.388955', fee: '0.050956' },
      to: { ticker: null, amount: '31473' },
    },
  }
  jest.mocked(sparkListHistory).mockResolvedValue([conversion])

  const lines = texts(await render())

  expect(lines).toContain('Conversion to bitcoin')
  expect(lines.join('\n')).not.toContain('\u2192')
  expect(lines).toContain(`${formatSats(31_473)} sats`)
  expect(lines).toContain('from 25.38 USDB')
})

const usdbArrived = (from: HistoryConversionSide | undefined): HistoryItem => ({
  id: 'c2',
  direction: 'converted',
  status: 'complete',
  amountSat: 0,
  feesSat: 0,
  timestamp: NOW,
  method: 'spark',
  asset: { assetId: 'btkn1usdb', ticker: 'USDB', amount: '25.337999' },
  conversion: { status: 'complete', automatic: false, from, to: { ticker: 'USDB', amount: '25.337999' } },
})

test('a figure from the local note reads as the quote it is', async () => {
  jest.mocked(sparkListHistory).mockResolvedValue([usdbArrived({ ticker: null, amount: '31473', quoted: true })])

  const lines = texts(await render())

  expect(lines).toContain('25.33 USDB')
  expect(lines).toContain(`from \u2248 ${formatSats(31_473)} sats`)
})

test('with the source unknown the row has no caption, and states no figure of its own', async () => {
  jest.mocked(sparkListHistory).mockResolvedValue([usdbArrived(undefined), { ...usdbArrived({ ticker: null }), id: 'c3' }])

  const lines = texts(await render())

  expect(lines.filter(line => line === 'Conversion to USDB')).toHaveLength(2)
  expect(lines.join('\n')).not.toContain('from ')
})

test('the detail keeps the exact decimals the row cut', async () => {
  jest.mocked(sparkListHistory).mockResolvedValue([usdbArrived({ ticker: null, amount: '31473' })])
  const tree = await render()

  await tapRow(tree, 'Conversion to USDB')

  expect(texts(tree).join('\n')).toContain('25.337999 USDB')
})

test('tapping a row opens the detail sheet with the network behind its fold', async () => {
  const tree = await render()
  await tapRow(tree, 'Received')
  expect(texts(tree).join('\n')).toContain('Destination')
  expect(texts(tree).join('\n')).not.toContain('Network')
  await tapRow(tree, 'Technical details')
  expect(texts(tree).join('\n')).toContain('Network')
  expect(texts(tree).join('\n')).toContain('Lightning')
})

// The list, the detail and every row a contact appears on read one map, resolved as they draw.
describe('a send to a contact', () => {
  const paid: HistoryItem = { ...btcSend, id: 'to-maria', lnAddress: 'maria@usevoltz.app', destination: 'maria@usevoltz.app' }

  test('titles the row and the detail after the contact, with the address still there to copy', async () => {
    jest.mocked(sparkListContacts).mockResolvedValue([{ id: '1', name: 'Maria', address: 'maria@usevoltz.app' }])
    jest.mocked(sparkListHistory).mockResolvedValue([paid])
    const tree = await render()

    expect(texts(tree)).toContain('To Maria')
    await tapRow(tree, 'To Maria')
    expect(tree.root.findAllByType(Txt).filter(n => n.props.role === 'section').map(n => n.props.children)).toContain(
      'To Maria',
    )
    expect(texts(tree).join('\n')).toContain('Destination')
  })

  test('falls back to the address when the contacts cannot be read, and the list stands', async () => {
    jest.mocked(sparkListContacts).mockRejectedValue(new Error('no connection'))
    jest.mocked(sparkListHistory).mockResolvedValue([paid])
    const tree = await render()

    expect(texts(tree)).toContain('To maria@usevoltz.app')
  })
})

test('copying the txid writes to the clipboard', async () => {
  const tree = await render()
  await tapRow(tree, 'Received')
  await tapRow(tree, 'Technical details')
  // The copy control is labelled with the txid itself rather than an action word.
  const copyRow = tree.root
    .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .find(n => String(n.props.accessibilityLabel ?? '').startsWith('Transaction ID'))
  await ReactTestRenderer.act(async () => {
    copyRow?.props.onPress()
  })
  expect(Clipboard.setString).toHaveBeenCalledWith('sparktxhash')
})

test('refetches live when a payment lands or leaves, without a manual reload', async () => {
  jest
    .mocked(sparkListHistory)
    .mockResolvedValueOnce([btcReceive])
    .mockResolvedValueOnce([btcReceive, btcSend])
  const tree = await render()
  expect(texts(tree).join('\n')).not.toContain('Sent')

  await ReactTestRenderer.act(async () => {
    firePayment?.()
  })
  await drain()

  expect(texts(tree).join('\n')).toContain('Sent')
  expect(sparkListHistory).toHaveBeenCalledTimes(2)
})

// Paging keeps a long history usable: the first screenful loads, and reaching the end asks the SDK
// for the next page starting where the list ends.
function page(size: number, from: number): HistoryItem[] {
  return Array.from({ length: size }, (_, i) => ({
    ...btcReceive,
    id: `p${from + i}`,
    amountSat: 1000 + from + i,
    timestamp: NOW - (from + i) * 86_400,
  }))
}

function listOf(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findByType(require('react-native').FlatList)
}

test('the first load asks for one page, not the whole history', async () => {
  jest.mocked(sparkListHistory).mockResolvedValue(page(30, 0))

  await render()

  expect(sparkListHistory).toHaveBeenCalledWith(30, undefined)
})

test('reaching the end loads the next page and appends it', async () => {
  jest
    .mocked(sparkListHistory)
    .mockResolvedValueOnce(page(30, 0))
    .mockResolvedValueOnce(page(30, 30))
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    listOf(tree).props.onEndReached()
  })
  await drain()

  // The second call starts where the loaded list ends, so nothing is fetched twice.
  expect(sparkListHistory).toHaveBeenLastCalledWith(30, undefined, 30)
  const rows = listOf(tree).props.data as { key: string }[]
  expect(rows.filter(r => !r.key.startsWith('h-'))).toHaveLength(60)
})

test('a short page means the end, so no further request is made', async () => {
  jest.mocked(sparkListHistory).mockResolvedValue(page(4, 0))
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    listOf(tree).props.onEndReached()
  })
  await drain()

  expect(sparkListHistory).toHaveBeenCalledTimes(1)
})

test('a fast scroll cannot fire two page loads at once', async () => {
  let release: ((v: HistoryItem[]) => void) | undefined
  jest
    .mocked(sparkListHistory)
    .mockResolvedValueOnce(page(30, 0))
    .mockImplementationOnce(() => new Promise(resolve => (release = resolve)))
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    listOf(tree).props.onEndReached()
    listOf(tree).props.onEndReached()
    listOf(tree).props.onEndReached()
  })

  expect(sparkListHistory).toHaveBeenCalledTimes(2)
  await ReactTestRenderer.act(async () => {
    release?.([])
  })
  await drain()
})

test('a short second page ends the paging, so scrolling again asks for nothing', async () => {
  jest
    .mocked(sparkListHistory)
    .mockResolvedValueOnce(page(30, 0))
    .mockResolvedValueOnce(page(7, 30))
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    listOf(tree).props.onEndReached()
  })
  await drain()
  expect(sparkListHistory).toHaveBeenCalledTimes(2)

  await ReactTestRenderer.act(async () => {
    listOf(tree).props.onEndReached()
  })
  await drain()

  expect(sparkListHistory).toHaveBeenCalledTimes(2)
})

// A failed next page keeps the rows and hides the footer skeleton, which would otherwise promise
// rows that are not coming. A good page after it brings the footer back while more remain.
test('a next page that fails hides the footer skeleton until a page answers', async () => {
  jest
    .mocked(sparkListHistory)
    .mockResolvedValueOnce(page(30, 0))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(page(30, 30))
  const tree = await render()
  expect(listOf(tree).props.ListFooterComponent).not.toBeNull()

  await ReactTestRenderer.act(async () => {
    listOf(tree).props.onEndReached()
  })
  await drain()
  expect(listOf(tree).props.ListFooterComponent).toBeNull()
  const rows = () => (listOf(tree).props.data as { key: string }[]).filter(r => !r.key.startsWith('h-'))
  expect(rows()).toHaveLength(30)

  await ReactTestRenderer.act(async () => {
    listOf(tree).props.onEndReached()
  })
  await drain()
  expect(sparkListHistory).toHaveBeenLastCalledWith(30, undefined, 30)
  expect(rows()).toHaveLength(60)
  expect(listOf(tree).props.ListFooterComponent).not.toBeNull()
})

// Reads the style of the amount on a row, found by its sign rather than by its digits, because the
// thousands separator follows the app language, so a literal number would pass or fail on which
// language the test happens to run in.
function amountStyle(
  tree: ReactTestRenderer.ReactTestRenderer,
  sign: '+' | '\u2212',
): Record<string, unknown> {
  const node = tree.root
    .findAllByType(Text)
    .find(n => typeof n.props.children === 'string' && n.props.children.startsWith(sign))
  if (!node) {
    throw new Error(`no amount starting with ${sign}`)
  }
  return Object.assign(
    {},
    ...[node.props.style].flat(Infinity).filter(x => x && typeof x === 'object'),
  )
}

// A loading row is as tall as a ready one: the badge beside the body and caption lines.
test('the loading rows and the paging footer take the ready row line heights', async () => {
  let release: ((v: HistoryItem[]) => void) | undefined
  jest.mocked(sparkListHistory).mockImplementationOnce(() => new Promise(resolve => (release = resolve)))
  const tree = await render()
  const barHeights = (root: ReactTestRenderer.ReactTestInstance) =>
    root.findAllByType(Skeleton).map(node => node.props.height)
  const loading = barHeights(tree.root)
  // Six rows of four bars, and the bar of the day's label over them.
  expect(loading).toHaveLength(25)
  expect(new Set(loading)).toEqual(new Set([40, font.leading.base, font.leading.sm]))

  await ReactTestRenderer.act(async () => {
    release?.(page(30, 0))
  })
  await drain()
  // Only the paging footer is left loading once the first page is in.
  expect(barHeights(tree.root).sort()).toEqual(
    [40, font.leading.base, font.leading.sm, font.leading.base].sort(),
  )
})

test('says the history is empty rather than drawing an empty screen', async () => {
  // The empty state is what a wallet shows on its first day, so it is the one state a new person is
  // certain to see.
  jest.mocked(sparkListHistory).mockResolvedValue([])
  expect(texts(await render()).join(' ')).toContain(i18n.t('history.empty'))
})

test('an empty history leads to Receive, the one thing a new wallet has to do next', async () => {
  jest.mocked(sparkListHistory).mockResolvedValue([])
  const tree = await render()
  const empty = tree.root.findByType(EmptyState)
  const receive = tree.root.findAllByType(GradientButton).find(button => button.props.label === i18n.t('home.receive'))

  expect(empty.props.icon).toBe('history')
  ReactTestRenderer.act(() => receive?.props.onPress())
  expect(mockNavigate).toHaveBeenCalledWith('Receive', undefined)
})

test('a list that is not updated points nowhere, since nothing is known about the wallet', async () => {
  jest.mocked(sparkListHistory).mockResolvedValue([])
  jest.mocked(sparkSyncState).mockReturnValue('stale')
  const tree = await render()

  expect(texts(tree).join(' ')).toContain(i18n.t('home.notUpdated'))
  expect(tree.root.findAllByType(GradientButton)).toHaveLength(0)
})

// The tab bar under the History tab holds the bottom inset, as it does under Home, so the tab leaves
// only its own air there, while the asset's list, pushed on the stack with no bar under it, adds it.
describe('the bottom of the list', () => {
  const INSET = 34
  const TAB_BAR = 83
  async function renderWithInset(element: React.JSX.Element): Promise<ReactTestRenderer.ReactTestRenderer> {
    const insets = jest.spyOn(require('react-native-safe-area-context'), 'useSafeAreaInsets')
    insets.mockReturnValue({ top: 0, right: 0, bottom: INSET, left: 0 })
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(element)
    })
    await drain()
    insets.mockRestore()
    return tree
  }
  const inTab = (element: React.JSX.Element) => (
    <BottomTabBarHeightContext.Provider value={TAB_BAR}>{element}</BottomTabBarHeightContext.Provider>
  )
  const listBottom = (tree: ReactTestRenderer.ReactTestRenderer) =>
    StyleSheet.flatten(listOf(tree).props.contentContainerStyle).paddingBottom
  const scrollBottom = (tree: ReactTestRenderer.ReactTestRenderer) =>
    StyleSheet.flatten(tree.root.findByType(ScrollView).props.contentContainerStyle).paddingBottom

  test('as a tab the rows leave the inset to the tab bar', async () => {
    expect(listBottom(await renderWithInset(inTab(<HistoryScreen />)))).toBe(space.xl)
  })

  test('as a tab the empty list and the wait for it leave the inset to the tab bar too', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([])
    expect(scrollBottom(await renderWithInset(inTab(<HistoryScreen />)))).toBe(space.xl)

    jest.mocked(sparkListHistory).mockImplementation(() => new Promise(() => undefined))
    expect(scrollBottom(await renderWithInset(inTab(<HistoryScreen />)))).toBe(space.xl)
  })

  test("the asset's own list, with no tab bar under it, keeps the inset", async () => {
    jest
      .mocked(sparkListHistory)
      .mockResolvedValue([{ ...btcReceive, asset: { assetId: USDB.identifier, ticker: 'USDB', amount: '10' } }])
    expect(listBottom(await renderWithInset(<HistoryScreen assetId={USDB.identifier} />))).toBe(space.xl + INSET)
  })
})

// "No transactions yet" is a statement about the wallet's money, so it is drawn only from a read that
// answered with nothing. A read that threw says it failed and offers the read again.
describe('a first read that fails', () => {
  function retryButton(tree: ReactTestRenderer.ReactTestRenderer) {
    return tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(txt => txt.props.children === i18n.t('common.retry')))
  }

  test('says the read failed and offers Try again, never the empty line', async () => {
    // What requireSdk throws before the wallet connects.
    jest.mocked(sparkListHistory).mockRejectedValue(new Error('Spark SDK not connected'))
    const shown = texts(await render()).join(' ')

    expect(shown).toContain(i18n.t('history.loadFailed'))
    expect(shown).toContain(i18n.t('common.retry'))
    expect(shown).not.toContain(i18n.t('history.empty'))
    // Nothing to subscribe to while the SDK cannot be read.
    expect(sparkSubscribeToPayments).not.toHaveBeenCalled()
  })

  test('a lost connection is named as such', async () => {
    jest.mocked(sparkListHistory).mockRejectedValue(new Error('network unreachable'))
    const shown = texts(await render()).join(' ')

    expect(shown).toContain(i18n.t('errors.offline'))
    expect(shown).not.toContain(i18n.t('history.empty'))
  })

  test('Try again reads the first page again and then subscribes, once', async () => {
    jest
      .mocked(sparkListHistory)
      .mockRejectedValueOnce(new Error('Spark SDK not connected'))
      .mockResolvedValue([btcReceive])
    const tree = await render()

    await ReactTestRenderer.act(async () => {
      retryButton(tree)!.props.onPress()
    })
    await drain()

    expect(sparkListHistory).toHaveBeenCalledTimes(2)
    expect(texts(tree).join(' ')).toContain('Received')
    expect(sparkSubscribeToPayments).toHaveBeenCalledTimes(1)

    // A payment refreshes the list without registering a second listener.
    await ReactTestRenderer.act(async () => {
      firePayment?.()
    })
    await drain()
    expect(sparkListHistory).toHaveBeenCalledTimes(3)
    expect(sparkSubscribeToPayments).toHaveBeenCalledTimes(1)
  })

  // The button gives way to the skeleton on the first tap, so the handler is held to tap twice.
  test('a second tap starts a new read, and the first one answering late never lands', async () => {
    let first: ((v: HistoryItem[]) => void) | undefined
    let second: ((v: HistoryItem[]) => void) | undefined
    jest
      .mocked(sparkListHistory)
      .mockRejectedValueOnce(new Error('Spark SDK not connected'))
      .mockImplementationOnce(() => new Promise(resolve => (first = resolve)))
      .mockImplementationOnce(() => new Promise(resolve => (second = resolve)))
    const tree = await render()
    const onPress = retryButton(tree)!.props.onPress

    await ReactTestRenderer.act(async () => {
      onPress()
      onPress()
    })
    expect(sparkListHistory).toHaveBeenCalledTimes(3)

    await ReactTestRenderer.act(async () => {
      second?.([btcSend])
    })
    await drain()
    await ReactTestRenderer.act(async () => {
      first?.([btcReceive])
    })
    await drain()

    const shown = texts(tree).join(' ')
    expect(shown).toContain('Sent')
    expect(shown).not.toContain('Received')
    expect(sparkSubscribeToPayments).toHaveBeenCalledTimes(1)
  })

  test('the first read failing late keeps the skeleton while the last one is in flight', async () => {
    let first: ((cause: Error) => void) | undefined
    jest
      .mocked(sparkListHistory)
      .mockRejectedValueOnce(new Error('Spark SDK not connected'))
      .mockImplementationOnce(() => new Promise((_, reject) => (first = reject)))
      .mockImplementationOnce(() => new Promise(() => undefined))
    const tree = await render()
    const onPress = retryButton(tree)!.props.onPress

    await ReactTestRenderer.act(async () => {
      onPress()
      onPress()
    })
    await ReactTestRenderer.act(async () => {
      first?.(new Error('Spark SDK not connected'))
    })
    await drain()

    expect(texts(tree).join(' ')).not.toContain(i18n.t('history.loadFailed'))
  })
})

// History is a tab that stays mounted, so focus is the one moment that always reads again. A read that
// never answers must not hold the screen, and a read still in flight must not swallow the refocus.
describe('coming back to the tab', () => {
  async function blur(): Promise<void> {
    await ReactTestRenderer.act(async () => {
      mockFocus.set?.(false)
    })
  }
  async function focus(): Promise<void> {
    await ReactTestRenderer.act(async () => {
      mockFocus.set?.(true)
    })
    await drain()
  }

  test('a first read that never answers gives way to the read the refocus starts', async () => {
    jest
      .mocked(sparkListHistory)
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce([btcReceive])
    const tree = await render()
    expect(texts(tree).join(' ')).not.toContain('Received')

    await blur()
    await focus()

    expect(sparkListHistory).toHaveBeenCalledTimes(2)
    expect(texts(tree).join(' ')).toContain('Received')
    expect(sparkSubscribeToPayments).toHaveBeenCalledTimes(1)
  })

  test('a first read answering after a blur lands nothing and subscribes nothing', async () => {
    let slow: ((v: HistoryItem[]) => void) | undefined
    jest.mocked(sparkListHistory).mockImplementationOnce(() => new Promise(resolve => (slow = resolve)))
    const tree = await render()

    await blur()
    await ReactTestRenderer.act(async () => {
      slow?.([btcReceive])
    })
    await drain()

    expect(texts(tree).join(' ')).not.toContain('Received')
    expect(sparkSubscribeToPayments).not.toHaveBeenCalled()
  })

  test('a next page that never answers stops paging only until the tab is shown again', async () => {
    let abandoned: ((v: HistoryItem[]) => void) | undefined
    jest
      .mocked(sparkListHistory)
      .mockResolvedValueOnce(page(30, 0))
      .mockImplementationOnce(() => new Promise(resolve => (abandoned = resolve)))
      .mockResolvedValueOnce(page(30, 0))
      .mockResolvedValueOnce(page(30, 30))
    const tree = await render()
    const rows = () => (listOf(tree).props.data as { key: string }[]).filter(r => !r.key.startsWith('h-'))

    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    await blur()
    await focus()
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    await drain()
    expect(sparkListHistory).toHaveBeenCalledTimes(4)
    expect(sparkListHistory).toHaveBeenLastCalledWith(30, undefined, 30)
    expect(rows()).toHaveLength(60)

    // The abandoned read answering at last appends nothing on top.
    await ReactTestRenderer.act(async () => {
      abandoned?.(page(30, 30))
    })
    await drain()
    expect(rows()).toHaveLength(60)
  })

  test('a refocus during a slow refresh reads again, and the slow answer never lands', async () => {
    let slow: ((v: HistoryItem[]) => void) | undefined
    const stale: HistoryItem = { ...btcSend, id: 'tx-stale', amountSat: 4321 }
    jest
      .mocked(sparkListHistory)
      .mockResolvedValueOnce([btcReceive])
      .mockImplementationOnce(() => new Promise(resolve => (slow = resolve)))
      .mockResolvedValueOnce([btcReceive, btcSend])
    const tree = await render()

    await ReactTestRenderer.act(async () => {
      firePayment?.()
    })
    expect(sparkListHistory).toHaveBeenCalledTimes(2)

    // A payment made while the tab was away has no listener to announce it, so only the refocus
    // read can bring it in.
    await blur()
    await focus()
    expect(sparkListHistory).toHaveBeenCalledTimes(3)
    expect(texts(tree).join(' ')).toContain('Sent')

    await ReactTestRenderer.act(async () => {
      slow?.([stale])
    })
    await drain()
    const shown = texts(tree).join(' ')
    expect(shown).toContain('Received')
    expect(shown).not.toContain(formatSats(4321))
  })

  test('a superseded read that answers leaves the payment queue to the read that replaced it', async () => {
    let slow: ((v: HistoryItem[]) => void) | undefined
    let live: ((v: HistoryItem[]) => void) | undefined
    jest
      .mocked(sparkListHistory)
      .mockResolvedValueOnce([btcReceive])
      .mockImplementationOnce(() => new Promise(resolve => (slow = resolve)))
      .mockResolvedValueOnce([btcReceive])
      .mockImplementationOnce(() => new Promise(resolve => (live = resolve)))
      .mockResolvedValueOnce([btcReceive, btcSend])
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      firePayment?.()
    })
    await blur()
    await focus()
    await ReactTestRenderer.act(async () => {
      firePayment?.()
    })
    expect(sparkListHistory).toHaveBeenCalledTimes(4)

    // The read from before the blur answers while the payment's read is still in flight.
    await ReactTestRenderer.act(async () => {
      slow?.([btcReceive])
    })
    await drain()
    await ReactTestRenderer.act(async () => {
      firePayment?.()
    })
    expect(sparkListHistory).toHaveBeenCalledTimes(4)

    await ReactTestRenderer.act(async () => {
      live?.([btcReceive])
    })
    await drain()
    expect(sparkListHistory).toHaveBeenCalledTimes(5)
    expect(texts(tree).join(' ')).toContain('Sent')
  })
})

// A list read answers whichever wallet is connected, as the SDK does, cut at the limit asked for.
function answerWith(rows: () => HistoryItem[]): void {
  jest.mocked(sparkListHistory).mockImplementation(async (limit = 50, _asset, offset = 0) =>
    rows().slice(offset, offset + limit),
  )
}

const shownIds = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
  (listOf(tree).props.data as ({ kind: string; item: HistoryItem } | { kind: 'header' })[]).flatMap(row =>
    'item' in row ? [row.item.id] : [],
  )

function wallet(name: string, size: number): HistoryItem[] {
  return Array.from({ length: size }, (_, i) => ({
    ...btcReceive,
    id: `${name}${i}`,
    timestamp: NOW - i,
  }))
}

async function switchWallet(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    mockSwitch.fire?.()
  })
  await drain()
}

describe('the lines belong to one wallet', () => {
  async function blurAndFocus(): Promise<void> {
    await ReactTestRenderer.act(async () => {
      mockFocus.set?.(false)
    })
    await ReactTestRenderer.act(async () => {
      mockFocus.set?.(true)
    })
    await drain()
  }

  test('a wallet with fewer lines shows only its own, with the tab away during the switch', async () => {
    let rows = wallet('A', 12)
    answerWith(() => rows)
    const tree = await render()

    await ReactTestRenderer.act(async () => {
      mockFocus.set?.(false)
    })
    rows = wallet('B', 3)
    await switchWallet()
    await ReactTestRenderer.act(async () => {
      mockFocus.set?.(true)
    })
    await drain()

    expect(shownIds(tree)).toEqual(['B0', 'B1', 'B2'])
  })

  test('an empty wallet after a full one never shows the full one', async () => {
    let rows = wallet('A', 5)
    answerWith(() => rows)
    const tree = await render()

    rows = []
    await switchWallet()

    const shown = texts(tree).join(' ')
    expect(shown).toContain(i18n.t('history.empty'))
    expect(shown).not.toContain('Received')
  })

  // A read answers for the connection as it is, with or without a switch announced to this screen.
  test('a read with fewer lines than the list replaces the list', async () => {
    jest.mocked(sparkListHistory).mockResolvedValueOnce(wallet('A', 12))
    const tree = await render()

    jest.mocked(sparkListHistory).mockResolvedValueOnce(wallet('B', 3))
    await blurAndFocus()

    expect(shownIds(tree)).toEqual(['B0', 'B1', 'B2'])
  })

  test('a read with no lines leaves none of the list', async () => {
    jest.mocked(sparkListHistory).mockResolvedValueOnce(wallet('A', 5))
    const tree = await render()

    jest.mocked(sparkListHistory).mockResolvedValueOnce([])
    await blurAndFocus()

    expect(texts(tree).join(' ')).not.toContain('Received')
  })

  test('the skeleton takes the previous lines the moment the switch is announced', async () => {
    answerWith(() => wallet('A', 5))
    const tree = await render()
    jest.mocked(connectActiveSpark).mockImplementationOnce(() => new Promise(() => undefined))

    await switchWallet()

    expect(texts(tree).join(' ')).not.toContain('Received')
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
  })

  test('a read out for the previous wallet lands nothing after the switch', async () => {
    let slow: ((v: HistoryItem[]) => void) | undefined
    answerWith(() => wallet('A', 5))
    const tree = await render()
    jest.mocked(sparkListHistory).mockImplementationOnce(() => new Promise(resolve => (slow = resolve)))
    await ReactTestRenderer.act(async () => {
      firePayment?.()
    })
    answerWith(() => wallet('B', 2))
    await switchWallet()

    await ReactTestRenderer.act(async () => {
      slow?.(wallet('A', 5))
    })
    await drain()

    expect(shownIds(tree)).toEqual(['B0', 'B1'])
  })

  test('a next page out for the previous wallet appends nothing after the switch', async () => {
    let slow: ((v: HistoryItem[]) => void) | undefined
    jest.mocked(sparkListHistory).mockResolvedValueOnce(wallet('A', 30))
    const tree = await render()
    jest.mocked(sparkListHistory).mockImplementationOnce(() => new Promise(resolve => (slow = resolve)))
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    answerWith(() => wallet('B', 2))
    await switchWallet()

    await ReactTestRenderer.act(async () => {
      slow?.(wallet('A', 30))
    })
    await drain()

    expect(shownIds(tree)).toEqual(['B0', 'B1'])
  })

  test('the detail of a line of the previous wallet closes with the switch', async () => {
    answerWith(() => [btcReceive])
    const tree = await render()
    await tapRow(tree, 'Received')
    expect(texts(tree).join(' ')).toContain('Destination')

    answerWith(() => [btcSend])
    await switchWallet()

    expect(texts(tree).join(' ')).not.toContain('Destination')
  })

  test('a refresh after paging reads every row on screen, so none goes missing', async () => {
    let rows = wallet('A', 60)
    answerWith(() => rows)
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    await drain()
    expect(shownIds(tree)).toHaveLength(60)

    rows = [{ ...btcSend, id: 'NEW', timestamp: NOW + 1 }, ...rows]
    await blurAndFocus()

    expect(sparkListHistory).toHaveBeenLastCalledWith(60, undefined)
    const ids = shownIds(tree)
    expect(ids[0]).toBe('NEW')
    expect(ids).toContain('A29')
    expect(ids).toContain('A58')
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a list at its end stays there through a refresh, with no footer coming back', async () => {
    const rows = wallet('A', 60)
    answerWith(() => rows)
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    await drain()
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    await drain()
    expect(listOf(tree).props.ListFooterComponent).toBeNull()

    await blurAndFocus()

    expect(sparkListHistory).toHaveBeenLastCalledWith(61, undefined)
    expect(shownIds(tree)).toHaveLength(60)
    expect(listOf(tree).props.ListFooterComponent).toBeNull()
  })

  test('the next page after that refresh continues with no row repeated or skipped', async () => {
    let rows = wallet('A', 90)
    answerWith(() => rows)
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    await drain()

    rows = [{ ...btcSend, id: 'NEW', timestamp: NOW + 1 }, ...rows]
    await blurAndFocus()
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    await drain()

    expect(shownIds(tree)).toEqual(rows.slice(0, 90).map(row => row.id))
  })

  test('a line that settled below the first page reads as settled after a refresh', async () => {
    let rows = wallet('A', 31)
    rows[30] = { ...rows[30], status: 'pending' }
    answerWith(() => rows)
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    await drain()

    rows = rows.map(row => ({ ...row, status: 'complete' }))
    await blurAndFocus()

    const statuses = (listOf(tree).props.data as { item?: HistoryItem }[]).flatMap(row =>
      row.item ? [row.item.status] : [],
    )
    expect(statuses).not.toContain('pending')
  })

  test('a next page out when a refresh starts lands nothing, and a list being replaced does not page', async () => {
    let slow: ((v: HistoryItem[]) => void) | undefined
    let refresh: ((v: HistoryItem[]) => void) | undefined
    jest.mocked(sparkListHistory).mockResolvedValueOnce(wallet('A', 30))
    const tree = await render()
    jest.mocked(sparkListHistory).mockImplementationOnce(() => new Promise(resolve => (slow = resolve)))
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    jest.mocked(sparkListHistory).mockImplementationOnce(() => new Promise(resolve => (refresh = resolve)))
    await ReactTestRenderer.act(async () => {
      firePayment?.()
    })
    const calls = jest.mocked(sparkListHistory).mock.calls.length
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    expect(sparkListHistory).toHaveBeenCalledTimes(calls)

    await ReactTestRenderer.act(async () => {
      slow?.(wallet('X', 30))
    })
    await ReactTestRenderer.act(async () => {
      refresh?.(wallet('A', 30))
    })
    await drain()

    expect(shownIds(tree)).toEqual(wallet('A', 30).map(row => row.id))
  })
})

describe('reading before and across a connection', () => {
  test('connects before it reads, so the tab never reads the wallet a switch left behind', async () => {
    const order: string[] = []
    jest.mocked(connectActiveSpark).mockImplementation(async () => {
      order.push('connect')
    })
    jest.mocked(sparkListHistory).mockImplementation(async () => {
      order.push('read')
      return [btcReceive]
    })

    await render()

    expect(order).toEqual(['connect', 'read'])
  })

  test('a connect that fails is the same error as a read that fails', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValue(new Error('network unreachable'))

    const shown = texts(await render()).join(' ')

    expect(shown).toContain(i18n.t('errors.offline'))
    expect(sparkListHistory).not.toHaveBeenCalled()
  })

  test('a connect a newer one replaced stays on the skeleton and the new connection reads', async () => {
    const superseded = Object.assign(new Error('superseded'), { name: 'SparkConnectSuperseded' })
    jest.mocked(connectActiveSpark).mockRejectedValueOnce(superseded)
    const tree = await render()
    expect(texts(tree).join(' ')).not.toContain(i18n.t('history.loadFailed'))
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)

    await ReactTestRenderer.act(async () => {
      fireConnected?.()
    })
    await drain()

    expect(texts(tree).join(' ')).toContain('Received')
  })

  test('a connection already up at mount does not read twice', async () => {
    jest.mocked(onSparkConnected).mockImplementation(cb => {
      fireConnected = cb
      cb()
      return () => {}
    })

    await render()

    expect(sparkListHistory).toHaveBeenCalledTimes(1)
  })

  test('a reconnect takes the listener off the old instance and adds one on the new', async () => {
    const removed = jest.fn()
    jest.mocked(sparkSubscribeToPayments).mockImplementation(async cb => {
      firePayment = cb
      return removed
    })
    await render()
    expect(sparkSubscribeToPayments).toHaveBeenCalledTimes(1)

    await ReactTestRenderer.act(async () => {
      fireConnected?.()
    })
    await drain()

    expect(removed).toHaveBeenCalledTimes(1)
    expect(sparkSubscribeToPayments).toHaveBeenCalledTimes(2)
  })

  test('a new connection with the tab away reads nothing until the tab is back', async () => {
    await render()
    await ReactTestRenderer.act(async () => {
      mockFocus.set?.(false)
    })
    const calls = jest.mocked(sparkListHistory).mock.calls.length

    await ReactTestRenderer.act(async () => {
      fireConnected?.()
    })
    await drain()

    expect(sparkListHistory).toHaveBeenCalledTimes(calls)
  })
})

describe('what the list claims without a sync', () => {
  const MARK = 'home.notUpdated'
  const synced = async (): Promise<void> => {
    await ReactTestRenderer.act(async () => {
      mockSynced.fire?.()
    })
    await drain()
  }

  test('nothing read yet on a connection still waiting is the skeleton, never the empty line', async () => {
    jest.mocked(sparkSyncState).mockReturnValue('waiting')
    jest.mocked(sparkListHistory).mockResolvedValue([])
    const tree = await render()

    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    expect(texts(tree).join(' ')).not.toContain(i18n.t('history.empty'))
  })

  test('a skeleton over an empty list gives way to the error when the next read fails', async () => {
    jest.mocked(sparkSyncState).mockReturnValue('waiting')
    jest.mocked(sparkListHistory).mockResolvedValueOnce([]).mockRejectedValue(new Error('read failed'))
    const tree = await render()
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)

    await synced()

    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
    expect(texts(tree)).toContain(i18n.t('history.loadFailed'))
    expect(texts(tree)).toContain(i18n.t('common.retry'))
  })

  test('nothing read past the wait says not updated, never the empty line', async () => {
    jest.mocked(sparkSyncState).mockReturnValue('stale')
    jest.mocked(sparkListHistory).mockResolvedValue([])
    const shown = texts(await render()).join(' ')

    expect(shown).toContain(i18n.t(MARK))
    expect(shown).not.toContain(i18n.t('history.empty'))
  })

  test('nothing read on a synced connection is the empty line, and no mark', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([])
    const shown = texts(await render()).join(' ')

    expect(shown).toContain(i18n.t('history.empty'))
    expect(shown).not.toContain(i18n.t(MARK))
  })

  describe('with the deposits behind it', () => {
    test('stays on the skeleton while their first read is out, never the empty line', async () => {
      jest.mocked(sparkListHistory).mockResolvedValue([])
      jest.mocked(sparkListUnclaimedDeposits).mockReturnValue(hung())
      const tree = await render()

      expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
      expect(texts(tree).join(' ')).not.toContain(i18n.t('history.empty'))
    })

    test('a deposits read that fails says not updated, never the empty line', async () => {
      jest.mocked(sparkListHistory).mockResolvedValue([])
      jest.mocked(sparkListUnclaimedDeposits).mockRejectedValue(new Error('read failed'))
      const shown = texts(await render()).join(' ')

      expect(shown).toContain(i18n.t(MARK))
      expect(shown).not.toContain(i18n.t('history.empty'))
    })

    test('a pull never brings the skeleton back while they are read again', async () => {
      jest.mocked(sparkListHistory).mockResolvedValue([])
      const tree = await render()
      expect(texts(tree).join(' ')).toContain(i18n.t('history.empty'))

      jest.mocked(sparkListUnclaimedDeposits).mockReturnValue(hung())
      await ReactTestRenderer.act(async () => {
        tree.root.findByType(ScrollView).props.refreshControl.props.onRefresh()
      })
      await drain()

      expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
    })
  })

  test('the first sync brings the lines the database did not have yet', async () => {
    jest.mocked(sparkSyncState).mockReturnValue('waiting')
    jest.mocked(sparkListHistory).mockResolvedValueOnce([]).mockResolvedValue([btcReceive])
    const tree = await render()

    jest.mocked(sparkSyncState).mockReturnValue('synced')
    await synced()

    expect(texts(tree).join(' ')).toContain('Received')
    expect(texts(tree).join(' ')).not.toContain(i18n.t(MARK))
  })

  test('a sync with the tab away reads when the tab is back', async () => {
    await render()
    await ReactTestRenderer.act(async () => {
      mockFocus.set?.(false)
    })
    const calls = jest.mocked(sparkListHistory).mock.calls.length

    await synced()

    expect(sparkListHistory).toHaveBeenCalledTimes(calls)
  })

  test('lines read on a connection still waiting show with no mark', async () => {
    jest.mocked(sparkSyncState).mockReturnValue('waiting')
    const shown = texts(await render()).join(' ')

    expect(shown).toContain('Received')
    expect(shown).not.toContain(i18n.t(MARK))
  })

  test('lines read past the wait carry the mark above them, and a sync takes it away', async () => {
    jest.mocked(sparkSyncState).mockReturnValue('stale')
    const tree = await render()
    expect(texts(tree).join(' ')).toContain('Received')
    expect(texts(tree).join(' ')).toContain(i18n.t(MARK))

    jest.mocked(sparkSyncState).mockReturnValue('synced')
    await synced()

    expect(texts(tree).join(' ')).toContain('Received')
    expect(texts(tree).join(' ')).not.toContain(i18n.t(MARK))
  })

  test('the sync standing is the one from before the read', async () => {
    const order: string[] = []
    jest.mocked(sparkSyncState).mockImplementation(() => {
      order.push('standing')
      return 'synced'
    })
    jest.mocked(sparkListHistory).mockImplementation(async () => {
      order.push('read')
      return [btcReceive]
    })

    await render()

    expect(order).toEqual(['standing', 'read'])
  })
})

describe('pulling the list to refresh', () => {
  const MARK = 'home.notUpdated'
  const control = (tree: ReactTestRenderer.ReactTestRenderer) => {
    const lists = tree.root.findAllByType(require('react-native').FlatList)
    return (lists[0] ?? tree.root.findByType(ScrollView)).props.refreshControl
  }
  async function pull(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    await ReactTestRenderer.act(async () => {
      control(tree).props.onRefresh()
    })
    await drain()
  }

  test('no line moves and nothing is read while the sync is out', async () => {
    const tree = await render()
    jest.mocked(sparkRefreshWallet).mockReturnValue(new Promise(() => undefined))
    jest.mocked(sparkListHistory).mockResolvedValue([btcSend])
    jest.mocked(sparkSyncState).mockReturnValue('stale')
    const before = texts(tree).join(' ')
    const reads = jest.mocked(sparkListHistory).mock.calls.length

    await pull(tree)

    expect(control(tree).props.refreshing).toBe(true)
    expect(texts(tree).join(' ')).toBe(before)
    expect(sparkListHistory).toHaveBeenCalledTimes(reads)
  })

  test('a sync that was heard replaces the lines, and the spinner closes', async () => {
    const tree = await render()
    jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcSend, id: 'NEW' }, btcReceive])

    await pull(tree)

    expect(shownIds(tree)).toEqual(['NEW', btcReceive.id])
    expect(texts(tree).join(' ')).not.toContain(i18n.t(MARK))
    expect(control(tree).props.refreshing).toBe(false)
  })

  test('a sync not heard keeps the lines under the mark, with no error', async () => {
    const tree = await render()
    jest.mocked(sparkSyncState).mockReturnValue('stale')

    await pull(tree)

    const shown = texts(tree).join(' ')
    expect(shown).toContain('Received')
    expect(shown).toContain(i18n.t(MARK))
    expect(shown).not.toContain(i18n.t('history.loadFailed'))
  })

  test('the mark goes up even when the read after the sync fails', async () => {
    const tree = await render()
    jest.mocked(sparkSyncState).mockReturnValue('stale')
    jest.mocked(sparkListHistory).mockRejectedValue(new Error('network unreachable'))

    await pull(tree)

    const shown = texts(tree).join(' ')
    expect(shown).toContain('Received')
    expect(shown).toContain(i18n.t(MARK))
  })

  test('offline with a read already out, the mark goes up with no answer from it', async () => {
    const tree = await render()
    jest.mocked(sparkListHistory).mockImplementation(() => hung())
    await ReactTestRenderer.act(async () => {
      firePayment?.()
    })
    jest.mocked(sparkSyncState).mockReturnValue('stale')

    await pull(tree)

    expect(texts(tree).join(' ')).toContain(i18n.t(MARK))
    expect(texts(tree).join(' ')).toContain('Received')
  })

  test('an empty list can be pulled, and the lines arrive', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([])
    const tree = await render()
    expect(texts(tree).join(' ')).toContain(i18n.t('history.empty'))

    jest.mocked(sparkListHistory).mockResolvedValue([btcReceive])
    await pull(tree)

    expect(shownIds(tree)).toEqual([btcReceive.id])
  })

  test('the line past the wait can be pulled, and never turns into the empty line on the way', async () => {
    jest.mocked(sparkSyncState).mockReturnValue('stale')
    jest.mocked(sparkListHistory).mockResolvedValue([])
    const tree = await render()

    jest.mocked(sparkSyncState).mockReturnValue('synced')
    jest.mocked(sparkListHistory).mockImplementation(() => hung())
    await pull(tree)

    expect(texts(tree).join(' ')).toContain(i18n.t(MARK))
    expect(texts(tree).join(' ')).not.toContain(i18n.t('history.empty'))
  })

  test('a switch while the sync is out reads nothing for the pull', async () => {
    const tree = await render()
    let answer: (() => void) | undefined
    jest.mocked(sparkRefreshWallet).mockReturnValue(new Promise<void>(resolve => (answer = resolve)))
    await pull(tree)

    jest.mocked(connectActiveSpark).mockImplementation(() => new Promise(() => undefined))
    await switchWallet()
    const connects = jest.mocked(connectActiveSpark).mock.calls.length

    await ReactTestRenderer.act(async () => {
      answer?.()
    })
    await drain()

    expect(connectActiveSpark).toHaveBeenCalledTimes(connects)
  })

  describe('what the pull says when it ends', () => {
    const entered = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAllByType(Reenter).some(part => part.props.beat > 0)
    const freshLines = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAllByType(FadeInLine).filter(line => line.props.fresh)

    test("a pull re-enters each day's label with the rows", async () => {
      const tree = await render()

      await pull(tree)

      const labels = tree.root.findAllByType(Reenter).filter(part => part.findAllByType(SectionLabel).length > 0)
      expect(labels.length).toBeGreaterThan(0)
      expect(labels.every(part => part.props.beat > 0)).toBe(true)
    })

    test('a Synced heard re-enters the rows', async () => {
      const tree = await render()

      await pull(tree)

      expect(entered(tree)).toBe(true)
    })

    test('a screen reader hears that a pull landed, and nothing when it did not', async () => {
      const heard = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
      const tree = await render()
      jest.mocked(sparkSyncState).mockReturnValue('stale')
      await pull(tree)
      expect(heard).not.toHaveBeenCalled()

      jest.mocked(sparkSyncState).mockReturnValue('synced')
      await pull(tree)

      expect(heard.mock.calls).toEqual([[i18n.t('home.updatedNow')]])
      heard.mockRestore()
    })

    test.each([
      ['the list', [btcSend]],
      ['the empty screen', []],
    ])('nothing moves while %s scrolls', async (_, items) => {
      jest.mocked(sparkListHistory).mockResolvedValue(items)
      const tree = await render()
      const lists = tree.root.findAllByType(require('react-native').FlatList)
      const scroller = () => lists[0] ?? tree.root.findByType(ScrollView)
      ReactTestRenderer.act(() => scroller().props.onScrollBeginDrag())

      await pull(tree)
      expect(entered(tree)).toBe(false)

      ReactTestRenderer.act(() => scroller().props.onScrollEndDrag())
      await pull(tree)
      expect(entered(tree)).toBe(true)
    })

    test("no Synced moves nothing, and the 'not updated' mark instead", async () => {
      const tree = await render()
      jest.mocked(sparkSyncState).mockReturnValue('stale')

      await pull(tree)

      expect(entered(tree)).toBe(false)
      expect(texts(tree)).toContain(i18n.t(MARK))
    })

    test('a read that failed says nothing is updated', async () => {
      const tree = await render()
      jest.mocked(sparkListHistory).mockRejectedValue(new Error('storage busy'))

      await pull(tree)

      expect(entered(tree)).toBe(false)
    })

    test('nothing is said while the sync is out', async () => {
      const tree = await render()
      jest.mocked(sparkRefreshWallet).mockReturnValue(new Promise(() => undefined))

      await pull(tree)

      expect(entered(tree)).toBe(false)
    })

    test('the empty list says it too, from the same place', async () => {
      jest.mocked(sparkListHistory).mockResolvedValue([])
      const tree = await render()

      await pull(tree)

      expect(entered(tree)).toBe(true)
    })

    test('a line new since the pull fades in, and the lines already there do not', async () => {
      const tree = await render()
      const arrived: HistoryItem = { ...btcSend, id: 'tx-new' }
      jest.mocked(sparkListHistory).mockResolvedValue([arrived, btcReceive, btcSend])

      await pull(tree)

      expect(freshLines(tree).map(line => line.findAllByType(Text).length)).toHaveLength(1)
      expect(tree.root.findAllByType(FadeInLine)).toHaveLength(3)
    })

    test('a read with nothing new fades nothing', async () => {
      const tree = await render()

      await pull(tree)

      expect(freshLines(tree)).toHaveLength(0)
    })

    test('after a pull a payment line arrives as any other, with no fade', async () => {
      const tree = await render()
      await pull(tree)
      jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcSend, id: 'tx-later' }, btcReceive, btcSend])

      await ReactTestRenderer.act(async () => {
        firePayment?.()
      })
      await drain()

      expect(tree.root.findAllByType(FadeInLine)).toHaveLength(3)
      expect(freshLines(tree)).toHaveLength(0)
    })

    // A read out when something else starts one: the sync's notice here, which reads at once, as the
    // end of the wait for a sync and a new connection do. The payment listener queues instead.
    const pullWithTwoReads = async (tree: ReactTestRenderer.ReactTestRenderer) => {
      const first: { answer?: (items: HistoryItem[]) => void; refuse?: (cause: Error) => void } = {}
      const second: { answer?: (items: HistoryItem[]) => void; refuse?: (cause: Error) => void } = {}
      const held = (slot: typeof first) =>
        new Promise<HistoryItem[]>((resolve, reject) => {
          slot.answer = resolve
          slot.refuse = reject
        })
      jest.mocked(sparkListHistory).mockReturnValueOnce(held(first))
      jest.mocked(sparkListHistory).mockReturnValueOnce(held(second))
      await pull(tree)
      await ReactTestRenderer.act(async () => {
        mockSynced.fire?.()
      })
      await drain()
      return { first, second }
    }
    const arrived: HistoryItem = { ...btcSend, id: 'tx-new' }

    test('a pull follows the read that replaced it, and the pill comes with its lines', async () => {
      const tree = await render()
      const { first, second } = await pullWithTwoReads(tree)

      await ReactTestRenderer.act(async () => {
        first.answer?.([btcReceive])
      })
      await drain()
      expect(entered(tree)).toBe(false)
      expect(control(tree).props.refreshing).toBe(true)

      await ReactTestRenderer.act(async () => {
        second.answer?.([arrived, btcReceive, btcSend])
      })
      await drain()
      expect(entered(tree)).toBe(true)
      expect(tree.root.findAllByType(FadeInLine)).toHaveLength(3)
      expect(freshLines(tree)).toHaveLength(1)
    })

    test('the read that replaced the pull\'s fails: no pill over lines that never changed', async () => {
      const tree = await render()
      const { first, second } = await pullWithTwoReads(tree)

      await ReactTestRenderer.act(async () => {
        first.answer?.([arrived, btcReceive, btcSend])
      })
      await drain()
      await ReactTestRenderer.act(async () => {
        second.refuse?.(new Error('storage busy'))
      })
      await drain()

      expect(entered(tree)).toBe(false)
      expect(tree.root.findAllByType(FadeInLine)).toHaveLength(2)
    })

    test('the pull\'s read fails while a newer one is out, and the newer one answers the pull', async () => {
      const tree = await render()
      const { first, second } = await pullWithTwoReads(tree)

      await ReactTestRenderer.act(async () => {
        first.refuse?.(new Error('storage busy'))
      })
      await drain()
      expect(entered(tree)).toBe(false)

      await ReactTestRenderer.act(async () => {
        second.answer?.([arrived, btcReceive, btcSend])
      })
      await drain()
      expect(entered(tree)).toBe(true)
      expect(freshLines(tree)).toHaveLength(1)
    })

    test('a read that answers on a blurred tab lands nowhere, so no pill waits there', async () => {
      const tree = await render()
      let answer: ((items: HistoryItem[]) => void) | undefined
      jest.mocked(sparkListHistory).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
      await pull(tree)

      await ReactTestRenderer.act(async () => {
        mockFocus.set?.(false)
      })
      await ReactTestRenderer.act(async () => {
        answer?.([arrived, btcReceive, btcSend])
      })
      await drain()

      expect(entered(tree)).toBe(false)
    })

    test('a read that never answers ends the pull at the bound, with no pill', async () => {
      const tree = await render()
      jest.useFakeTimers()
      try {
        jest.mocked(sparkListHistory).mockReturnValueOnce(new Promise(() => undefined))
        await ReactTestRenderer.act(async () => {
          control(tree).props.onRefresh()
        })
        await ReactTestRenderer.act(async () => {
          await jest.advanceTimersByTimeAsync(12_000)
        })
        expect(entered(tree)).toBe(false)

        // The pull is over, so a line that arrives from here on is no line of the pull's.
        jest.mocked(sparkListHistory).mockResolvedValue([arrived, btcReceive, btcSend])
        await ReactTestRenderer.act(async () => {
          mockSynced.fire?.()
        })
        await ReactTestRenderer.act(async () => {
          await jest.advanceTimersByTimeAsync(0)
        })
        expect(tree.root.findAllByType(FadeInLine)).toHaveLength(3)
        expect(freshLines(tree)).toHaveLength(0)
      } finally {
        jest.useRealTimers()
      }
    })

    test('a switch during the read lands no pill for the next wallet', async () => {
      const tree = await render()
      let answer: ((items: HistoryItem[]) => void) | undefined
      jest.mocked(sparkListHistory).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
      await pull(tree)

      await switchWallet()
      await ReactTestRenderer.act(async () => {
        answer?.([btcReceive])
      })
      await drain()

      expect(entered(tree)).toBe(false)
    })

    test("a switch during the pull fades none of the next wallet's lines", async () => {
      const tree = await render()
      let answer: (() => void) | undefined
      jest.mocked(sparkRefreshWallet).mockReturnValue(new Promise<void>(resolve => (answer = resolve)))
      await pull(tree)
      jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcSend, id: 'other-wallet' }])

      await switchWallet()
      await ReactTestRenderer.act(async () => {
        answer?.()
      })
      await drain()

      expect(freshLines(tree)).toHaveLength(0)
      expect(entered(tree)).toBe(false)
    })
  })

  test('the skeleton has no pull', async () => {
    jest.mocked(sparkListHistory).mockImplementation(() => new Promise(() => undefined))
    const tree = await render()

    expect(tree.root.findByType(ScrollView).props.refreshControl).toBeUndefined()
  })

  test('the error has no pull, since it has Try again', async () => {
    jest.mocked(sparkListHistory).mockRejectedValue(new Error('network unreachable'))
    const tree = await render()

    expect(tree.root.findAllByType(ScrollView)).toHaveLength(0)
  })

  test('the spinner closes at SYNC_WAIT_MS with the read after the sync silent', async () => {
    const tree = await render()
    jest.useFakeTimers()
    try {
      jest.mocked(sparkListHistory).mockImplementation(() => new Promise(() => undefined))
      await ReactTestRenderer.act(async () => {
        control(tree).props.onRefresh()
      })
      await ReactTestRenderer.act(async () => {
        await jest.advanceTimersByTimeAsync(12_000 - 1)
      })
      expect(control(tree).props.refreshing).toBe(true)
      await ReactTestRenderer.act(async () => {
        await jest.advanceTimersByTimeAsync(1)
      })
      expect(control(tree).props.refreshing).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })
})

test('a live refresh that fails keeps the list on screen', async () => {
  jest
    .mocked(sparkListHistory)
    .mockResolvedValueOnce([btcReceive])
    .mockRejectedValueOnce(new Error('network unreachable'))
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    firePayment?.()
  })
  await drain()

  const shown = texts(tree).join(' ')
  expect(sparkListHistory).toHaveBeenCalledTimes(2)
  expect(shown).toContain('Received')
  expect(shown).not.toContain(i18n.t('history.loadFailed'))
})

// The read in flight may have started before the payment existed, so the payment is read after it
// rather than dropped or run alongside it.
test('a payment that lands during a read is read once that read is done', async () => {
  let release: ((v: HistoryItem[]) => void) | undefined
  jest
    .mocked(sparkListHistory)
    .mockResolvedValueOnce([btcReceive])
    .mockImplementationOnce(() => new Promise(resolve => (release = resolve)))
    .mockResolvedValueOnce([btcReceive, btcSend])
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    firePayment?.()
    firePayment?.()
  })
  expect(sparkListHistory).toHaveBeenCalledTimes(2)

  await ReactTestRenderer.act(async () => {
    release?.([btcReceive])
  })
  await drain()

  expect(sparkListHistory).toHaveBeenCalledTimes(3)
  expect(texts(tree).join(' ')).toContain('Sent')
})

describe('the amount carries the outcome in its colour', () => {
  // Received, sent, failed and pending each read differently, and the colour and the strike are
  // what tell them apart at a glance.
  test('received is green and sent is not', async () => {
    const tree = await render()
    expect(amountStyle(tree, '+').color).toBe(colors.success)
    expect(amountStyle(tree, '\u2212').color).toBe(colors.text)
  })

  test('a failed payment is struck through in the danger colour', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcSend, status: 'failed' }])
    const style = amountStyle(await render(), '\u2212')
    expect(style.color).toBe(colors.danger)
    expect(style.textDecorationLine).toBe('line-through')
  })

  test('a pending payment is muted, since it is neither gain nor loss yet', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcReceive, status: 'pending' }])
    expect(amountStyle(await render(), '+').color).toBe(colors.textSecondary)
  })
})

// The line's own style, flattened, from the pressable that holds `label`.
function lineStyleOf(tree: ReactTestRenderer.ReactTestRenderer, label: string): Record<string, unknown> {
  const line = tree.root
    .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.style === 'function')
    .find(n => n.findAllByType(Text).some(txt => String(txt.props.children).includes(label)))!
  return Object.assign(
    {},
    ...[line.props.style({ pressed: false })].flat(Infinity).filter(x => x && typeof x === 'object'),
  )
}

// A Touch is a column, so a line that does not lay itself across stacks every part vertically.
test('a history line lays its badge, text and amount across', async () => {
  const style = lineStyleOf(await render(), 'Received')
  expect(style.flexDirection).toBe('row')
  expect(style.alignItems).toBe('center')
})

// A group's date sits over its card with the asset screen's section spacing, not flush on it.
test('a group label keeps its distance from the card under it', async () => {
  const tree = await render()
  const label = tree.root
    .findAllByType(Text)
    .find(n => n.props.children === i18n.t('history.today'))!
  const style = Object.assign(
    {},
    ...[label.props.style].flat(Infinity).filter(x => x && typeof x === 'object'),
  )
  expect(style.marginBottom).toBe(space.md)
  expect(style.paddingHorizontal).toBeUndefined()
})

// A row's figure keeps to one line and shrinks to fit, where an ellipsis would cut a money figure.
test('draws each amount on one line that shrinks to fit', async () => {
  const tree = await render()
  const figures = tree.root
    .findAllByType(Text)
    .filter(n => typeof n.props.children === 'string' && n.props.children.includes(formatSats(3000)))
  expect(figures.length).toBeGreaterThan(0)
  for (const figure of figures) {
    expect([figure.props.numberOfLines, figure.props.adjustsFontSizeToFit]).toEqual([1, true])
  }
})

// At a large text size a figure beside the labels took the whole row: the label column, laid out
// from a basis of 0, was left no width at all, and the labels broke inside their words ("Conv/erted").
describe('the activity rows at large text', () => {
  const start = Dimensions.get('window')
  const setScale = (fontScale: number) => {
    const window = { ...start, fontScale }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  }
  afterEach(() => setScale(start.fontScale))

  test('side by side, a figure gives way in its row and leaves the labels a share of it', async () => {
    const tree = await render()
    const figures = figuresIn(tree.root)
    expect(figures.length).toBeGreaterThan(0)
    expect(figuresHeldOut(tree.root)).toEqual([])
    // Each row is a FigureRow, whose figure side keeps its width up to a share of the row.
    const inRows = new Set(tree.root.findAllByType(FigureRow).flatMap(row => figuresIn(row)))
    for (const figure of figures) {
      expect(inRows.has(figure)).toBe(true)
      expect(flat(hostParent(figure))).toMatchObject({ maxWidth: '60%', flexShrink: 0 })
    }
  })

  test('too narrow for both, a figure goes under the labels, which keep the row', async () => {
    setScale(3.12)
    const tree = await render()
    const figures = figuresIn(tree.root)
    expect(figures.length).toBeGreaterThan(0)
    for (const figure of figures) {
      const side = hostParent(figure)
      expect(flat(side && hostParent(side)).flexDirection).toBe('column')
      expect(flat(hostParent(figure)).maxWidth).toBe('100%')
    }
  })

  test('the labels wrap only between words', async () => {
    const tree = await render()
    const label = tree.root
      .findAllByType(Txt)
      .find(node => node.props.children === i18n.t('history.received'))
    expect(label?.props.wholeWords).toBe(true)
  })
})

// One asset's movements in the History list, for the list the asset screen opens. The tab itself has
// no filter, and the first test of this file holds that.
describe('the list of one asset', () => {
  const movement = (id: string, assetId: string): HistoryItem => ({
    ...btcReceive,
    id,
    asset: { assetId, ticker: 'USDB', amount: '10' },
  })
  const assetPage = (from: number, count: number, assetId: string = USDB.identifier) =>
    Array.from({ length: count }, (_, index) => movement(`m${from + index}`, assetId))
  const filter = { tokenIdentifier: USDB.identifier }

  async function renderAsset(): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<HistoryScreen assetId={USDB.identifier} />)
    })
    await drain()
    return tree
  }

  test('asks for that asset on the first page and on the next one, from where the query stopped', async () => {
    jest.mocked(sparkListHistory).mockResolvedValueOnce(assetPage(0, 30)).mockResolvedValueOnce(assetPage(30, 2))
    const tree = await renderAsset()
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    await drain()

    expect(sparkListHistory).toHaveBeenNthCalledWith(1, 30, filter)
    expect(sparkListHistory).toHaveBeenNthCalledWith(2, 30, filter, 30)
  })

  describe('with bitcoin on its way to the wallet', () => {
    const arriving: SparkDeposit = { txid: 'tx', vout: 0, amountSat: 42_000, claimable: false, stage: 'arriving', refundable: false }

    beforeEach(() => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([arriving])
    })

    test.each([
      ['an empty list', 0],
      ['a list with rows', 3],
    ])('%s reads nothing of it and shows no row of it', async (_case, count) => {
      jest.mocked(sparkListHistory).mockResolvedValue(assetPage(0, count))
      const tree = await renderAsset()

      expect(sparkListUnclaimedDeposits).not.toHaveBeenCalled()
      expect(tree.root.findAllByType(PendingDepositRows).flatMap(rows => rows.props.deposits)).toEqual([])
      expect(texts(tree).join(' ')).not.toContain('Arriving')
    })

    test('the tab, with the same answer, does show it', async () => {
      jest.mocked(sparkListHistory).mockResolvedValue(assetPage(0, 3))
      const tree = await render()

      expect(sparkListUnclaimedDeposits).toHaveBeenCalled()
      expect(texts(tree).join(' ')).toContain('Arriving')
    })
  })

  test('a row of another asset in the answer stays out, on any page', async () => {
    jest
      .mocked(sparkListHistory)
      .mockResolvedValueOnce([...assetPage(0, 29), movement('stray1', 'btkn1other')])
      .mockResolvedValueOnce([...assetPage(30, 1), movement('stray2', 'btkn1other')])
    const tree = await renderAsset()
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    await drain()
    const keys = listOf(tree).props.data.filter((row: { kind: string }) => row.kind === 'item').map((row: { key: string }) => row.key)

    expect(keys).toHaveLength(30)
    expect(keys).not.toContain('stray1')
    expect(keys).not.toContain('stray2')
  })

  // The offset counts what the query gave, or a dropped row would make the next page repeat one.
  test('the next page starts past a row the filter dropped', async () => {
    jest
      .mocked(sparkListHistory)
      .mockResolvedValueOnce([...assetPage(0, 29), movement('stray', 'btkn1other')])
      .mockResolvedValueOnce([])
    const tree = await renderAsset()
    await ReactTestRenderer.act(async () => {
      listOf(tree).props.onEndReached()
    })
    await drain()

    expect(sparkListHistory).toHaveBeenNthCalledWith(2, 30, filter, 30)
  })
})

// The sheet shows a row of the list, so what happens to that row happens on the sheet.
describe('an open detail', () => {
  const waiting: HistoryItem = { ...btcSend, id: 'moving', status: 'pending' }

  async function openOn(item: HistoryItem): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.mocked(sparkListHistory).mockResolvedValue([item])
    const tree = await render()
    await tapRow(tree, 'Sent')
    return tree
  }

  test('follows a payment that settles under it', async () => {
    const tree = await openOn(waiting)
    expect(sheetOf(tree).props.item.status).toBe('pending')

    jest.mocked(sparkListHistory).mockResolvedValue([{ ...waiting, status: 'complete' }])
    await ReactTestRenderer.act(async () => firePayment?.())
    await drain()

    expect(sheetOf(tree).props.item.status).toBe('complete')
    expect(texts(tree).join('\n')).toContain('Completed')
  })

  test('stays open on the last copy of a row that left the list', async () => {
    const tree = await openOn(waiting)

    jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcReceive, id: 'other' }])
    await ReactTestRenderer.act(async () => firePayment?.())
    await drain()

    expect(sheetOf(tree).props.item.id).toBe('moving')
  })

  test('a wallet switch closes it', async () => {
    const tree = await openOn(waiting)

    await ReactTestRenderer.act(async () => mockSwitch.fire?.())
    await drain()

    expect(tree.root.findAllByType(TransactionDetailSheet).every(sheet => sheet.props.item === null)).toBe(true)
  })
})

describe('money pending above the list', () => {
  const arriving: SparkDeposit = {
    txid: 'tx',
    vout: 0,
    amountSat: 42_000,
    claimable: false,
    stage: 'arriving',
    refundable: false,
  }

  test('a row sits above the days, approximate and arriving', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([arriving])
    const tree = await render()

    const shown = texts(tree).join(' ')
    expect(shown).toContain('Arriving')
    expect(shown).toContain(`≈ ${formatSats(42_000)} sats`)
    expect(texts(tree).length).toBeGreaterThan(2)
  })

  describe('its detail', () => {
    const txid = 'a1'.repeat(32)
    const refundTxId = 'b2'.repeat(32)
    const onChain: SparkDeposit = { ...arriving, txid }
    const depositSheet = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findByType(DepositDetailSheet)
    const pressLabelled = async (tree: ReactTestRenderer.ReactTestRenderer, label: string) => {
      const target = depositSheet(tree)
        .findAll(n => typeof n.props.onPress === 'function')
        .find(
          n =>
            n.findAllByType(Text).some(txt => String(txt.props.children) === label) ||
            n.props.label === label,
        )
      if (!target) {
        throw new Error(`nothing pressable reads ${label}`)
      }
      await ReactTestRenderer.act(async () => target.props.onPress())
    }

    beforeEach(() => {
      jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
      jest.mocked(Clipboard.setString).mockClear()
    })

    test.each([
      ['above the rows', [btcReceive]],
      ['with no rows', []],
    ])(
      '%s, a tap shows the transaction, copied whole, and opens it in the explorer',
      async (_case, items) => {
        jest.mocked(sparkListHistory).mockResolvedValue(items)
        jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
        const tree = await render()
        expect(depositSheet(tree).props.deposits).toEqual([])

        await tapRow(tree, 'Arriving')
        expect(depositSheet(tree).props.deposits).toEqual([onChain])
        const shown = depositSheet(tree).findAllByType(Text).map(n => String(n.props.children))
        expect(shown).toContain(i18n.t('history.detail.txid'))
        expect(shown).toContain(`≈ ${formatSats(42_000)} sats`)
        expect(shown).toContain('Arriving')

        await pressLabelled(tree, i18n.t('history.detail.viewExplorer'))
        expect(Linking.openURL).toHaveBeenCalledWith(`https://mempool.space/tx/${txid}`)

        const copyRow = depositSheet(tree)
          .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.label === 'string')
          .find(n => n.props.label.startsWith(i18n.t('history.detail.txid')))
        await ReactTestRenderer.act(async () => copyRow?.props.onPress())
        expect(Clipboard.setString).toHaveBeenCalledWith(txid)
      },
    )

    test('a return is followed on its own transaction, the received one still there', async () => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([
        { ...onChain, stage: 'returning', refundTxId, refundState: 'broadcast' },
      ])
      const tree = await render()
      await tapRow(tree, i18n.t('deposits.returning'))

      const shown = depositSheet(tree).findAllByType(Text).map(n => String(n.props.children))
      expect(shown).toContain(i18n.t('history.detail.txid'))
      expect(shown).toContain(i18n.t('history.detail.refundTxid'))
      await pressLabelled(tree, i18n.t('history.detail.viewExplorer'))
      expect(Linking.openURL).toHaveBeenCalledWith(`https://mempool.space/tx/${refundTxId}`)
    })

    test.each([
      ['signed and not seen yet', {}],
      ['refused by the network', { refundError: 'min relay fee not met' }],
    ])('a return %s keeps the explorer on the received transaction', async (_case, over) => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([
        { ...onChain, stage: 'returning', refundTxId, refundState: 'pending', ...over },
      ])
      const tree = await render()
      const status =
        'refundError' in over ? i18n.t('deposits.refundStalled') : i18n.t('deposits.returning')
      await tapRow(tree, status)

      const shown = depositSheet(tree).findAllByType(Text).map(n => String(n.props.children))
      expect(shown).toContain(status)
      expect(shown).toContain(i18n.t('history.detail.refundTxid'))
      await pressLabelled(tree, i18n.t('history.detail.viewExplorer'))
      expect(Linking.openURL).toHaveBeenCalledWith(`https://mempool.space/tx/${txid}`)
    })

    test('the explorer the person chose is the one the deposit opens in', async () => {
      const chosen = jest.spyOn(settings, 'loadTxExplorers').mockResolvedValue({
        custom: [{ id: 'mine', url: 'http://node.local:3006/' }],
        selectedId: 'mine',
      })
      try {
        jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
        const tree = await render()
        await tapRow(tree, 'Arriving')
        await drain()

        await pressLabelled(tree, i18n.t('history.detail.viewExplorer'))
        expect(Linking.openURL).toHaveBeenCalledWith(`http://node.local:3006/tx/${txid}`)
      } finally {
        chosen.mockRestore()
      }
    })

    test('a deposit the next read no longer lists takes its detail down', async () => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
      const tree = await render()
      await tapRow(tree, 'Arriving')
      expect(depositSheet(tree).props.deposits).toEqual([onChain])

      // A deposit claimed meanwhile is a payment now, and the detail must not call it on its way.
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([])
      await ReactTestRenderer.act(async () => mockSynced.fire?.())
      await drain()

      expect(depositSheet(tree).props.deposits).toEqual([])
    })

    // The first payment swaps the empty screen for the list under the open sheet.
    test('a first payment landing under the open detail leaves the sheet as it was', async () => {
      jest.mocked(sparkListHistory).mockResolvedValue([])
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
      const tree = await render()
      await tapRow(tree, 'Arriving')
      const copyRow = depositSheet(tree)
        .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.label === 'string')
        .find(n => n.props.label.startsWith(i18n.t('history.detail.txid')))
      await ReactTestRenderer.act(async () => copyRow?.props.onPress())
      const shown = () => depositSheet(tree).findAllByType(Text).map(n => String(n.props.children))
      expect(shown()).toContain(i18n.t('history.detail.copied'))

      jest.mocked(sparkListHistory).mockResolvedValue([btcReceive])
      await ReactTestRenderer.act(async () => mockSynced.fire?.())
      await drain()

      expect(tree.root.findAllByType(DirectionBadge).length).toBeGreaterThan(0)
      expect(depositSheet(tree).props.deposits).toEqual([onChain])
      expect(shown()).toContain(i18n.t('history.detail.copied'))
    })

    test.each([
      [
        'a read that failed',
        () => jest.mocked(sparkListUnclaimedDeposits).mockRejectedValueOnce(new Error('offline')),
      ],
      [
        'a read that answered without it',
        () => jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([]),
      ],
    ])('after %s, a read listing it again leaves the detail closed', async (_case, drop) => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
      const tree = await render()
      await tapRow(tree, 'Arriving')

      drop()
      await ReactTestRenderer.act(async () => mockSynced.fire?.())
      await drain()
      expect(depositSheet(tree).props.deposits).toEqual([])

      await ReactTestRenderer.act(async () => mockSynced.fire?.())
      await drain()
      expect(texts(tree)).toContain('Arriving')
      expect(depositSheet(tree).props.deposits).toEqual([])
    })

    test('a wallet switch closes the detail, and the next read leaves it closed', async () => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
      const tree = await render()
      await tapRow(tree, 'Arriving')

      await ReactTestRenderer.act(async () => mockSwitch.fire?.())
      await drain()
      await ReactTestRenderer.act(async () => mockSynced.fire?.())
      await drain()

      expect(texts(tree)).toContain('Arriving')
      expect(depositSheet(tree).props.deposits).toEqual([])
    })
  })

  describe('a return the network refused', () => {
    const returning: SparkDeposit = {
      ...arriving,
      stage: 'returning',
      refundTxId: 'r1',
      refundState: 'pending',
    }
    const refused: SparkDeposit = { ...returning, refundError: 'min relay fee not met' }
    const retry = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAllByType(GradientButton).find(b => b.props.label === i18n.t('deposits.refundRetry'))

    test.each([
      ['above the rows', [btcReceive]],
      ['with no rows', []],
    ])('%s says so and opens the way out, as Home does', async (_case, items) => {
      jest.mocked(sparkListHistory).mockResolvedValue(items)
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([refused])
      const tree = await render()

      expect(texts(tree)).toContain(i18n.t('deposits.refundStalled'))
      expect(texts(tree)).not.toContain(i18n.t('deposits.returning'))

      await ReactTestRenderer.act(async () => retry(tree)?.props.onPress())
      expect(mockNavigate).toHaveBeenCalledWith('RefundDeposit', { txid: 'tx', vout: 0 })
    })

    test.each([
      ['running', {}],
      ['accepted', { refundState: 'broadcast' as const }],
    ])('one %s reads in progress and offers nothing', async (_case, over) => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([{ ...returning, ...over }])
      const tree = await render()

      expect(texts(tree)).toContain(i18n.t('deposits.returning'))
      expect(retry(tree)).toBeUndefined()
    })
  })

  test('an empty history with pending money never says there is nothing', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([])
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([arriving])
    const tree = await render()

    expect(texts(tree).join(' ')).toContain('Arriving')
    expect(texts(tree).join(' ')).not.toContain(i18n.t('history.empty'))
  })

  test('the rows of an empty history carry the mark of a stale connection', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([])
    jest.mocked(sparkSyncState).mockReturnValue('stale')
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([arriving])
    const tree = await render()

    expect(texts(tree).join(' ')).toContain('Arriving')
    expect(texts(tree).join(' ')).toContain(i18n.t('home.notUpdated'))
  })

  test('a deposit read that fails takes the block away and leaves the list standing', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockRejectedValue(new Error('offline'))
    const tree = await render()

    expect(texts(tree).join(' ')).not.toContain('Arriving')
    expect(tree.root.findAllByType(DirectionBadge).length).toBeGreaterThan(0)
  })

  test('the list does not wait for a deposit read that never answers', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockReturnValue(hung())
    const tree = await render()

    expect(tree.root.findAllByType(DirectionBadge).length).toBeGreaterThan(0)
  })
})
