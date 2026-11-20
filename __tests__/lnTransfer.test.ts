import * as Keychain from 'react-native-keychain'
import RNFS from 'react-native-fs'
import { transferLnAddress, type TransferDeps, type TransferStep } from '../src/wallet/lnTransfer'
import { loadPending, savePending } from '../src/wallet/purchase'
import { ensureRegistered, getActiveWalletId, setActiveWallet } from '../src/wallet/walletRegistry'

// purchase.ts reaches the SDK to pay, which nothing here does. Mocked so the module loads without
// the native binding, while the registry it keys proofs by stays real.
jest.mock('../src/wallet/spark', () => ({}))

const ADDR = { username: 'alice', address: 'alice@usevoltz.app', lnurl: 'lnurl1' }

// `refuseSwitchTo` names a wallet the SDK cannot be pointed at, which is how a way back that fails
// is played. A refused switch leaves `connected` where it was, since nothing was reconnected.
function deps(over: Partial<TransferDeps> = {}, refuseSwitchTo?: string) {
  const trail: string[] = []
  const steps: TransferStep[] = []
  let connected = 'A'
  const base: TransferDeps = {
    identity: async () => `pub-${connected}`,
    switchTo: async id => {
      if (id === refuseSwitchTo) {
        throw new Error('no connection')
      }
      connected = id
      trail.push(`switch:${id}`)
    },
    authorize: async pubkey => {
      trail.push(`authorize:${pubkey}@${connected}`)
      return {
        username: 'alice',
        pubkey: `pub-${connected}`,
        signature: 'sig',
        domain: 'usevoltz.app',
        timestamp: 0n,
      }
    },
    claim: async (auth, from) => {
      trail.push(`claim:${auth.signature}@${connected} from:${from}`)
      return ADDR
    },
    onStep: s => steps.push(s),
    ...over,
  }
  return { deps: base, trail, steps, connectedTo: () => connected }
}

test('the target key is read on the target, and the authorization signed on the origin', async () => {
  // The SDK signs with whatever wallet is connected, so each half has to run on its own side. The
  // target key is only readable while connected to the target, which is why that leg comes first.
  const d = deps()
  await expect(transferLnAddress(d.deps, 'A', 'B')).resolves.toEqual(ADDR)
  expect(d.trail).toEqual([
    'switch:B',
    'switch:A',
    'authorize:pub-B@A',
    'switch:B',
    // The claim is told which wallet gave the name, so that wallet's memory of it goes once it lands.
    'claim:sig@B from:A',
  ])
})

test('it ends connected to the wallet that now holds the address', async () => {
  const d = deps()
  await transferLnAddress(d.deps, 'A', 'B')
  expect(d.connectedTo()).toBe('B')
})

test('a refused authorization leaves the address and the connection on the origin', async () => {
  const d = deps({
    authorize: async () => {
      throw new Error('refused')
    },
  })
  await expect(transferLnAddress(d.deps, 'A', 'B')).rejects.toThrow('refused')
  // Nothing was handed over, so the origin is already the connected one and the way back is a
  // switch to where the walk stands. Costing one no-op switch here buys a single way back for
  // every leg, instead of one rule per leg for which of them has to undo anything.
  expect(d.connectedTo()).toBe('A')
  // The override replaces the fake's own authorize, so no authorize step is recorded.
  expect(d.trail).toEqual(['switch:B', 'switch:A', 'switch:A'])
})

test('a failed claim puts the user back on the wallet that still holds the address', async () => {
  const d = deps({
    claim: async () => {
      throw new Error('already taken')
    },
  })
  await expect(transferLnAddress(d.deps, 'A', 'B')).rejects.toThrow('already taken')
  expect(d.connectedTo()).toBe('A')
})

test('transferring to the same wallet is refused before anything is signed', async () => {
  const d = deps()
  await expect(transferLnAddress(d.deps, 'A', 'A')).rejects.toThrow()
  expect(d.trail).toEqual([])
})

test('each leg is reported, so a slow reconnect does not read as a hang', async () => {
  const d = deps()
  await transferLnAddress(d.deps, 'A', 'B')
  expect(d.steps).toEqual(['reading-target', 'authorizing', 'claiming'])
})

test('a target key that cannot be read puts the user back on the origin', async () => {
  // The read runs on the target only because the walk needs it there. Nothing has been signed yet,
  // so the address is still the origin's and that is the wallet to be left on.
  const d = deps({
    identity: async () => {
      throw new Error('operator timed out')
    },
  })
  await expect(transferLnAddress(d.deps, 'A', 'B')).rejects.toThrow('operator timed out')
  expect(d.connectedTo()).toBe('A')
  expect(d.trail).toEqual(['switch:B', 'switch:A'])
})

test('the reason the move failed survives a way back that fails too', async () => {
  // Reporting the return leg would replace a reason the person can act on with one about a leg they
  // never asked for, on a screen whose only answer either way is that the move did not happen.
  const d = deps(
    {
      identity: async () => {
        throw new Error('operator timed out')
      },
    },
    'A',
  )
  await expect(transferLnAddress(d.deps, 'A', 'B')).rejects.toThrow('operator timed out')
  // Left on the target, which the wallet picker moves off. Nothing was signed, so the address, the
  // money and the keys are all where they were.
  expect(d.connectedTo()).toBe('B')
})

// The proof of a paid-for purchase is keyed by the active wallet, so which wallet a failed move
// leaves behind decides whether the buyer can still see what they paid for.
describe('a purchase left unfinished on the origin', () => {
  beforeEach(async () => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    // The registry lists a wallet only when its seed is on the device.
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValueOnce(true).mockResolvedValueOnce(true)
    await ensureRegistered('w_a', 'fp-a')
    await ensureRegistered('w_b', 'fp-b')
    await setActiveWallet('w_a')
  })

  it('is offered back to the buyer after a move that could not read the target', async () => {
    await savePending({
      kind: 'name',
      subject: 'bakery',
      reference: 'ref-1',
      amountSats: 12821,
    })
    const walk: TransferDeps = {
      // The real switch repoints the registry and then reconnects. Only the first half decides
      // which proof is visible, and that half is the real one here.
      switchTo: setActiveWallet,
      identity: async () => {
        throw new Error('operator timed out')
      },
      authorize: async () => {
        throw new Error('unreachable once the target key is unreadable')
      },
      claim: async () => {
        throw new Error('unreachable once the target key is unreadable')
      },
    }

    await expect(transferLnAddress(walk, 'w_a', 'w_b')).rejects.toThrow('operator timed out')

    expect(await getActiveWalletId()).toBe('w_a')
    // Read on the wallet that paid, the record still answers. Read on the target it does not, and
    // the sheet returns to the price step, which mints a second invoice for the same name.
    expect(await loadPending('name')).toMatchObject({ reference: 'ref-1' })
  })
})
