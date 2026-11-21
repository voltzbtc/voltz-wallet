import fs from 'fs'
import path from 'path'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import { connectSpark, disconnectSpark, sparkGetIdentityPubkey, sparkSignMessage } from '../src/wallet/spark'
import { identitySigner } from '../src/wallet/identitySigner'
import { currentDeps } from '../src/wallet/namePurchase'
import { recoverPurchases } from '../src/wallet/recover'
import { scopeOn } from '../src/wallet/releasedLines'
import { buyInStore, type StoreContext } from '../src/wallet/storePurchase'
import { moveDomain } from '../src/wallet/domainMove'

// A signature is bound to the identity of the very connection that makes it. The connection live at
// the call is taken once, its identity is read from it when not yet known, and the signature is
// refused before any request when that identity is not the pubkey being sent. A reconnect to the same
// wallet costs one identity read and signs; another wallet ends as without a connection.

jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezLnurlDomain: () => 'usevoltz.app',
  getDistribution: () => 'store',
}))

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const BOOK = '/mock/Documents/store-orders.json'
const ASKED = '/mock/Documents/purchase-asked.json'

type Instance = ReturnType<typeof instance>

// The SDK answers each signature with the key that made it, its identity key.
function instance(pubkey: string, signature: string) {
  return {
    getInfo: jest.fn(async () => ({ identityPubkey: pubkey, balanceSats: 0n, tokenBalances: new Map() })),
    signMessage: jest.fn(async () => ({ signature, pubkey })),
    disconnect: jest.fn(async () => undefined),
  }
}

let queue: Instance[]
let sent: Array<{ path: string; body: Record<string, unknown> }>
let onSend: (path: string) => Promise<void>
let a: Instance
let warn: jest.SpyInstance

// Each connect takes the next instance, which is what the binding does: a new object per connect.
function nextConnections(...list: Instance[]): void {
  queue.push(...list)
}

function reply(status: number, body: unknown): Response {
  return { ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response
}

const request = (async (url: string, init: { body: string }) => {
  const at = new URL(url).pathname
  sent.push({ path: at, body: JSON.parse(init.body) })
  await onSend(at)
  if (at === '/api/charges/pending') {
    return reply(200, { charges: [] })
  }
  if (at === '/api/store/credits') {
    return reply(200, { credits: [] })
  }
  return reply(409, { error: 'unknown_order' })
}) as unknown as typeof fetch

const switchTo = (walletId: string) => connectSpark(MNEMONIC, walletId).then(() => undefined)
const sameWalletAgain = async () => {
  await disconnectSpark()
  await connectSpark(MNEMONIC, 'w_a')
}

async function exists(file: string): Promise<boolean> {
  return require('react-native-fs').default.exists(file)
}

beforeEach(async () => {
  await disconnectSpark()
  const RNFS = require('react-native-fs').default
  for (const file of [BOOK, ASKED]) {
    if (await RNFS.exists(file)) {
      await RNFS.unlink(file)
    }
  }
  queue = []
  sent = []
  onSend = async () => undefined
  jest.mocked(connect).mockImplementation(async () => queue.shift() as never)
  a = instance('02aa', 'sig-a')
  nextConnections(a)
  await connectSpark(MNEMONIC, 'w_a')
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  warn.mockRestore()
})

describe('a pair built on one connection', () => {
  test('without a reconnect signs on it as before, with the one identity read that built it', async () => {
    const pair = await identitySigner()
    expect(pair.pubkey).toBe('02aa')
    expect(await pair.sign('m')).toBe('sig-a')
    expect(await pair.sign('n')).toBe('sig-a')
    expect(a.getInfo).toHaveBeenCalledTimes(1)
    expect(a.signMessage).toHaveBeenCalledWith({ message: 'm', compact: false })
  })

  test('after a reconnect to the same wallet reads the new identity once and signs there', async () => {
    const pair = await identitySigner()
    const again = instance('02aa', 'sig-a2')
    nextConnections(again)
    await sameWalletAgain()
    expect(await pair.sign('m')).toBe('sig-a2')
    expect(await pair.sign('n')).toBe('sig-a2')
    expect(again.getInfo).toHaveBeenCalledTimes(1)
    expect(a.signMessage).not.toHaveBeenCalled()
  })

  test('after a reconnect to another wallet is refused before either wallet signs', async () => {
    const pair = await identitySigner()
    const b = instance('02bb', 'sig-b')
    nextConnections(b)
    await switchTo('w_b')
    await expect(pair.sign('m')).rejects.toThrow()
    expect(a.signMessage).not.toHaveBeenCalled()
    expect(b.signMessage).not.toHaveBeenCalled()
  })

  test('is read again on a new connection even when the binding hands back the same object', async () => {
    const shared = instance('02aa', 'sig-shared')
    shared.getInfo
      .mockResolvedValueOnce({ identityPubkey: '02aa', balanceSats: 0n, tokenBalances: new Map() })
      .mockResolvedValue({ identityPubkey: '02bb', balanceSats: 0n, tokenBalances: new Map() })
    nextConnections(shared, shared)
    await switchTo('w_c')
    const pair = await identitySigner()
    await switchTo('w_b')
    await expect(pair.sign('m')).rejects.toThrow()
    expect(shared.getInfo).toHaveBeenCalledTimes(2)
    expect(shared.signMessage).not.toHaveBeenCalled()
  })

  test('an identity answered after a reconnect vouches only for the connection that answered', async () => {
    let answer: () => void = () => undefined
    a.getInfo.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answer = () => resolve({ identityPubkey: '02aa', balanceSats: 0n, tokenBalances: new Map() })
        }),
    )
    const building = identitySigner()
    const b = instance('02bb', 'sig-b')
    nextConnections(b)
    await switchTo('w_b')
    answer()
    const pair = await building
    expect(pair.pubkey).toBe('02aa')
    await expect(pair.sign('m')).rejects.toThrow()
    expect(b.getInfo).toHaveBeenCalledTimes(1)
    expect(b.signMessage).not.toHaveBeenCalled()
  })

  test('a signature is made on the connection it was asked on, never on the one that replaces it', async () => {
    let answer: () => void = () => undefined
    a.getInfo.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answer = () => resolve({ identityPubkey: '02aa', balanceSats: 0n, tokenBalances: new Map() })
        }),
    )
    const signing = sparkSignMessage('m', '02aa')
    const b = instance('02aa', 'sig-b')
    nextConnections(b)
    await switchTo('w_b')
    answer()
    expect(await signing).toBe('sig-a')
    expect(b.signMessage).not.toHaveBeenCalled()
  })

  test('a signature the SDK says another key made is refused, never sent beside the pubkey asked', async () => {
    a.signMessage.mockResolvedValueOnce({ signature: 'sig-other', pubkey: '02bb' })
    await expect(sparkSignMessage('m', '02aa')).rejects.toThrow('spark connected as another identity')
  })

  test('the key the SDK answers is compared without regard to case', async () => {
    a.signMessage.mockResolvedValueOnce({ signature: 'sig-a', pubkey: '02AA' })
    expect(await sparkSignMessage('m', '02aa')).toBe('sig-a')
  })

  test('after a disconnect is refused as without a connection', async () => {
    const pair = await identitySigner()
    await disconnectSpark()
    await expect(pair.sign('m')).rejects.toThrow('spark not connected')
  })
})

describe('the Home sweep', () => {
  async function sweepDeps() {
    return { walletId: 'w_a', lines: scopeOn('w_a'), ...(await identitySigner()), request, sleep: async () => undefined }
  }

  test('without a reconnect sends the charges and the credits read, each signed by its pubkey', async () => {
    expect(await recoverPurchases(await sweepDeps())).toBeNull()
    expect(sent.map(s => s.path)).toEqual(['/api/charges/pending', '/api/store/credits'])
    expect(sent.every(s => s.body.pubkey === '02aa' && s.body.signature === 'sig-a')).toBe(true)
  })

  test('built on one wallet sends no signature at all once another is connected', async () => {
    const deps = await sweepDeps()
    const b = instance('02bb', 'sig-b')
    nextConnections(b)
    await switchTo('w_b')
    expect(await recoverPurchases(deps)).toBeNull()
    expect(sent).toEqual([])
    expect(b.signMessage).not.toHaveBeenCalled()
  })

  test('reads no credits when another wallet connects after the charges were asked', async () => {
    const b = instance('02bb', 'sig-b')
    nextConnections(b)
    onSend = async at => {
      if (at === '/api/charges/pending') {
        await switchTo('w_b')
      }
    }
    expect(await recoverPurchases(await sweepDeps())).toBeNull()
    expect(sent.map(s => s.path)).toEqual(['/api/charges/pending'])
    expect(b.signMessage).not.toHaveBeenCalled()
  })

  test('reads the credits on the new connection after a reconnect to the same wallet', async () => {
    const again = instance('02aa', 'sig-a2')
    nextConnections(again)
    onSend = async at => {
      if (at === '/api/charges/pending') {
        await sameWalletAgain()
      }
    }
    expect(await recoverPurchases(await sweepDeps())).toBeNull()
    expect(sent.map(s => [s.path, s.body.signature])).toEqual([
      ['/api/charges/pending', 'sig-a'],
      ['/api/store/credits', 'sig-a2'],
    ])
  })
})

describe('a store purchase pressed across a reconnect', () => {
  const originalOs = require('react-native').Platform.OS

  beforeEach(() => {
    Object.defineProperty(require('react-native').Platform, 'OS', { value: 'android', configurable: true })
    jest.requireMock('../specs/NativeVoltzStore').control.reset()
  })

  afterEach(() => {
    Object.defineProperty(require('react-native').Platform, 'OS', { value: originalOs, configurable: true })
  })

  // The wallet check passes, and the reconnect lands after the identity was read.
  function context(reconnect: () => Promise<void>): StoreContext {
    return {
      walletId: () => 'w_a',
      wallets: async () => ['w_a', 'w_b'],
      gateway: async () => {
        const deps = await currentDeps()
        await reconnect()
        return { ...deps, request, sleep: async () => undefined }
      },
    }
  }

  test('to another wallet stops before the order and writes nothing to the book', async () => {
    nextConnections(instance('02bb', 'sig-b'))
    expect(await buyInStore('name', 'alice', context(() => switchTo('w_b')))).toEqual({ kind: 'orderRetry' })
    expect(sent).toEqual([])
    expect(await exists(BOOK)).toBe(false)
  })

  test('to the same wallet sends the order signed on the new connection', async () => {
    nextConnections(instance('02aa', 'sig-a2'))
    expect(await buyInStore('name', 'alice', context(sameWalletAgain))).toEqual({
      kind: 'orderRefused',
      status: 409,
      code: 'unknown_order',
    })
    expect(sent.map(s => [s.path, s.body.pubkey, s.body.signature])).toEqual([['/api/store/order', '02aa', 'sig-a2']])
  })
})

describe('the domain handover', () => {
  type Sent = { fromPubkey: string; toPubkey: string; fromSignature: string; toSignature: string }

  function walk(switchFor: (walletId: string, leg: number) => string) {
    let leg = 0
    const posted: Sent[] = []
    return {
      posted,
      run: () =>
        moveDomain(
          {
            gatewayUrl: 'https://usevoltz.app',
            identity: sparkGetIdentityPubkey,
            switchTo: walletId => switchTo(switchFor(walletId, ++leg)),
            sign: sparkSignMessage,
            adopt: async () => undefined,
            request: (async (_url: string, init: { body: string }) => {
              posted.push(JSON.parse(init.body))
              return reply(200, { transferSeq: 8 })
            }) as unknown as typeof fetch,
          },
          { host: 'pay.example', fromWalletId: 'w_a', toWalletId: 'w_b', transferSeq: 7, frozen: true },
        ),
    }
  }

  test('signs each half on the wallet whose pubkey it sends, the target reconnected in between', async () => {
    nextConnections(instance('02bb', 'sig-b1'), instance('02aa', 'sig-a1'), instance('02bb', 'sig-b2'))
    const move = walk(walletId => walletId)
    expect(await move.run()).toBe(8)
    expect(move.posted).toEqual([
      expect.objectContaining({ fromPubkey: '02aa', toPubkey: '02bb', fromSignature: 'sig-a1', toSignature: 'sig-b2' }),
    ])
  })

  test('sends nothing when a leg lands on another wallet than the pubkey it signs for', async () => {
    const c = instance('02cc', 'sig-c')
    nextConnections(instance('02bb', 'sig-b1'), instance('02aa', 'sig-a1'), c, instance('02aa', 'sig-back'))
    const move = walk((walletId, leg) => (leg === 3 ? 'w_c' : walletId))
    await expect(move.run()).rejects.toThrow()
    expect(move.posted).toEqual([])
    expect(c.signMessage).not.toHaveBeenCalled()
  })
})

describe('the callers', () => {
  // Every signed request outside the domain handover takes its pubkey and its signer from one pair.
  // The handover reads each wallet's identity on its own leg and passes that pubkey to every
  // signature.
  test('no module hands out the raw signer but the pair and the domain handover', () => {
    const root = path.join(__dirname, '..', 'src')
    const files: string[] = []
    const walkDir = (dir: string) =>
      fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walkDir(full)
        } else if (/\.tsx?$/.test(entry.name)) {
          files.push(full)
        }
      })
    walkDir(root)
    const users = files
      .filter(file => fs.readFileSync(file, 'utf8').includes('sparkSignMessage'))
      .map(file => path.relative(root, file))
      .sort()
    expect(users).toEqual(['screens/DomainScreen.tsx', 'wallet/identitySigner.ts', 'wallet/spark.ts'])
  })
})
