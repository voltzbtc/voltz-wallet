import { sparkConnectedIdentity, sparkGetIdentityPubkey, sparkSignMessage } from './spark'

// The connected wallet's identity and a signer that signs only as that identity. Every signature is
// made on the connection live when it is asked for, and only when that connection is the same wallet
// (sparkSignMessage), so a request built before a reconnect still goes out after a reconnect to the
// same wallet, and one built before a switch to another wallet ends as without a connection, before
// anything is sent.
export type IdentitySigner = { pubkey: string; sign: (message: string) => Promise<string> }

export async function identitySigner(): Promise<IdentitySigner> {
  const pubkey = await sparkGetIdentityPubkey()
  return { pubkey, sign: message => sparkSignMessage(message, pubkey) }
}

// The same signer with the id of the wallet it signs for, both read from one connection, for a record
// this device keeps by wallet id about something signed by the wallet's key.
export type WalletSigner = IdentitySigner & { walletId: string }

export async function walletSigner(): Promise<WalletSigner> {
  const { walletId, pubkey } = await sparkConnectedIdentity()
  return { walletId, pubkey, sign: message => sparkSignMessage(message, pubkey) }
}
