import RNFS from 'react-native-fs'
import { isUnreadableFile, readDurable, serialQueue, setAside, writeDurable } from './durableFile'
import type { OnchainSpeed, SparkDeposit, SparkFeeRates } from './spark'

// A fixed fee makes what arrives exactly the amount less the fee, with no sum over vbytes. The figure
// is the largest size the SDK documents for a refund (taproot, against 99 for native segwit), so a
// segwit address pays up to 12% over the rate to keep the number on screen exact.
export const REFUND_VBYTES = 111

// The dust limit depends on the address, and this is the largest of the common types.
export const REFUND_DUST_SAT = 546

export type RefundTier = { speed: OnchainSpeed; feeSat: number; netSat: number }

const SPEEDS: OnchainSpeed[] = ['fast', 'medium', 'slow']

// The speeds that still leave a payable output, fastest first. Empty means too small to send back.
export function refundTiers(amountSat: number, rates: SparkFeeRates): RefundTier[] {
  return SPEEDS.map(speed => {
    const feeSat = rates[speed] * REFUND_VBYTES
    return { speed, feeSat, netSat: amountSat - feeSat }
  }).filter(tier => tier.netSat > REFUND_DUST_SAT)
}

// A refund the network refused is answered only by one that pays more in total, by at least one sat
// per vbyte of its own size (BIP125 rule 4, the same step the mempool minimum moves by), so a fee
// under this floor is refused again.
export function refundFeeFloor(refusedFeeSat: number): number {
  return refusedFeeSat + REFUND_VBYTES
}

// The speeds a new refund may take once one at `refusedFeeSat` was refused: those at or above the
// floor. When today's rates are all below it but the floor still leaves a payable output, the floor
// itself is offered as the fast speed, so a deposit that can go back is never told it is too small.
// Null means no refusal is on record, and the speeds are the plain ones.
export function refundTiersAbove(
  amountSat: number,
  rates: SparkFeeRates,
  refusedFeeSat: number | null,
): RefundTier[] {
  const tiers = refundTiers(amountSat, rates)
  if (refusedFeeSat === null) {
    return tiers
  }
  const floor = refundFeeFloor(refusedFeeSat)
  const above = tiers.filter(tier => tier.feeSat >= floor)
  if (above.length > 0) {
    return above
  }
  const netSat = amountSat - floor
  return netSat > REFUND_DUST_SAT ? [{ speed: 'fast', feeSat: floor, netSat }] : []
}

// The highest fee any refund attempt of a deposit could have signed, by txid:vout, kept on the device
// because the SDK records only the refusal's text (RefundState.lastError), never the fee refused. A
// deposit's outpoint is unique on the chain, so the record needs no wallet.
const FEES_FILE = `${RNFS.DocumentDirectoryPath}/refund-fees.json`

type Fees = Record<string, number>

const isFees = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(fee => Number.isSafeInteger(fee) && (fee as number) >= 0)

const outpoint = (txid: string, vout: number): string => `${txid}:${vout}`

const feesQueue = serialQueue()

/**
 * Records the fee an attempt is about to sign, before it is handed to the SDK, keeping the highest
 * seen for the deposit. Rejects when it could not be recorded, and the caller then signs nothing, so a
 * refusal always has its fee on record. A file that cannot be read is set aside, never written over,
 * and the record starts again from this fee.
 */
export function noteRefundFee(txid: string, vout: number, feeSat: number): Promise<void> {
  return feesQueue(async () => {
    let fees: Fees
    try {
      fees = ((await readDurable(FEES_FILE, isFees, 'nothing')) as Fees | null) ?? {}
    } catch (err) {
      if (!isUnreadableFile(err)) {
        throw err
      }
      await setAside(FEES_FILE)
      fees = {}
    }
    const key = outpoint(txid, vout)
    const next = Math.max(fees[key] ?? 0, feeSat)
    if (fees[key] === next) {
      return
    }
    await writeDurable(FEES_FILE, JSON.stringify({ ...fees, [key]: next }), isFees, 'refuse', 'nothing')
  })
}

/**
 * The highest fee recorded for the deposit, or null when none is. A record that cannot be read also
 * answers null: the speeds are then today's, and a retry at a fee refused again costs that retry, not
 * the deposit.
 */
export function refusedRefundFee(txid: string, vout: number): Promise<number | null> {
  return feesQueue(async () => {
    try {
      const fees = ((await readDurable(FEES_FILE, isFees, 'nothing')) as Fees | null) ?? {}
      return fees[outpoint(txid, vout)] ?? null
    } catch {
      return null
    }
  })
}

// A refund the network keeps refusing cannot recover by rebroadcast, so it needs a new one at a higher
// fee. One that was accepted, or that nothing has refused yet, is left to run.
export function refundNeedsHigherFee(deposit: SparkDeposit): boolean {
  return deposit.refundState === 'pending' && deposit.refundError !== undefined
}

export function canSendBack(deposit: SparkDeposit): boolean {
  return deposit.refundable || refundNeedsHigherFee(deposit)
}
