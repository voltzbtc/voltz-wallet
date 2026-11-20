import { bech32 } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeed } from 'bip39'
import { Buffer } from 'buffer'
import { emergencyExitLive } from './emergencyExit'

// The key that pays an emergency exit's fees. A Spark wallet holds no UTXO, so the fees come from
// another wallet of the person's, sent to this address, which the words open in any BIP84 wallet. It
// sits on the standard path, away from Spark's m/8797555', and the seed takes the passphrase, since an
// address derived without it pays a key the person's own wallet never finds.
//
// The secret is handed to a callback, so it is never in a value a caller could put in state, a file or
// a log, and what may be kept is ExitFeeAddress. The wipe reaches the seed, the root, the last node and
// the copy the callback got. HDKey's intermediate nodes and the bridge's native copy stay in memory
// until they are collected, which JS cannot force.

export type ExitFeeAddress = { index: number; address: string; publicKey: string }

const hardened = 2 ** 31

function feePath(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= hardened) {
    throw new Error('exit fee key: invalid index')
  }
  return `m/84'/0'/0'/0/${index}`
}

async function feeNode(mnemonic: string, passphrase: string | undefined, index: number): Promise<HDKey> {
  if (!emergencyExitLive()) {
    throw new Error('emergency exit is off')
  }
  const path = feePath(index)
  const seed = await mnemonicToSeed(mnemonic, passphrase)
  const root = HDKey.fromMasterSeed(seed)
  const node = root.derive(path)
  root.wipePrivateData()
  seed.fill(0)
  return node
}

export async function exitFeeAddress(
  mnemonic: string,
  passphrase: string | undefined,
  index = 0,
): Promise<ExitFeeAddress> {
  const node = await feeNode(mnemonic, passphrase, index)
  const publicKey = node.publicKey
  const keyHash = node.identifier
  node.wipePrivateData()
  if (!publicKey || !keyHash) {
    throw new Error('exit fee key: no public key')
  }
  return {
    index,
    // Witness version 0 and the key's hash make a P2WPKH program.
    address: bech32.encode('bc', [0, ...bech32.toWords(keyHash)]),
    publicKey: Buffer.from(publicKey).toString('hex'),
  }
}

// Wiped once `signWith` settles, so `signWith` must not keep the bytes or hand them to anything that outlives it.
export async function withExitFeeSecret<T>(
  mnemonic: string,
  passphrase: string | undefined,
  index: number,
  signWith: (secretKey: Uint8Array) => Promise<T>,
): Promise<T> {
  const node = await feeNode(mnemonic, passphrase, index)
  const secret = node.privateKey
  if (!secret) {
    node.wipePrivateData()
    throw new Error('exit fee key: no secret key')
  }
  const copy = Uint8Array.from(secret)
  node.wipePrivateData()
  try {
    return await signWith(copy)
  } finally {
    copy.fill(0)
  }
}
