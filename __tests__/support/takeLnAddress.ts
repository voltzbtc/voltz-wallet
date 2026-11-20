// The one-turn take of a paid name (spark.ts, sparkTakeLnAddress) as a suite's spark double answers
// it: the address read through the double's sparkGetLnAddress and the register through its
// sparkRegisterLnAddress, so a case that holds, fails or counts either one drives the take the same
// way. A take for a wallet the double's sparkConnectedWalletId does not name reads and registers
// nothing, as spark.ts refuses one on another wallet's connection. Required from inside a jest.mock
// factory, which may not close over anything outside it.
export async function takeLnAddress(username: string, walletId?: string): Promise<unknown> {
  const spark = jest.requireMock('../../src/wallet/spark') as Record<string, (...args: unknown[]) => unknown>
  if (walletId !== undefined && spark.sparkConnectedWalletId!() !== walletId) {
    return { elsewhere: true }
  }
  let held: unknown
  try {
    held = await spark.sparkGetLnAddress!()
  } catch {
    return { unread: true }
  }
  return held ? { held } : { registered: await spark.sparkRegisterLnAddress!(username) }
}
