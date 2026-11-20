import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, Switch, Text } from 'react-native'
import * as Keychain from 'react-native-keychain'
import '../src/i18n'
import i18n from '../src/i18n'
import { PinSettingsScreen } from '../src/screens/PinSettingsScreen'
import RNFS from 'react-native-fs'
import { biometricOfferAfterUnlock, enableBiometricUnlock } from '../src/wallet/biometrics'
import { alpha } from '../src/theme'

const mockNavigate = jest.fn()
// Bumped to stand for the screen gaining focus again, as it does when EnableBiometrics goes back.
let mockFocusKey = 0
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    ...jest.requireActual('@react-navigation/native'),
    useNavigation: () => ({ navigate: mockNavigate }),
    useFocusEffect: (callback: () => void | (() => void)) =>
      react.useEffect(callback, [callback, mockFocusKey]),
  }
})

const BIO_SERVICE = 'com.voltz.wallet.biometric'
const keychain = new Map<string, string>()

beforeEach(async () => {
  jest.clearAllMocks()
  keychain.clear()
  mockFocusKey = 0
  await i18n.changeLanguage('en-US')
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return { service: options?.service ?? '', storage: 'test' } as never
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options =>
    keychain.has(options?.service ?? ''),
  )
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => {
    keychain.delete(options?.service ?? '')
    return true
  })
  jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FINGERPRINT)
})
afterAll(async () => {
  await i18n.changeLanguage('pt-BR')
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
    tree = ReactTestRenderer.create(<PinSettingsScreen />)
  })
  await settle()
  return tree
}

async function refocus(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  mockFocusKey += 1
  await ReactTestRenderer.act(async () => {
    tree.update(<PinSettingsScreen />)
  })
  await settle()
}

// What would dim a node or refuse its touches, read off every ancestor up to the root.
function lockedAncestors(node: ReactTestRenderer.ReactTestInstance): string[] {
  const found: string[] = []
  for (let at: ReactTestRenderer.ReactTestInstance | null = node.parent; at; at = at.parent) {
    const { disabled, accessibilityState, style } = at.props
    const flat = StyleSheet.flatten(typeof style === 'function' ? style({ pressed: false }) : style)
    if (disabled === true) {
      found.push('disabled')
    }
    if (accessibilityState?.disabled === true) {
      found.push('accessibilityState.disabled')
    }
    if (flat?.opacity === alpha.disabled) {
      found.push('dimmed')
    }
  }
  return found
}

function biometricSwitch(tree: ReactTestRenderer.ReactTestRenderer): ReactTestRenderer.ReactTestInstance {
  return tree.root.findByType(Switch)
}

test('the biometric row draws at full strength, and nothing around its switch refuses a touch', async () => {
  const tree = await render()

  const label = tree.root.findAllByType(Text).find(node => node.props.children === 'Biometrics')
  expect(label).toBeDefined()
  expect(lockedAncestors(label!)).toEqual([])
  expect(lockedAncestors(biometricSwitch(tree))).toEqual([])
  expect(biometricSwitch(tree).props.accessibilityLabel).toBe('Biometrics')
})

test('the switch turns biometric unlock on through EnableBiometrics, and off again', async () => {
  const tree = await render()
  expect(biometricSwitch(tree).props.value).toBe(false)

  await ReactTestRenderer.act(async () => {
    biometricSwitch(tree).props.onValueChange(true)
  })
  await settle()
  // The switch stores nothing itself: the PIN behind the gate is the one typed on that route.
  expect(mockNavigate).toHaveBeenCalledWith('EnableBiometrics')
  expect(keychain.has(BIO_SERVICE)).toBe(false)

  // What the route does with the PIN typed there, followed by the step back to this screen.
  await enableBiometricUnlock('135790')
  await refocus(tree)
  expect(biometricSwitch(tree).props.value).toBe(true)

  await ReactTestRenderer.act(async () => {
    biometricSwitch(tree).props.onValueChange(false)
  })
  await settle()
  expect(keychain.has(BIO_SERVICE)).toBe(false)
  expect(biometricSwitch(tree).props.value).toBe(false)
  expect(mockNavigate).toHaveBeenCalledTimes(1)
})

// OB-11. The switch is an answer to the biometric offer, so whoever turned biometrics off here is not
// offered them again after the next keypad unlock.
describe('touching the switch marks the offer as made', () => {
  const OFFERED = `${RNFS.DocumentDirectoryPath}/biometric-offer.json`

  beforeEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  async function flip(tree: ReactTestRenderer.ReactTestRenderer, value: boolean): Promise<void> {
    await ReactTestRenderer.act(async () => {
      biometricSwitch(tree).props.onValueChange(value)
    })
    await settle()
  }

  test('turning biometrics off leaves no offer for the next unlock', async () => {
    await enableBiometricUnlock('135790')
    const tree = await render()
    expect(await RNFS.exists(OFFERED)).toBe(false)

    await flip(tree, false)

    expect(keychain.has(BIO_SERVICE)).toBe(false)
    expect(await RNFS.exists(OFFERED)).toBe(true)
    expect(await biometricOfferAfterUnlock()).toBeNull()
  })

  test('turning biometrics on marks it too, before the PIN route opens', async () => {
    const tree = await render()

    await flip(tree, true)

    expect(mockNavigate).toHaveBeenCalledWith('EnableBiometrics')
    expect(await RNFS.exists(OFFERED)).toBe(true)
  })

  test('a mark that cannot be written still turns biometrics off', async () => {
    await enableBiometricUnlock('135790')
    const tree = await render()
    const write = RNFS.writeFile.bind(RNFS)
    jest.spyOn(RNFS, 'writeFile').mockImplementation(async (path, content, encoding) => {
      if (path === OFFERED) {
        throw new Error('disk full')
      }
      return write(path, content, encoding)
    })

    await flip(tree, false)

    expect(keychain.has(BIO_SERVICE)).toBe(false)
    expect(biometricSwitch(tree).props.value).toBe(false)
  })

  // With no touch the same unlock offers, so the mark above is what answers null.
  test('with the switch untouched, the next keypad unlock still offers', async () => {
    await render()
    expect(await biometricOfferAfterUnlock()).toBe('fingerprint')
  })
})

test('without enrolled biometry there is no biometric row', async () => {
  jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(null)
  const tree = await render()

  expect(tree.root.findAllByType(Switch)).toHaveLength(0)
})
