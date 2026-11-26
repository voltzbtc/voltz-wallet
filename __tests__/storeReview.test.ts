import RNFS from 'react-native-fs'
import {
  __resetStoreReviewForTests,
  considerReview,
  forgetStoreReview,
  noteAnnouncedReceive,
  quietMoment,
  wasAsked,
  type ReviewMoment,
} from '../src/wallet/storeReview'
import { notePendingSend } from '../src/wallet/pendingSends'

const { reviewStore } = jest.requireMock('../specs/NativeVoltzReview') as {
  reviewStore: { calls: number; fails: (code: string) => void }
}

const FILE = `${RNFS.DocumentDirectoryPath}/store-review.json`

const QUIET: ReviewMoment = {
  homeInFront: true,
  locked: false,
  appActive: true,
  modalsOpen: 0,
  spendInFlight: false,
}

const listWallets = (ids: string[], active: string | null): Promise<void> =>
  RNFS.writeFile(
    `${RNFS.DocumentDirectoryPath}/wallets.json`,
    JSON.stringify({ active, wallets: ids.map(id => ({ id, fingerprint: `fp-${id}` })) }),
    'utf8',
  )

async function receiveThenClose(walletId: string | null, moment: () => ReviewMoment = () => QUIET) {
  noteAnnouncedReceive(walletId)
  return considerReview(moment)
}

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  __resetStoreReviewForTests()
  await listWallets(['w_a', 'w_b'], 'w_a')
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('quietMoment', () => {
  test('holds only with Home in front, unlocked, active, no Modal and no spend', () => {
    expect(quietMoment(QUIET)).toBe(true)
    expect(quietMoment({ ...QUIET, homeInFront: false })).toBe(false)
    expect(quietMoment({ ...QUIET, locked: true })).toBe(false)
    expect(quietMoment({ ...QUIET, appActive: false })).toBe(false)
    expect(quietMoment({ ...QUIET, modalsOpen: 1 })).toBe(false)
    expect(quietMoment({ ...QUIET, spendInFlight: true })).toBe(false)
  })
})

describe('considerReview', () => {
  test('asks once after an announced receive of the wallet in front, and records it first', async () => {
    let recordedAtAsk: unknown = null
    const native = jest.requireMock('../specs/NativeVoltzReview').default as { request: () => Promise<void> }
    const request = native.request
    jest.spyOn(native, 'request').mockImplementation(async () => {
      recordedAtAsk = JSON.parse(await RNFS.readFile(FILE, 'utf8'))
      return request()
    })

    expect(await receiveThenClose('w_a')).toBe('asked')

    expect(reviewStore.calls).toBe(1)
    expect(recordedAtAsk).toEqual({ asked: ['w_a'] })
    expect(await wasAsked('w_a')).toBe(true)
  })

  test('never asks the same wallet twice', async () => {
    expect(await receiveThenClose('w_a')).toBe('asked')
    expect(await receiveThenClose('w_a')).toBe('alreadyAsked')
    expect(await receiveThenClose('w_a')).toBe('alreadyAsked')

    expect(reviewStore.calls).toBe(1)
  })

  test('keeps the record per wallet', async () => {
    expect(await receiveThenClose('w_a')).toBe('asked')
    await listWallets(['w_a', 'w_b'], 'w_b')

    expect(await receiveThenClose('w_b')).toBe('asked')

    expect(reviewStore.calls).toBe(2)
    expect(JSON.parse(await RNFS.readFile(FILE, 'utf8'))).toEqual({ asked: ['w_a', 'w_b'] })
  })

  test('asks nothing without an announced receive', async () => {
    expect(await considerReview(() => QUIET)).toBe('notArmed')
    expect(reviewStore.calls).toBe(0)
  })

  test('uses up the receive on a close that is not quiet, and waits for the next receive', async () => {
    expect(await receiveThenClose('w_a', () => ({ ...QUIET, homeInFront: false }))).toBe('notQuiet')
    // The same close heard again, with nothing new announced, asks nothing.
    expect(await considerReview(() => QUIET)).toBe('notArmed')
    expect(reviewStore.calls).toBe(0)
    expect(await wasAsked('w_a')).toBe(false)

    expect(await receiveThenClose('w_a')).toBe('asked')
    expect(reviewStore.calls).toBe(1)
  })

  test.each([
    ['a sheet open', { modalsOpen: 1 }],
    ['the PIN up', { locked: true }],
    ['the app away', { appActive: false }],
    ['a send in flight', { spendInFlight: true }],
    ['another screen in front', { homeInFront: false }],
  ])('asks nothing with %s', async (_, change) => {
    expect(await receiveThenClose('w_a', () => ({ ...QUIET, ...change }))).toBe('notQuiet')
    expect(reviewStore.calls).toBe(0)
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  test('asks nothing when the moment ends while the record is read', async () => {
    const moments = [QUIET, { ...QUIET, modalsOpen: 1 }]
    expect(await receiveThenClose('w_a', () => moments.shift() ?? QUIET)).toBe('notQuiet')

    expect(reviewStore.calls).toBe(0)
    expect(await wasAsked('w_a')).toBe(false)
  })

  test('asks nothing when the moment ends while the record is written, and keeps the record', async () => {
    const moments = [QUIET, QUIET, { ...QUIET, spendInFlight: true }]
    expect(await receiveThenClose('w_a', () => moments.shift() ?? QUIET)).toBe('notQuiet')

    expect(reviewStore.calls).toBe(0)
    expect(await wasAsked('w_a')).toBe(true)
  })

  test('asks nothing for a receive announced on a wallet that is no longer in front', async () => {
    await listWallets(['w_a', 'w_b'], 'w_b')

    expect(await receiveThenClose('w_a')).toBe('otherWallet')
    expect(reviewStore.calls).toBe(0)
    expect(await wasAsked('w_a')).toBe(false)
  })

  test('asks nothing for a receive with no connected wallet', async () => {
    expect(await receiveThenClose(null)).toBe('notArmed')
    expect(reviewStore.calls).toBe(0)
  })

  test('takes a registry with no active pointer as the primary wallet', async () => {
    await listWallets(['primary'], null)

    expect(await receiveThenClose('primary')).toBe('asked')
  })

  test('asks nothing while the wallet has a send left pending', async () => {
    await notePendingSend('w_a', 'pay-1')

    expect(await receiveThenClose('w_a')).toBe('notQuiet')
    expect(reviewStore.calls).toBe(0)
  })

  test('asks nothing when the pending sends cannot be read', async () => {
    await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/pending-sends-w_a.json`, '{"torn', 'utf8')

    expect(await receiveThenClose('w_a')).toBe('notQuiet')
    expect(reviewStore.calls).toBe(0)
  })

  test('counts a torn record as asked, for every wallet, and writes nothing over it', async () => {
    await RNFS.writeFile(FILE, '{"asked": ["w_', 'utf8')

    expect(await receiveThenClose('w_a')).toBe('alreadyAsked')
    await listWallets(['w_a', 'w_b'], 'w_b')
    expect(await receiveThenClose('w_b')).toBe('alreadyAsked')

    expect(reviewStore.calls).toBe(0)
    expect(await RNFS.readFile(FILE, 'utf8')).toBe('{"asked": ["w_')
  })

  test('counts a record the platform will not read as asked', async () => {
    await RNFS.writeFile(FILE, JSON.stringify({ asked: [] }), 'utf8')
    const read = RNFS.readFile
    jest.spyOn(RNFS, 'readFile').mockImplementation(async (path: string, encoding?: string) => {
      if (path === FILE) {
        throw new Error('EACCES')
      }
      return read(path, encoding)
    })

    expect(await receiveThenClose('w_a')).toBe('alreadyAsked')
    expect(reviewStore.calls).toBe(0)
  })

  test('asks nothing when the record cannot be written', async () => {
    jest.spyOn(RNFS, 'writeFile').mockRejectedValue(new Error('ENOSPC'))

    expect(await receiveThenClose('w_a')).toBe('unrecorded')
    expect(reviewStore.calls).toBe(0)
  })

  test('reads a cut first write as no record', async () => {
    await RNFS.writeFile(`${FILE}.tmp`, '{"ask', 'utf8')

    expect(await wasAsked('w_a')).toBe(false)
    expect(await receiveThenClose('w_a')).toBe('asked')
  })

  test('says nothing when the store fails, and never asks that wallet again', async () => {
    const said = [
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      jest.spyOn(console, 'error').mockImplementation(() => undefined),
    ]
    reviewStore.fails('play-1')

    expect(await receiveThenClose('w_a')).toBe('asked')
    expect(await receiveThenClose('w_a')).toBe('alreadyAsked')

    expect(reviewStore.calls).toBe(1)
    said.forEach(spy => expect(spy).not.toHaveBeenCalled())
  })

  test('makes no network call of its own', async () => {
    const fetchSpy = jest.fn()
    const realFetch = global.fetch
    global.fetch = fetchSpy as unknown as typeof fetch
    try {
      expect(await receiveThenClose('w_a')).toBe('asked')
    } finally {
      global.fetch = realFetch
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('without the native module', () => {
  test('records the ask and asks nothing, silently', async () => {
    jest.replaceProperty(jest.requireMock('../specs/NativeVoltzReview'), 'default', null)
    const said = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(receiveThenClose('w_a')).resolves.toBe('asked')

    expect(reviewStore.calls).toBe(0)
    expect(await wasAsked('w_a')).toBe(true)
    expect(said).not.toHaveBeenCalled()
  })
})

describe('forgetStoreReview', () => {
  test('lets the same id be asked again once removed, and keeps every other id', async () => {
    expect(await receiveThenClose('w_a')).toBe('asked')
    await listWallets(['w_a', 'w_b'], 'w_b')
    expect(await receiveThenClose('w_b')).toBe('asked')

    await forgetStoreReview('w_a')

    expect(JSON.parse(await RNFS.readFile(FILE, 'utf8'))).toEqual({ asked: ['w_b'] })
    expect(await wasAsked('w_a')).toBe(false)
  })

  test('leaves a torn record as it is, still counting every wallet as asked', async () => {
    await RNFS.writeFile(FILE, '{"asked', 'utf8')

    await expect(forgetStoreReview('w_a')).rejects.toBeTruthy()

    expect(await RNFS.readFile(FILE, 'utf8')).toBe('{"asked')
    expect(await wasAsked('w_b')).toBe(true)
  })

  test('writes nothing when the wallet was never asked', async () => {
    await forgetStoreReview('w_a')

    expect(await RNFS.exists(FILE)).toBe(false)
  })
})
