import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { BackHandler, DeviceEventEmitter, Text, TextInput } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import { wordlists } from 'bip39'
import { State } from 'react-native-gesture-handler'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'
import App from '../App'

// Jest resolves react-native for iOS, whose BackHandler drops every listener. The Android module is
// the one that runs on the phone: it calls the listeners newest first and exits the app when none of
// them takes the press, so a press here goes through the same code a back gesture does.
jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/BackHandler.android'),
)
// The navigator is past the onboarding; a marker says the app got there.
jest.mock('../src/navigation/RootNavigator', () => {
  const react = require('react')
  const { Text: RNText } = require('react-native')
  return { RootNavigator: () => react.createElement(RNText, null, 'NAVIGATOR') }
})

const ENGLISH: readonly string[] = wordlists.english
const SEED_SERVICE = 'com.voltz.wallet.seed'
const PIN_SERVICE = 'com.voltz.wallet.pin'
const VALID_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// A Keychain that remembers what it was given, so a step back can be checked against what is stored.
const keychain = new Map<string, string>()
// When set, the next seed write waits for release(), which holds the app mid-write.
let pendingHold = false
let holdSeedWrite: { release: () => void } | null = null

beforeEach(() => {
  jest.clearAllMocks()
  keychain.clear()
  // The first run records its wallet in the registry, and a wallet left listed by the test before
  // would send this run's seed to an id of its own instead of the primary slot watched here.
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  holdSeedWrite = null
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    const service = options?.service ?? ''
    if (service === SEED_SERVICE && holdSeedWrite === null && pendingHold) {
      await new Promise<void>(resolve => {
        holdSeedWrite = { release: resolve }
      })
    }
    keychain.set(service, password)
    return { service, storage: 'test' } as never
  })
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options =>
    keychain.has(options?.service ?? ''),
  )
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => {
    keychain.delete(options?.service ?? '')
    return true
  })
  jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(null)
  pendingHold = false
})

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
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

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
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

function backControls(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    node => node.props.accessibilityLabel === 'Back' && typeof node.props.onPress === 'function',
  )
}

// Every drawn element labelled Back, whether or not it does anything, so a Back that is drawn with no
// effect still counts. Host elements only, since each control also has composite parents with the
// same label.
function backLabels(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'Back')
}

async function pressBackControl(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  const [control] = backControls(tree)
  if (!control) {
    throw new Error('no back control on screen')
  }
  await ReactTestRenderer.act(async () => {
    control.props.onPress()
  })
  await settle()
}

// What the system sends on the back gesture or the back key.
async function androidBack(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    DeviceEventEmitter.emit('hardwareBackPress', {})
  })
  await settle()
}

// A swipe from the leading edge, as far as `distance` points along the screen.
async function edgeSwipe(distance: number): Promise<void> {
  await ReactTestRenderer.act(async () => {
    fireGestureHandler(getByGestureTestId('onboarding-edge-back'), [
      { state: State.BEGAN, translationX: 0, velocityX: 0 },
      { state: State.ACTIVE, translationX: distance / 2, velocityX: 0 },
      { state: State.END, translationX: distance, velocityX: 0 },
    ])
  })
  await settle()
}

function shownMnemonic(tree: ReactTestRenderer.ReactTestRenderer): string {
  return allText(tree)
    .filter(text => ENGLISH.includes(text))
    .join(' ')
}

function seedWrites(): number {
  return jest
    .mocked(Keychain.setGenericPassword)
    .mock.calls.filter(([, , options]) => options?.service === SEED_SERVICE).length
}

async function typePhrase(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  const inputs = tree.root.findAllByType(TextInput)
  const words = VALID_12.split(' ')
  for (let i = 0; i < words.length; i++) {
    await ReactTestRenderer.act(async () => {
      inputs[i].props.onChangeText(words[i])
    })
  }
  await settle()
}

let exitApp: jest.SpyInstance
beforeEach(() => {
  exitApp = jest.spyOn(BackHandler, 'exitApp').mockImplementation(() => undefined)
})
afterEach(() => {
  exitApp.mockRestore()
})

test('every step before the first write steps back to the welcome, and stepping back writes nothing', async () => {
  const tree = await render()

  await press(tree, 'Create wallet')
  expect(shownMnemonic(tree).split(' ')).toHaveLength(12)
  await pressBackControl(tree)
  expect(allText(tree)).toContain('Create wallet')

  await press(tree, 'Create wallet')
  await androidBack()
  expect(allText(tree)).toContain('Create wallet')

  await press(tree, 'I already have a wallet')
  await pressBackControl(tree)
  expect(allText(tree)).toContain('Create wallet')

  expect(exitApp).not.toHaveBeenCalled()
  expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
  expect(Keychain.resetGenericPassword).not.toHaveBeenCalled()
  expect(keychain.size).toBe(0)
})

test('Android back never leaves the app mid-onboarding, and on welcome keeps the system default', async () => {
  const tree = await render()

  await press(tree, 'I already have a wallet')
  await androidBack()
  expect(allText(tree)).toContain('Create wallet')
  expect(exitApp).not.toHaveBeenCalled()

  // Welcome is the start, so back there is the system's, which closes the app.
  await androidBack()
  expect(exitApp).toHaveBeenCalledTimes(1)
})

test('once the seed write starts there is no back, so a second seed cannot be written', async () => {
  pendingHold = true
  const tree = await render()

  await press(tree, 'Create wallet')
  const words = shownMnemonic(tree)
  expect(backLabels(tree)).not.toHaveLength(0)

  // The write is held open, and a step back from here could lead into a second write.
  await press(tree, 'I wrote them down safely')
  expect(holdSeedWrite).not.toBeNull()
  expect(backLabels(tree)).toHaveLength(0)
  await androidBack()
  expect(shownMnemonic(tree)).toBe(words)
  expect(exitApp).not.toHaveBeenCalled()

  await ReactTestRenderer.act(async () => {
    holdSeedWrite?.release()
  })
  await settle()
  expect(allText(tree)).toContain('Create a PIN')

  // Past the write the PIN step has no back either, and Android back does nothing.
  expect(backLabels(tree)).toHaveLength(0)
  await androidBack()
  expect(allText(tree)).toContain('Create a PIN')
  expect(exitApp).not.toHaveBeenCalled()
  expect(seedWrites()).toBe(1)
  expect(keychain.get(SEED_SERVICE)).toBe(words)
})

test('a restore that started writing has no back either', async () => {
  pendingHold = true
  const tree = await render()

  await press(tree, 'I already have a wallet')
  await typePhrase(tree)
  expect(backLabels(tree)).toHaveLength(1)

  await press(tree, 'Restore')
  expect(holdSeedWrite).not.toBeNull()
  expect(backLabels(tree)).toHaveLength(0)
  await androidBack()
  expect(allText(tree)).not.toContain('Create wallet')
  expect(exitApp).not.toHaveBeenCalled()

  await ReactTestRenderer.act(async () => {
    holdSeedWrite?.release()
  })
  await settle()
  expect(allText(tree)).toContain('Create a PIN')
  expect(seedWrites()).toBe(1)
})

// A second tap while the first write runs would store the phrase again, or a second wallet beside it.
test('a second tap on I wrote them down or Restore while the first write runs writes once', async () => {
  pendingHold = true
  const tree = await render()
  await press(tree, 'Create wallet')

  await press(tree, 'I wrote them down safely')
  expect(holdSeedWrite).not.toBeNull()
  await press(tree, 'I wrote them down safely')
  await ReactTestRenderer.act(async () => {
    holdSeedWrite?.release()
  })
  await settle()
  expect(allText(tree)).toContain('Create a PIN')
  expect(seedWrites()).toBe(1)
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })

  ;(RNFS as unknown as { __reset: () => void }).__reset()
  keychain.clear()
  jest.mocked(Keychain.setGenericPassword).mockClear()
  holdSeedWrite = null
  const restore = await render()
  await press(restore, 'I already have a wallet')
  await typePhrase(restore)
  await press(restore, 'Restore')
  expect(holdSeedWrite).not.toBeNull()
  await press(restore, 'Restore')
  await ReactTestRenderer.act(async () => {
    holdSeedWrite?.release()
  })
  await settle()
  expect(allText(restore)).toContain('Create a PIN')
  expect(seedWrites()).toBe(1)
})

const SAVE_FAILED = 'The wallet could not be saved on this device. Try again.'

function refuseSeedWrite() {
  const store = jest.mocked(Keychain.setGenericPassword).getMockImplementation()!
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (user, password, options) => {
    if (options?.service === SEED_SERVICE) {
      throw new Error('interaction not allowed')
    }
    return store(user, password, options)
  })
  return () => jest.mocked(Keychain.setGenericPassword).mockImplementation(store)
}

test('a first write that failed says so, and the same button writes the same words', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const tree = await render()
  await press(tree, 'Create wallet')
  const words = shownMnemonic(tree)

  const restoreKeychain = refuseSeedWrite()
  await press(tree, 'I wrote them down safely')
  expect(allText(tree)).toContain(SAVE_FAILED)
  expect(shownMnemonic(tree)).toBe(words)
  expect(keychain.has(SEED_SERVICE)).toBe(false)
  // The button repeats the write, and a second refusal keeps the message.
  await press(tree, 'I wrote them down safely')
  expect(seedWrites()).toBe(2)
  expect(allText(tree)).toContain(SAVE_FAILED)

  restoreKeychain()
  await press(tree, 'I wrote them down safely')
  expect(allText(tree)).toContain('Create a PIN')
  expect(allText(tree)).not.toContain(SAVE_FAILED)
  expect(keychain.get(SEED_SERVICE)).toBe(words)
  warn.mockRestore()
})

test('a restore that failed says so, and Restore writes the same words', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const tree = await render()
  await press(tree, 'I already have a wallet')
  await typePhrase(tree)

  const restoreKeychain = refuseSeedWrite()
  await press(tree, 'Restore')
  expect(allText(tree)).toContain(SAVE_FAILED)
  expect(tree.root.findAllByType(TextInput)[11].props.value).toBe('about')

  restoreKeychain()
  await press(tree, 'Restore')
  expect(allText(tree)).toContain('Create a PIN')
  expect(keychain.get(SEED_SERVICE)).toBe(VALID_12)
  warn.mockRestore()
})

test('a PIN that could not be saved says so, and Try again saves the same PIN', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const tree = await render()
  await press(tree, 'Create wallet')
  await press(tree, 'I wrote them down safely')

  const store = jest.mocked(Keychain.setGenericPassword).getMockImplementation()!
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (user, password, options) => {
    if (options?.service === PIN_SERVICE) {
      throw new Error('interaction not allowed')
    }
    return store(user, password, options)
  })
  for (const digit of '135790135790') {
    await press(tree, digit)
  }
  expect(allText(tree)).toContain('Your PIN could not be saved on this device. Try again.')
  expect(keychain.has(PIN_SERVICE)).toBe(false)
  expect(allText(tree)).not.toContain('NAVIGATOR')

  jest.mocked(Keychain.setGenericPassword).mockImplementation(store)
  await press(tree, 'Try again')
  expect(keychain.get(PIN_SERVICE)).toBe('135790')
  expect(allText(tree)).toContain('NAVIGATOR')
  warn.mockRestore()
})

// Every string held in a hook of the mounted tree, read from the fibers, since the state that matters
// here is never drawn.
function heldStrings(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  const found: string[] = []
  const seen = new Set<unknown>()
  const collect = (value: unknown, depth: number) => {
    if (typeof value === 'string') {
      found.push(value)
      return
    }
    if (value === null || typeof value !== 'object' || depth > 4 || seen.has(value)) {
      return
    }
    seen.add(value)
    for (const [key, inner] of Object.entries(value)) {
      if (key !== 'next' && key !== 'queue' && key !== '_owner' && typeof inner !== 'function') {
        collect(inner, depth + 1)
      }
    }
  }
  type Fiber = { memoizedState: unknown; child: Fiber | null; sibling: Fiber | null }
  const walk = (fiber: Fiber | null) => {
    for (let node = fiber; node; node = node.sibling) {
      let hook = node.memoizedState as { memoizedState: unknown; next: unknown } | null
      while (hook && typeof hook === 'object' && 'next' in hook) {
        collect(hook.memoizedState, 0)
        hook = hook.next as typeof hook
      }
      walk(node.child)
    }
  }
  walk((tree.root as unknown as { _currentFiber: () => Fiber })._currentFiber())
  return found
}

function heldPhrases(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return heldStrings(tree).filter(text => {
    const parts = text.split(' ')
    return parts.length >= 12 && parts.every(word => ENGLISH.includes(word))
  })
}

test('nothing of the seed stays in memory past the write: no phrase and no drawn pair', async () => {
  const tree = await render()
  await press(tree, 'Create wallet')
  // As a control, the walk finds the phrase while it is on screen, and both drawn lengths with it.
  expect(heldPhrases(tree)).toContain(shownMnemonic(tree))
  await press(tree, 'I wrote them down safely')
  expect(allText(tree)).toContain('Create a PIN')
  expect(heldPhrases(tree)).toEqual([])
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })

  // A pair drawn and left for a restore goes with the restore's write.
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  keychain.clear()
  const restore = await render()
  await press(restore, 'Create wallet')
  expect(heldPhrases(restore)).toContain(shownMnemonic(restore))
  await pressBackControl(restore)
  await press(restore, 'I already have a wallet')
  await typePhrase(restore)
  await press(restore, 'Restore')
  expect(allText(restore)).toContain('Create a PIN')
  expect(heldPhrases(restore)).toEqual([])
})

test('Android back on the biometric offer keeps the offer up and never leaves the app', async () => {
  jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FINGERPRINT)
  const tree = await render()
  await press(tree, 'I already have a wallet')
  await typePhrase(tree)
  await press(tree, 'Restore')
  for (const digit of '135790135790') {
    await press(tree, digit)
  }
  expect(allText(tree)).toContain('Unlock with your fingerprint?')

  await androidBack()
  expect(allText(tree)).toContain('Unlock with your fingerprint?')
  expect(allText(tree)).not.toContain('NAVIGATOR')
  expect(exitApp).not.toHaveBeenCalled()

  // The offer still answers after the press.
  await press(tree, 'Not now')
  expect(allText(tree)).toContain('NAVIGATOR')
})

// The first-run steps sit outside the navigator, so iOS had no swipe back on them while the button
// worked. The swipe takes the same steps as the button and Android back, and none past the seed write.
test('a swipe from the leading edge steps back as the button does, and a short one does nothing', async () => {
  const tree = await render()

  await press(tree, 'Create wallet')
  const words = shownMnemonic(tree)

  // Not far enough, so it springs back.
  await edgeSwipe(20)
  expect(shownMnemonic(tree)).toBe(words)

  await edgeSwipe(120)
  expect(allText(tree)).toContain('Create wallet')

  expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
  expect(keychain.size).toBe(0)
})

test('the edge swipe takes no step once the seed write starts', async () => {
  pendingHold = true
  const tree = await render()

  await press(tree, 'Create wallet')
  const words = shownMnemonic(tree)
  await press(tree, 'I wrote them down safely')
  expect(holdSeedWrite).not.toBeNull()

  await edgeSwipe(120)
  expect(shownMnemonic(tree)).toBe(words)

  await ReactTestRenderer.act(async () => {
    holdSeedWrite?.release()
  })
  await settle()
  expect(allText(tree)).toContain('Create a PIN')
  expect(seedWrites()).toBe(1)
})
