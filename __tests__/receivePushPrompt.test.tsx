import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { PermissionsAndroid, Text } from 'react-native'
import RNFS from 'react-native-fs'
import {
  AuthorizationStatus,
  getToken,
  hasPermission,
  requestPermission,
} from '@react-native-firebase/messaging'
import type * as BridgeDouble from '../specs/__mocks__/NativeVoltzNotifications'
import i18n from '../src/i18n'
import { ReceiveSpark } from '../src/screens/ReceiveSpark'
import { sparkEnsureLnAddress } from '../src/wallet/spark'

// Receive explains the notification dialog before the system shows it, and only its button asks.
// The real pushToken runs here, over the Firebase and file mocks, so what is asserted is whether the
// system was asked, not which function was called. Jest runs as iOS.

jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezLnurlDomain: jest.fn(() => 'lnurl.usevoltz.app'),
}))

jest.mock('../src/wallet/spark', () => ({
  sparkReceive: jest.fn(async () => ({ destination: 'spark1testaddr', feeSat: 0 })),
  sparkGetFiatRates: jest.fn(async () => ({})),
  sparkEnsureLnAddress: jest.fn(),
  sparkGetWalletInfo: jest.fn(async () => ({ sync: 'synced', balanceSat: 0, tokens: [] })),
  sparkCheckLnAddress: jest.fn(async () => true),
  sparkRegisterLnAddress: jest.fn(),
  sparkDeleteLnAddress: jest.fn(async () => undefined),
  sparkListFiatCurrencies: jest.fn(async () => []),
  sparkGetIdentityPubkey: jest.fn(async () => '02'.padEnd(66, 'a')),
  sparkConnectedIdentity: jest.fn(async () => ({ walletId: 'primary', pubkey: '02'.padEnd(66, 'a') })),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkWebhookSession: jest.fn(() => ({
    list: async () => [],
    register: async () => 'hook-1',
    unregister: async () => undefined,
  })),
}))
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ setOptions: jest.fn() }),
  useRoute: () => ({ params: {} }),
}))

const ADDRESS = { username: 'satoshi', address: 'satoshi@lnurl.usevoltz.app', lnurl: 'lnurl1abc' }
const ASKED = `${RNFS.DocumentDirectoryPath}/notification-asked.json`

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

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ReceiveSpark />)
  })
  mounted = tree
  await flush()
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

const cardShown = (tree: ReactTestRenderer.ReactTestRenderer) =>
  texts(tree).includes(i18n.t('receive.pushPromptTitle'))

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const target = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === label))
  if (!target) {
    throw new Error(`not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
  })
  await flush()
}

// The iOS notification bridge and the iPhone state it stands for, reset by jest.setup.js.
const notifications: typeof BridgeDouble = jest.requireMock('../specs/NativeVoltzNotifications')

// Every way the system could show its dialog, on either platform, Firebase's own iOS prompt included.
function systemAsks(): number {
  return (
    jest.mocked(notifications.default.requestAuthorization).mock.calls.length +
    jest.mocked(requestPermission).mock.calls.length +
    (PermissionsAndroid.request as unknown as jest.Mock).mock.calls.length
  )
}

let fetchMock: jest.Mock
beforeEach(() => {
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  ;(PermissionsAndroid.request as unknown as jest.Mock) = jest.fn(async () => 'granted')
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ADDRESS)
  // A fresh install that has not answered, which the Firebase mock answers by default.
  jest.mocked(hasPermission).mockReset().mockResolvedValue(AuthorizationStatus.NOT_DETERMINED)
  // The gateway's answers: a registration carries the webhook id the provider posts to, 22 base64url
  // characters, and a forget answers alike whatever it matched.
  fetchMock = jest.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.endsWith('/api/device') ? { registered: true, webhookId: 'AbCdEfGhIjKlMnOpQrSt_-' } : {}),
  }))
  global.fetch = fetchMock as unknown as typeof fetch
})

test('a first Receive explains the alerts and asks the system nothing before a tap', async () => {
  const tree = await render()

  expect(cardShown(tree)).toBe(true)
  await press(tree, i18n.t('receive.pushPromptTitle'))
  expect(texts(tree)).toEqual(
    expect.arrayContaining([
      i18n.t('receive.pushPromptBody'),
      i18n.t('receive.pushPromptAllow'),
      i18n.t('receive.pushPromptLater'),
    ]),
  )
  expect(systemAsks()).toBe(0)
  expect(getToken).not.toHaveBeenCalled()
  expect(await RNFS.exists(ASKED)).toBe(false)
})

test('Turn on asks the system once, writes the mark and puts the card away', async () => {
  notifications.device.answer = 'authorized'
  const tree = await render()

  await press(tree, i18n.t('receive.pushPromptTitle'))
  await press(tree, i18n.t('receive.pushPromptAllow'))

  expect(notifications.default.requestAuthorization).toHaveBeenCalledTimes(1)
  expect(systemAsks()).toBe(1)
  expect(await RNFS.exists(ASKED)).toBe(true)
  expect(cardShown(tree)).toBe(false)
  // Allowed, so the device is registered with the gateway.
  expect(getToken).toHaveBeenCalled()
  expect(fetchMock.mock.calls[0]?.[0]).toBe('https://lnurl.usevoltz.app/api/device')
})

test('with alerts already allowed it registers silently and shows no card', async () => {
  jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)
  const tree = await render()

  expect(cardShown(tree)).toBe(false)
  expect(systemAsks()).toBe(0)
  expect(fetchMock.mock.calls[0]?.[0]).toBe('https://lnurl.usevoltz.app/api/device')
})

test('after the system answered, a refusal included, no card shows again', async () => {
  jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.DENIED)
  const tree = await render()

  expect(cardShown(tree)).toBe(false)
  expect(systemAsks()).toBe(0)
})

test('a permission read that fails shows no card and asks nothing', async () => {
  jest.mocked(hasPermission).mockRejectedValue(new Error('no answer'))
  const tree = await render()

  expect(cardShown(tree)).toBe(false)
  expect(systemAsks()).toBe(0)
})

test('while the permission read is in flight there is no card yet', async () => {
  type Status = Awaited<ReturnType<typeof hasPermission>>
  let answer: (status: Status) => void = () => {}
  jest.mocked(hasPermission).mockImplementation(() => new Promise<Status>(resolve => (answer = resolve)))
  const tree = await render()
  expect(cardShown(tree)).toBe(false)

  // The silent read answers first, then the read of whether the dialog is still to come.
  await ReactTestRenderer.act(async () => answer(AuthorizationStatus.NOT_DETERMINED))
  await flush()
  await ReactTestRenderer.act(async () => answer(AuthorizationStatus.NOT_DETERMINED))
  await flush()
  expect(cardShown(tree)).toBe(true)
  expect(systemAsks()).toBe(0)
})

test('an address read that fails shows no card and asks nothing', async () => {
  jest.mocked(sparkEnsureLnAddress).mockRejectedValue(new Error('offline'))
  const tree = await render()

  expect(cardShown(tree)).toBe(false)
  expect(systemAsks()).toBe(0)
})

test('a wallet with no address to pay shows no card', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(null)
  const tree = await render()

  expect(cardShown(tree)).toBe(false)
  expect(systemAsks()).toBe(0)
})

// Hidden by Activity, the screen keeps its state while its effects end and run again when it shows,
// so an answer to the run that ended would still land on the card. Here the system moved on before
// the screen came back, and the run that answers now says no card.
test('an answer that comes after its run ended never puts the card up', async () => {
  type Status = Awaited<ReturnType<typeof hasPermission>>
  const answers: Array<(status: Status) => void> = []
  jest.mocked(hasPermission).mockImplementation(() => new Promise<Status>(resolve => answers.push(resolve)))
  const at = (mode: 'visible' | 'hidden') => (
    <React.Activity mode={mode}>
      <ReceiveSpark />
    </React.Activity>
  )
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(at('visible'))
  })
  mounted = tree
  await flush()
  // The silent read answers, and the read of whether the dialog is still to come is in flight.
  await ReactTestRenderer.act(async () => answers[0](AuthorizationStatus.NOT_DETERMINED))
  await flush()
  expect(answers).toHaveLength(2)

  await ReactTestRenderer.act(async () => tree.update(at('hidden')))
  await ReactTestRenderer.act(async () => answers[1](AuthorizationStatus.NOT_DETERMINED))
  await flush()
  jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.DENIED)
  await ReactTestRenderer.act(async () => tree.update(at('visible')))
  await flush()

  expect(cardShown(tree)).toBe(false)
  expect(systemAsks()).toBe(0)
})

// A request that fails leaves the system still to ask, so the card comes back when the screen shows
// again on the same mount. It comes back as the quiet line, never as the sheet opened unasked.
test('an offer that comes back after Turn on shows the line, not the sheet', async () => {
  jest.mocked(notifications.default.requestAuthorization).mockRejectedValueOnce(new Error('no answer'))
  const at = (mode: 'visible' | 'hidden') => (
    <React.Activity mode={mode}>
      <ReceiveSpark />
    </React.Activity>
  )
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(at('visible'))
  })
  mounted = tree
  await flush()
  await press(tree, i18n.t('receive.pushPromptTitle'))
  expect(texts(tree)).toContain(i18n.t('receive.pushPromptBody'))
  await press(tree, i18n.t('receive.pushPromptAllow'))
  expect(cardShown(tree)).toBe(false)

  await ReactTestRenderer.act(async () => tree.update(at('hidden')))
  await ReactTestRenderer.act(async () => tree.update(at('visible')))
  await flush()

  expect(cardShown(tree)).toBe(true)
  expect(texts(tree)).not.toContain(i18n.t('receive.pushPromptBody'))
})

// Last in the file: "Not now" is kept for the run, which in Jest is the module registry of this file.
test('Not now asks nothing, puts the card away and keeps it away for this run', async () => {
  const tree = await render()
  await press(tree, i18n.t('receive.pushPromptTitle'))
  await press(tree, i18n.t('receive.pushPromptLater'))

  expect(cardShown(tree)).toBe(false)
  expect(systemAsks()).toBe(0)
  expect(await RNFS.exists(ASKED)).toBe(false)

  ReactTestRenderer.act(() => tree.unmount())
  const again = await render()
  expect(cardShown(again)).toBe(false)
  expect(systemAsks()).toBe(0)
})
