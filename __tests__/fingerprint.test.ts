import { fingerprintFromMnemonic } from '../src/wallet/fingerprint'

// GetInfoResponse carries an identityPubkey and no fingerprint, so this local derivation is the
// only source of a wallet id, and pinning the vectors keeps restore labelling a wallet the same way.
describe('fingerprintFromMnemonic', () => {
  it('derives the SDK master fingerprint for the canonical test vector', () => {
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    expect(fingerprintFromMnemonic(mnemonic)).toBe('73c5da0a')
  })

  it('derives the SDK master fingerprint for a second seed', () => {
    expect(fingerprintFromMnemonic('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong')).toBe(
      '3f635a63',
    )
  })

  it('returns 8 lowercase hex chars', () => {
    expect(fingerprintFromMnemonic('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong')).toMatch(
      /^[0-9a-f]{8}$/,
    )
  })
})
