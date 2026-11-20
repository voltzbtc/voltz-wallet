import RNFS from 'react-native-fs'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import {
  clearGranted,
  clearPending,
  disownPending,
  forgetWalletPurchases,
  loadPending,
  onPendingGone,
  recordRefusal,
  releasePending,
  savePending,
} from '../src/wallet/purchase'
import {
  clearGrantedPurchase,
  clearPendingPurchase,
  forgetWalletDomainPurchase,
  loadPendingPurchase,
  onPendingPurchaseGone,
  recordPurchaseRefusal,
  releasePendingPurchase,
  savePendingPurchase,
} from '../src/wallet/domainOnboard'

jest.mock('../src/wallet/spark', () => ({}))

// The proof belongs to the wallet that pays, so the active wallet decides which slot is read.
jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn(async () => 'w_a') }))

const active = jest.mocked(getActiveWalletId)
const STORE = `${RNFS.DocumentDirectoryPath}/purchases.json`
const UNKEYED = `${RNFS.DocumentDirectoryPath}/purchase-name.json`
const DOMAIN = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`

const NAME = { kind: 'name' as const, subject: 'bakery', reference: 'ref-1', amountSats: 12821 }
const YEAR = { host: 'pay.bakery.com.br', reference: 'ref-1', amountSats: 199800 }

async function remove(path: string): Promise<void> {
  if (await RNFS.exists(path)) {
    await RNFS.unlink(path)
  }
}

// What a view hears from both slots while `work` runs, each heard reference named by its slot.
async function heardDuring(work: () => Promise<unknown>): Promise<string[]> {
  const heard: string[] = []
  const offName = onPendingGone((kind, reference) => heard.push(`${kind}:${reference}`))
  const offTier = onPendingPurchaseGone(reference => heard.push(`tier:${reference}`))
  try {
    await work()
  } finally {
    offName()
    offTier()
  }
  return heard
}

beforeEach(async () => {
  active.mockResolvedValue('w_a')
  for (const path of [STORE, UNKEYED, DOMAIN]) {
    await remove(path)
  }
})

// A view waiting on a payment hears once its proof is no longer owed, whichever writer took it out,
// and hears nothing for a write that leaves it owed.
describe('the name slot tells a view when a proof leaves it', () => {
  it('on a release, and a listener reading the slot then finds no proof', async () => {
    await savePending(NAME)
    let readInside: unknown = 'not heard'
    const heard: string[] = []
    const off = onPendingGone((kind, reference) => {
      heard.push(`${kind}:${reference}`)
      readInside = loadPending('name')
    })
    await releasePending('name', 'ref-1', 'repaid')
    off()
    expect(heard).toEqual(['name:ref-1'])
    expect(await readInside).toBeNull()
  })

  it('on a clear naming the reference', async () => {
    await savePending(NAME)
    expect(await heardDuring(() => clearPending('name', 'ref-1'))).toEqual(['name:ref-1'])
  })

  it('on a mark that names an answer owing nothing, before any clear', async () => {
    await savePending(NAME)
    expect(await heardDuring(() => recordRefusal('name', 'ref-1', true, 'boughtBefore'))).toEqual(['name:ref-1'])
    expect(await loadPending('name')).toBeNull()
  })

  it('on a disowned record, which the wallet no longer reads as its own', async () => {
    await RNFS.writeFile(UNKEYED, JSON.stringify(NAME), 'utf8')
    expect(await heardDuring(() => disownPending('name', 'ref-1'))).toEqual(['name:ref-1'])
  })

  it('on forgetting the wallet, for its proofs alone', async () => {
    await savePending(NAME)
    active.mockResolvedValue('w_b')
    await savePending({ ...NAME, reference: 'ref-2' })
    expect(await heardDuring(() => forgetWalletPurchases('w_a'))).toEqual(['name:ref-1'])
  })

  it('never for a write that leaves the proof owed', async () => {
    await savePending(NAME)
    const heard = await heardDuring(async () => {
      await recordRefusal('name', 'ref-1', true)
      await recordRefusal('name', 'ref-1', false)
      await clearPending('name', 'ref-other')
      await releasePending('name', 'ref-other', 'repaid')
      await savePending({ ...NAME, reference: 'ref-2' })
    })
    expect(heard).toEqual([])
    expect(await loadPending('name')).toMatchObject({ reference: 'ref-1' })
  })

  it('never for a record that stood for no payment', async () => {
    await savePending({ ...NAME, unpaid: true })
    expect(await heardDuring(() => clearPending('name', 'ref-1'))).toEqual([])
  })

  // A clear that cannot land tells nobody the proof is gone, since it is still there.
  it('never for a clear over a store that cannot be read', async () => {
    await RNFS.writeFile(STORE, '{"w_a":', 'utf8')
    expect(await heardDuring(() => clearPending('name', 'ref-1'))).toEqual([])
  })
})

describe('the year record tells a view when a proof leaves it', () => {
  it('on a release', async () => {
    await savePendingPurchase(YEAR)
    expect(await heardDuring(() => releasePendingPurchase('ref-1', 'repaid'))).toContain('tier:ref-1')
    expect(await loadPendingPurchase()).toBeNull()
  })

  it('on a clear naming the reference', async () => {
    await savePendingPurchase(YEAR)
    expect(await heardDuring(() => clearPendingPurchase('ref-1'))).toEqual(['tier:ref-1'])
  })

  it('on a clear that leaves another wallet\'s record in the file', async () => {
    active.mockResolvedValue('w_b')
    await savePendingPurchase({ ...YEAR, reference: 'ref-2' })
    active.mockResolvedValue('w_a')
    await savePendingPurchase(YEAR)
    expect(await heardDuring(() => clearPendingPurchase('ref-1'))).toEqual(['tier:ref-1'])
  })

  it('on a mark that names an answer owing nothing, before any clear', async () => {
    await savePendingPurchase(YEAR)
    expect(await heardDuring(() => recordPurchaseRefusal('ref-1', true, 'boughtBefore'))).toEqual(['tier:ref-1'])
  })

  it('on forgetting the wallet', async () => {
    await savePendingPurchase(YEAR)
    expect(await heardDuring(() => forgetWalletDomainPurchase('w_a'))).toEqual(['tier:ref-1'])
  })

  it('never for a write that leaves the proof owed', async () => {
    await savePendingPurchase(YEAR)
    const heard = await heardDuring(async () => {
      await recordPurchaseRefusal('ref-1', true)
      await recordPurchaseRefusal('ref-1', false)
      await clearPendingPurchase('ref-other')
      await savePendingPurchase({ ...YEAR, reference: 'ref-2' })
    })
    expect(heard).toEqual([])
    expect(await loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
  })

  it('never for a clear over a record that cannot be read', async () => {
    await RNFS.writeFile(DOMAIN, '{"w_a":', 'utf8')
    expect(await heardDuring(() => clearPendingPurchase('ref-1'))).toEqual([])
  })
})

// The writer says how the proof left. Only the clear after a grant says delivered, with the year
// its grant answered for a year, and every other way out says gone, so a view waiting on it shows what
// was bought or goes on as a released slot, and never takes one for the other.
describe('a proof that leaves says how it left', () => {
  const YEAR_GRANTED = { expiresAt: 1_800_000_000, frozen: false }

  async function howDuring(work: () => Promise<unknown>): Promise<string[]> {
    const heard: string[] = []
    const offName = onPendingGone((kind, reference, reason) => heard.push(`${kind}:${reference}:${reason}`))
    const offTier = onPendingPurchaseGone((reference, left) =>
      heard.push(`tier:${reference}:${left.reason === 'granted' ? `granted:${left.year.expiresAt}` : left.reason}`),
    )
    try {
      await work()
    } finally {
      offName()
      offTier()
    }
    return heard
  }

  it('a name cleared after its grant was delivered', async () => {
    await savePending(NAME)
    expect(await howDuring(() => clearGranted('name', 'ref-1'))).toEqual(['name:ref-1:granted'])
    expect(await loadPending('name')).toBeNull()
  })

  it('a year cleared after its grant was delivered, with the year the grant answered', async () => {
    await savePendingPurchase(YEAR)
    expect(await howDuring(() => clearGrantedPurchase('ref-1', YEAR_GRANTED))).toEqual(['tier:ref-1:granted:1800000000'])
    expect(await loadPendingPurchase()).toBeNull()
  })

  it('every other way out of the name slot is gone', async () => {
    const heard: string[] = []
    await savePending(NAME)
    heard.push(...(await howDuring(() => clearPending('name', 'ref-1'))))
    await savePending(NAME)
    heard.push(...(await howDuring(() => releasePending('name', 'ref-1', 'repaid'))))
    await savePending(NAME)
    heard.push(...(await howDuring(() => recordRefusal('name', 'ref-1', true, 'boughtBefore'))))
    await clearPending('name', 'ref-1')
    await savePending(NAME)
    heard.push(...(await howDuring(() => forgetWalletPurchases('w_a'))))
    await RNFS.writeFile(UNKEYED, JSON.stringify(NAME), 'utf8')
    heard.push(...(await howDuring(() => disownPending('name', 'ref-1'))))
    expect(heard).toEqual(Array(5).fill('name:ref-1:gone'))
  })

  it('every other way out of the year record is gone', async () => {
    const heard: string[] = []
    await savePendingPurchase(YEAR)
    heard.push(...(await howDuring(() => clearPendingPurchase('ref-1'))))
    await savePendingPurchase(YEAR)
    heard.push(...(await howDuring(() => recordPurchaseRefusal('ref-1', true, 'boughtBefore'))))
    await clearPendingPurchase('ref-1')
    await savePendingPurchase(YEAR)
    heard.push(...(await howDuring(() => forgetWalletDomainPurchase('w_a'))))
    expect(heard).toEqual(Array(3).fill('tier:ref-1:gone'))
  })

  // A delivery names its reference, so a clear that finds another payment's proof leaves it and tells
  // nobody that anything was delivered.
  it('a delivered clear naming another reference leaves the proof and tells nobody', async () => {
    await savePending(NAME)
    await savePendingPurchase(YEAR)
    const heard = await howDuring(async () => {
      await clearGranted('name', 'ref-other')
      await clearGrantedPurchase('ref-other', YEAR_GRANTED)
    })
    expect(heard).toEqual([])
    expect(await loadPending('name')).toMatchObject({ reference: 'ref-1' })
    expect(await loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
  })
})
