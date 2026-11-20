import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import * as Keychain from 'react-native-keychain'
import i18n from '../src/i18n'
import { EnableBiometricsFlow } from '../src/navigation/RootNavigator'

// The keypad's check, over the comparison each case decides, with no wrong-PIN wait.
jest.mock('../src/wallet/pin', () => {
  const compare = jest.fn(async (_pin: string) => true)
  return {
    hasPin: jest.fn(), savePin: jest.fn(), verifyPin: compare,
    enterPin: jest.fn(async (pin: string) => ((await compare(pin)) ? { ok: true } : { ok: false, waitMs: 0 })),
    pinWaitLeft: jest.fn(async () => 0),
    clearPinFailures: jest.fn(async () => undefined),
  }
})

const BIO_SERVICE = 'com.voltz.wallet.biometric'
const keychain = new Map<string, string>()
let write: 'ok' | 'cancel' = 'ok'

beforeEach(async () => {
  jest.clearAllMocks()
  keychain.clear()
  write = 'ok'
  await i18n.changeLanguage('en-US')
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    // Android raises the system prompt on this write, and a cancelled prompt rejects it.
    if (write === 'cancel') {
      throw new Error('code: 13, msg: Cancel')
    }
    keychain.set(options?.service ?? '', password)
    return { service: options?.service ?? '', storage: 'test' } as never
  })
  jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FINGERPRINT)
})

afterAll(async () => {
  await i18n.changeLanguage('en-US')
})

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

async function enable(onDone: () => void): Promise<void> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<EnableBiometricsFlow onDone={onDone} />)
  })
  await settle()
  for (const digit of '135790') {
    const key = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(text => text.props.children === digit))
    if (!key) {
      throw new Error(`keypad digit not found: ${digit}`)
    }
    await ReactTestRenderer.act(async () => {
      key.props.onPress()
    })
  }
  await settle()
}

function promptOfWrite() {
  const writes = jest
    .mocked(Keychain.setGenericPassword)
    .mock.calls.filter(([, , options]) => options?.service === BIO_SERVICE)
  expect(writes).toHaveLength(1)
  return writes[0][2]?.authenticationPrompt
}

test('stores the typed PIN behind a prompt worded as the first-run offer words it', async () => {
  const onDone = jest.fn()
  await enable(onDone)

  expect(keychain.get(BIO_SERVICE)).toBe('135790')
  expect(promptOfWrite()).toEqual({ title: 'Confirm your fingerprint', cancel: 'Cancel' })
  expect(onDone).toHaveBeenCalledTimes(1)
})

test('names the face, and speaks the language on screen, never the library default', async () => {
  jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FACE)
  await i18n.changeLanguage('pt-BR')
  await enable(jest.fn())

  const prompt = promptOfWrite()
  expect(prompt).toEqual({ title: i18n.t('biometricOffer.confirmFace'), cancel: i18n.t('common.cancel') })
  expect(prompt?.title).not.toBe('Confirm your face')
  expect(prompt?.cancel).not.toBe('Cancel')
})

test('a cancelled prompt stores nothing and still leaves, so the settings read the switch as off', async () => {
  write = 'cancel'
  const onDone = jest.fn()
  await enable(onDone)

  expect(keychain.has(BIO_SERVICE)).toBe(false)
  expect(onDone).toHaveBeenCalledTimes(1)
})

test('a failed biometry read still asks with a worded prompt', async () => {
  jest.mocked(Keychain.getSupportedBiometryType).mockRejectedValue(new Error('no hardware module'))
  const onDone = jest.fn()
  await enable(onDone)

  expect(promptOfWrite()).toEqual({ title: 'Confirm your fingerprint', cancel: 'Cancel' })
  expect(onDone).toHaveBeenCalledTimes(1)
})
