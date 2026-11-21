import { connect } from '@breeztech/breez-sdk-spark-react-native'
import { connectSpark, disconnectSpark } from '../src/wallet/spark'
import { currentDeps } from '../src/wallet/namePurchase'
import { confirmStorePurchase, openStoreOrder, recordSpendIntent, storeCredits } from '../src/wallet/storePurchase'

// What signs a store request is bound to the identity the request names. A reconnect to another
// wallet after the identity was read refuses the signature before anything is sent, which the store
// flow reads as a lost connection.

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const REF = 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f'

function instance(pubkey: string, signature: string) {
  return {
    getInfo: jest.fn(async () => ({ identityPubkey: pubkey, balanceSats: 0n, tokenBalances: new Map() })),
    signMessage: jest.fn(async () => ({ signature, pubkey })),
    disconnect: jest.fn(async () => undefined),
  }
}

let a: ReturnType<typeof instance>
let b: ReturnType<typeof instance>
let sent: Array<{ url: string; body: Record<string, unknown> }>

const request = (async (url: string, init: { body: string }) => {
  sent.push({ url, body: JSON.parse(init.body) })
  return { status: 503, ok: false, text: async () => '{}' } as unknown as Response
}) as unknown as typeof fetch

beforeEach(async () => {
  await disconnectSpark()
  a = instance('02aa', 'sig-a')
  b = instance('02bb', 'sig-b')
  const connections = [a, b]
  jest.mocked(connect).mockImplementation(async () => connections.shift() as never)
  sent = []
  await connectSpark(MNEMONIC, 'w_a')
})

async function depsOfA() {
  return { ...(await currentDeps()), request, sleep: async () => undefined }
}

describe('a reconnect to another wallet after the identity was read', () => {
  test('refuses the signature without asking either wallet to sign', async () => {
    const deps = await depsOfA()
    await connectSpark(MNEMONIC, 'w_b')
    await expect(deps.sign('voltz-store-order:v1')).rejects.toThrow()
    expect(a.signMessage).not.toHaveBeenCalled()
    expect(b.signMessage).not.toHaveBeenCalled()
  })

  test('an identity that answers after the reconnect is not taken for the new connection', async () => {
    let answer: () => void = () => undefined
    a.getInfo.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answer = () => resolve({ identityPubkey: '02aa', balanceSats: 0n, tokenBalances: new Map() })
        }),
    )
    const building = currentDeps()
    await connectSpark(MNEMONIC, 'w_b')
    answer()
    const deps = await building
    expect(deps.pubkey).toBe('02aa')
    await expect(deps.sign('voltz-store-order:v1')).rejects.toThrow()
    expect(b.signMessage).not.toHaveBeenCalled()
  })

  test('sends none of the store requests, each ending as without a connection', async () => {
    const deps = await depsOfA()
    await connectSpark(MNEMONIC, 'w_b')
    // The identity of the new connection read in between changes nothing for what was built before.
    await currentDeps()
    expect(await openStoreOrder(deps, 'google', 'name', 'alice')).toEqual({ kind: 'retry' })
    expect(
      await confirmStorePurchase(deps, {
        store: 'google',
        productId: 'name_standard',
        state: 'purchased',
        purchasedAt: 0,
        reference: REF,
        key: 'token-1',
        verified: true,
        revoked: false,
      }),
    ).toEqual({ kind: 'retry' })
    expect(await storeCredits(deps)).toBeNull()
    expect(await recordSpendIntent(deps, 'alice')).toEqual({ kind: 'retry' })
    expect(sent).toEqual([])
  })
})

describe('without a reconnect', () => {
  test('signs with the SDK exactly as before', async () => {
    const deps = await depsOfA()
    expect(deps.pubkey).toBe('02aa')
    expect(await deps.sign('message')).toBe('sig-a')
    expect(a.signMessage).toHaveBeenCalledWith({ message: 'message', compact: false })
  })

  test('sends the store request with the identity and the signature it read', async () => {
    const deps = await depsOfA()
    await openStoreOrder(deps, 'google', 'name', 'alice')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toMatchObject({ pubkey: '02aa', signature: 'sig-a', store: 'google', kind: 'name', subject: 'alice' })
  })

  test('a signature after the connection ended is refused as before', async () => {
    const deps = await depsOfA()
    await disconnectSpark()
    await expect(deps.sign('message')).rejects.toThrow('spark not connected')
  })
})
