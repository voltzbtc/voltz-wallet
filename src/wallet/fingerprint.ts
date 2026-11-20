import { mnemonicToSeed, mnemonicToSeedSync } from 'bip39'
import { HDKey } from '@scure/bip32'

function fingerprintFromSeed(seed: Uint8Array): string {
  // @scure/bip32 reads the fingerprint as an unsigned 32-bit big-endian int, so 8 hex chars fit.
  return HDKey.fromMasterSeed(seed).fingerprint.toString(16).padStart(8, '0')
}

// Non-blocking sibling of fingerprintFromMnemonic. pbkdf2Async yields the JS thread between chunks
// instead of freezing it for the full 2048 HMAC-SHA512 rounds, so the backup screen can paint the
// words and stay responsive while the id fills in.
export async function fingerprintFromMnemonicAsync(
  mnemonic: string,
  passphrase?: string,
): Promise<string> {
  return fingerprintFromSeed(await mnemonicToSeed(mnemonic, passphrase))
}

// Standard BIP32 master fingerprint, derived locally so backup and restore can label a wallet before
// it is persisted or connected. Spark's GetInfoResponse carries an identityPubkey and no fingerprint,
// leaving this derivation as the only source. Since a BIP39 passphrase changes the derived wallet
// entirely, restore passes it here to show which wallet it opens, the only check available on an
// otherwise unvalidatable passphrase.
export function fingerprintFromMnemonic(mnemonic: string, passphrase?: string): string {
  return fingerprintFromSeed(mnemonicToSeedSync(mnemonic, passphrase))
}
