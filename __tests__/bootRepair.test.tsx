import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Image, Linking, ScrollView, Text, TextInput } from 'react-native'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import App from '../App'
import i18n from '../src/i18n'
import { GradientButton } from '../src/components/GradientButton'
import { ScreenTitle } from '../src/components/ScreenTitle'
import { expectMailFallback, pressCopy } from './support/mailFallback'
import { loadRegistry } from '../src/wallet/walletRegistry'
import { fingerprintFromMnemonicAsync } from '../src/wallet/fingerprint'
import { SUPPORT_EMAIL } from '../src/wallet/recover'

// The app over a wallets.json cut mid write, with the seeds still in the Keychain. The boot, the
// onboarding, the registry and the Keychain reads are all real, over the in-memory fs and a Keychain
// that keeps what it is given and lists what it holds.

jest.mock('../src/navigation/RootNavigator', () => ({ RootNavigator: () => null }))
jest.mock('../src/wallet/fingerprint', () => {
  const actual = jest.requireActual('../src/wallet/fingerprint')
  return { ...actual, fingerprintFromMnemonicAsync: jest.fn(actual.fingerprintFromMnemonicAsync) }
})

const REGISTRY = `${RNFS.DocumentDirectoryPath}/wallets.json`
const ASIDE = `${REGISTRY}.unreadable`
const SEED = 'com.voltz.wallet.seed'
const PASSPHRASE = 'com.voltz.wallet.passphrase'
const PIN = 'com.voltz.wallet.pin'
const TORN = '{"wallets":[{"id":"primary","fingerprint":"aa'
const WORDS_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const WORDS_B = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
const WORDS_C = 'unveil nice picture region tragic fault cream strike tourist control recipe tourist'

const keychain = new Map<string, string>()

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  keychain.clear()
  jest.clearAllMocks()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => keychain.has(options?.service ?? ''))
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
  jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementation(async () => [...keychain.keys()])
  jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(null)
  await RNFS.writeFile(REGISTRY, TORN, 'utf8')
})

afterEach(() => {
  jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementation(async () => [])
})

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
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

async function disk(): Promise<(string | null)[]> {
  return Promise.all(
    [REGISTRY, `${REGISTRY}.tmp`, ASIDE, `${REGISTRY}.tmp.unreadable`].map(async path =>
      (await RNFS.exists(path)) ? RNFS.readFile(path, 'utf8') : null,
    ),
  )
}

async function fingerprintOf(words: string, passphrase?: string): Promise<string> {
  return jest.requireActual('../src/wallet/fingerprint').fingerprintFromMnemonicAsync(words, passphrase)
}

test('a torn list with three seeds here opens on the PIN with the three wallets listed again', async () => {
  keychain.set(SEED, WORDS_A)
  keychain.set(`${SEED}.w_a`, WORDS_B)
  keychain.set(`${SEED}.w_b`, WORDS_C)
  keychain.set(`${PASSPHRASE}.w_b`, 'correct horse')
  keychain.set(PIN, '123456')

  const tree = await open()

  expect(onWelcome(tree)).toBe(false)
  expect(allText(tree)).toContain(i18n.t('pin.enter'))
  expect(await loadRegistry()).toEqual({
    wallets: [
      { id: 'primary', fingerprint: await fingerprintOf(WORDS_A) },
      { id: 'w_a', fingerprint: await fingerprintOf(WORDS_B) },
      { id: 'w_b', fingerprint: await fingerprintOf(WORDS_C, 'correct horse') },
    ],
    active: 'primary',
  })
  expect(await RNFS.readFile(ASIDE, 'utf8')).toBe(TORN)
})

test('a torn list with no seed here sets the file aside, shows Welcome, and the onboarding writes a fresh list', async () => {
  const tree = await open()

  expect(onWelcome(tree)).toBe(true)
  expect(await RNFS.exists(REGISTRY)).toBe(false)
  expect(await RNFS.readFile(ASIDE, 'utf8')).toBe(TORN)

  await press(tree, i18n.t('welcome.import'))
  const words = WORDS_A.split(' ')
  for (let i = 0; i < words.length; i++) {
    const input = tree.root.findAllByType(TextInput)[i]
    await ReactTestRenderer.act(() => {
      input.props.onChangeText(words[i])
    })
  }
  await press(tree, 'Restore')

  expect(allText(tree)).toContain(i18n.t('pin.create'))
  expect(await loadRegistry()).toEqual({
    wallets: [{ id: 'primary', fingerprint: await fingerprintOf(WORDS_A) }],
    active: 'primary',
  })
  expect(await RNFS.readFile(ASIDE, 'utf8')).toBe(TORN)
})

// RNFS decodes UTF-8 in JS, so the text read of a list cut inside a multibyte character fails while its
// bytes still read. While `REGISTRY` holds `content`, its text read rejects and its bytes read answers
// `bytes`; once anything else is written there, both read as usual.
function readsOfRegistry(content: string, bytes: () => Promise<unknown>): void {
  const real = RNFS.readFile.bind(RNFS)
  jest.spyOn(RNFS, 'readFile').mockImplementation((async (path: string, encoding?: string) => {
    const read = (real as (...a: unknown[]) => Promise<string>)
    if (path === REGISTRY && (await read(path, 'utf8')) === content) {
      return encoding === 'base64' ? bytes() : Promise.reject(new Error('Invalid continuation byte'))
    }
    return read(path, encoding)
  }) as never)
}

test('a list whose bytes do not decode as text is torn, and is set aside and rebuilt', async () => {
  const cut = '{"wallets":[{"id":"primary","name":"Caf'
  await RNFS.writeFile(REGISTRY, cut, 'utf8')
  keychain.set(SEED, WORDS_A)
  keychain.set(PIN, '123456')
  readsOfRegistry(cut, () => Promise.resolve('eyJ3YWxsZXRzIjpbeyJpZCI6InByaW1hcnkiLCJuYW1lIjoiQ2Fmww=='))
  let tree!: ReactTestRenderer.ReactTestRenderer
  try {
    tree = await open()
  } finally {
    jest.mocked(RNFS.readFile).mockRestore()
  }

  expect(allText(tree)).toContain(i18n.t('pin.enter'))
  expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['primary'])
  expect(await RNFS.exists(ASIDE)).toBe(true)
})

// A read the platform refuses says nothing about the list, so the boot neither sets it aside nor
// rebuilds it: it stops on its error screen, and Try again opens the same list once the read answers.
test('a list the platform refuses to read stops the boot, moves nothing, and Try again opens it', async () => {
  const intact = JSON.stringify({ wallets: [{ id: 'primary', fingerprint: await fingerprintOf(WORDS_A) }], active: 'primary' })
  await RNFS.writeFile(REGISTRY, intact, 'utf8')
  keychain.set(SEED, WORDS_A)
  keychain.set(PIN, '123456')
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const before = await disk()
  readsOfRegistry(intact, () => Promise.reject(new Error('EIO: i/o error')))
  let tree!: ReactTestRenderer.ReactTestRenderer
  try {
    tree = await open()
  } finally {
    jest.mocked(RNFS.readFile).mockRestore()
    warn.mockRestore()
  }

  expect(allText(tree)).toContain(i18n.t('welcome.bootFailed'))
  expect(await disk()).toEqual(before)

  await press(tree, i18n.t('common.retry'))

  expect(allText(tree)).toContain(i18n.t('pin.enter'))
  expect(await RNFS.readFile(REGISTRY, 'utf8')).toBe(intact)
  expect(await RNFS.exists(ASIDE)).toBe(false)
})

// A repair that cannot finish writes nothing, and the boot shows its way out instead of the splash.
describe.each([
  ['the listing', () => jest.mocked(Keychain.getAllGenericPasswordServices).mockRejectedValueOnce(new Error('keychain unavailable'))],
  ['a presence read', () => jest.mocked(Keychain.hasGenericPassword).mockRejectedValueOnce(new Error('keychain unavailable'))],
  ['a fingerprint', () => jest.mocked(fingerprintFromMnemonicAsync).mockRejectedValueOnce(new Error('derivation failed'))],
])('a repair that cannot finish because %s throws', (_what, fail) => {
  beforeEach(() => {
    keychain.set(SEED, WORDS_A)
    keychain.set(`${SEED}.w_a`, WORDS_B)
    keychain.set(PIN, '123456')
  })

  test('shows the boot error with Try again, opens no wallet, creates no PIN and writes nothing', async () => {
    fail()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const before = await disk()

    const tree = await open()

    const text = allText(tree)
    expect(text).toContain(i18n.t('welcome.bootFailed'))
    expect(text).toContain(i18n.t('common.retry'))
    expect(text).toContain(i18n.t('welcome.contactSupport'))
    expect(onWelcome(tree)).toBe(false)
    expect(text).not.toContain(i18n.t('pin.enter'))
    expect(text).not.toContain(i18n.t('pin.create'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boot did not finish'))
    expect(await disk()).toEqual(before)
    warn.mockRestore()
  })

  test('Try again stays on the page, turning, until the boot answers', async () => {
    fail()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await open()
    warn.mockRestore()
    let answer!: (services: string[]) => void
    jest
      .mocked(Keychain.getAllGenericPasswordServices)
      .mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    const retry = () => tree.root.findAllByType(GradientButton).find(b => b.props.label === i18n.t('common.retry'))

    expect(retry()?.props.loading).toBe(false)
    await press(tree, i18n.t('common.retry'))

    // The stage that draws nothing is never reached: this is the page, with its button turning.
    expect(allText(tree)).toContain(i18n.t('welcome.bootFailed'))
    expect(allText(tree)).toContain(SUPPORT_EMAIL)
    expect(retry()?.props.loading).toBe(true)

    await ReactTestRenderer.act(async () => answer([...keychain.keys()]))
    await settle()
    expect(allText(tree)).toContain(i18n.t('pin.enter'))
  })

  test('a Try again that fails again lands on the page with the button ready', async () => {
    fail()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await open()
    jest.mocked(Keychain.getAllGenericPasswordServices).mockRejectedValueOnce(new Error('keychain unavailable'))

    await press(tree, i18n.t('common.retry'))
    warn.mockRestore()

    expect(allText(tree)).toContain(i18n.t('welcome.bootFailed'))
    expect(tree.root.findAllByType(GradientButton).find(b => b.props.label === i18n.t('common.retry'))?.props.loading).toBe(false)
  })

  test('Try again, with the Keychain answering, repairs and opens on the PIN', async () => {
    fail()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await open()
    warn.mockRestore()

    await press(tree, i18n.t('common.retry'))

    expect(allText(tree)).toContain(i18n.t('pin.enter'))
    expect(allText(tree)).not.toContain(i18n.t('welcome.bootFailed'))
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['primary', 'w_a'])
    expect(await RNFS.readFile(ASIDE, 'utf8')).toBe(TORN)
  })
})

test('Write to support opens a mail to the support address', async () => {
  jest.mocked(Keychain.getAllGenericPasswordServices).mockRejectedValueOnce(new Error('keychain unavailable'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  const tree = await open()
  warn.mockRestore()

  await press(tree, i18n.t('welcome.contactSupport'))

  expect(openURL).toHaveBeenCalledWith(`mailto:${SUPPORT_EMAIL}`)
  expect(allText(tree)).toContain(i18n.t('welcome.bootFailed'))
  // The address stays on screen after a mail that opened, with the line for a mail that may not
  // have gone out, and no line says the mail failed.
  expectMailFallback(tree, null, 'opened')
  openURL.mockRestore()
})

// The first thing anyone reads, on the rule every other title follows.
test('the welcome opens on the one title piece, with no size of its own', async () => {
  const tree = await open()

  expect(tree.root.findByType(ScreenTitle).props).toMatchObject({
    centered: true,
    title: i18n.t('welcome.title'),
    subtitle: i18n.t('welcome.subtitle'),
  })
  expect(readFileSync(join(__dirname, '../App.tsx'), 'utf8')).not.toMatch(/\bfontSize\b/)
})

// The boot error is the one page a person sees when the wallets cannot be opened, so it names the
// address itself, before any press and whatever the mail does.
test('the boot error shows the support address before any press', async () => {
  jest.mocked(Keychain.getAllGenericPasswordServices).mockRejectedValueOnce(new Error('keychain unavailable'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const tree = await open()
  warn.mockRestore()

  expect(allText(tree)).toContain(i18n.t('welcome.bootFailed'))
  expect(allText(tree)).toContain(SUPPORT_EMAIL)
  // No mail went out yet, so no line speaks of one.
  expectMailFallback(tree, null, 'none')
  expect(await pressCopy(tree)).toBe(SUPPORT_EMAIL)
})

// At the largest text sizes the page is taller than the screen, and a centred page that cannot scroll
// cuts the logo at the top and the address at the bottom.
test('the boot error scrolls, so the logo and the support address stay reachable', async () => {
  jest.mocked(Keychain.getAllGenericPasswordServices).mockRejectedValueOnce(new Error('keychain unavailable'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const tree = await open()
  warn.mockRestore()

  const scrolls = (node: ReactTestRenderer.ReactTestInstance): boolean => {
    for (let at: ReactTestRenderer.ReactTestInstance | null = node; at; at = at.parent) {
      if (at.type === ScrollView) {
        return true
      }
    }
    return false
  }
  const address = tree.root.findAllByType(Text).find(node => node.props.children === SUPPORT_EMAIL)
  expect(address).toBeDefined()
  expect(scrolls(address!)).toBe(true)
  expect(tree.root.findAllByType(Image).some(scrolls)).toBe(true)
})

// A re-render of the app, as the splash finishing makes, must not take Copied back to Copy.
test('the boot error keeps Copied through a re-render of the app', async () => {
  jest.mocked(Keychain.getAllGenericPasswordServices).mockRejectedValueOnce(new Error('keychain unavailable'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const tree = await open()
  warn.mockRestore()

  expect(await pressCopy(tree)).toBe(SUPPORT_EMAIL)
  expect(allText(tree)).toContain(i18n.t('support.copied'))
  await ReactTestRenderer.act(async () => {
    tree.update(<App />)
  })
  expect(allText(tree)).toContain(i18n.t('support.copied'))
})

test('Write to support with no app for mail says so, and Copy takes the address', async () => {
  jest.mocked(Keychain.getAllGenericPasswordServices).mockRejectedValueOnce(new Error('keychain unavailable'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const openURL = jest.spyOn(Linking, 'openURL').mockClear().mockRejectedValue(new Error('no mail app'))
  const tree = await open()
  warn.mockRestore()

  await press(tree, i18n.t('welcome.contactSupport'))

  expect(openURL).toHaveBeenCalledWith(`mailto:${SUPPORT_EMAIL}`)
  expectMailFallback(tree, null)
  expect(await pressCopy(tree)).toBe(SUPPORT_EMAIL)
  openURL.mockRestore()
})
