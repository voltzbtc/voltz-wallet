import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Keyboard, Text, TextInput } from 'react-native'
import i18n from '../src/i18n'
import Clipboard from '@react-native-clipboard/clipboard'
import { SendSpark } from '../src/screens/SendSpark'
import { AmountSheet } from '../src/components/AmountSheet'
import { AssetPickerSheet } from '../src/components/AssetPickerSheet'
import { ChunkedAddress } from '../src/components/ChunkedAddress'
import { GradientButton } from '../src/components/GradientButton'
import { ReceivedOverlay } from '../src/components/ReceivedOverlay'
import { SaveContactSheet } from '../src/components/SaveContactSheet'
import { Skeleton } from '../src/components/Skeleton'
import { Touch } from '../src/components/Touch'
import {
  sparkAddContact,
  sparkClassify,
  sparkConfirmLnurlPay,
  sparkConfirmSend,
  sparkFollowSend,
  sparkInspectDestination,
  sparkListContacts,
  sparkParseLnurlPay,
  sparkPrepareLnurlPay,
  sparkPrepareSend,
  sparkSyncState,
  type BalanceSync,
  type SparkContact,
  type SparkDestinationInfo,
  type SparkDestinationKind,
  type SparkLnurlPay,
  type SparkSendQuote,
} from '../src/wallet/spark'

type RouteParams = { destination?: string; contactName?: string; picked?: number }

let mockRouteParams: RouteParams = {}
const mockGoBack = jest.fn()
const mockWalletChange = new Set<() => void>()
const mockFocus = new Set<() => void>()

jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useDollarMode: () => false,
    useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }),
  }
})
jest.mock('../src/wallet/wallet', () => ({
  onActiveWalletChanged: (cb: () => void) => {
    mockWalletChange.add(cb)
    return () => mockWalletChange.delete(cb)
  },
}))
jest.mock('../src/wallet/spark', () => ({
  // The send reads the signing wallet's exit plan by the connected wallet's id.
  sparkConnectedWalletId: () => 'w_test',
  onSparkConnected: () => () => undefined,
  onSparkSynced: () => () => undefined,
  sparkSyncWaitLeftMs: () => 0,
  sparkSyncState: jest.fn(() => 'synced'),
  sparkClassify: jest.fn(),
  sparkListContacts: jest.fn(),
  sparkAddContact: jest.fn(),
  sparkInspectDestination: jest.fn(),
  sparkPrepareSend: jest.fn(),
  sparkPrepareCrossChainSend: jest.fn(),
  sparkDiscardSendQuote: jest.fn(),
  sparkConfirmSend: jest.fn(),
  // A send takes no key unless a test says so, which is what the token, conversion and cross-chain sends answer.
  sparkSendTakesKey: jest.fn(() => false),
  sparkConfirmSendHeld: jest.fn(),
  sparkRetryHeldSend: jest.fn(),
  sparkDropHeldSend: jest.fn(),
  sparkParseLnurlPay: jest.fn(),
  sparkPrepareLnurlPay: jest.fn(),
  sparkConfirmLnurlPay: jest.fn(),
  sparkFollowSend: jest.fn(),
  sparkSentRail: jest.fn(() => undefined),
  sparkGetWalletInfo: jest.fn(async () => ({ sync: 'synced', balanceSat: 500_000, tokens: [] })),
  sparkGetFiatRates: jest.fn(async () => ({})),
  sparkGetStableBalance: jest.fn(async () => false),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))
jest.mock('../src/wallet/nfc', () => ({
  nfcState: jest.fn(async () => 'unsupported'),
  openNfcSettings: jest.fn(async () => true),
  readNfcDestination: jest.fn(),
  cancelNfcRead: jest.fn(),
}))
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) =>
    require('react').useEffect(() => {
      mockFocus.add(callback)
      callback()
    }, [callback]),
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: jest.fn(),
    replace: jest.fn(),
    setOptions: jest.fn(),
    setParams: (params: RouteParams) => {
      mockRouteParams = params
      mockRerender()
    },
  }),
  useRoute: () => ({ params: mockRouteParams }),
  usePreventRemove: () => undefined,
}))

// Stands for react-navigation rendering the screen again with the route's new params.
let mockRerender: () => void = () => undefined

const MARIA: SparkContact = { id: 'c1', name: 'Mária Souza', address: 'maria@usevoltz.app' }
const ZE: SparkContact = { id: 'c2', name: 'Zé', address: 'ze@example.com' }
const LNURL: SparkLnurlPay = {
  handle: 'lnurl-1',
  minSat: 1,
  maxSat: 100_000,
  commentAllowed: 0,
  payee: 'maria@usevoltz.app',
}
const QUOTE: SparkSendQuote = { handle: 'h1', amount: 1000, fee: 5 }

const classify = jest.mocked(sparkClassify)
const inspect = jest.mocked(sparkInspectDestination)
const syncState = jest.mocked(sparkSyncState)
const list = jest.mocked(sparkListContacts)

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SendSpark />)
  })
  mockRerender = () => tree.update(<SendSpark />)
  await settle()
  return tree
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

const field = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAllByType(TextInput)[0]

async function write(tree: ReactTestRenderer.ReactTestRenderer, text: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    field(tree).props.onChangeText(text)
  })
}

// The pause that ends a run of typing, and the answers that follow it.
async function pause(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(400)
  })
  await settle()
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const button = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!button) {
    throw new Error(`no button named ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    button.props.onPress()
  })
  await settle()
}

const suggested = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
  texts(tree).filter(text => [MARIA.name, ZE.name].includes(text))

// Text no destination at all, said as Scan and errors.ts say it.
const refusal = i18n.t('errors.invalidInput')
// An address its own server denied, said as Contacts says it.
const notFound = i18n.t('contacts.addressNotFound')
const offline = i18n.t('errors.offline')
const connecting = i18n.t('send.stillConnecting')
// Whether any line calls the destination wrong.
const calledWrong = (tree: ReactTestRenderer.ReactTestRenderer) =>
  texts(tree).some(line => line === refusal || line === notFound || line === i18n.t('send.unsupported'))
const realFetch = global.fetch
const fetching = jest.fn()
const noNetwork = () => new TypeError('Network request failed')

function deferred<T>(): { promise: Promise<T>; answer: (value: T) => void } {
  let answer!: (value: T) => void
  const promise = new Promise<T>(resolve => (answer = resolve))
  return { promise, answer }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date'] })
  mockRouteParams = {}
  mockWalletChange.clear()
  mockFocus.clear()
  classify.mockReset()
  classify.mockResolvedValue('other')
  syncState.mockReturnValue('synced' as BalanceSync)
  list.mockReset()
  list.mockResolvedValue([])
  inspect.mockResolvedValue({ kind: 'bolt11' })
  jest.mocked(sparkPrepareSend).mockResolvedValue(QUOTE)
  jest.mocked(sparkParseLnurlPay).mockResolvedValue(LNURL)
  jest.mocked(sparkPrepareLnurlPay).mockResolvedValue(QUOTE)
  jest.mocked(Clipboard.getString).mockResolvedValue('')
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined)
  fetching.mockReset()
  fetching.mockResolvedValue({ status: 404 })
  global.fetch = fetching as unknown as typeof fetch
})

afterEach(() => {
  jest.useRealTimers()
  global.fetch = realFetch
})

describe('typing a destination', () => {
  test('the field stays the same one while a classification is out', async () => {
    classify.mockReturnValue(deferred<SparkDestinationKind>().promise)
    const tree = await render()
    const before = field(tree).instance

    await write(tree, 'lnbc1pasted')
    await pause()

    expect(classify).toHaveBeenCalledWith('lnbc1pasted')
    expect(field(tree).instance).toBe(before)
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
  })

  test('the field stays the same one while a typed prepare is out', async () => {
    classify.mockResolvedValue('bolt11')
    inspect.mockReturnValue(deferred<SparkDestinationInfo>().promise)
    const tree = await render()
    const before = field(tree).instance

    await write(tree, 'lnbc1pasted')
    await pause()

    expect(inspect).toHaveBeenCalledWith('lnbc1pasted')
    expect(field(tree).instance).toBe(before)
    // The field's own thin line, with no review drawn under a field that is still in use.
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(1)
  })

  test('a prepare from the Paste button still shows the review shape in place of the field', async () => {
    inspect.mockReturnValue(deferred<SparkDestinationInfo>().promise)
    const tree = await render()
    jest.mocked(Clipboard.getString).mockResolvedValue('lnbc1pasted')
    await press(tree, 'Paste')
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0)
  })

  test('a prepare of the older text never becomes a review of the newer one', async () => {
    classify.mockResolvedValue('bolt11')
    const first = deferred<SparkDestinationInfo>()
    inspect.mockReturnValueOnce(first.promise)
    const tree = await render()
    await write(tree, 'lnbc1old')
    await pause()
    expect(inspect).toHaveBeenCalledWith('lnbc1old')

    await write(tree, 'lnbc1old-and-more')
    await ReactTestRenderer.act(async () => first.answer({ kind: 'bolt11' }))
    await settle()

    expect(sparkPrepareSend).not.toHaveBeenCalled()
    expect(texts(tree)).not.toContain(i18n.t('send.confirm'))
    expect(field(tree).props.value).toBe('lnbc1old-and-more')
  })

  test('a quote of the older text never lands on the newer one', async () => {
    classify.mockResolvedValue('bolt11')
    const pending = deferred<SparkSendQuote>()
    jest.mocked(sparkPrepareSend).mockReturnValueOnce(pending.promise)
    const tree = await render()
    await write(tree, 'lnbc1old')
    await pause()
    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)

    await write(tree, 'x')
    await ReactTestRenderer.act(async () => pending.answer(QUOTE))
    await settle()

    expect(texts(tree)).not.toContain(i18n.t('send.confirm'))
    expect(field(tree).props.value).toBe('x')
  })

  test('nothing prepares for text the classification turned down', async () => {
    const tree = await render()
    await write(tree, 'ana')
    await pause()

    expect(classify).toHaveBeenCalledTimes(1)
    expect(inspect).not.toHaveBeenCalled()
  })

  test('a destination the classification takes prepares once', async () => {
    classify.mockResolvedValue('bolt11')
    const tree = await render()
    await write(tree, 'lnbc1pasted')
    await pause()

    expect(inspect).toHaveBeenCalledTimes(1)
    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)
  })

  test.each([
    'maria@',
    'maria@usevoltz',
    '@usevoltz.app',
    'ma ria@usevoltz.app',
    'bitcoin@usevoltz',
    'bitcoinx:bc1qaddr?label=shop@example.com',
    'pay bitcoin:bc1qaddr?label=shop@example.com',
  ])(
    '%s stays on the device',
    async text => {
      const tree = await render()
      await write(tree, text)
      await pause()

      expect(classify).not.toHaveBeenCalled()
      expect(texts(tree)).toContain(refusal)
    },
  )

  test('a whole lightning address is asked about', async () => {
    const tree = await render()
    await write(tree, 'maria@usevoltz.app')
    await pause()
    expect(classify).toHaveBeenCalledWith('maria@usevoltz.app')
  })

  // The SDK reads a bitcoin: URI, in any case, before any address and with no request, whatever its
  // query holds, so an @ in a label or a message is no address to hold back.
  test.each([
    'bitcoin:bc1qaddr?label=shop@example.com',
    'BitCoin:bc1qaddr?amount=0.00005&message=a@b@c',
    'bitcoin:bc1qaddr@example.com',
  ])('%s reaches the SDK typed, and pays as the same code scanned', async uri => {
    classify.mockResolvedValue('bitcoinAddress')
    inspect.mockResolvedValue({
      kind: 'bitcoinAddress',
      resolved: 'bc1qaddr',
      requestedAmount: 5000,
    })
    mockRouteParams = { destination: uri, picked: 1 }
    const scanned = await render()
    const scannedPay = [...jest.mocked(sparkPrepareSend).mock.calls]
    expect(scannedPay).toEqual([['bc1qaddr', 5000, undefined]])
    scanned.unmount()
    jest.mocked(sparkPrepareSend).mockClear()
    inspect.mockClear()
    mockRouteParams = {}

    const tree = await render()
    await write(tree, uri)
    await pause()

    expect(classify).toHaveBeenCalledWith(uri)
    expect(inspect).toHaveBeenCalledWith(uri)
    expect(jest.mocked(sparkPrepareSend).mock.calls).toEqual(scannedPay)
    expect(calledWrong(tree)).toBe(false)
    expect(fetching).not.toHaveBeenCalled()
  })

  test('an older classification answering late is dropped', async () => {
    const older = deferred<SparkDestinationKind>()
    classify.mockReturnValueOnce(older.promise).mockResolvedValue('other')
    const tree = await render()
    await write(tree, 'lnbc1old')
    await pause()
    await write(tree, 'lnbc1new')
    await pause()

    await ReactTestRenderer.act(async () => older.answer('bolt11'))
    await settle()

    expect(inspect).not.toHaveBeenCalled()
  })

  test('a paste while a classification is out wins over its answer', async () => {
    const older = deferred<SparkDestinationKind>()
    classify.mockReturnValueOnce(older.promise)
    const tree = await render()
    await write(tree, 'lnbc1typed')
    await pause()

    jest.mocked(Clipboard.getString).mockResolvedValue('lnbc1pasted')
    await press(tree, 'Paste')
    await ReactTestRenderer.act(async () => older.answer('bolt11'))
    await settle()

    expect(inspect).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledWith('lnbc1pasted')
  })

  test('clearing during a typed prepare leaves no review behind', async () => {
    classify.mockResolvedValue('bolt11')
    const pending = deferred<SparkDestinationInfo>()
    inspect.mockReturnValueOnce(pending.promise)
    const tree = await render()
    await write(tree, 'lnbc1typed')
    await pause()

    const clear = tree.root
      .findAllByType(Touch)
      .find(node => node.props.label === i18n.t('send.clear'))
    await ReactTestRenderer.act(async () => clear?.props.onPress())
    await ReactTestRenderer.act(async () => pending.answer({ kind: 'bolt11' }))
    await settle()

    expect(field(tree).props.value).toBe('')
    expect(sparkPrepareSend).not.toHaveBeenCalled()
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
  })

  test('text refused with no contact matching says so, with the field up', async () => {
    const tree = await render()
    await write(tree, 'ana')
    await pause()

    expect(texts(tree)).toContain(refusal)
    expect(field(tree).props.value).toBe('ana')
  })

  test('text refused with a contact matching shows the contact and no error', async () => {
    list.mockResolvedValue([MARIA])
    const tree = await render()
    await write(tree, 'mari')
    await pause()

    expect(calledWrong(tree)).toBe(false)
    expect(suggested(tree)).toEqual([MARIA.name])
  })

  test('the next keystroke takes the refusal away', async () => {
    const tree = await render()
    await write(tree, 'ana')
    await pause()
    await write(tree, 'anab')
    expect(calledWrong(tree)).toBe(false)
  })

  test.each([
    ['waiting', connecting, offline],
    ['stale', offline, connecting],
  ] as [BalanceSync, string, string][])(
    'on a %s connection a refusal speaks of the connection, not of the address',
    async (sync, said, notSaid) => {
      syncState.mockReturnValue(sync)
      const tree = await render()
      await write(tree, 'maria@usevoltz.app')
      await pause()

      expect(texts(tree)).toContain(said)
      expect(texts(tree)).not.toContain(notSaid)
      expect(calledWrong(tree)).toBe(false)
      expect(field(tree).props.value).toBe('maria@usevoltz.app')
    },
  )

  // Before the first sync even text that is no destination may only have been read too early.
  test('text refused before the first sync says the wallet is still connecting', async () => {
    syncState.mockReturnValue('waiting')
    const tree = await render()
    await write(tree, 'ana')
    await pause()

    expect(texts(tree)).toContain(connecting)
    expect(calledWrong(tree)).toBe(false)
  })

  // sparkSyncState stays synced through a network drop, so this is where a connection that synced
  // minutes ago meets airplane mode.
  describe('on a connection that synced before the network went', () => {
    test('a typed address is not called wrong', async () => {
      fetching.mockRejectedValue(noNetwork())
      const tree = await render()

      await write(tree, 'ana@usevoltz.app')
      await pause()

      expect(fetching).toHaveBeenCalledWith('https://usevoltz.app/.well-known/lnurlp/ana')
      expect(texts(tree)).toContain(offline)
      expect(calledWrong(tree)).toBe(false)
      expect(field(tree).props.value).toBe('ana@usevoltz.app')
    })

    test('a pasted address is not called wrong', async () => {
      inspect.mockResolvedValue({ kind: 'other' })
      fetching.mockRejectedValue(noNetwork())
      const tree = await render()
      jest.mocked(Clipboard.getString).mockResolvedValue('ana@usevoltz.app')

      await press(tree, 'Paste')

      expect(texts(tree)).toContain(offline)
      expect(calledWrong(tree)).toBe(false)
    })

    test('a server that errors says nothing of the address either', async () => {
      fetching.mockResolvedValue({ status: 503 })
      const tree = await render()

      await write(tree, 'ana@usevoltz.app')
      await pause()

      expect(texts(tree)).toContain(offline)
    })

    test('an LNURL whose server stayed silent speaks of the connection, with nothing to ask', async () => {
      classify.mockResolvedValue('unread')
      const tree = await render()

      await write(tree, 'lnurl1dp68gurn8ghj7')
      await pause()

      expect(texts(tree)).toContain(offline)
      expect(calledWrong(tree)).toBe(false)
      expect(fetching).not.toHaveBeenCalled()
    })

    test('a pasted LNURL too', async () => {
      inspect.mockResolvedValue({ kind: 'unread' })
      const tree = await render()
      jest.mocked(Clipboard.getString).mockResolvedValue('lnurl1dp68gurn8ghj7')

      await press(tree, 'Paste')

      expect(texts(tree)).toContain(offline)
      expect(fetching).not.toHaveBeenCalled()
    })
  })

  describe('with a server to ask', () => {
    test('an address its server denies is refused as Contacts refuses it, with the field up', async () => {
      const tree = await render()

      await write(tree, 'nobody@usevoltz.app')
      await pause()

      expect(texts(tree)).toContain(notFound)
      expect(texts(tree)).not.toContain(refusal)
      expect(texts(tree)).not.toContain(offline)
      expect(field(tree).props.value).toBe('nobody@usevoltz.app')
    })

    test('an address its server denies reads the same pasted', async () => {
      inspect.mockResolvedValue({ kind: 'other' })
      const tree = await render()
      jest.mocked(Clipboard.getString).mockResolvedValue('nobody@usevoltz.app')

      await press(tree, 'Paste')

      expect(texts(tree)).toContain(notFound)
      expect(texts(tree)).not.toContain(offline)
    })

    test('an address under the bitcoin sign is asked about, typed or pasted', async () => {
      fetching.mockRejectedValue(noNetwork())
      const tree = await render()

      await write(tree, '₿ana@usevoltz.app')
      await pause()

      expect(classify).toHaveBeenCalledWith('₿ana@usevoltz.app')
      expect(fetching).toHaveBeenCalledWith('https://usevoltz.app/.well-known/lnurlp/ana')
      expect(texts(tree)).toContain(offline)
    })

    test('a name in letters the app would not register still reaches the SDK', async () => {
      classify.mockResolvedValue('lightningAddress')
      const tree = await render()

      await write(tree, 'josé@usevoltz.app')
      await pause()

      expect(classify).toHaveBeenCalledWith('josé@usevoltz.app')
    })

    // Its refusal is the SDK's own reading, made with no request, so no host named in it is asked.
    test.each(['typed', 'pasted'])('a bitcoin: URI refused, %s, asks no host', async how => {
      const uri = 'bitcoin:bc1qbad@example.com'
      inspect.mockResolvedValue({ kind: 'other' })
      fetching.mockResolvedValue({ status: 200 })
      const tree = await render()

      if (how === 'typed') {
        await write(tree, uri)
        await pause()
        expect(classify).toHaveBeenCalledWith(uri)
      } else {
        jest.mocked(Clipboard.getString).mockResolvedValue(uri)
        await press(tree, 'Paste')
        expect(inspect).toHaveBeenCalledWith(uri)
      }

      expect(texts(tree)).toContain(refusal)
      expect(texts(tree)).not.toContain(offline)
      expect(fetching).not.toHaveBeenCalled()
    })

    test('text that is no address has no server, and is refused with nothing asked', async () => {
      const tree = await render()

      await write(tree, 'not a destination')
      await pause()

      expect(texts(tree)).toContain(refusal)
      expect(fetching).not.toHaveBeenCalled()
    })

    test('the skeleton stays while the server is out', async () => {
      fetching.mockReturnValue(deferred<{ status: number }>().promise)
      const tree = await render()

      await write(tree, 'ana@usevoltz.app')
      await pause()

      expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
      expect(calledWrong(tree)).toBe(false)
      expect(texts(tree)).not.toContain(offline)
    })

    test('an answer about text since changed says nothing', async () => {
      const answer = deferred<{ status: number }>()
      fetching.mockReturnValue(answer.promise)
      const tree = await render()
      await write(tree, 'ana@usevoltz.app')
      await pause()

      await write(tree, 'ana@usevoltz.ap')
      answer.answer({ status: 404 })
      await settle()

      expect(calledWrong(tree)).toBe(false)
    })

    test('an answer about a paste since replaced says nothing', async () => {
      inspect.mockResolvedValue({ kind: 'other' })
      const answer = deferred<{ status: number }>()
      fetching.mockReturnValue(answer.promise)
      const tree = await render()
      jest.mocked(Clipboard.getString).mockResolvedValue('ana@usevoltz.app')
      await press(tree, 'Paste')
      inspect.mockReturnValue(deferred<SparkDestinationInfo>().promise)
      mockRouteParams = { destination: 'lnbc1other', picked: 2 }
      await ReactTestRenderer.act(async () => mockRerender())
      await settle()

      answer.answer({ status: 404 })
      await settle()

      expect(calledWrong(tree)).toBe(false)
    })
  })

  test('Paste refused with no sync behind it speaks of the connection too', async () => {
    syncState.mockReturnValue('stale')
    inspect.mockResolvedValue({ kind: 'other' })
    const tree = await render()
    jest.mocked(Clipboard.getString).mockResolvedValue('maria@usevoltz.app')
    await press(tree, 'Paste')

    expect(texts(tree)).toContain(offline)
    expect(calledWrong(tree)).toBe(false)
  })

  test('the amount sheet takes the keyboard down, since it has a keypad of its own', async () => {
    classify.mockResolvedValue('lightningAddress')
    inspect.mockResolvedValue({ kind: 'lightningAddress' })
    const tree = await render()
    await write(tree, 'maria@usevoltz.app')
    expect(Keyboard.dismiss).not.toHaveBeenCalled()
    await pause()

    expect(tree.root.findByType(AmountSheet).props.visible).toBe(true)
    expect(Keyboard.dismiss).toHaveBeenCalledTimes(1)
  })

  test('the network picker takes the keyboard down as well', async () => {
    const route = {
      id: 'addr|base|USDC|orchestra',
      chain: 'base',
      asset: 'USDC',
      decimals: 6,
      provider: 'orchestra' as const,
      accepts: { btc: true, usdb: false },
    }
    classify.mockResolvedValue('crossChainAddress')
    inspect.mockResolvedValue({
      kind: 'crossChainAddress',
      routes: [route, { ...route, id: 'addr|arbitrum|USDC|orchestra', chain: 'arbitrum' }],
    })
    const tree = await render()
    await write(tree, '0xaddr')
    await pause()

    expect(tree.root.findAllByType(AssetPickerSheet).some(node => node.props.visible)).toBe(true)
    expect(Keyboard.dismiss).toHaveBeenCalled()
  })
})

describe('contacts under the field', () => {
  test('a name matches with neither its capital nor its accent', async () => {
    list.mockResolvedValue([MARIA, ZE])
    const tree = await render()
    await write(tree, 'maria')
    expect(suggested(tree)).toEqual([MARIA.name])
  })

  test('an address matches as well', async () => {
    list.mockResolvedValue([MARIA, ZE])
    const tree = await render()
    await write(tree, 'example.com')
    expect(suggested(tree)).toEqual([ZE.name])
  })

  test('a list read that failed leaves the field as it is', async () => {
    list.mockRejectedValue(new Error('no connection'))
    const tree = await render()
    await write(tree, 'maria')

    expect(suggested(tree)).toEqual([])
    expect(field(tree).props.value).toBe('maria')
  })

  describe('picking one', () => {
    const pickFrom = async (tree: ReactTestRenderer.ReactTestRenderer) => {
      await write(tree, 'mar')
      await press(tree, MARIA.name)
    }

    beforeEach(() => {
      list.mockResolvedValue([MARIA])
      inspect.mockResolvedValue({ kind: 'lightningAddress' })
    })

    test('puts the contact in place of the field, with one prepare', async () => {
      const tree = await render()
      await pickFrom(tree)
      await ReactTestRenderer.act(async () => {
        tree.root.findByType(AmountSheet).props.onClose()
      })

      expect(tree.root.findAllByType(TextInput).filter(i => i.props.multiline)).toHaveLength(0)
      expect(texts(tree)).toEqual(expect.arrayContaining([MARIA.name, MARIA.address]))
      expect(inspect).toHaveBeenCalledTimes(1)
      expect(inspect).toHaveBeenCalledWith(MARIA.address)
      expect(classify).not.toHaveBeenCalled()
    })

    test('the pause of the text it replaced prepares nothing more', async () => {
      const tree = await render()
      await pickFrom(tree)
      await pause()
      expect(inspect).toHaveBeenCalledTimes(1)
    })

    test('clearing goes back to an empty field with nothing of the contact', async () => {
      const tree = await render()
      await pickFrom(tree)
      await ReactTestRenderer.act(async () => {
        tree.root.findByType(AmountSheet).props.onClose()
      })
      const clear = tree.root
        .findAllByType(Touch)
        .find(node => node.props.label === i18n.t('send.clear'))
      await ReactTestRenderer.act(async () => clear?.props.onPress())
      await settle()

      expect(field(tree).props.value).toBe('')
      expect(texts(tree)).not.toContain(MARIA.name)
      expect(texts(tree)).not.toContain(i18n.t('send.confirm'))
    })

    test('the same contact picked twice prepares twice', async () => {
      const tree = await render()
      await pickFrom(tree)
      await ReactTestRenderer.act(async () => {
        tree.root.findByType(AmountSheet).props.onClose()
      })
      const clear = tree.root
        .findAllByType(Touch)
        .find(node => node.props.label === i18n.t('send.clear'))
      await ReactTestRenderer.act(async () => clear?.props.onPress())
      await settle()
      const later = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
      await pickFrom(tree)
      later.mockRestore()

      expect(inspect).toHaveBeenCalledTimes(2)
    })

    test('a wallet switch clears the contact, its list and the suggestions', async () => {
      const tree = await render()
      await pickFrom(tree)
      await ReactTestRenderer.act(async () => {
        tree.root.findByType(AmountSheet).props.onClose()
      })
      expect(texts(tree)).toContain(MARIA.name)

      await ReactTestRenderer.act(async () => mockWalletChange.forEach(change => change()))
      await settle()

      expect(field(tree).props.value).toBe('')
      await write(tree, 'mar')
      expect(suggested(tree)).toEqual([])
    })
  })

  test('a wallet switch takes the suggestions off a field still being typed in', async () => {
    list.mockResolvedValue([MARIA])
    const tree = await render()
    await write(tree, 'mar')
    expect(suggested(tree)).toEqual([MARIA.name])

    await ReactTestRenderer.act(async () => mockWalletChange.forEach(change => change()))
    expect(suggested(tree)).toEqual([])
    expect(field(tree).props.value).toBe('mar')
  })

  test('another focus reads the list again', async () => {
    const tree = await render()
    list.mockResolvedValue([MARIA])
    await ReactTestRenderer.act(async () => mockFocus.forEach(focus => focus()))
    await settle()
    await write(tree, 'mar')
    expect(suggested(tree)).toEqual([MARIA.name])
  })
})

describe('the review of a contact', () => {
  const reviewOf = async (params: RouteParams) => {
    mockRouteParams = params
    inspect.mockResolvedValue({ kind: 'lightningAddress' })
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(AmountSheet).props.onConfirm(1000)
    })
    await settle()
    return tree
  }
  const payTo = (name: string) => i18n.t('send.payTo', { name })

  test('shows the name and the address together', async () => {
    const tree = await reviewOf({ destination: MARIA.address, contactName: MARIA.name, picked: 1 })

    expect(texts(tree)).toContain(payTo(MARIA.name))
    expect(tree.root.findByType(ChunkedAddress).props.value).toBe(MARIA.address)
  })

  test('with no contact it keeps the plain line', async () => {
    const tree = await reviewOf({ destination: 'someone@usevoltz.app', picked: 1 })

    expect(texts(tree)).toContain(i18n.t('send.to'))
    expect(tree.root.findByType(ChunkedAddress).props.value).toBe('someone@usevoltz.app')
  })

  test('an address typed by hand finds its contact whatever its capitals', async () => {
    list.mockResolvedValue([MARIA])
    classify.mockResolvedValue('lightningAddress')
    inspect.mockResolvedValue({ kind: 'lightningAddress' })
    const tree = await render()
    await write(tree, 'Maria@Usevoltz.App')
    await pause()
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(AmountSheet).props.onConfirm(1000)
    })
    await settle()

    expect(texts(tree)).toContain(payTo(MARIA.name))
    expect(tree.root.findByType(ChunkedAddress).props.value).toBe('Maria@Usevoltz.App')
  })

  test.each(['ar', 'he', 'ur'])('in %s the name sits in its own direction', async code => {
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage(code)
    })
    const tree = await reviewOf({ destination: MARIA.address, contactName: 'Maria', picked: 1 })
    try {
      expect(texts(tree).join(' ')).toContain('⁨Maria⁩')
    } finally {
      await ReactTestRenderer.act(async () => {
        await i18n.changeLanguage('en-US')
      })
    }
  })
})

describe('after paying an address that is no contact yet', () => {
  const ADDRESS = 'ana.lima@usevoltz.app'
  const sheet = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAllByType(SaveContactSheet)
  const overlay = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(ReceivedOverlay)
  const added = jest.mocked(sparkAddContact)

  const paid = async (status: 'complete' | 'pending' = 'complete', address = ADDRESS) => {
    mockRouteParams = { destination: address, picked: 1 }
    inspect.mockResolvedValue({ kind: 'lightningAddress' })
    jest.mocked(sparkConfirmLnurlPay).mockResolvedValue({ status, successAction: undefined } as never)
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(AmountSheet).props.onConfirm(1000)
    })
    await settle()
    await press(tree, i18n.t('send.confirm'))
    return tree
  }
  const overlayEnds = async (tree: ReactTestRenderer.ReactTestRenderer) => {
    await ReactTestRenderer.act(async () => overlay(tree).props.onDone())
    await settle()
  }
  const offered = async () => {
    const tree = await paid()
    await overlayEnds(tree)
    return tree
  }

  beforeEach(() => {
    added.mockReset()
    added.mockResolvedValue({ id: 'c9', name: 'ana.lima', address: ADDRESS })
    jest.spyOn(global, 'fetch' as never)
  })

  test('the offer waits for the overlay, and takes its place', async () => {
    const tree = await paid()
    expect(sheet(tree)).toHaveLength(0)
    expect(mockGoBack).not.toHaveBeenCalled()

    await overlayEnds(tree)
    expect(sheet(tree)).toHaveLength(1)
    expect(tree.root.findAllByType(ReceivedOverlay)).toHaveLength(0)
    expect(mockGoBack).not.toHaveBeenCalled()
  })

  test('the name comes from before the @, editable, with the address on show', async () => {
    const tree = await offered()
    expect(tree.root.findByType(TextInput).props.value).toBe('ana.lima')
    expect(texts(tree)).toContain(ADDRESS)

    await ReactTestRenderer.act(async () => tree.root.findByType(TextInput).props.onChangeText(' Ana '))
    await press(tree, i18n.t('contacts.save'))
    expect(added).toHaveBeenCalledWith('Ana', ADDRESS)
  })

  test('a long name arrives inside the field limit', async () => {
    const long = `${'a'.repeat(60)}@usevoltz.app`
    const tree = await paid('complete', long)
    await overlayEnds(tree)
    expect(tree.root.findByType(TextInput).props.value).toBe('a'.repeat(40))
  })

  test('Save is one tap that asks the network nothing, and ends as a send does', async () => {
    const tree = await offered()
    classify.mockClear()
    await press(tree, i18n.t('contacts.save'))

    expect(added).toHaveBeenCalledTimes(1)
    expect(classify).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockGoBack).toHaveBeenCalledTimes(1)
  })

  test('a save that fails keeps the sheet and what was typed, and closing still leaves', async () => {
    added.mockRejectedValue(new Error('storage'))
    const tree = await offered()
    await press(tree, i18n.t('contacts.save'))

    expect(texts(tree)).toContain(i18n.t('contacts.saveFailed'))
    expect(sheet(tree)).toHaveLength(1)
    expect(mockGoBack).not.toHaveBeenCalled()

    await press(tree, i18n.t('send.saveContactLater'))
    expect(mockGoBack).toHaveBeenCalledTimes(1)
  })

  test('dismissing saves nothing and ends as a send does', async () => {
    const tree = await offered()
    await press(tree, i18n.t('send.saveContactLater'))
    expect(added).not.toHaveBeenCalled()
    expect(mockGoBack).toHaveBeenCalledTimes(1)
  })

  test('two taps on Save save once', async () => {
    added.mockReturnValue(new Promise(() => undefined))
    const tree = await offered()
    await press(tree, i18n.t('contacts.save'))
    await press(tree, i18n.t('contacts.save'))
    expect(added).toHaveBeenCalledTimes(1)
  })

  test('a save that answers after closing does not leave a second time', async () => {
    const save = deferred<SparkContact>()
    added.mockReturnValue(save.promise)
    const tree = await offered()
    await press(tree, i18n.t('contacts.save'))
    await press(tree, i18n.t('send.saveContactLater'))
    await ReactTestRenderer.act(async () => save.answer({ id: 'c9', name: 'x', address: ADDRESS }))
    await settle()
    expect(mockGoBack).toHaveBeenCalledTimes(1)
  })

  test('an emptied name cannot be saved', async () => {
    const tree = await offered()
    await ReactTestRenderer.act(async () => tree.root.findByType(TextInput).props.onChangeText('   '))
    expect(tree.root.findByType(GradientButton).props.disabled).toBe(true)
  })

  describe('there is no offer', () => {
    const noOffer = async (tree: ReactTestRenderer.ReactTestRenderer) => {
      await overlayEnds(tree)
      expect(sheet(tree)).toHaveLength(0)
      expect(mockGoBack).toHaveBeenCalledTimes(1)
    }

    test('while the payment is still on its way', async () => {
      jest.mocked(sparkFollowSend).mockResolvedValue('pending')
      await noOffer(await paid('pending'))
    })

    test('when the list read failed, since the address may be a contact already', async () => {
      list.mockRejectedValue(new Error('no connection'))
      await noOffer(await paid())
    })

    test('when the list read never answered', async () => {
      list.mockReturnValue(new Promise(() => undefined))
      await noOffer(await paid())
    })

    test('for an address already in the list, whatever its capitals', async () => {
      list.mockResolvedValue([{ id: 'c1', name: 'Ana', address: 'Ana.Lima@Usevoltz.App' }])
      await noOffer(await paid())
    })

    test('for an invoice', async () => {
      jest.mocked(sparkConfirmSend).mockResolvedValue('complete')
      mockRouteParams = { destination: 'lnbc1invoice', picked: 1 }
      const tree = await render()
      await press(tree, i18n.t('send.confirm'))
      await noOffer(tree)
    })
  })
})
