import {
  savePassphraseFor,
  loadPassphraseFor,
  deletePassphraseFor,
  PRIMARY_ID,
} from '../src/wallet/seed'
import { fingerprintFromMnemonic } from '../src/wallet/fingerprint'

// The mock keys by service so per-wallet entries stay isolated the way the real Keychain does.
jest.mock('react-native-keychain', () => {
  const store = new Map<string, string>()
  return {
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly' },
    setGenericPassword: jest.fn(async (_user: string, password: string, opts: { service: string }) => {
      store.set(opts.service, password)
      return true
    }),
    getGenericPassword: jest.fn(async (opts: { service: string }) => {
      const password = store.get(opts.service)
      return password === undefined ? false : { username: 'passphrase', password, service: opts.service }
    }),
    resetGenericPassword: jest.fn(async (opts: { service: string }) => {
      store.delete(opts.service)
      return true
    }),
  }
})

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('passphrase storage', () => {
  test('saves and loads a passphrase for a wallet', async () => {
    await savePassphraseFor(PRIMARY_ID, 'correct horse')
    expect(await loadPassphraseFor(PRIMARY_ID)).toBe('correct horse')
  })

  test('no passphrase set -> undefined (the base wallet)', async () => {
    expect(await loadPassphraseFor('never-set')).toBeUndefined()
  })

  // Storing "" instead of clearing would leave a stale passphrase and silently open another wallet.
  test('saving an empty passphrase clears any stored one', async () => {
    await savePassphraseFor('w2', 'temp')
    await savePassphraseFor('w2', '')
    expect(await loadPassphraseFor('w2')).toBeUndefined()
  })

  test('delete removes it', async () => {
    await savePassphraseFor('w3', 'gone soon')
    await deletePassphraseFor('w3')
    expect(await loadPassphraseFor('w3')).toBeUndefined()
  })

  test('passphrases are isolated per wallet', async () => {
    await savePassphraseFor('wa', 'alpha')
    await savePassphraseFor('wb', 'beta')
    expect(await loadPassphraseFor('wa')).toBe('alpha')
    expect(await loadPassphraseFor('wb')).toBe('beta')
  })
})

describe('fingerprintFromMnemonic with passphrase', () => {
  // 73c5da0a is the well-known master fingerprint of the all-"abandon" test seed with no passphrase.
  test('no passphrase matches the known master fingerprint', () => {
    expect(fingerprintFromMnemonic(MNEMONIC)).toBe('73c5da0a')
    expect(fingerprintFromMnemonic(MNEMONIC, undefined)).toBe('73c5da0a')
  })

  test('a passphrase derives a different wallet (different fingerprint)', () => {
    expect(fingerprintFromMnemonic(MNEMONIC, 'TREZOR')).toBe('b4e3f5ed')
    expect(fingerprintFromMnemonic(MNEMONIC, 'TREZOR')).not.toBe(fingerprintFromMnemonic(MNEMONIC))
  })

  // Case sensitivity is why a mistyped passphrase opens a different, empty wallet without warning.
  test('passphrase is case-sensitive', () => {
    expect(fingerprintFromMnemonic(MNEMONIC, 'trezor')).toBe('f28b7c1d')
    expect(fingerprintFromMnemonic(MNEMONIC, 'trezor')).not.toBe(fingerprintFromMnemonic(MNEMONIC, 'TREZOR'))
  })
})
