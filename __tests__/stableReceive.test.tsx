import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Dimensions, StyleSheet, Text } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import Clipboard from '@react-native-clipboard/clipboard'
import i18n from '../src/i18n'
import { ReceiveSpark } from '../src/screens/ReceiveSpark'
import { StableReceivePanel } from '../src/components/StableReceivePanel'
import { sparkListReceiveRoutes, sparkReceiveStable } from '../src/wallet/spark'
import { loadLastReceiveRoute, saveLastReceiveRoute } from '../src/wallet/settings'
import { AmountSheet } from '../src/components/AmountSheet'
import { AssetPickerSheet } from '../src/components/AssetPickerSheet'
import { markedInOpenPicker } from './support/pickerMark'
import { AssetIcon } from '../src/components/AssetIcon'
import { FigureRow } from '../src/components/FigureRow'
import { Txt } from '../src/components/Txt'
import { figuresHeldOut, figuresIn, hostChildren, hostParent, textOf } from './support/figureFit'
import { SegmentedControl } from '../src/components/SegmentedControl'
import { USDB } from '../src/wallet/tokens'
import { formatSats } from '../src/wallet/amount'
import { toBaseUnitsExact } from '../src/wallet/sparkConvert'

let mockDollarMode = false
jest.mock('../src/wallet/dollarMode', () => ({
  useDollarMode: () => mockDollarMode,
  useAccent: () => {
    const theme = require('../src/theme')
    return { accent: theme.colors.primary, gradient: theme.gradients.primary }
  },
}))
jest.mock('../src/wallet/spark', () => ({
  sparkReceive: jest.fn(async () => ({ destination: 'spark1me', feeSat: 0 })),
  sparkGetFiatRates: jest.fn(async () => ({})),
  sparkEnsureLnAddress: jest.fn(async () => null),
  sparkGetWalletInfo: jest.fn(async () => ({ sync: 'synced', balanceSat: 0, tokens: [] })),
  sparkListReceiveRoutes: jest.fn(),
  sparkReceiveStable: jest.fn(),
}))
jest.mock('../src/wallet/settings', () => ({
  loadDisplayCurrency: jest.fn(async () => null),
  loadLastReceiveRoute: jest.fn(async () => null),
  saveLastReceiveRoute: jest.fn(async () => undefined),
}))
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ setOptions: jest.fn() }),
  useRoute: () => ({ params: {} }),
}))

// Shaped like sparkListReceiveRoutes returns them, with the common network first.
// Bounds in the coin's base units, a dollar floor and on Tron a ceiling of ten thousand.
const TRON = {
  id: 'receive|tron|USDT|TR7|0',
  chain: 'tron',
  asset: 'USDT',
  decimals: 6,
  landing: 'btc' as const,
  min: 1_000_000n,
  max: 10_000_000_000n,
}
const BASE = {
  id: 'receive|base|USDC|0xb|0',
  chain: 'base',
  asset: 'USDC',
  decimals: 6,
  landing: 'btc' as const,
  min: 1_000_000n,
}
const ETH_USDT = { ...TRON, id: 'receive|ethereum|USDT|0xdac|0', chain: 'ethereum' }
const ETH_USDC = { ...BASE, id: 'receive|ethereum|USDC|0xa0b|0', chain: 'ethereum' }

type Item = { assetId: string; iconId?: string; ticker: string; name: string }
// The two pickers are told apart by title, since both are AssetPickerSheet.
function picker(tree: ReactTestRenderer.ReactTestRenderer, title: string) {
  const sheet = tree.root.findAllByType(AssetPickerSheet).find(n => n.props.title === title)
  if (!sheet) {
    throw new Error(`no picker titled ${title}`)
  }
  return sheet
}

// An EVM quote carries the wallet URI in the QR, and its address is what an exchange form accepts.
const quote = (over: object = {}) => ({
  qr: 'ethereum:0xusdc@8453/transfer?address=0xdep&uint256=50210000',
  address: '0xdep',
  sendAmount: '50.21',
  chain: 'base',
  asset: 'USDC',
  landing: 'btc' as const,
  receiveAmount: 52_000,
  expiresAtMs: Date.now() + 120_000,
  ...over,
})

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
  }
}

let mounted: ReactTestRenderer.ReactTestRenderer | null = null
afterEach(() => {
  ReactTestRenderer.act(() => {
    mounted?.unmount()
  })
  mounted = null
})

// The dollar side opens on USDB, so a cross-chain coin is chosen after it.
async function openStable(
  coin: 'USDT' | 'USDC' = 'USDT',
  heldAtPress?: () => Promise<boolean>,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ReceiveSpark heldAtPress={heldAtPress} />)
  })
  mounted = tree
  await flush()
  await press(tree, 'Stablecoins')
  await chooseCoin(tree, coin)
  return tree
}

// The coin is picked the way the Bitcoin side picks an asset, from its row and then the list.
async function chooseCoin(tree: ReactTestRenderer.ReactTestRenderer, coin: string): Promise<void> {
  const row = tree.root.find(
    n => typeof n.props.onPress === 'function' && String(n.props.accessibilityLabel).endsWith('Choose asset'),
  )
  await ReactTestRenderer.act(async () => row.props.onPress())
  await ReactTestRenderer.act(async () => picker(tree, 'Choose asset').props.onSelect(coin))
  await flush()
}

// The keypad opens only on a tap of the amount link, never by itself.
async function openAmount(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  const link = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => /^Amount in US[DT][CT]$/.test(String(txt.props.children))))
  if (!link) {
    throw new Error('no amount link')
  }
  await ReactTestRenderer.act(async () => {
    link.props.onPress()
  })
  await flush()
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap(node => {
      const children = node.props.children
      return (Array.isArray(children) ? children : [children]).filter(
        (child): child is string => typeof child === 'string',
      )
    })
    .join(' ')
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const target = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(
      n =>
        n.props.accessibilityLabel === label ||
        n.findAllByType(Text).some(txt => txt.props.children === label),
    )
  if (!target) {
    throw new Error(`not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
  })
  await flush()
}

// A double writes a figure under 1e-6 as "1e-7", which no keypad types, so it is written out in places.
function plain(value: number): string {
  const exponent = /^(\d)(?:\.(\d+))?e-(\d+)$/.exec(String(value))
  return exponent ? `0.${'0'.repeat(Number(exponent[3]) - 1)}${exponent[1]}${exponent[2] ?? ''}` : String(value)
}

// The sheet hands a route's amount on in base units, as its keypad would.
async function enterAmount(tree: ReactTestRenderer.ReactTestRenderer, value: number | string): Promise<void> {
  if (!tree.root.findAllByType(AmountSheet).some(node => node.props.visible)) {
    await openAmount(tree)
  }
  const sheet = tree.root.findAllByType(AmountSheet).find(node => node.props.visible)
  if (!sheet) {
    throw new Error('no amount sheet is open')
  }
  const base = toBaseUnitsExact(typeof value === 'string' ? value : plain(value), sheet.props.tokenBounds.decimals)
  if (base === null) {
    throw new Error(`the keypad cannot type ${value}`)
  }
  await ReactTestRenderer.act(async () => {
    sheet.props.onConfirm(base)
  })
  await flush()
}

beforeEach(() => {
  mockDollarMode = false
  jest.clearAllMocks()
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([TRON, BASE])
  jest.mocked(sparkReceiveStable).mockResolvedValue(quote())
  jest.mocked(loadLastReceiveRoute).mockResolvedValue(null)
})

// The SDK mints no address without an amount, but asking for it the moment the tab opens is an
// interruption, so the keypad waits for a tap, and the card says what it waits for.
test('USDT opens on its common network, and the keypad waits for a tap, within the network floor', async () => {
  const tree = await openStable()

  expect(sparkListReceiveRoutes).toHaveBeenCalledWith(false)
  const shown = texts(tree)
  expect(shown).toContain('Tron')
  expect(shown).toContain('Enter the amount to generate the payment address')
  expect(tree.root.findAllByType(AmountSheet).some(node => node.props.visible)).toBe(false)
  expect(sparkReceiveStable).not.toHaveBeenCalled()

  await openAmount(tree)
  const sheet = tree.root.findAllByType(AmountSheet).find(node => node.props.visible)
  // The route bounds what the payer sends, which fees make larger than what lands: the floor is
  // safe to apply to the typed amount, the ceiling is not.
  expect(sheet?.props).toMatchObject({
    unit: 'USDT',
    tokenBounds: { decimals: 6, min: 1_000_000n },
    allowDecimal: true,
    maxDecimals: 6,
  })
  expect(sheet?.props.tokenBounds.max).toBeUndefined()
  expect(sheet?.props.min).toBeUndefined()
  expect(sheet?.props.max).toBeUndefined()
})

// USDC on BSC has 18 places, past a double, so its floor reaches the keypad in base units: a figure
// a double would call equal to it is refused before any address is minted, and the floor drawn
// passes.
test('an 18-place network floor is held to its last base unit', async () => {
  const BSC = {
    id: 'receive|bsc|USDC|0x8ac|0',
    chain: 'bsc',
    asset: 'USDC',
    decimals: 18,
    landing: 'btc' as const,
    min: 5_000_000_000_000_000_001n,
  }
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BSC])
  const tree = await openStable('USDC')
  await openAmount(tree)
  expect(texts(tree)).toContain('Minimum 5.01 USDC')

  await press(tree, '5')
  await press(tree, 'Confirm')
  expect(sparkReceiveStable).not.toHaveBeenCalled()
  expect(texts(tree)).toContain('The minimum is 5.01 USDC')

  for (const key of '.01') {
    await press(tree, key)
  }
  await press(tree, 'Confirm')
  expect(sparkReceiveStable).toHaveBeenCalledWith(BSC.id, '5.01')
})

// A double carries about 15 significant digits and writes a small figure as "1e-7", so the figure
// quoted is taken from the base units the keypad hands on, never read back from a double.
describe('the amount quoted is the one typed, at 18 places', () => {
  const BSC = {
    id: 'receive|bsc|USDC|0x8ac|0',
    chain: 'bsc',
    asset: 'USDC',
    decimals: 18,
    landing: 'btc' as const,
  }

  test.each([
    ['one base unit past the floor, which a double reads as 5', 5_000_000_000_000_000_001n, '5.000000000000000001'],
    ['a figure a double writes in exponent form', 1n, '0.0000001'],
    ['a figure past what a double holds', 1n, '123456789.123456789123456789'],
  ])('%s', async (_case, min, typed) => {
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([{ ...BSC, min }])
    const tree = await openStable('USDC')
    await openAmount(tree)
    for (const key of typed) {
      await press(tree, key)
    }
    await press(tree, 'Confirm')

    expect(sparkReceiveStable).toHaveBeenCalledTimes(1)
    expect(sparkReceiveStable).toHaveBeenCalledWith(BSC.id, typed)
    // The keypad reopens on the figure quoted, which a double would have cut.
    const sheet = tree.root.findAllByType(AmountSheet).find(node => node.props.tokenBounds)
    expect(sheet?.props.initial).toBe(typed)
  })
})

test('a quote shows exactly what to send, where, and copies the bare address', async () => {
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BASE])
  const tree = await openStable('USDC')
  await enterAmount(tree, 50)

  expect(sparkReceiveStable).toHaveBeenCalledWith(BASE.id, '50')
  expect(tree.root.findByType(QRCode).props.value).toBe(quote().qr)
  const shown = texts(tree)
  expect(shown).toContain('Exact amount to send')
  expect(shown).toContain('50.21 USDC')
  // One 0x address exists on every EVM chain, and a coin sent on the wrong one may be lost.
  expect(shown).toContain('Send only USDC on the Base network')
  expect(shown).toContain('Single-use address, valid for this payment only')
  expect(shown).toContain('Converted and delivered by Flashnet')

  // A label replaces what a screen reader would read inside, so it names the address as well.
  await press(tree, '0xdep, Copy')
  // An exchange withdrawal form takes an address, not a wallet URI.
  expect(Clipboard.setString).toHaveBeenLastCalledWith('0xdep')
})

// An address quoted before an exit started never leaves the screen once the exit holds the wallet.
test.each([
  [true, 0],
  [false, 1],
])('Copy asks the exit again at the press (held %s)', async (held, copies) => {
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BASE])
  const asked = jest.fn(async () => held)
  const tree = await openStable('USDC', asked)
  await enterAmount(tree, 50)
  await press(tree, '0xdep, Copy')
  await flush()
  expect(asked).toHaveBeenCalled()
  expect(Clipboard.setString).toHaveBeenCalledTimes(copies)
})

// The amount line is a button, and a button label replaces its text for a screen reader.
test('the exact amount stays readable to a screen reader and copies on its own', async () => {
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BASE])
  const tree = await openStable('USDC')
  await enterAmount(tree, 50)

  const line = tree.root
    .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.accessibilityLabel === 'string')
    .find(n => n.props.accessibilityLabel.includes('Send exactly 50.21 USDC on Base'))
  expect(line).toBeDefined()
  await ReactTestRenderer.act(async () => {
    line?.props.onPress()
  })
  expect(Clipboard.setString).toHaveBeenLastCalledWith('50.21')
  // The hint under the address speaks for the address, which was not what got copied.
  expect(texts(tree)).not.toContain('Copied')
})

// The payer pastes the copied figure into another wallet, so only the drawn text takes the comma.
test('in Portuguese the amount to send reads a comma and still copies with a dot', async () => {
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BASE])
  const tree = await openStable('USDC')
  await enterAmount(tree, 25.5)
  await ReactTestRenderer.act(async () => {
    await i18n.changeLanguage('pt-BR')
  })
  try {
    expect(texts(tree)).toContain('50,21 USDC')
    // The typed amount on the edit link, next to the keypad that drew it with a comma.
    expect(texts(tree)).toContain('25,5 USDC')
    const line = tree.root
      .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.accessibilityLabel === 'string')
      .find(n => n.props.accessibilityLabel.includes('50,21 USDC'))
    expect(line).toBeDefined()
    await ReactTestRenderer.act(async () => {
      line?.props.onPress()
    })
    expect(Clipboard.setString).toHaveBeenLastCalledWith('50.21')
  } finally {
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('en-US')
    })
  }
})

test('what lands follows the dollar wallet', async () => {
  mockDollarMode = true
  jest.mocked(sparkReceiveStable).mockResolvedValue(quote({ landing: 'usdb', receiveAmount: 49.99 }))
  const tree = await openStable()
  await enterAmount(tree, 50)

  expect(sparkListReceiveRoutes).toHaveBeenCalledWith(true)
  expect(texts(tree)).toContain('49.99 USDB')
})

test('a bitcoin landing reads in sats', async () => {
  const tree = await openStable()
  await enterAmount(tree, 50)
  expect(texts(tree).replace(/\s/g, '')).toContain(`${formatSats(52_000)}sats`.replace(/\s/g, ''))
})

test('the sats word comes from the locale', async () => {
  const original = i18n.t('common.sats')
  i18n.addResource(i18n.language, 'translation', 'common.sats', 'sat-x')
  try {
    const tree = await openStable()
    await enterAmount(tree, 50)
    expect(texts(tree).replace(/\s/g, '')).toContain(`${formatSats(52_000)}sat-x`.replace(/\s/g, ''))
  } finally {
    i18n.addResource(i18n.language, 'translation', 'common.sats', original)
  }
})

// Each quote is a single-use address with a two-minute price, so none is ever reused.
test('an expired price offers an update, which quotes afresh', async () => {
  jest.mocked(sparkReceiveStable).mockResolvedValue(quote({ expiresAtMs: Date.now() - 1 }))
  const tree = await openStable()
  await enterAmount(tree, 50)

  expect(texts(tree)).toContain('Quote expired')
  // An expired address still takes money at an uncertain price, so it is not left up to be paid.
  expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
  expect(texts(tree)).not.toContain('Exact amount to send')
  await press(tree, 'Generate new quote')
  expect(sparkReceiveStable).toHaveBeenCalledTimes(2)
  expect(sparkReceiveStable).toHaveBeenLastCalledWith(TRON.id, '50')
})

test('the price flips to expired by itself when its time runs out', async () => {
  // The countdown's interval and the clock are faked from the start; setTimeout stays real so the
  // render can settle.
  jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] })
  try {
    jest.mocked(sparkReceiveStable).mockResolvedValue(quote({ expiresAtMs: Date.now() + 1500 }))
    const tree = await openStable()
    await enterAmount(tree, 50)
    expect(texts(tree)).toMatch(/Quote valid for 0:02/)

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(3000)
    })
    expect(texts(tree)).toContain('Quote expired')
  } finally {
    jest.useRealTimers()
  }
})

test('a network list that failed to load says so and loads again on request', async () => {
  jest.mocked(sparkListReceiveRoutes).mockRejectedValueOnce(new Error('provider unreachable'))
  const tree = await openStable()

  expect(texts(tree)).toContain('Could not generate')
  expect(texts(tree)).not.toContain('No network available')
  await press(tree, 'Try again')

  expect(sparkListReceiveRoutes).toHaveBeenCalledTimes(2)
  expect(texts(tree)).toContain('Tron')
})

test('a network that refuses the receive leaves the choice', async () => {
  jest.mocked(sparkReceiveStable).mockRejectedValue(
    Object.assign(new Error('SdkError.CrossChainRouteUnavailable'), {
      tag: 'CrossChainRouteUnavailable',
      inner: { reason: 'route_disabled', temporary: false },
    }),
  )
  const tree = await openStable()
  await enterAmount(tree, 50)

  expect(texts(tree)).toContain('Choose another one')
  expect(texts(tree)).toContain('Choose the network')
  // Tron is the only USDT network here, and it is not offered again.
  expect(picker(tree, 'Choose the network').props.items).toEqual([])
})

test('a live price says how long it holds', async () => {
  const tree = await openStable()
  await enterAmount(tree, 50)
  expect(texts(tree)).toContain('Quote valid for')
  expect(texts(tree)).toMatch(/\b[12]:\d\d\b/)
})

test('with no network available it says so instead of asking for an amount', async () => {
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([])
  const tree = await openStable()

  expect(texts(tree)).toContain('No network available at the moment')
  expect(tree.root.findAllByType(AmountSheet).some(node => node.props.visible)).toBe(false)
})

// A route for the other coin is no network for this one, and an empty picker would be a dead end.
test('a coin with no network of its own says so, while the other coin still shows its network', async () => {
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BASE])
  const tree = await openStable('USDT')
  expect(texts(tree)).toContain('No network available at the moment')

  await chooseCoin(tree, 'USDC')
  expect(texts(tree)).not.toContain('No network available at the moment')
  expect(texts(tree)).toContain('Base')
})

test('a busy network says so', async () => {
  jest
    .mocked(sparkReceiveStable)
    .mockRejectedValue(
      Object.assign(new Error('SdkError.CrossChainRouteUnavailable'), {
        tag: 'CrossChainRouteUnavailable',
        inner: { reason: 'service_unavailable', temporary: true },
      }),
    )
  const tree = await openStable()
  await enterAmount(tree, 50)

  expect(texts(tree)).toContain('This network is busy')
})

test('the last network used for a coin comes back', async () => {
  jest.mocked(loadLastReceiveRoute).mockResolvedValue(BASE.id)
  const tree = await openStable('USDC')
  expect(texts(tree)).toContain('Base')
})

test('choosing a network remembers it for the next receive', async () => {
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([TRON, ETH_USDT])
  const tree = await openStable()
  expect(texts(tree)).toContain('Tron')

  await ReactTestRenderer.act(async () => {
    picker(tree, 'Choose the network').props.onSelect(ETH_USDT.id)
  })
  await flush()

  expect(saveLastReceiveRoute).toHaveBeenLastCalledWith(ETH_USDT.id)
  expect(texts(tree)).toContain('Ethereum')
})

// The coin list opens on the coin the screen receives, USDB until another is picked.
test('the coin list marks the coin being received, then the one picked', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ReceiveSpark />)
  })
  mounted = tree
  await flush()
  await press(tree, 'Stablecoins')
  const coinRow = () =>
    tree.root.find(
      n => typeof n.props.onPress === 'function' && String(n.props.accessibilityLabel).endsWith('Choose asset'),
    )
  await ReactTestRenderer.act(async () => coinRow().props.onPress())
  expect(markedInOpenPicker(tree.root)).toEqual([USDB.identifier])

  await ReactTestRenderer.act(async () => picker(tree, 'Choose asset').props.onSelect('USDT'))
  await flush()
  await ReactTestRenderer.act(async () => coinRow().props.onPress())
  expect(markedInOpenPicker(tree.root)).toEqual(['USDT'])
})

// The network list opens on the network the payment address is minted on, and follows a new choice.
test('the network list marks the network the quote uses, then the one picked', async () => {
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([TRON, ETH_USDT])
  const tree = await openStable()
  await press(tree, 'Tron, Choose the network')
  expect(markedInOpenPicker(tree.root)).toEqual([TRON.id])

  await ReactTestRenderer.act(async () => picker(tree, 'Choose the network').props.onSelect(ETH_USDT.id))
  await flush()
  await press(tree, 'Ethereum, Choose the network')
  expect(markedInOpenPicker(tree.root)).toEqual([ETH_USDT.id])
  await enterAmount(tree, 50)
  expect(sparkReceiveStable).toHaveBeenLastCalledWith(ETH_USDT.id, '50')
})

// The sender picks a coin and then its network, the way an exchange withdrawal form asks.
test('the coin comes first, and the networks listed are that coin networks, each with its mark', async () => {
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([TRON, ETH_USDT, BASE, ETH_USDC])
  const tree = await openStable()

  // The coin is an asset row and a list, as on the Bitcoin side, each coin with its mark and name.
  const coins: Item[] = picker(tree, 'Choose asset').props.items
  expect(coins.map(i => [i.ticker, i.iconId ?? i.assetId, i.name])).toEqual([
    ['USDB', USDB.identifier, 'Bitcoin USD'],
    ['USDT', 'coin:USDT', 'Tether USD'],
    ['USDC', 'coin:USDC', 'USD Coin'],
  ])
  const row = tree.root.find(
    n => typeof n.props.onPress === 'function' && String(n.props.accessibilityLabel).endsWith('Choose asset'),
  )
  expect(row.props.accessibilityLabel).toBe('USDT, Choose asset')
  // The coin is chosen from the asset list, so the only segmented control is Bitcoin/Stablecoins.
  expect(
    tree.root
      .findAllByType(SegmentedControl)
      .some(n => n.props.options.some((o: { value: string }) => o.value === 'USDT')),
  ).toBe(false)

  const networks: Item[] = picker(tree, 'Choose the network').props.items
  expect(networks.map(i => [i.ticker, i.iconId])).toEqual([
    ['Tron', 'chain:tron'],
    ['Ethereum', 'chain:ethereum'],
  ])
  // A short list reads faster without a search field.
  expect(picker(tree, 'Choose the network').props.searchable).toBe(false)
  const icons = tree.root.findAllByType(AssetIcon).map(n => n.props.assetId)
  expect(icons).toEqual(expect.arrayContaining(['chain:tron']))
})

test('switching coin keeps the network when that coin is on it', async () => {
  jest.mocked(sparkListReceiveRoutes).mockResolvedValue([TRON, ETH_USDT, BASE, ETH_USDC])
  jest.mocked(loadLastReceiveRoute).mockResolvedValue(ETH_USDT.id)
  const tree = await openStable()
  await enterAmount(tree, 50)
  expect(sparkReceiveStable).toHaveBeenLastCalledWith(ETH_USDT.id, '50')

  await chooseCoin(tree, 'USDC')

  // Ethereum, not Base, although Base is the first USDC network in the list; the amount carries over.
  expect(sparkReceiveStable).toHaveBeenLastCalledWith(ETH_USDC.id, '50')
})

// A label and the figure it names share one row by one rule, so a long label at the largest text
// size cannot squeeze the amount to send beside it to a few points.
describe('the quote rows at large text', () => {
  const start = Dimensions.get('window')
  const setScale = (fontScale: number) => {
    const window = { ...start, fontScale }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  }
  afterEach(() => setScale(start.fontScale))

  const labels = ['Exact amount to send', 'You receive', 'Quote valid for']

  test('the amount to send, what lands and the time left go through FigureRow', async () => {
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BASE])
    const tree = await openStable('USDC')
    await enterAmount(tree, 50)
    const rows = tree.root.findAllByType(FigureRow)
    expect(rows.map(row => row.props.label)).toEqual(labels)
    const quoteFigures = rows.slice(0, 2).flatMap(row => figuresIn(row))
    expect(quoteFigures.map(textOf)).toEqual(['50.21 USDC', expect.stringMatching(/^≈ /)])
    expect(figuresHeldOut(rows[0]).concat(figuresHeldOut(rows[1]))).toEqual([])
  })

  test('at the largest text size each figure goes under its label', async () => {
    setScale(3.571)
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BASE])
    const tree = await openStable('USDC')
    await enterAmount(tree, 50)
    const rows = tree.root.findAllByType(FigureRow)
    expect(rows.map(row => row.props.label)).toEqual(labels)
    for (const row of rows.slice(0, 2)) {
      const [figure] = figuresIn(row)
      let box = hostParent(figure)
      while (box && !hostChildren(box).some(child => child.findAllByType(Txt).some(t => t.props.children === row.props.label))) {
        box = hostParent(box)
      }
      expect(StyleSheet.flatten(box?.props.style).flexDirection).toBe('column')
    }
  })
})

test('the test keypad types a figure a double writes in exponent form', () => {
  expect(plain(1e-7)).toBe('0.0000001')
  expect(plain(1.5e-7)).toBe('0.00000015')
  expect(plain(50)).toBe('50')
})

// A figure typed for one network and carried to another is checked there before any address is asked
// for, since the SDK refuses one past the coin's places or under its floor with a failure that names
// neither, and the keypad, which would have said so, is closed.
describe('an amount carried to another route', () => {
  const BSC_USDC = { ...BASE, id: 'receive|bsc|USDC|0x8ac|0', chain: 'bsc', decimals: 18, min: 1n }
  const HIGH_USDT = { ...ETH_USDT, min: 20_000_000n }
  const HIGH_USDC = { ...BASE, min: 20_000_000n }

  async function chooseNetwork(tree: ReactTestRenderer.ReactTestRenderer, id: string): Promise<void> {
    await ReactTestRenderer.act(async () => {
      picker(tree, 'Choose the network').props.onSelect(id)
    })
    await flush()
  }

  const openSheet = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(AmountSheet).find(node => node.props.visible)

  // With a figure set, the link that opens the keypad reads the figure.
  async function reopenAmount(
    tree: ReactTestRenderer.ReactTestRenderer,
    shown: string,
  ): Promise<void> {
    const link = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(txt => txt.props.children === shown))
    if (!link) {
      throw new Error(`no link reading ${shown}`)
    }
    await ReactTestRenderer.act(async () => {
      link.props.onPress()
    })
    await flush()
  }

  test('past the places of the new network, says so and asks for nothing', async () => {
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BSC_USDC, ETH_USDC])
    jest.mocked(loadLastReceiveRoute).mockResolvedValue(BSC_USDC.id)
    const tree = await openStable('USDC')
    await enterAmount(tree, '1.0000001')
    expect(sparkReceiveStable).toHaveBeenLastCalledWith(BSC_USDC.id, '1.0000001')

    await chooseNetwork(tree, ETH_USDC.id)

    expect(sparkReceiveStable).not.toHaveBeenCalledWith(ETH_USDC.id, expect.anything())
    expect(texts(tree)).toContain(i18n.t('receive.routePlaces'))
    expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
  })

  // The figure cannot be confirmed on the new network, and the line above asks for a new one.
  test('past the places of the new network, the keypad opens empty', async () => {
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BSC_USDC, ETH_USDC])
    jest.mocked(loadLastReceiveRoute).mockResolvedValue(BSC_USDC.id)
    const tree = await openStable('USDC')
    await enterAmount(tree, '1.0000001')
    await chooseNetwork(tree, ETH_USDC.id)

    await reopenAmount(tree, '1.0000001 USDC')

    expect(openSheet(tree)?.props.initial).toBe('')
  })

  test('under the floor of the new network, the keypad opens on the figure', async () => {
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([TRON, HIGH_USDT])
    const tree = await openStable()
    await enterAmount(tree, 5)
    await chooseNetwork(tree, HIGH_USDT.id)

    await reopenAmount(tree, '5 USDT')

    expect(openSheet(tree)?.props.initial).toBe('5')
  })

  test('within the places of the new network, quotes there', async () => {
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BSC_USDC, ETH_USDC])
    jest.mocked(loadLastReceiveRoute).mockResolvedValue(BSC_USDC.id)
    const tree = await openStable('USDC')
    await enterAmount(tree, '1.000001')

    await chooseNetwork(tree, ETH_USDC.id)

    expect(sparkReceiveStable).toHaveBeenLastCalledWith(ETH_USDC.id, '1.000001')
  })

  test('under the floor of the new network, names it as the keypad does', async () => {
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([TRON, HIGH_USDT])
    const tree = await openStable()
    await enterAmount(tree, 5)
    expect(sparkReceiveStable).toHaveBeenLastCalledWith(TRON.id, '5')

    await chooseNetwork(tree, HIGH_USDT.id)

    expect(sparkReceiveStable).not.toHaveBeenCalledWith(HIGH_USDT.id, expect.anything())
    expect(texts(tree)).toContain(i18n.t('receive.belowMin', { min: '20 USDT' }))
  })

  // A floor the keypad cannot type is drawn at two places rounded up, so typed back it passes.
  test('a floor past two places is named rounded up', async () => {
    const ODD_USDC = { ...ETH_USDC, id: 'receive|eth|USDC|odd|0', min: 1_234_567n }
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([BSC_USDC, ODD_USDC])
    jest.mocked(loadLastReceiveRoute).mockResolvedValue(BSC_USDC.id)
    const tree = await openStable('USDC')
    await enterAmount(tree, 1)

    await chooseNetwork(tree, ODD_USDC.id)

    expect(texts(tree)).toContain(i18n.t('receive.belowMin', { min: '1.24 USDC' }))
  })

  test('the floor itself passes on the new network', async () => {
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([TRON, HIGH_USDT])
    const tree = await openStable()
    await enterAmount(tree, 20)

    await chooseNetwork(tree, HIGH_USDT.id)

    expect(sparkReceiveStable).toHaveBeenLastCalledWith(HIGH_USDT.id, '20')
  })

  test('under the floor of the network a new coin lands on, says so and asks for nothing', async () => {
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([TRON, HIGH_USDC])
    const tree = await openStable()
    await enterAmount(tree, 5)

    await chooseCoin(tree, 'USDC')

    expect(sparkReceiveStable).not.toHaveBeenCalledWith(HIGH_USDC.id, expect.anything())
    expect(texts(tree)).toContain(i18n.t('receive.belowMin', { min: '20 USDC' }))
  })

  // The landed quote's address is for the previous network, so the share is taken back with the QR.
  test('a landed quote on the old network is taken from the share by the refusal', async () => {
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([TRON, HIGH_USDT])
    const onShareable = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<StableReceivePanel coin="USDT" onShareable={onShareable} />)
    })
    mounted = tree
    await flush()
    await enterAmount(tree, 5)
    expect(onShareable).toHaveBeenLastCalledWith(expect.stringContaining(quote().address))

    await chooseNetwork(tree, HIGH_USDT.id)

    expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
    expect(onShareable).toHaveBeenLastCalledWith(null)
  })

  // Its address is for the previous network, so neither the screen nor the share may offer it.
  test('a quote asked on the previous network that lands after the refusal is neither shown nor shared', async () => {
    jest.mocked(sparkListReceiveRoutes).mockResolvedValue([TRON, HIGH_USDT])
    let answer: (value: ReturnType<typeof quote>) => void = () => undefined
    jest.mocked(sparkReceiveStable).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    const onShareable = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<StableReceivePanel coin="USDT" onShareable={onShareable} />)
    })
    mounted = tree
    await flush()
    await enterAmount(tree, 5)

    await chooseNetwork(tree, HIGH_USDT.id)
    await ReactTestRenderer.act(async () => answer(quote()))
    await flush()

    expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
    expect(texts(tree)).toContain(i18n.t('receive.belowMin', { min: '20 USDT' }))
    expect(onShareable).toHaveBeenLastCalledWith(null)
    expect(onShareable).not.toHaveBeenCalledWith(expect.stringContaining(quote().address))
  })
})
