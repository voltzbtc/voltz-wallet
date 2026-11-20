import type { SparkLnAddress } from './spark'

// Moving a lightning address between two wallets of the same person. The server wants a signature
// from each side, and the SDK signs with whichever wallet is connected, so the flow has to walk
// through both. Releasing the name from one wallet and claiming it from the other does not work:
// the server keeps a released name reserved for the wallet that released it.
// Mirrors the SDK's TransferAuthorization. The walk carries the value from one wallet to the other
// without reading it, but the shape has to match for the claim call to type check.
export type TransferAuth = {
  username: string
  pubkey: string
  signature: string
  domain: string
  timestamp: bigint
}

export type TransferDeps = {
  /** Identity key of the wallet currently connected. */
  identity: () => Promise<string>
  /** Connects the SDK to another wallet and waits for it. */
  switchTo: (walletId: string) => Promise<void>
  authorize: (transfereePubkey: string) => Promise<TransferAuth>
  /** Claims on the target, told which wallet gave the name so its memory of it goes once it lands. */
  claim: (auth: TransferAuth, fromWalletId: string) => Promise<SparkLnAddress>
  /** Reports which leg is running, so a slow reconnect does not look like a hang. */
  onStep?: (step: TransferStep) => void
}

export type TransferStep = 'reading-target' | 'authorizing' | 'claiming'

// Returns the address as it now stands on the target wallet. The target is left connected on
// success, since that is the wallet the address now belongs to and the one about to be looked at.
export async function transferLnAddress(
  deps: TransferDeps,
  fromWalletId: string,
  toWalletId: string,
): Promise<SparkLnAddress> {
  if (fromWalletId === toWalletId) {
    throw new Error('cannot transfer an address to the wallet that already holds it')
  }

  try {
    // The target's identity key is only readable while connected to it, so the walk starts there.
    deps.onStep?.('reading-target')
    await deps.switchTo(toWalletId)
    const transfereePubkey = await deps.identity()

    deps.onStep?.('authorizing')
    await deps.switchTo(fromWalletId)
    const auth = await deps.authorize(transfereePubkey)

    deps.onStep?.('claiming')
    await deps.switchTo(toWalletId)
    return await deps.claim(auth, fromWalletId)
  } catch (err) {
    // Wherever the walk gave up, the address is still the origin's, and every leg but the
    // authorization runs on the target. Per-wallet state is keyed to whichever wallet is active, so
    // a device left on the target hides a purchase the origin paid for and has not finished, and
    // the buyer is offered the price a second time.
    //
    // The way back is a switch like any other and can fail. Its failure is dropped so the reason
    // the move failed is the one that reaches the caller, and because a device left on the target
    // is confusing rather than broken, since nothing moved and the wallet picker goes back.
    await deps.switchTo(fromWalletId).catch(() => undefined)
    throw err
  }
}
