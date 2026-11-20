import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import { wordlists } from 'bip39'
import App from '../App'
import i18n from '../src/i18n'
import { loadRegistry, type Registry } from '../src/wallet/walletRegistry'
import { fingerprintFromMnemonic } from '../src/wallet/fingerprint'
import { domainFor } from '../src/wallet/lnurlDomainPref'
import { lastLnAddress } from '../src/wallet/lnAddressMemory'

// The app over an iPhone restored from another device's backup: Documents came back, and the wallet
// registry with it, while every seed and the PIN were stored WHEN_UNLOCKED_THIS_DEVICE_ONLY and stayed
// on the old phone. The boot, the onboarding, the registry and the Keychain reads are all real, over
// the in-memory fs and a Keychain that keeps what it is given.

jest.mock('../src/navigation/RootNavigator', () => ({ RootNavigator: () => null }))

const REGISTRY = `${RNFS.DocumentDirectoryPath}/wallets.json`
const SEED = 'com.voltz.wallet.seed'
const PIN = 'com.voltz.wallet.pin'
const ENGLISH: readonly string[] = wordlists.english
const VALID_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const keychain = new Map<string, string>()
const unreadable = new Set<string>()

// Two wallets from the old phone, neither with its seed here. Neither is the primary, which is how
// the device walk found it: a wallet added after the first gets an id of its own.
const LOST: Registry = {
  wallets: [
    { id: 'w_lost1', fingerprint: 'aaaa1111' },
    { id: 'w_lost2', fingerprint: 'bbbb2222' },
  ],
  active: 'w_lost1',
}

async function writeRegistry(reg: Registry): Promise<void> {
  await RNFS.writeFile(REGISTRY, JSON.stringify(reg), 'utf8')
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  keychain.clear()
  unreadable.clear()
  jest.clearAllMocks()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => {
    const service = options?.service ?? ''
    if (unreadable.has(service)) {
      throw new Error('keychain unavailable')
    }
    return keychain.has(service)
  })
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
  jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(null)
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

async function open(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />)
  })
  await settle()
  return tree
}

async function close(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
}

function allText(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

const onWelcome = (tree: ReactTestRenderer.ReactTestRenderer): boolean =>
  allText(tree).includes(i18n.t('welcome.create'))

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const button = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!button) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(() => {
    button.props.onPress()
  })
  await settle()
}

async function typePin(tree: ReactTestRenderer.ReactTestRenderer, pin: string): Promise<void> {
  for (const digit of pin) {
    const [key] = tree.root.findAll(
      node => node.props.label === digit && typeof node.props.onPress === 'function',
    )
    await ReactTestRenderer.act(async () => {
      key.props.onPress()
    })
  }
  await settle()
}

async function importPhrase(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await press(tree, i18n.t('welcome.import'))
  const words = VALID_12.split(' ')
  for (let i = 0; i < words.length; i++) {
    const input = tree.root.findAllByType(TextInput)[i]
    await ReactTestRenderer.act(() => {
      input.props.onChangeText(words[i])
    })
  }
  await press(tree, 'Restore')
}

// The create flow up to its first writes: the phrase shown and written down.
async function createWallet(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await press(tree, i18n.t('welcome.create'))
  expect(allText(tree).filter(text => ENGLISH.includes(text))).toHaveLength(12)
  await press(tree, 'I wrote them down safely')
}

// Through the screens a person goes through. The old phone's wallets stay listed.
describe.each([
  ['imported', importPhrase],
  ['created', createWallet],
])('a wallet %s in the first-run onboarding', (_how, onboard) => {
  test('is the one the app opens next time, on a registry pointing at a wallet with no seed', async () => {
    await writeRegistry(LOST)
    const first = await open()
    expect(onWelcome(first)).toBe(true)

    await onboard(first)
    expect(allText(first)).toContain(i18n.t('pin.create'))
    const reg = await loadRegistry()
    expect(LOST.wallets.map(w => w.id)).not.toContain(reg.active)
    expect(keychain.has(`${SEED}.${reg.active}`)).toBe(true)
    expect(reg.wallets).toEqual(expect.arrayContaining(LOST.wallets))
    await typePin(first, '123456')
    await typePin(first, '123456')
    expect(keychain.get(PIN)).toBe('123456')
    await close(first)

    const next = await open()
    expect(onWelcome(next)).toBe(false)
    expect(allText(next)).toContain(i18n.t('pin.enter'))
    expect((await loadRegistry()).active).toBe(reg.active)
    await close(next)
  })
})

// The most common restore: one wallet on the old phone, its words typed back on the new one. The
// records the backup brought back are keyed by that wallet's id, so the words take the id back, and
// the list, the domain and the remembered address are the ones the old phone had.
test('the words of the one wallet the backup listed open as that wallet, with its domain and address', async () => {
  await writeRegistry({ wallets: [{ id: 'primary', fingerprint: fingerprintFromMnemonic(VALID_12) }], active: 'primary' })
  await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/lnurl-domain.json`, JSON.stringify({ primary: 'example.com' }), 'utf8')
  await RNFS.writeFile(
    `${RNFS.DocumentDirectoryPath}/ln-address-last.json`,
    JSON.stringify({ primary: 'padaria@example.com' }),
    'utf8',
  )
  const first = await open()
  expect(onWelcome(first)).toBe(true)

  await importPhrase(first)
  await typePin(first, '123456')
  await typePin(first, '123456')
  await close(first)

  const next = await open()
  expect(allText(next)).toContain(i18n.t('pin.enter'))
  expect(await loadRegistry()).toEqual({
    wallets: [{ id: 'primary', fingerprint: fingerprintFromMnemonic(VALID_12) }],
    active: 'primary',
  })
  expect(await domainFor((await loadRegistry()).active ?? '')).toBe('example.com')
  expect(await lastLnAddress()).toBe('padaria@example.com')
  await close(next)
})

test('a registry pointing at a wallet with no seed opens another listed wallet that has one', async () => {
  await writeRegistry({ ...LOST, wallets: [...LOST.wallets, { id: 'w_ok', fingerprint: 'cccc3333' }] })
  keychain.set(`${SEED}.w_ok`, VALID_12)
  keychain.set(PIN, '123456')

  const tree = await open()

  expect(onWelcome(tree)).toBe(false)
  expect(allText(tree)).toContain(i18n.t('pin.enter'))
  expect((await loadRegistry()).active).toBe('w_ok')
  await close(tree)
})

// For a seed under the primary id that the registry does not list.
test('a primary seed the registry does not list opens, with the pointer on a wallet with no seed', async () => {
  await writeRegistry(LOST)
  keychain.set(SEED, VALID_12)
  keychain.set(PIN, '123456')

  const tree = await open()

  expect(onWelcome(tree)).toBe(false)
  expect(allText(tree)).toContain(i18n.t('pin.enter'))
  expect((await loadRegistry()).active).toBe('primary')
  await close(tree)
})

// The boot keeps its fail-closed answer to a Keychain it cannot read: no Welcome, no wallet.
test('a seed read that throws at boot shows neither Welcome nor a wallet, and moves nothing', async () => {
  await writeRegistry({ ...LOST, wallets: [...LOST.wallets, { id: 'w_ok', fingerprint: 'cccc3333' }] })
  keychain.set(`${SEED}.w_ok`, VALID_12)
  keychain.set(PIN, '123456')
  unreadable.add(`${SEED}.w_lost1`)
  const before = await RNFS.readFile(REGISTRY, 'utf8')
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

  const tree = await open()

  expect(onWelcome(tree)).toBe(false)
  expect(allText(tree)).not.toContain(i18n.t('pin.enter'))
  expect(allText(tree)).not.toContain(i18n.t('pin.create'))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('boot did not finish'))
  expect(allText(tree)).toContain(i18n.t('welcome.bootFailed'))
  expect(await RNFS.readFile(REGISTRY, 'utf8')).toBe(before)
  warn.mockRestore()
  await close(tree)
})
