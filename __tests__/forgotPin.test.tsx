import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import App from '../App'
import i18n from '../src/i18n'
import { ForgotPinSheet } from '../src/components/ForgotPinSheet'
import { markUnconfirmed } from '../src/wallet/backupMark'
import { settleActiveWallet } from '../src/wallet/wallet'

// The navigator is past the lock; a marker says the app got there.
jest.mock('../src/navigation/RootNavigator', () => {
  const react = require('react')
  const { Text: RNText } = require('react-native')
  return { RootNavigator: () => react.createElement(RNText, null, 'NAVIGATOR') }
})

const PIN = 'com.voltz.wallet.pin'
const SEED = 'com.voltz.wallet.seed'
const PASSPHRASE = 'com.voltz.wallet.passphrase'
const BIOMETRIC = 'com.voltz.wallet.biometric'
const OWNER_CHECK = 'com.voltz.wallet.ownerCheck'
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const keychain = new Map<string, string>()
// Every Keychain delete in the order it ran.
let deleted: string[] = []
// The services whose delete throws, or answers without removing.
let refused: Set<string> = new Set()
let ignored: Set<string> = new Set()

type Tree = ReactTestRenderer.ReactTestRenderer

function allText(tree: Tree): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

async function boot(): Promise<Tree> {
  let tree!: Tree
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />)
  })
  await settle()
  return tree
}

async function press(tree: Tree, label: string): Promise<void> {
  const button = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!button) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    button.props.onPress()
  })
  await settle()
}

async function listWallets(...ids: string[]): Promise<void> {
  await RNFS.writeFile(
    `${RNFS.DocumentDirectoryPath}/wallets.json`,
    JSON.stringify({ active: ids[0], wallets: ids.map(id => ({ id, fingerprint: `fp${id}` })) }),
    'utf8',
  )
}

const serviceOf = (id: string): string => (id === 'primary' ? SEED : `${SEED}.${id}`)
const seeds = (): string[] => [...keychain.keys()].filter(service => service.startsWith(SEED))

async function deviceWith(...ids: string[]): Promise<void> {
  await listWallets(...ids)
  ids.forEach(id => keychain.set(serviceOf(id), WORDS))
  keychain.set(PIN, '123456')
}

const t = (key: string, values?: Record<string, unknown>): string => i18n.t(key, values) as string

beforeAll(async () => {
  await i18n.changeLanguage('en-US')
})

afterAll(async () => {
  await i18n.changeLanguage('pt-BR')
})

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  keychain.clear()
  deleted = []
  refused = new Set()
  ignored = new Set()
  jest.clearAllMocks()
  jest.mocked(Keychain.setGenericPassword).mockReset()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest.mocked(Keychain.getGenericPassword).mockReset()
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => keychain.has(options?.service ?? ''))
  jest.mocked(Keychain.resetGenericPassword).mockReset()
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => {
    const service = options?.service ?? ''
    if (refused.has(service)) {
      throw new Error('interaction not allowed')
    }
    if (!ignored.has(service)) {
      deleted.push(service)
      keychain.delete(service)
    }
    return true
  })
  jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementation(async () => [...keychain.keys()])
  jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(null)
  jest.mocked(Keychain.isPasscodeAuthAvailable).mockResolvedValue(true)
})

test('from the lock: the link, the warning, the check, and the welcome with nothing left', async () => {
  await deviceWith('primary', 'w2')
  keychain.set(`${PASSPHRASE}.w2`, 'twenty-fifth')
  keychain.set(BIOMETRIC, '123456')
  const tree = await boot()
  expect(allText(tree)).toContain(t('pin.enter'))

  await press(tree, t('pin.forgot'))
  expect(allText(tree)).toContain(t('pin.forgotBody'))
  // Nothing goes on the link.
  expect(keychain.has(PIN)).toBe(true)

  await press(tree, t('pin.forgotErase'))

  expect(jest.mocked(Keychain.getGenericPassword)).toHaveBeenCalledWith(
    expect.objectContaining({ service: OWNER_CHECK, authenticationPrompt: expect.anything() }),
  )
  expect([...keychain.keys()]).toEqual([])
  expect(allText(tree)).toContain(t('welcome.create'))
  expect((await settleActiveWallet())).toBe(false)
  const { wallets } = JSON.parse(await RNFS.readFile(`${RNFS.DocumentDirectoryPath}/wallets.json`, 'utf8'))
  expect(wallets).toEqual([])
})

test('the PIN is the last thing to go, after every seed', async () => {
  await deviceWith('primary', 'w2')
  keychain.set(BIOMETRIC, '123456')
  const tree = await boot()
  await press(tree, t('pin.forgot'))
  await press(tree, t('pin.forgotErase'))

  const pinAt = deleted.indexOf(PIN)
  expect(pinAt).toBeGreaterThanOrEqual(0)
  expect(deleted.indexOf(SEED)).toBeLessThan(pinAt)
  expect(deleted.indexOf(`${SEED}.w2`)).toBeLessThan(pinAt)
  expect(deleted.indexOf(BIOMETRIC)).toBeLessThan(pinAt)
})

describe('an erase that does not finish', () => {
  test('keeps the PIN, says so, and the next open is the lock', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await deviceWith('primary', 'w2')
    refused.add(`${SEED}.w2`)
    const tree = await boot()
    await press(tree, t('pin.forgot'))
    await press(tree, t('pin.forgotErase'))

    expect(allText(tree)).toContain(t('pin.forgotFailed'))
    expect(keychain.get(PIN)).toBe('123456')
    expect(seeds()).toEqual([`${SEED}.w2`])
    expect(allText(tree)).toContain(t('pin.enter'))
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })

    // The kill in the middle, as the next open meets it.
    const next = await boot()
    expect(allText(next)).toContain(t('pin.enter'))
    expect(allText(next)).not.toContain(t('pin.create'))
    await ReactTestRenderer.act(async () => {
      next.unmount()
    })
    warn.mockRestore()
  })

  test('keeps the PIN when a delete answered and the seed is still listed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await deviceWith('primary')
    ignored.add(SEED)
    const tree = await boot()
    await press(tree, t('pin.forgot'))
    await press(tree, t('pin.forgotErase'))

    expect(allText(tree)).toContain(t('pin.forgotFailed'))
    expect(keychain.get(PIN)).toBe('123456')
    warn.mockRestore()
  })

  test('finishes on Try again', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await deviceWith('primary', 'w2')
    refused.add(`${SEED}.w2`)
    const tree = await boot()
    await press(tree, t('pin.forgot'))
    await press(tree, t('pin.forgotErase'))

    refused.clear()
    await press(tree, t('common.retry'))

    expect(keychain.size).toBe(0)
    expect(allText(tree)).toContain(t('welcome.create'))
    warn.mockRestore()
  })
})

describe('the check of the device owner', () => {
  const checks = () =>
    jest.mocked(Keychain.getGenericPassword).mock.calls.filter(([options]) => options?.service === OWNER_CHECK).length

  function cancelTheCheck(): void {
    const read = jest.mocked(Keychain.getGenericPassword).getMockImplementation()!
    jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
      if (options?.service === OWNER_CHECK) {
        throw new Error('user cancelled')
      }
      return read(options)
    })
  }

  test('cancelled erases nothing and asks no second time on its own', async () => {
    await deviceWith('primary')
    cancelTheCheck()
    const tree = await boot()
    await press(tree, t('pin.forgot'))
    await press(tree, t('pin.forgotErase'))
    await settle()

    expect(checks()).toBe(1)
    expect(allText(tree)).toContain(t('pin.forgotNotChecked'))
    expect(keychain.get(SEED)).toBe(WORDS)
    expect(keychain.get(PIN)).toBe('123456')
  })

  test('asks again on a tap, and a pass then erases', async () => {
    await deviceWith('primary')
    const pass = jest.mocked(Keychain.getGenericPassword).getMockImplementation()!
    cancelTheCheck()
    const tree = await boot()
    await press(tree, t('pin.forgot'))
    await press(tree, t('pin.forgotErase'))

    jest.mocked(Keychain.getGenericPassword).mockImplementation(pass)
    await press(tree, t('pin.forgotErase'))

    expect(keychain.size).toBe(0)
    expect(allText(tree)).toContain(t('welcome.create'))
  })

  test('on a device with no lock there is nothing to ask, and the warning stands alone', async () => {
    jest.mocked(Keychain.isPasscodeAuthAvailable).mockResolvedValue(false)
    await deviceWith('primary')
    const tree = await boot()
    await press(tree, t('pin.forgot'))
    await press(tree, t('pin.forgotErase'))

    expect(checks()).toBe(0)
    expect(allText(tree)).toContain(t('welcome.create'))
  })

  test('takes the sheet off the backdrop while it runs', async () => {
    await deviceWith('primary')
    jest.mocked(Keychain.isPasscodeAuthAvailable).mockReturnValue(new Promise<boolean>(() => undefined))
    const tree = await boot()
    await press(tree, t('pin.forgot'))
    await press(tree, t('pin.forgotErase'))

    const sheet = tree.root.findByType(ForgotPinSheet)
    await ReactTestRenderer.act(async () => {
      sheet.findByProps({ closeLabel: t('common.close') }).props.onClose()
    })
    await settle()
    expect(tree.root.findByType(ForgotPinSheet).props.visible).toBe(true)
  })
})

describe('the warning', () => {
  test('counts the wallets with unconfirmed words', async () => {
    await deviceWith('primary', 'w2', 'w3')
    await markUnconfirmed('primary')
    await markUnconfirmed('w3')
    const tree = await boot()
    await press(tree, t('pin.forgot'))
    expect(allText(tree)).toContain(t('pin.forgotUnconfirmed', { count: 2 }))
  })

  test('leaves a mark with no wallet out of the count', async () => {
    await deviceWith('primary')
    await markUnconfirmed('w_gone')
    const tree = await boot()
    await press(tree, t('pin.forgot'))
    expect(allText(tree).some(line => line.startsWith('Wallets here with'))).toBe(false)
  })

  test('leaves out a listed wallet whose seed is not on this device', async () => {
    await deviceWith('primary')
    await listWallets('primary', 'w_lost')
    await markUnconfirmed('w_lost')
    const tree = await boot()
    await press(tree, t('pin.forgot'))
    expect(allText(tree).some(line => line.startsWith('Wallets here with'))).toBe(false)
  })

  test('says what is lost even when no wallet carries the mark', async () => {
    await deviceWith('primary')
    const tree = await boot()
    await press(tree, t('pin.forgot'))
    expect(allText(tree)).toContain(t('pin.forgotBody'))
  })
})

test('a seed no list names goes too, since the ids come from the Keychain', async () => {
  await deviceWith('primary')
  keychain.set(`${SEED}.w_old`, WORDS)
  keychain.set(`${PASSPHRASE}.w_old`, 'twenty-fifth')
  keychain.set(`${PASSPHRASE}.w_cut`, 'twenty-fifth')
  const tree = await boot()
  await press(tree, t('pin.forgot'))
  await press(tree, t('pin.forgotErase'))

  expect(keychain.size).toBe(0)
  expect(allText(tree)).toContain(t('welcome.create'))
})

test('purchase proofs stay, since they stand for money paid', async () => {
  await deviceWith('primary')
  const proofs = `${RNFS.DocumentDirectoryPath}/purchases.json`
  await RNFS.writeFile(proofs, '{"primary":{}}', 'utf8')
  const tree = await boot()
  await press(tree, t('pin.forgot'))
  await press(tree, t('pin.forgotErase'))

  expect(allText(tree)).toContain(t('welcome.create'))
  expect(await RNFS.readFile(proofs, 'utf8')).toBe('{"primary":{}}')
})

test('a wallet created after an erase asks for a PIN of its own', async () => {
  await deviceWith('primary')
  const tree = await boot()
  await press(tree, t('pin.forgot'))
  await press(tree, t('pin.forgotErase'))
  await press(tree, t('welcome.create'))
  await press(tree, t('backup.confirm'))

  expect(allText(tree)).toContain(t('pin.create'))
  for (const digit of '135790135790') {
    await press(tree, digit)
  }
  expect(keychain.get(PIN)).toBe('135790')
  expect(allText(tree)).toContain('NAVIGATOR')
})
