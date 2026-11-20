import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { BackHandler, DeviceEventEmitter } from 'react-native'
import * as Keychain from 'react-native-keychain'
import App from '../App'
import i18n from '../src/i18n'
import { hasPin, savePin } from '../src/wallet/pin'

// Jest resolves react-native for iOS, whose BackHandler drops every listener. The Android module is
// the one that runs on the phone, so a press here goes through the same code a back gesture does.
jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/BackHandler.android'),
)

// Boot lands on HomeScreen, which connects the SDK, so the API key has to hold a value or connect
// aborts before anything renders.
jest.mock('../src/config', () => ({
  getBreezApiKey: () => 'test-api-key',
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => undefined,
  // The build that ships, so boot runs with the store's listener up.
  getDistribution: () => 'store',
}))

// The keypad's check, over the comparison each case decides, with no wrong-PIN wait.
jest.mock('../src/wallet/pin', () => {
  const compare = jest.fn()
  return {
    hasPin: jest.fn(), savePin: jest.fn(), verifyPin: compare,
    enterPin: jest.fn(async (pin: string) => ((await compare(pin)) ? { ok: true } : { ok: false, waitMs: 0 })),
    pinWaitLeft: jest.fn(async () => 0),
    clearPinFailures: jest.fn(async () => undefined),
  }
})

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />)
  })
  return tree
}

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  const strings: string[] = []
  const walk = (node: ReactTestRenderer.ReactTestRendererJSON | string) => {
    if (typeof node === 'string') {
      strings.push(node)
      return
    }
    node.children?.forEach(walk)
  }
  const json = tree.toJSON()
  if (json) {
    ;(Array.isArray(json) ? json : [json]).forEach(walk)
  }
  return strings.join(' ')
}

const WELCOME = ['Voltz Wallet']
// The wallet is open when Home's actions are drawn, which they are from its first frame. Its balance
// label waits for the figure, so it says nothing about whether Home is up.
const onWallet = (text: string): boolean =>
  [i18n.t('home.send'), i18n.t('home.receive')].some(label => text.includes(label))
const PIN_PROMPT = ['Digite seu PIN', 'Enter your PIN', 'Ingresa tu PIN']

const STORED_SEED = {
  service: 'com.voltz.wallet.seed',
  username: 'seed',
  password:
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  storage: 'kc',
}

beforeEach(() => {
  jest.clearAllMocks()
})

// The boot check asks hasGenericPassword while everything after it needs the seed itself, so
// setting only one of the two would model a state no device can reach.
function storeSeed(present: boolean) {
  jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(present)
  jest.mocked(Keychain.getGenericPassword).mockResolvedValue((present ? STORED_SEED : false) as never)
}

// Taps the PIN keypad, whose keys carry their digit as the label.
async function typePin(tree: ReactTestRenderer.ReactTestRenderer, pin: string): Promise<void> {
  for (const digit of pin) {
    const [key] = tree.root.findAll(
      node => node.props.label === digit && typeof node.props.onPress === 'function',
    )
    await ReactTestRenderer.act(async () => {
      key.props.onPress()
    })
  }
  await ReactTestRenderer.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

// A wallet without a PIN is not a state the app allows. A seed with none can only be a first run cut
// off between the seed write and the PIN write, so the boot resumes at Create PIN rather than opening
// the wallet to whoever holds the phone.
test('a seed with no PIN reopens on Create PIN, never on the wallet', async () => {
  storeSeed(true)
  jest.mocked(hasPin).mockResolvedValue(false)

  const text = renderedText(await renderApp())

  expect(text).toContain(i18n.t('pin.create'))
  expect(onWallet(text)).toBe(false)
  expect(WELCOME.some(title => text.includes(title))).toBe(false)
})

test('nothing leaves that Create PIN but a saved PIN, not even Android back', async () => {
  storeSeed(true)
  jest.mocked(hasPin).mockResolvedValue(false)
  const exitApp = jest.spyOn(BackHandler, 'exitApp').mockImplementation(() => undefined)
  const tree = await renderApp()

  await ReactTestRenderer.act(async () => {
    DeviceEventEmitter.emit('hardwareBackPress', {})
  })
  expect(renderedText(tree)).toContain(i18n.t('pin.create'))
  expect(exitApp).not.toHaveBeenCalled()

  await typePin(tree, '123456')
  await typePin(tree, '123456')

  expect(savePin).toHaveBeenCalledTimes(1)
  expect(savePin).toHaveBeenCalledWith('123456')
  expect(onWallet(renderedText(tree))).toBe(true)
  exitApp.mockRestore()
})

test('a PIN store that cannot be read keeps the wallet closed', async () => {
  storeSeed(true)
  jest.mocked(hasPin).mockRejectedValue(new Error('keychain unavailable'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

  const text = renderedText(await renderApp())
  warn.mockRestore()

  expect(onWallet(text)).toBe(false)
  expect(text).not.toContain(i18n.t('pin.create'))
  expect(text).toContain(i18n.t('welcome.bootFailed'))
})

test('asks for the PIN when there is a seed and a PIN is set', async () => {
  storeSeed(true)
  jest.mocked(hasPin).mockResolvedValue(true)

  const text = renderedText(await renderApp())

  expect(PIN_PROMPT.some(prompt => text.includes(prompt))).toBe(true)
  // The balance must not leak behind the lock screen.
  expect(onWallet(text)).toBe(false)
})

test('shows onboarding when there is no stored seed', async () => {
  storeSeed(false)

  const text = renderedText(await renderApp())

  expect(WELCOME.some(title => text.includes(title))).toBe(true)
  expect(onWallet(text)).toBe(false)
})
