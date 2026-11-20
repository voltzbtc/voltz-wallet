import {
  CpfpFundingStrategy,
  RecoveryMethod,
  RecoveryTxKind,
} from '@breeztech/breez-sdk-spark-react-native'
import type { ExitPlan } from '../../src/wallet/exitPlan'
import type { SparkRecoverQuote, SparkRecovery } from '../../src/wallet/spark'

// The shapes of the binding's PrepareRecoverFundsResponse and RecoverFundsResponse, every field filled.

export const DESTINATION = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
export const FEE_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
export const FEE_PUBLIC_KEY = '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c'
export const UTXO_TXID = 'ab'.repeat(32)

const leaf = (leafId: string, valueSats: bigint, method = RecoveryMethod.Unilateral) => ({
  leafId,
  valueSats,
  method,
})

export const quoteOf = (over: Partial<SparkRecoverQuote> = {}): SparkRecoverQuote =>
  ({
    leaves: [leaf('leaf-1', 60_000n), leaf('leaf-2', 40_000n)],
    skipped: [],
    recoverableValueSats: 100_000n,
    totalFeeSats: 12_000n,
    cooperativeFeeSats: 0n,
    cpfpFeeSats: 8_000n,
    fanoutFeeSats: 1_000n,
    refundFeeSats: 0n,
    sweepFeeSats: 3_000n,
    funding: { singleUtxoSats: 15_000n, perBranch: [], strategy: CpfpFundingStrategy.PerBranch },
    feeRateSatPerVbyte: 10n,
    destination: DESTINATION,
    exitChainState: {
      confirmedNodes: [],
      refunds: [],
      stoppedLeafIds: [],
      unverifiedNodeIds: [],
      unverifiableConfirmedNodeIds: [],
    },
    ...over,
  }) as SparkRecoverQuote

type Step = SparkRecovery['transactions'][number]

export const stepOf = (over: Partial<Omit<Step, 'status'>> & { status: unknown }): Step =>
  ({
    kind: RecoveryTxKind.Node,
    nodeId: 'node-1',
    txid: 'aa'.repeat(32),
    txHex: 'aabb',
    cpfpTxHex: undefined,
    csvTimelockBlocks: undefined,
    dependsOn: [],
    ...over,
  }) as Step

export const READY = { tag: 'Ready' }
export const CONFIRMED = { tag: 'Confirmed', inner: { blockHeight: 870_000 } }

export const recoveryOf = (over: Partial<SparkRecovery> = {}): SparkRecovery =>
  ({
    recoverableValueSats: 100_000n,
    totalFeeSats: 12_000n,
    cooperativeFeeSats: 0n,
    cpfpFeeSats: 8_000n,
    fanoutFeeSats: 1_000n,
    refundFeeSats: 0n,
    sweepFeeSats: 3_000n,
    leaves: [leaf('leaf-1', 60_000n), leaf('leaf-2', 40_000n)],
    failed: [],
    transactions: [stepOf({ status: READY, cpfpTxHex: 'ccdd' })],
    fundingInputs: [
      { tag: 'P2wpkh', inner: { txid: UTXO_TXID, vout: 1, valueSats: 15_000n, pubkey: FEE_PUBLIC_KEY } },
    ],
    feeRateSatPerVbyte: 10n,
    destination: DESTINATION,
    ...over,
  }) as SparkRecovery

export const planOf = (over: Partial<ExitPlan> = {}): ExitPlan => ({
  walletId: 'primary',
  feeKey: { index: 0, address: FEE_ADDRESS, publicKey: FEE_PUBLIC_KEY },
  recovery: recoveryOf(),
  verdict: 'valid',
  checkedAt: 1_000,
  refused: [],
  ...over,
})

// A CPFP child as build_cpfp_child makes it: version 3, the funding coins with 72 byte signatures, the
// parent's P2A anchor last with an empty witness, and one P2WPKH change of 1,000 sats.
export const cpfpChildHex = (coins: number): string => {
  const byte = (value: number): string => value.toString(16).padStart(2, '0')
  const input = (txidByte: string, vout: number): string => txidByte.repeat(32) + byte(vout) + '000000' + '00fdffffff'
  const funding = Array.from({ length: coins }, (_, vout) => input('22', vout)).join('')
  const change = 'e803000000000000' + '16' + '0014' + '44'.repeat(20)
  const witnesses = ('02' + '48' + '30'.repeat(72) + '21' + '02'.repeat(33)).repeat(coins)
  return '03000000' + '0001' + byte(coins + 1) + funding + input('33', 0) + '01' + change + witnesses + '00' + '00000000'
}
