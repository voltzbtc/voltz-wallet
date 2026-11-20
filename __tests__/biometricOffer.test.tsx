import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import * as Keychain from 'react-native-keychain'
import RNFS from 'react-native-fs'
import App from '../App'
import i18n from '../src/i18n'

// The navigator is past the PIN; a marker says the app got there.
jest.mock('../src/navigation/RootNavigator', () => {
  const react = require('react')
  const { Text: RNText } = require('react-native')
  return { RootNavigator: () => react.createElement(RNText, null, 'NAVIGATOR') }
})

const SEED_SERVICE = 'com.voltz.wallet.seed'
const PIN_SERVICE = 'com.voltz.wallet.pin'
const BIO_SERVICE = 'com.voltz.wallet.biometric.currentSet'
const VALID_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// A Keychain that remembers what it was given. A read of the biometric entry is what raises the
// system prompt, so `biometricRead` decides how that prompt ends.
const keychain = new Map<string, string>()
let biometricRead: 'ok' | 'cancel' | 'fail' = 'ok'
let biometricWrite: 'ok' | 'cancel' = 'ok'

beforeEach(() => {
  jest.clearAllMocks()
  keychain.clear()
  // The device's own record of the offer lives in the documents directory, which a test starts empty.
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  biometricRead = 'ok'
  biometricWrite = 'ok'
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    const service = options?.service ?? ''
    if (service === BIO_SERVICE && biometricWrite === 'cancel') {
      throw new Error('code: 13, msg: Cancel')
    }
    keychain.set(service, password)
    return { service, storage: 'test' } as never
  })
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const service = options?.service ?? ''
    if (service === BIO_SERVICE && biometricRead === 'cancel') {
      throw new Error('code: 13, msg: Cancel')
    }
    // A face or finger that does not match ends the prompt with errSecAuthFailed, which the library
    // rejects with; only an entry that is not there reads as false.
    if (service === BIO_SERVICE && biometricRead === 'fail') {
      throw new Error('code: -25293, msg: Authentication failed')
    }
    const password = keychain.get(service)
    return password === undefined ? false : ({ username: 'u', password } as never)
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

// A biometric unlock opens the app once the dots have filled.
async function dotsFilled(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 300))
  })
  await settle()
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

async function typePin(tree: ReactTestRenderer.ReactTestRenderer, pin: string): Promise<void> {
  for (const digit of pin) {
    await press(tree, digit)
  }
}

// The shortest way to the PIN step: a restore writes the seed and goes straight to it.
async function reachSetPin(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await press(tree, 'I already have a wallet')
  const { TextInput } = require('react-native')
  const inputs = tree.root.findAllByType(TextInput)
  const words = VALID_12.split(' ')
  for (let i = 0; i < words.length; i++) {
    await ReactTestRenderer.act(async () => {
      inputs[i].props.onChangeText(words[i])
    })
  }
  await press(tree, 'Restore')
  expect(allText(tree)).toContain('Create a PIN')
}

function biometricWrites() {
  return jest
    .mocked(Keychain.setGenericPassword)
    .mock.calls.filter(([, , options]) => options?.service === BIO_SERVICE)
}

describe('the offer right after the first PIN', () => {
  test('turning it on stores the PIN that was just set, behind the biometric gate', async () => {
    const tree = await render()
    await reachSetPin(tree)

    // A mismatched confirmation starts over, so the PIN kept is the one confirmed last.
    await typePin(tree, '111111')
    await typePin(tree, '222222')
    expect(allText(tree)).toContain('The PINs do not match. Try again.')
    await typePin(tree, '135790')
    await typePin(tree, '135790')

    expect(allText(tree)).toContain('Unlock with your fingerprint?')
    await press(tree, 'Turn on')

    expect(allText(tree)).toContain('NAVIGATOR')
    expect(keychain.get(PIN_SERVICE)).toBe('135790')
    expect(keychain.get(BIO_SERVICE)).toBe('135790')
    const writes = biometricWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0][2]).toEqual(
      expect.objectContaining({
        accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
        authenticationPrompt: { title: 'Confirm your fingerprint', cancel: 'Cancel' },
      }),
    )
  })

  test('not now stores nothing and goes on to the wallet', async () => {
    const tree = await render()
    await reachSetPin(tree)
    await typePin(tree, '135790')
    await typePin(tree, '135790')

    await press(tree, 'Not now')

    expect(allText(tree)).toContain('NAVIGATOR')
    expect(biometricWrites()).toHaveLength(0)
    expect(keychain.has(BIO_SERVICE)).toBe(false)
    expect(keychain.get(PIN_SERVICE)).toBe('135790')
  })

  test('a cancelled system prompt keeps the offer up with nothing stored, and skipping still works', async () => {
    biometricWrite = 'cancel'
    const tree = await render()
    await reachSetPin(tree)
    await typePin(tree, '135790')
    await typePin(tree, '135790')

    await press(tree, 'Turn on')
    expect(allText(tree)).toContain('Unlock with your fingerprint?')
    expect(allText(tree)).toContain(
      'It was not turned on. Try again, or turn it on later under PIN in the menu.',
    )
    expect(keychain.has(BIO_SERVICE)).toBe(false)

    await press(tree, 'Not now')
    expect(allText(tree)).toContain('NAVIGATOR')
    expect(keychain.has(BIO_SERVICE)).toBe(false)
  })

  test('names the face when the device unlocks with the face', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FACE_ID)
    const tree = await render()
    await reachSetPin(tree)
    await typePin(tree, '135790')
    await typePin(tree, '135790')

    expect(allText(tree)).toContain('Unlock with your face?')
    expect(allText(tree)).not.toContain('Unlock with your fingerprint?')
  })

  test('is never offered without enrolled biometry', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(null)
    const tree = await render()
    await reachSetPin(tree)
    await typePin(tree, '135790')
    await typePin(tree, '135790')

    expect(allText(tree)).toContain('NAVIGATOR')
    expect(allText(tree)).not.toContain('Unlock with your fingerprint?')
    expect(allText(tree)).not.toContain('Unlock with your face?')
    expect(biometricWrites()).toHaveLength(0)
  })

  test('a failed biometry read after the PIN goes on to the wallet with no offer', async () => {
    const tree = await render()
    await reachSetPin(tree)
    jest.mocked(Keychain.getSupportedBiometryType).mockRejectedValue(new Error('no hardware module'))
    await typePin(tree, '135790')
    await typePin(tree, '135790')

    expect(allText(tree)).toContain('NAVIGATOR')
    expect(allText(tree)).not.toContain('Unlock with your fingerprint?')
    expect(keychain.get(PIN_SERVICE)).toBe('135790')
    expect(biometricWrites()).toHaveLength(0)
  })

  // The mark is written as the offer shows. When that write fails the offer still shows, and the
  // unlock after it, which finds no mark, offers once more and marks then.
  test('a failed mark costs at most one more offer', async () => {
    const offerFile = /biometric-offer\.json$/
    const write = RNFS.writeFile
    const failing = jest
      .spyOn(RNFS, 'writeFile')
      .mockImplementation(async (path, ...rest) =>
        offerFile.test(path) ? Promise.reject(new Error('ENOSPC')) : write(path, ...rest),
      )
    const first = await render()
    try {
      await reachSetPin(first)
      await typePin(first, '135790')
      await typePin(first, '135790')
      expect(allText(first)).toContain('Unlock with your fingerprint?')
      await press(first, 'Not now')
      expect(allText(first)).toContain('NAVIGATOR')
    } finally {
      failing.mockRestore()
    }
    await ReactTestRenderer.act(async () => {
      first.unmount()
    })

    const second = await render()
    await typePin(second, '135790')
    expect(allText(second)).toContain('Unlock with your fingerprint?')
    await press(second, 'Not now')
    await ReactTestRenderer.act(async () => {
      second.unmount()
    })

    const third = await render()
    await typePin(third, '135790')
    expect(allText(third)).toContain('NAVIGATOR')
    expect(allText(third)).not.toContain('Unlock with your fingerprint?')
    expect(biometricWrites()).toHaveLength(0)
  })

})

describe('the unlock screen', () => {
  function storedWallet(withBiometric: boolean) {
    keychain.set(SEED_SERVICE, VALID_12)
    keychain.set(PIN_SERVICE, '135790')
    if (withBiometric) {
      keychain.set(BIO_SERVICE, '135790')
    }
  }

  function biometricReads(): number {
    return jest
      .mocked(Keychain.getGenericPassword)
      .mock.calls.filter(([options]) => options?.service === BIO_SERVICE).length
  }

  test('asks for the biometric on open and unlocks with it', async () => {
    storedWallet(true)
    const tree = await render()
    await dotsFilled()

    expect(biometricReads()).toBe(1)
    expect(allText(tree)).toContain('NAVIGATOR')
  })

  test('a cancelled prompt falls back to the keypad, which still unlocks', async () => {
    storedWallet(true)
    biometricRead = 'cancel'
    const tree = await render()

    expect(biometricReads()).toBe(1)
    expect(allText(tree)).toContain('Enter your PIN')
    expect(allText(tree)).not.toContain('NAVIGATOR')

    await typePin(tree, '135790')
    expect(allText(tree)).toContain('NAVIGATOR')
  })

  test('a failed match never locks out: a wrong PIN and then the right one still unlock', async () => {
    storedWallet(true)
    biometricRead = 'fail'
    const tree = await render()
    expect(allText(tree)).toContain('Enter your PIN')

    await typePin(tree, '000000')
    expect(allText(tree)).toContain('Wrong PIN')
    await typePin(tree, '135790')
    expect(allText(tree)).toContain('NAVIGATOR')
  })

  test('without the biometric turned on it asks for nothing', async () => {
    storedWallet(false)
    const tree = await render()

    expect(biometricReads()).toBe(0)
    expect(allText(tree)).toContain('Enter your PIN')
  })
})

// An install whose PIN was set before the offer existed meets it after a keypad unlock, once per
// device.
describe('the offer after a keypad unlock', () => {
  function storedWallet(withBiometric = false) {
    keychain.set(SEED_SERVICE, VALID_12)
    keychain.set(PIN_SERVICE, '135790')
    if (withBiometric) {
      keychain.set(BIO_SERVICE, '135790')
    }
  }

  const OFFER = 'Unlock with your fingerprint?'

  // The app closing, which the next render opens again on the same Keychain and documents.
  async function close(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
  }

  test('shows only once the PIN verifies, and turning it on stores the PIN just typed', async () => {
    storedWallet()
    const tree = await render()
    expect(allText(tree)).toContain('Enter your PIN')
    expect(allText(tree)).not.toContain(OFFER)

    await typePin(tree, '000000')
    expect(allText(tree)).toContain('Wrong PIN')
    expect(allText(tree)).not.toContain(OFFER)

    await typePin(tree, '135790')
    expect(allText(tree)).toContain(OFFER)
    await press(tree, 'Turn on')

    expect(allText(tree)).toContain('NAVIGATOR')
    expect(keychain.get(BIO_SERVICE)).toBe('135790')
    const writes = biometricWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0][2]).toEqual(
      expect.objectContaining({
        accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
        authenticationPrompt: { title: 'Confirm your fingerprint', cancel: 'Cancel' },
      }),
    )
  })

  test('not now goes straight on and is remembered, so the next keypad unlock asks nothing', async () => {
    storedWallet()
    const first = await render()
    await typePin(first, '135790')
    await press(first, 'Not now')
    expect(allText(first)).toContain('NAVIGATOR')
    expect(biometricWrites()).toHaveLength(0)
    await close(first)

    const second = await render()
    await typePin(second, '135790')
    expect(allText(second)).toContain('NAVIGATOR')
    expect(allText(second)).not.toContain(OFFER)
    expect(biometricWrites()).toHaveLength(0)
  })

  test('closing the app with the offer on screen still counts as the one time', async () => {
    storedWallet()
    const first = await render()
    await typePin(first, '135790')
    expect(allText(first)).toContain(OFFER)
    await close(first)

    const second = await render()
    await typePin(second, '135790')
    expect(allText(second)).toContain('NAVIGATOR')
    expect(biometricWrites()).toHaveLength(0)
  })

  test('a biometric unlock goes straight on, and so does the keypad while it is turned on', async () => {
    storedWallet(true)
    const tree = await render()
    await dotsFilled()
    expect(allText(tree)).toContain('NAVIGATOR')
    expect(allText(tree)).not.toContain(OFFER)
    await close(tree)

    biometricRead = 'cancel'
    const keypad = await render()
    await typePin(keypad, '135790')
    expect(allText(keypad)).toContain('NAVIGATOR')
    expect(biometricWrites()).toHaveLength(0)
  })

  test('without enrolled biometry nothing is offered or marked, so enrolling later still gets the offer', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(null)
    storedWallet()
    const first = await render()
    await typePin(first, '135790')
    expect(allText(first)).toContain('NAVIGATOR')
    await close(first)

    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FINGERPRINT)
    const second = await render()
    await typePin(second, '135790')
    expect(allText(second)).toContain(OFFER)
  })

  test('a failed biometry read or a failed mark never holds the unlock, and never shows an unmarked offer', async () => {
    storedWallet()
    jest.mocked(Keychain.getSupportedBiometryType).mockRejectedValue(new Error('no hardware module'))
    const first = await render()
    await typePin(first, '135790')
    expect(allText(first)).toContain('NAVIGATOR')
    await close(first)

    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FINGERPRINT)
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValue(new Error('ENOSPC'))
    try {
      const second = await render()
      await typePin(second, '135790')
      expect(allText(second)).toContain('NAVIGATOR')
      expect(allText(second)).not.toContain(OFFER)
    } finally {
      write.mockRestore()
    }
  })

  test('a wallet that met the offer while setting its first PIN is not offered it again at unlock', async () => {
    const first = await render()
    await reachSetPin(first)
    await typePin(first, '135790')
    await typePin(first, '135790')
    await press(first, 'Not now')
    expect(allText(first)).toContain('NAVIGATOR')
    await close(first)

    const second = await render()
    expect(allText(second)).toContain('Enter your PIN')
    await typePin(second, '135790')
    expect(allText(second)).toContain('NAVIGATOR')
    expect(biometricWrites()).toHaveLength(0)
  })
})

// Both roads to the offer turn it on through the same call, so one of them carries the language.
test('the prompt for the write speaks the language on screen', async () => {
  await i18n.changeLanguage('pt-BR')
  try {
    keychain.set(SEED_SERVICE, VALID_12)
    keychain.set(PIN_SERVICE, '135790')
    const tree = await render()
    await typePin(tree, '135790')
    expect(allText(tree)).toContain(i18n.t('biometricOffer.titleFingerprint'))
    await press(tree, i18n.t('biometricOffer.enable'))

    const prompt = biometricWrites()[0]?.[2]?.authenticationPrompt
    expect(prompt).toEqual({
      title: i18n.t('biometricOffer.confirmFingerprint'),
      cancel: i18n.t('common.cancel'),
    })
    expect(prompt?.title).not.toBe('Confirm your fingerprint')
    expect(prompt?.cancel).not.toBe('Cancel')
  } finally {
    await i18n.changeLanguage('en-US')
  }
})
