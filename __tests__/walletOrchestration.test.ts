import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import NativeVoltzDurable from '../specs/NativeVoltzDurable'
import { getBreezLnurlDomain } from '../src/config'
import { deviceForgetSettled, FORGET_WAIT_MS, sendDeviceForgets } from '../src/wallet/deviceForget'
import { forgetProof } from '../src/wallet/webhook'
import {
  loadDeviceForgets,
  loadRetiring,
  loadWebhookState,
  noteGatewayWebhookId,
  noteSdkWebhook,
  webhookStateFor,
} from '../src/wallet/webhookSecret'
import {
  addAndActivateWallet,
  addFirstWallet,
  switchWalletWithoutReconnecting,
  switchWalletAndConnect,
  onActiveWalletChanged,
  removeActiveWallet,
  removeWallet,
  isWalletSeedAbsent,
} from '../src/wallet/wallet'
import { saveDollarMode } from '../src/wallet/settings'
import { keepConversionNote } from '../src/wallet/conversionNotes'
import { notePendingSend, readPendingSends } from '../src/wallet/pendingSends'
import { lastLnAddress, rememberLnAddress } from '../src/wallet/lnAddressMemory'
import { saveSeedFor, deleteSeedFor, hasSeedFor, savePassphraseFor } from '../src/wallet/seed'
import {
  ensureRegistered,
  setActiveWallet,
  loadRegistry,
  newWalletId,
  removeWalletEntry,
} from '../src/wallet/walletRegistry'
import { fingerprintFromMnemonic, fingerprintFromMnemonicAsync } from '../src/wallet/fingerprint'
import { connectActiveSpark, disconnectSpark, sparkConnectedIdentity, sparkWebhookSession } from '../src/wallet/spark'

// Adding and switching only repoint the registry and leave Home to connect on focus, while removing
// the active wallet tears the live Spark engine down first so a deleted wallet is never in use.
jest.mock('../src/wallet/seed', () => ({
  saveSeedFor: jest.fn(),
  loadSeedFor: jest.fn(),
  loadPassphraseFor: jest.fn(async () => undefined),
  deleteSeedFor: jest.fn(),
  hasSeedFor: jest.fn(),
  savePassphraseFor: jest.fn(),
  deletePassphraseFor: jest.fn(),
  PRIMARY_ID: 'primary',
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  ensureRegistered: jest.fn(),
  setActiveWallet: jest.fn(),
  getActiveWalletId: jest.fn(),
  loadRegistry: jest.fn().mockResolvedValue({ wallets: [], active: null }),
  newWalletId: jest.fn(() => 'w_new'),
  removeWalletEntry: jest.fn(),
}))
// Both derivations answer the same id, so only the call record tells which one a flow ran.
jest.mock('../src/wallet/fingerprint', () => ({
  fingerprintFromMnemonic: jest.fn(() => 'fp123'),
  fingerprintFromMnemonicAsync: jest.fn(async () => 'fp123'),
}))
jest.mock('../src/wallet/spark', () => ({
  disconnectSpark: jest.fn(async () => undefined),
  connectActiveSpark: jest.fn(async () => undefined),
  sparkConnectedIdentity: jest.fn(async () => {
    throw new Error('spark not connected')
  }),
  sparkWebhookSession: jest.fn(() => {
    throw new Error('spark not connected')
  }),
}))
jest.mock('../src/wallet/walletImage', () => ({ deleteWalletImage: jest.fn(async () => undefined) }))
// The build's own domain unless a test names one.
jest.mock('../src/config', () => {
  const actual = jest.requireActual('../src/config')
  return { ...actual, getBreezLnurlDomain: jest.fn(actual.getBreezLnurlDomain) }
})

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

beforeEach(() => {
  jest.clearAllMocks()
  // Every wallet holds its seed unless a test says otherwise, and the id an add draws holds none until
  // the add writes it, as the Keychain answers.
  jest
    .mocked(hasSeedFor)
    .mockImplementation(async id => id !== 'w_new' || jest.mocked(saveSeedFor).mock.calls.some(([saved]) => saved === id))
})

describe('addAndActivateWallet', () => {
  test('records the local fingerprint and activates, WITHOUT connecting', async () => {
    const id = await addAndActivateWallet(MNEMONIC)

    expect(saveSeedFor).toHaveBeenCalledWith('w_new', MNEMONIC)
    // Passing '' clears any passphrase already stored under the new id.
    expect(savePassphraseFor).toHaveBeenCalledWith('w_new', '')
    // The fingerprint is derived locally, with no connection involved, and off the JS thread: the
    // synchronous PBKDF2 would hold the screen still for its 2048 rounds.
    expect(fingerprintFromMnemonicAsync).toHaveBeenCalledWith(MNEMONIC, undefined)
    expect(fingerprintFromMnemonic).not.toHaveBeenCalled()
    expect(ensureRegistered).toHaveBeenCalledWith('w_new', 'fp123')
    expect(setActiveWallet).toHaveBeenCalledWith('w_new')
    expect(id).toBe('w_new')
  })

  test('persists a provided passphrase under the new wallet and folds it into the fingerprint', async () => {
    await addAndActivateWallet(MNEMONIC, 'hunter2')

    expect(savePassphraseFor).toHaveBeenCalledWith('w_new', 'hunter2')
    expect(fingerprintFromMnemonicAsync).toHaveBeenCalledWith(MNEMONIC, 'hunter2')
    expect(fingerprintFromMnemonic).not.toHaveBeenCalled()
  })

  test('announces the wallet it activates, once the registry points at it', async () => {
    const order: string[] = []
    jest.mocked(setActiveWallet).mockImplementation(async id => {
      order.push(`set ${id}`)
    })
    const off = onActiveWalletChanged(id => order.push(`heard ${id}`))

    await addAndActivateWallet(MNEMONIC)

    expect(order).toEqual(['set w_new', 'heard w_new'])
    off()
  })
})

describe('the id a new wallet takes', () => {
  // clearAllMocks keeps queued once values, so a draw one case left unread would answer the next.
  beforeEach(() => {
    jest.mocked(newWalletId).mockReset().mockReturnValue('w_new')
    jest.mocked(loadRegistry).mockReset().mockResolvedValue({ wallets: [], active: null })
  })

  // A wallet listed under `w_new`, with its seed here. A second add drawing the same id would write over it.
  test('is drawn again while a listed wallet holds it, and never writes over that wallet', async () => {
    jest.mocked(loadRegistry).mockResolvedValueOnce({ wallets: [{ id: 'w_new', fingerprint: 'fp-other' }], active: 'w_new' })
    jest.mocked(newWalletId).mockReturnValueOnce('w_new').mockReturnValueOnce('w_free')
    jest.mocked(hasSeedFor).mockImplementation(async id => id !== 'w_free' || jest.mocked(saveSeedFor).mock.calls.length > 0)

    expect(await addAndActivateWallet(MNEMONIC, 'hunter2')).toBe('w_free')

    expect(jest.mocked(saveSeedFor).mock.calls.map(([id]) => id)).toEqual(['w_free'])
    expect(jest.mocked(savePassphraseFor).mock.calls.map(([id]) => id)).toEqual(['w_free'])
  })

  // A kill between the seed and the registry write leaves a seed no entry names.
  test('is drawn again while the Keychain holds a seed under it that no entry names', async () => {
    jest.mocked(newWalletId).mockReturnValueOnce('w_orphan').mockReturnValueOnce('w_free')
    jest.mocked(hasSeedFor).mockImplementation(async id => id === 'w_orphan' || jest.mocked(saveSeedFor).mock.calls.length > 0)

    expect(await addAndActivateWallet(MNEMONIC)).toBe('w_free')
    expect(jest.mocked(saveSeedFor).mock.calls.map(([id]) => id)).toEqual(['w_free'])
  })

  test('the first-run add checks it as well, when lost wallets are listed', async () => {
    jest.mocked(loadRegistry).mockResolvedValueOnce({ wallets: [{ id: 'w_lost', fingerprint: 'fp-other' }], active: 'w_lost' })
    jest.mocked(newWalletId).mockReturnValueOnce('w_orphan').mockReturnValueOnce('w_free')
    jest.mocked(hasSeedFor).mockImplementation(async id => id === 'w_orphan' || (id === 'w_free' && jest.mocked(saveSeedFor).mock.calls.length > 0))

    expect(await addFirstWallet(MNEMONIC, undefined, 'typed')).toBe('w_free')
    expect(jest.mocked(saveSeedFor).mock.calls.map(([id]) => id)).toEqual(['w_free'])
  })

  test('a Keychain that answers every id as taken stops the add before anything is written', async () => {
    jest.mocked(hasSeedFor).mockResolvedValue(true)

    await expect(addAndActivateWallet(MNEMONIC)).rejects.toThrow('no free wallet id')
    expect(saveSeedFor).not.toHaveBeenCalled()
    expect(savePassphraseFor).not.toHaveBeenCalled()
  })
})

describe('switchWalletWithoutReconnecting', () => {
  test('only repoints the active wallet', async () => {
    await switchWalletWithoutReconnecting('w_2')
    expect(setActiveWallet).toHaveBeenCalledWith('w_2')
  })

  test('announces the new wallet, which per-wallet chrome needs before the SDK reconnects', async () => {
    // Reconnecting takes seconds, and without this the accent stays on the previous wallet until it
    // lands, opening a bitcoin wallet green.
    const seen: string[] = []
    const off = onActiveWalletChanged(id => seen.push(id))

    await switchWalletWithoutReconnecting('w_2')

    expect(seen).toEqual(['w_2'])
    off()
  })

  test('a removed listener stops hearing switches', async () => {
    const seen: string[] = []
    onActiveWalletChanged(id => seen.push(id))()

    await switchWalletWithoutReconnecting('w_2')

    expect(seen).toEqual([])
  })
})

describe('switchWalletAndConnect', () => {
  // The lightning address transfer switches wallets mid-run, with no screen focus in between to
  // reconnect. Each leg signs with whichever wallet is connected, so a leg left on the previous one
  // posts to that wallet's own path and the server refuses it.
  test('reconnects after repointing, so the SDK lands on the wallet just selected', async () => {
    const order: string[] = []
    ;(setActiveWallet as jest.Mock).mockImplementation(async () => {
      order.push('switch')
    })
    ;(connectActiveSpark as jest.Mock).mockImplementation(async () => {
      order.push('connect')
    })

    await switchWalletAndConnect('w_2')

    expect(setActiveWallet).toHaveBeenCalledWith('w_2')
    // Order is the assertion that matters: connectActiveSpark reads the active id, so connecting
    // before the switch would reconnect the wallet being left behind.
    expect(order).toEqual(['switch', 'connect'])
  })
})

describe('removeActiveWallet', () => {
  test("takes the wallet's webhook off the provider on its own connection before tearing it down", async () => {
    await withKeychain(async () => {
      const PK = '02'.padEnd(66, 'a')
      const GID = 'AbCdEfGhIjKlMnOpQrStUv'
      const url = `https://lnurl.usevoltz.app/api/push/spark/${GID}`
      jest.mocked(getBreezLnurlDomain).mockReturnValue('lnurl.usevoltz.app')
      global.fetch = jest.fn(async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch
      const { secret } = await webhookStateFor('primary', PK)
      await noteGatewayWebhookId('primary', secret, GID, PK)
      await noteSdkWebhook('primary', secret, { id: 'h1', url })
      const order: string[] = []
      jest.mocked(sparkConnectedIdentity).mockResolvedValueOnce({ walletId: 'primary', pubkey: PK })
      jest.mocked(sparkWebhookSession).mockImplementationOnce(() => ({
        list: async () => [{ id: 'h1', url, events: [] }],
        register: async () => 'never',
        unregister: async (id: string) => {
          order.push(`unregister ${id}`)
        },
      }))
      jest.mocked(disconnectSpark).mockImplementationOnce(async () => {
        order.push('disconnect')
      })
      jest.mocked(loadRegistry).mockResolvedValueOnce({
        wallets: [
          { id: 'primary', fingerprint: 'a' },
          { id: 'w_2', fingerprint: 'b' },
        ],
        active: 'primary',
      })

      try {
        await removeActiveWallet()
        await deviceForgetSettled()
      } finally {
        jest.mocked(getBreezLnurlDomain).mockImplementation(jest.requireActual('../src/config').getBreezLnurlDomain)
      }

      expect(order).toEqual(['unregister h1', 'disconnect'])
      expect(await loadRetiring(PK)).toBeNull()
      expect(deleteSeedFor).toHaveBeenCalledWith('primary')
      // Its forget is queued, and kept while the gateway cannot be reached.
      expect(await loadDeviceForgets()).toEqual([{ pubkey: PK, proof: forgetProof('lnurl.usevoltz.app', PK, secret) }])
    })
  })

  test('tears down the Spark engine, switches away, then deletes the former active', async () => {
    jest.mocked(loadRegistry).mockResolvedValueOnce({
      wallets: [
        { id: 'primary', fingerprint: 'a' },
        { id: 'w_2', fingerprint: 'b' },
      ],
      active: 'primary',
    })

    await removeActiveWallet()

    expect(disconnectSpark).toHaveBeenCalled()
    expect(setActiveWallet).toHaveBeenCalledWith('w_2')
    expect(deleteSeedFor).toHaveBeenCalledWith('primary')
    expect(removeWalletEntry).toHaveBeenCalledWith('primary')
  })

  // Home keeps a figure until it hears the active wallet move, so a removal it never hears leaves
  // the removed wallet's balance on screen.
  test('announces the wallet it switches to, after the registry points at it', async () => {
    jest.mocked(loadRegistry).mockResolvedValueOnce({
      wallets: [
        { id: 'primary', fingerprint: 'a' },
        { id: 'w_2', fingerprint: 'b' },
      ],
      active: 'primary',
    })
    const order: string[] = []
    jest.mocked(setActiveWallet).mockImplementation(async id => {
      order.push(`set ${id}`)
    })
    const off = onActiveWalletChanged(id => order.push(`heard ${id}`))

    await removeActiveWallet()

    expect(order).toEqual(['set w_2', 'heard w_2'])
    off()
  })

  test('the last wallet is kept, and nothing is announced', async () => {
    jest.mocked(loadRegistry).mockResolvedValueOnce({
      wallets: [{ id: 'primary', fingerprint: 'a' }],
      active: 'primary',
    })
    const seen: string[] = []
    const off = onActiveWalletChanged(id => seen.push(id))

    await removeActiveWallet()

    expect(seen).toEqual([])
    expect(setActiveWallet).not.toHaveBeenCalled()
    expect(deleteSeedFor).not.toHaveBeenCalled()
    off()
  })
})

// A registry restored from a backup onto a new iPhone lists wallets whose seeds stayed on the old one,
// since every seed is stored WHEN_UNLOCKED_THIS_DEVICE_ONLY. Such a wallet cannot sign, so no move of
// the pointer lands on it, and a seed read that fails moves nothing either.
describe('a wallet whose seed is not on this device', () => {
  test('a switch to it is refused, and the pointer and its listeners stay put', async () => {
    jest.mocked(hasSeedFor).mockImplementation(async id => id !== 'w_gone')
    const seen: string[] = []
    const off = onActiveWalletChanged(id => seen.push(id))

    const refused = await switchWalletWithoutReconnecting('w_gone').catch((err: unknown) => err)

    expect(isWalletSeedAbsent(refused)).toBe(true)
    expect(hasSeedFor).toHaveBeenCalledWith('w_gone')
    expect(setActiveWallet).not.toHaveBeenCalled()
    expect(seen).toEqual([])
    off()
  })

  test('the connecting switch is refused before it reconnects anything', async () => {
    jest.mocked(hasSeedFor).mockResolvedValue(false)

    const refused = await switchWalletAndConnect('w_gone').catch((err: unknown) => err)

    expect(isWalletSeedAbsent(refused)).toBe(true)
    expect(setActiveWallet).not.toHaveBeenCalled()
    expect(connectActiveSpark).not.toHaveBeenCalled()
  })

  test('a seed read that throws is not an absent seed: the switch fails with it and moves nothing', async () => {
    const unreadable = new Error('keychain unavailable')
    jest.mocked(hasSeedFor).mockRejectedValue(unreadable)

    const failed = await switchWalletWithoutReconnecting('w_2').catch((err: unknown) => err)

    expect(failed).toBe(unreadable)
    expect(isWalletSeedAbsent(failed)).toBe(false)
    expect(setActiveWallet).not.toHaveBeenCalled()
  })

  test('removing the active wallet lands on the first other wallet whose seed is here', async () => {
    jest.mocked(loadRegistry).mockResolvedValueOnce({
      wallets: [
        { id: 'primary', fingerprint: 'a' },
        { id: 'w_gone', fingerprint: 'b' },
        { id: 'w_3', fingerprint: 'c' },
      ],
      active: 'primary',
    })
    jest.mocked(hasSeedFor).mockImplementation(async id => id !== 'w_gone')

    await removeActiveWallet()

    expect(setActiveWallet).toHaveBeenCalledTimes(1)
    expect(setActiveWallet).toHaveBeenCalledWith('w_3')
    expect(deleteSeedFor).toHaveBeenCalledWith('primary')
    expect(deleteSeedFor).not.toHaveBeenCalledWith('w_gone')
  })

  test('removing the active wallet with no other one that opens is refused and touches nothing', async () => {
    jest.mocked(loadRegistry).mockResolvedValueOnce({
      wallets: [
        { id: 'primary', fingerprint: 'a' },
        { id: 'w_gone', fingerprint: 'b' },
      ],
      active: 'primary',
    })
    jest.mocked(hasSeedFor).mockImplementation(async id => id === 'primary')

    const refused = await removeActiveWallet().catch((err: unknown) => err)

    expect(isWalletSeedAbsent(refused)).toBe(true)
    expect(disconnectSpark).not.toHaveBeenCalled()
    expect(setActiveWallet).not.toHaveBeenCalled()
    expect(deleteSeedFor).not.toHaveBeenCalled()
    expect(removeWalletEntry).not.toHaveBeenCalled()
  })
})

// What a removal clears beside the seed and the list entry, over the in-memory fs: only the removed
// wallet's own entries, never another wallet's, and never what stands for money paid.
// A Keychain that keeps what it is given for the length of `run`, then the default double again.
async function withKeychain(run: () => Promise<void>): Promise<void> {
  const store = new Map<string, string>()
  const set = jest.mocked(Keychain.setGenericPassword)
  const get = jest.mocked(Keychain.getGenericPassword)
  const reset = jest.mocked(Keychain.resetGenericPassword)
  const before = [set.getMockImplementation(), get.getMockImplementation(), reset.getMockImplementation()] as const
  set.mockImplementation(async (_user, password, options) => {
    store.set(options?.service ?? '', password)
    return false
  })
  get.mockImplementation(async options =>
    store.has(options?.service ?? '') ? ({ username: 'u', password: store.get(options?.service ?? '')! } as never) : false,
  )
  reset.mockImplementation(async options => store.delete(options?.service ?? ''))
  try {
    await run()
  } finally {
    set.mockImplementation(before[0]!)
    get.mockImplementation(before[1]!)
    reset.mockImplementation(before[2]!)
  }
}

describe('removeWallet', () => {
  const DOCS = RNFS.DocumentDirectoryPath
  const SETTINGS = `${DOCS}/settings.json`
  const ASKED = `${DOCS}/purchase-asked.json`
  const ASKS = { w_gone: { at: 1_800_000_000, open: false }, w_kept: { at: 1_800_000_100, open: true } }
  const PROOFS: Record<string, string> = {
    [`${DOCS}/purchases.json`]: JSON.stringify({ w_gone: { name: { reference: 'ref-1' } } }),
    [`${DOCS}/purchase-name.json`]: JSON.stringify({ reference: 'ref-0' }),
    [`${DOCS}/store-orders.json`]: JSON.stringify({ orders: { 'ref-2': 'w_gone' } }),
    [`${DOCS}/domain-purchase.json`]: JSON.stringify({ w_gone: { reference: 'ref-3' } }),
  }

  const dollarModes = async () => JSON.parse(await RNFS.readFile(SETTINGS, 'utf8')).dollarMode
  const asks = async () => JSON.parse(await RNFS.readFile(ASKED, 'utf8'))

  beforeEach(async () => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    await saveDollarMode('w_gone', true)
    await saveDollarMode('w_kept', true)
    await RNFS.writeFile(ASKED, JSON.stringify(ASKS), 'utf8')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test("forgets the removed wallet's payment webhook secret and id, and keeps every other wallet's", async () => {
    await withKeychain(async () => {
      const gone = await webhookStateFor('w_gone', '02'.padEnd(66, 'a'))
      const kept = await webhookStateFor('w_kept', '03'.padEnd(66, 'b'))
      expect(gone.secret).not.toBe(kept.secret)

      await removeWallet('w_gone', 'fp')

      expect(await loadWebhookState('w_gone')).toBeNull()
      expect((await loadWebhookState('w_kept'))?.secret).toBe(kept.secret)
    })
  })

  // A wallet removed while another one is connected: its forget is queued before its words go,
  // and goes without them.
  async function removedOffline(reply: () => Promise<unknown>): Promise<{ pub: string; secret: string; fetchMock: jest.Mock }> {
    const pub = '03'.padEnd(66, 'e')
    const { secret } = await webhookStateFor('w_gone', pub)
    jest.mocked(getBreezLnurlDomain).mockReturnValue('lnurl.usevoltz.app')
    const fetchMock = jest.fn(reply)
    global.fetch = fetchMock as unknown as typeof fetch
    const queuedAtDelete: unknown[] = []
    jest.mocked(deleteSeedFor).mockImplementationOnce(async () => {
      queuedAtDelete.push(...(await loadDeviceForgets()))
    })
    await removeWallet('w_gone', 'fp')
    expect(queuedAtDelete).toEqual([{ pubkey: pub, proof: forgetProof('lnurl.usevoltz.app', pub, secret) }])
    return { pub, secret, fetchMock }
  }

  test('queues the forget of a removed wallet before its words go, and a later start sends it without them', async () => {
    await withKeychain(async () => {
      try {
        const { pub, secret } = await removedOffline(async () => {
          throw new Error('network down')
        })
        await deviceForgetSettled()
        expect(deleteSeedFor).toHaveBeenCalledWith('w_gone')
        expect(removeWalletEntry).toHaveBeenCalledWith('w_gone')
        expect(await loadDeviceForgets()).toHaveLength(1)

        const later = jest.fn(async (_url: string, _init: { body: string }) => ({ ok: true, status: 200 }))
        global.fetch = later as unknown as typeof fetch
        await sendDeviceForgets()
        expect(later).toHaveBeenCalledTimes(1)
        expect(later.mock.calls[0]![0]).toBe('https://lnurl.usevoltz.app/api/device/forget')
        expect(JSON.parse(later.mock.calls[0]![1].body)).toEqual({
          pubkey: pub,
          proof: forgetProof('lnurl.usevoltz.app', pub, secret),
        })
        expect(await loadDeviceForgets()).toEqual([])
      } finally {
        jest.mocked(getBreezLnurlDomain).mockImplementation(jest.requireActual('../src/config').getBreezLnurlDomain)
      }
    })
  })

  test('a removal never waits on a gateway that does not answer the forget', async () => {
    await withKeychain(async () => {
      jest.useFakeTimers()
      try {
        // Resolves with no timer advanced, so no wait stood between the person and the removal.
        await removedOffline(() => new Promise(() => undefined))
        expect(deleteSeedFor).toHaveBeenCalledWith('w_gone')
        expect(await loadDeviceForgets()).toHaveLength(1)
        await jest.advanceTimersByTimeAsync(FORGET_WAIT_MS)
      } finally {
        jest.useRealTimers()
        jest.mocked(getBreezLnurlDomain).mockImplementation(jest.requireActual('../src/config').getBreezLnurlDomain)
      }
    })
  })

  test('keeps what the provider may hold of a wallet removed while not connected', async () => {
    await withKeychain(async () => {
      const PK = '03'.padEnd(66, 'd')
      const { secret } = await webhookStateFor('w_gone', PK)
      await noteGatewayWebhookId('w_gone', secret, 'AbCdEfGhIjKlMnOpQrStUv', PK)

      await removeWallet('w_gone', 'fp')

      expect(await loadWebhookState('w_gone')).toBeNull()
      expect(await loadRetiring(PK)).toEqual({ webhookIds: ['AbCdEfGhIjKlMnOpQrStUv'], sdkIds: [], urls: [] })
    })
  })

  test("drops the removed wallet's dollar mode and keeps every other wallet's", async () => {
    await removeWallet('w_gone', 'fp')

    expect(await dollarModes()).toEqual({ w_kept: true })
    expect(removeWalletEntry).toHaveBeenCalledWith('w_gone')
  })

  test("drops the removed wallet's token lists and keeps every other wallet's", async () => {
    const lists = { added: [], hidden: ['btkn1usdb'] }
    await RNFS.writeFile(`${DOCS}/token-prefs.json`, JSON.stringify({ wallets: { w_gone: lists, w_kept: lists } }), 'utf8')

    await removeWallet('w_gone', 'fp')

    expect(JSON.parse(await RNFS.readFile(`${DOCS}/token-prefs.json`, 'utf8'))).toEqual({ wallets: { w_kept: lists } })
  })

  test("drops the removed wallet's review ask and keeps every other wallet's", async () => {
    await RNFS.writeFile(`${DOCS}/store-review.json`, JSON.stringify({ asked: ['w_gone', 'w_kept'] }), 'utf8')

    await removeWallet('w_gone', 'fp')

    expect(JSON.parse(await RNFS.readFile(`${DOCS}/store-review.json`, 'utf8'))).toEqual({ asked: ['w_kept'] })
  })

  test("drops the removed wallet's pending sends and keeps every other wallet's", async () => {
    await notePendingSend('w_gone', 'pay-gone')
    await notePendingSend('w_kept', 'pay-kept')

    await removeWallet('w_gone', 'fp')

    expect(await RNFS.exists(`${DOCS}/pending-sends-w_gone.json`)).toBe(false)
    expect(await readPendingSends('w_gone')).toEqual({ kind: 'ok', ids: [] })
    expect(await readPendingSends('w_kept')).toEqual({ kind: 'ok', ids: ['pay-kept'] })
  })

  test("drops the removed wallet's conversion notes and keeps every other wallet's", async () => {
    const note = {
      from: { ticker: 'USDB', decimals: 6, baseUnits: '1' },
      to: { ticker: null, decimals: 0 },
      fee: { ticker: 'USDB', decimals: 6, baseUnits: '1' },
    }
    await keepConversionNote('w_gone', 'c1', note)
    await keepConversionNote('w_kept', 'c2', note)

    await removeWallet('w_gone', 'fp')

    expect(JSON.parse(await RNFS.readFile(`${DOCS}/conversion-notes.json`, 'utf8'))).toEqual({ w_kept: { c2: note } })
  })

  test('conversion notes that cannot be cleared are logged, and the removal goes on', async () => {
    const note = {
      from: { ticker: 'USDB', decimals: 6, baseUnits: '1' },
      to: { ticker: null, decimals: 0 },
      fee: { ticker: 'USDB', decimals: 6, baseUnits: '1' },
    }
    await keepConversionNote('w_gone', 'c1', note)
    const realWrite = RNFS.writeFile.bind(RNFS)
    jest.spyOn(RNFS, 'writeFile').mockImplementation((async (to: string, text: string, encoding?: string) => {
      if (to.includes('conversion-notes')) {
        throw new Error('disk full')
      }
      return realWrite(to, text, encoding)
    }) as never)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(removeWallet('w_gone', 'fp')).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith('conversion notes not cleared on removal: disk full')
    expect(removeWalletEntry).toHaveBeenCalledWith('w_gone')
  })

  test.each([
    ['domain choice', `${DOCS}/lnurl-domain.json`],
    ['domain answer', `${DOCS}/domain-tier.json`],
  ])('a %s that cannot be written is logged, and the removal goes on', async (what, path) => {
    await RNFS.writeFile(path, JSON.stringify({ w_gone: { host: 'loja.example' } }), 'utf8')
    const realWrite = RNFS.writeFile.bind(RNFS)
    // Jest maps the spec to its in-memory double, which is never null.
    const durable = NativeVoltzDurable as NonNullable<typeof NativeVoltzDurable>
    const realRename = durable.rename.bind(durable)
    // The domain choice is written durably, so the rename over it is the step refused, after its copy
    // was written. The domain answer is written in place, so that write is.
    const rename = jest.spyOn(durable, 'rename').mockImplementation((async (from: string, to: string) => {
      if (to === path) {
        throw new Error('disk full')
      }
      return realRename(from, to)
    }) as never)
    jest.spyOn(RNFS, 'writeFile').mockImplementation((async (to: string, text: string, encoding?: string) => {
      if (to === path) {
        throw new Error('disk full')
      }
      return realWrite(to, text, encoding)
    }) as never)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(removeWallet('w_gone', 'fp')).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(`${what} not cleared on removal: disk full`)
    expect(rename.mock.calls.some(([, to]) => to === path)).toBe(what === 'domain choice')
    expect(removeWalletEntry).toHaveBeenCalledWith('w_gone')
  })

  test("drops when the removed wallet last asked about purchases and keeps every other wallet's", async () => {
    await removeWallet('w_gone', 'fp')

    expect(await asks()).toEqual({ w_kept: ASKS.w_kept })
  })

  test.each([
    ['dollar mode', SETTINGS],
    ['purchase ask', ASKED],
  ])('a %s that cannot be written is logged, and the removal and the other step go on', async (what, path) => {
    const realWrite = RNFS.writeFile.bind(RNFS)
    // The settings file is written whole to its temporary copy first, so that is the write a full
    // disk refuses.
    jest.spyOn(RNFS, 'writeFile').mockImplementation((async (to: string, text: string, encoding?: string) => {
      if (to === path || to === `${path}.tmp`) {
        throw new Error('disk full')
      }
      return realWrite(to, text, encoding)
    }) as never)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(removeWallet('w_gone', 'fp')).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(`${what} not cleared on removal: disk full`)
    expect(deleteSeedFor).toHaveBeenCalledWith('w_gone')
    expect(removeWalletEntry).toHaveBeenCalledWith('w_gone')
    expect(await dollarModes()).toEqual(path === SETTINGS ? { w_gone: true, w_kept: true } : { w_kept: true })
    expect(await asks()).toEqual(path === ASKED ? ASKS : { w_kept: ASKS.w_kept })
  })

  // A line names an address or a host and owes nothing here, so it goes with the wallet rather than
  // coming back under the id the same words take again.
  test("drops the removed wallet's released lines and keeps every other wallet's", async () => {
    const LINES = `${DOCS}/released-lines.json`
    const kept = [{ kind: 'tier', reference: 'ref-k', answer: 'repaid', subject: 'pay.b.com' }]
    await RNFS.writeFile(
      LINES,
      JSON.stringify({ w_gone: [{ kind: 'name', reference: 'ref-g', answer: 'repaid', subject: 'alice@usevoltz.app' }], w_kept: kept }),
      'utf8',
    )

    await removeWallet('w_gone', 'fp')

    expect(JSON.parse(await RNFS.readFile(LINES, 'utf8'))).toEqual({ w_kept: kept })
  })

  // A new wallet under the same id would otherwise claim back a name it never held.
  test("drops the removed wallet's remembered address and keeps every other wallet's", async () => {
    await rememberLnAddress('padaria@usevoltz.app', 'w_gone')
    await rememberLnAddress('mercearia@usevoltz.app', 'w_kept')

    await removeWallet('w_gone', 'fp')

    expect(await lastLnAddress('w_gone')).toBeNull()
    expect(await lastLnAddress('w_kept')).toBe('mercearia@usevoltz.app')
  })

  test('an address memory that cannot be written leaves the removal done', async () => {
    await rememberLnAddress('padaria@usevoltz.app', 'w_gone')
    const realWrite = RNFS.writeFile.bind(RNFS)
    jest.spyOn(RNFS, 'writeFile').mockImplementation((async (to: string, text: string, encoding?: string) => {
      if (to.includes('ln-address-last')) {
        throw new Error('disk full')
      }
      return realWrite(to, text, encoding)
    }) as never)

    await expect(removeWallet('w_gone', 'fp')).resolves.toBeUndefined()

    expect(removeWalletEntry).toHaveBeenCalledWith('w_gone')
    expect(deleteSeedFor).toHaveBeenCalledWith('w_gone')
  })

  test('released lines that cannot be written are logged, and the removal goes on', async () => {
    const LINES = `${DOCS}/released-lines.json`
    await RNFS.writeFile(LINES, JSON.stringify({ w_gone: [], w_kept: [{ reference: 'ref-s', shown: true }] }), 'utf8')
    const realWrite = RNFS.writeFile.bind(RNFS)
    jest.spyOn(RNFS, 'writeFile').mockImplementation((async (to: string, text: string, encoding?: string) => {
      if (to.startsWith(LINES)) {
        throw new Error('disk full')
      }
      return realWrite(to, text, encoding)
    }) as never)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(removeWallet('w_gone', 'fp')).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith('released lines not cleared on removal: disk full')
    expect(removeWalletEntry).toHaveBeenCalledWith('w_gone')
  })

  test('leaves the purchase proofs as they were', async () => {
    for (const [path, text] of Object.entries(PROOFS)) {
      await RNFS.writeFile(path, text, 'utf8')
    }

    await removeWallet('w_gone', 'fp')

    for (const [path, text] of Object.entries(PROOFS)) {
      expect({ path, text: await RNFS.readFile(path, 'utf8') }).toEqual({ path, text })
    }
  })
})
