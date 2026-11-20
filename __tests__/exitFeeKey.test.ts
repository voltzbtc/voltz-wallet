import fs from 'fs'
import path from 'path'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from 'bip39'
import { Buffer } from 'buffer'
import RNFS from 'react-native-fs'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { exitFeeAddress, withExitFeeSecret } from '../src/wallet/exitFeeKey'
import { writeDurable } from '../src/wallet/durableFile'

// BIP84's own test vector, https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki
const VECTOR_WORDS =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const VECTOR_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const VECTOR_PUBLIC_KEY = '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c'
const NEXT_ADDRESS = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'

const source = fs.readFileSync(path.join(__dirname, '../src/wallet/exitFeeKey.ts'), 'utf8')

const secretFrom = (words: string, passphrase?: string): Uint8Array => {
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(words, passphrase)).derive("m/84'/0'/0'/0/0")
  return node.privateKey as Uint8Array
}

beforeEach(() => __setEmergencyExitLiveForTests(true))
afterEach(() => __setEmergencyExitLiveForTests(null))

describe('the BIP84 vector, against the real @scure/bip32', () => {
  test('the words open the vector address and public key at index 0', async () => {
    expect(await exitFeeAddress(VECTOR_WORDS, undefined)).toEqual({
      index: 0,
      address: VECTOR_ADDRESS,
      publicKey: VECTOR_PUBLIC_KEY,
    })
  })

  test('the empty passphrase is the same wallet as no passphrase', async () => {
    expect((await exitFeeAddress(VECTOR_WORDS, '')).address).toBe(VECTOR_ADDRESS)
  })

  test('the index moves along the last step of the path', async () => {
    const next = await exitFeeAddress(VECTOR_WORDS, undefined, 1)
    expect(next).toMatchObject({ index: 1, address: NEXT_ADDRESS })
  })

  test('a passphrase opens another address, the one its own seed derives', async () => {
    const withPassphrase = await exitFeeAddress(VECTOR_WORDS, 'TREZOR')
    expect(withPassphrase.address).not.toBe(VECTOR_ADDRESS)
    const expected = HDKey.fromMasterSeed(mnemonicToSeedSync(VECTOR_WORDS, 'TREZOR')).derive("m/84'/0'/0'/0/0")
    expect(withPassphrase.publicKey).toBe(Buffer.from(expected.publicKey as Uint8Array).toString('hex'))
  })

  test('the secret handed out is the key of that same address', async () => {
    await withExitFeeSecret(VECTOR_WORDS, 'TREZOR', 0, async secret => {
      expect(Buffer.from(secret).toString('hex')).toBe(
        Buffer.from(secretFrom(VECTOR_WORDS, 'TREZOR')).toString('hex'),
      )
      expect(secret).toHaveLength(32)
    })
  })

  test.each([-1, 1.5, 2 ** 31, Number.NaN])('index %s is refused', async index => {
    await expect(exitFeeAddress(VECTOR_WORDS, undefined, index)).rejects.toThrow('invalid index')
  })
})

describe('the fee key never leaves and never stays', () => {
  test('the module imports no HTTP client and no file layer', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1])
    expect(imports.sort()).toEqual(['./emergencyExit', '@scure/base', '@scure/bip32', 'bip39', 'buffer'])
    expect(source).not.toMatch(/\bfetch\b|XMLHttpRequest|require\(|import\(/)
  })

  test('the bytes are wiped once the callback settles, whichever way', async () => {
    let held: Uint8Array = new Uint8Array()
    await withExitFeeSecret(VECTOR_WORDS, undefined, 0, async secret => {
      held = secret
      expect(held.some(byte => byte !== 0)).toBe(true)
    })
    expect(held.every(byte => byte === 0)).toBe(true)

    await expect(
      withExitFeeSecret(VECTOR_WORDS, undefined, 0, async secret => {
        held = secret
        throw new Error('signing failed')
      }),
    ).rejects.toThrow('signing failed')
    expect(held.every(byte => byte === 0)).toBe(true)
  })

  test('the saved shape holds neither the words nor the key in any encoding', async () => {
    const file = `${RNFS.DocumentDirectoryPath}/exit-fee-key.test.json`
    const saved = await exitFeeAddress(VECTOR_WORDS, 'TREZOR')
    await writeDurable(file, JSON.stringify(saved), () => true, 'replace', 'nothing')
    const written = await RNFS.readFile(file, 'utf8')
    expect(written).toContain(saved.address)

    const secret = Buffer.from(secretFrom(VECTOR_WORDS, 'TREZOR'))
    for (const leak of [
      secret.toString('hex'),
      secret.toString('base64'),
      JSON.stringify([...secret]).slice(1, -1),
      JSON.stringify(Object.fromEntries([...secret].map((byte, i) => [i, byte]))).slice(1, -1),
      'abandon',
      'TREZOR',
    ]) {
      expect(written).not.toContain(leak)
    }
    expect(Object.keys(saved).sort()).toEqual(['address', 'index', 'publicKey'])
  })

  test('a derivation writes nothing to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
      jest.spyOn(console, level).mockImplementation(() => undefined),
    )
    await exitFeeAddress(VECTOR_WORDS, 'TREZOR')
    await withExitFeeSecret(VECTOR_WORDS, 'TREZOR', 0, async () => undefined)
    await exitFeeAddress(VECTOR_WORDS, 'TREZOR', -1).catch(() => undefined)
    spies.forEach(spy => {
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  test('an index refused names neither the words nor the passphrase', async () => {
    const error: Error = await exitFeeAddress(VECTOR_WORDS, 'TREZOR', -1).catch(e => e)
    expect(error.message).not.toMatch(/abandon|TREZOR/)
  })
})

test('with the switch off nothing is derived and the callback never runs', async () => {
  __setEmergencyExitLiveForTests(false)
  const use = jest.fn(async () => undefined)
  await expect(exitFeeAddress(VECTOR_WORDS, undefined)).rejects.toThrow('off')
  await expect(withExitFeeSecret(VECTOR_WORDS, undefined, 0, use)).rejects.toThrow('off')
  expect(use).not.toHaveBeenCalled()
})
