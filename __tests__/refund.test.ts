import RNFS from 'react-native-fs'
import {
  REFUND_DUST_SAT,
  REFUND_VBYTES,
  noteRefundFee,
  refundFeeFloor,
  refundTiers,
  refundTiersAbove,
  refusedRefundFee,
} from '../src/wallet/refund'

const rates = { fast: 10, medium: 5, slow: 1 }
const FILE = `${RNFS.DocumentDirectoryPath}/refund-fees.json`

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.restoreAllMocks()
})

describe('refundTiersAbove', () => {
  it('with no refusal on record offers the plain speeds', () => {
    expect(refundTiersAbove(50_000, rates, null)).toEqual(refundTiers(50_000, rates))
  })

  it('offers only speeds at or above one sat per vbyte over the refused fee', () => {
    const refused = rates.medium * REFUND_VBYTES
    const tiers = refundTiersAbove(50_000, rates, refused)
    expect(tiers.map(tier => tier.speed)).toEqual(['fast'])
    expect(tiers.every(tier => tier.feeSat > refused)).toBe(true)
  })

  it('never offers the refused fee itself, nor one a vbyte step short of the floor', () => {
    const refused = rates.fast * REFUND_VBYTES - REFUND_VBYTES
    const tiers = refundTiersAbove(50_000, rates, refused)
    expect(tiers.map(tier => tier.feeSat)).toEqual([rates.fast * REFUND_VBYTES])
    const floor = (rates.fast + 1) * REFUND_VBYTES
    expect(refundFeeFloor(rates.fast * REFUND_VBYTES)).toBe(floor)
    expect(refundTiersAbove(50_000, rates, rates.fast * REFUND_VBYTES)).toEqual([
      { speed: 'fast', feeSat: floor, netSat: 50_000 - floor },
    ])
  })

  it('offers the floor as the fast speed when every rate today is under it', () => {
    const refused = 5_000
    const floor = refused + REFUND_VBYTES
    expect(refundTiersAbove(50_000, rates, refused)).toEqual([{ speed: 'fast', feeSat: floor, netSat: 50_000 - floor }])
  })

  it('offers nothing when the floor leaves dust, which is then too small to send back', () => {
    const refused = 555
    const floor = refundFeeFloor(refused)
    expect(refundTiersAbove(floor + REFUND_DUST_SAT, rates, refused)).toEqual([])
    expect(refundTiersAbove(floor + REFUND_DUST_SAT + 1, rates, refused)).toEqual([
      { speed: 'fast', feeSat: floor, netSat: REFUND_DUST_SAT + 1 },
    ])
  })
})

describe('the refused fee record', () => {
  it('answers null for a deposit with nothing on record, and with no file', async () => {
    expect(await refusedRefundFee('tx', 0)).toBeNull()
  })

  it('keeps the highest fee per outpoint, across reads as after a restart', async () => {
    await noteRefundFee('tx', 0, 555)
    await noteRefundFee('tx', 0, 300)
    await noteRefundFee('tx', 1, 1_110)
    expect(await refusedRefundFee('tx', 0)).toBe(555)
    expect(await refusedRefundFee('tx', 1)).toBe(1_110)
    expect(await refusedRefundFee('other', 0)).toBeNull()
    expect(JSON.parse(await RNFS.readFile(FILE))).toEqual({ 'tx:0': 555, 'tx:1': 1_110 })
  })

  it('rejects when the fee could not be written, so the caller signs nothing', async () => {
    jest.spyOn(RNFS, 'writeFile').mockRejectedValue(new Error('disk full'))
    await expect(noteRefundFee('tx', 0, 555)).rejects.toThrow('disk full')
  })

  it('sets a torn file aside and starts again from the new fee', async () => {
    await RNFS.writeFile(FILE, '{"tx:0": 55', 'utf8')
    expect(await refusedRefundFee('tx', 0)).toBeNull()
    await noteRefundFee('tx', 0, 777)
    expect(await refusedRefundFee('tx', 0)).toBe(777)
    expect(await RNFS.exists(`${FILE}.unreadable`)).toBe(true)
  })
})
