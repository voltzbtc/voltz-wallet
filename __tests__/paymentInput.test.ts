import { isBitcoinUri, paymentInput } from '../src/wallet/paymentInput'

describe('paymentInput', () => {
  test.each([
    ['lightning:lnbc1abc', 'lnbc1abc'],
    ['LIGHTNING:LNBC1ABC', 'LNBC1ABC'],
    ['Lightning:lnbc1abc', 'lnbc1abc'],
    ['lightning://lnbc1abc', 'lnbc1abc'],
    ['  lightning:lnbc1abc \n', 'lnbc1abc'],
    ['lightning:LNURL1DP68GURN8GHJ7', 'LNURL1DP68GURN8GHJ7'],
    ['lightning:ana@usevoltz.app', 'ana@usevoltz.app'],
  ])('takes the lightning scheme off %s', (text, expected) => {
    expect(paymentInput(text)).toBe(expected)
  })

  // A bitcoin URI can carry a lightning leg in its query, which the SDK reads with the scheme on.
  test.each([
    'bitcoin:bc1qxyz?amount=0.001&lightning=lnbc1abc',
    'lnbc1abc',
    'ana@usevoltz.app',
    'sp1qqexample',
  ])('leaves %s as it is', text => {
    expect(paymentInput(text)).toBe(text)
  })
})

// The SDK matches the scheme as eq_ignore_ascii_case does, after trimming, at the start alone.
describe('isBitcoinUri', () => {
  test.each([
    'bitcoin:bc1qxyz?label=shop@example.com',
    'BITCOIN:BC1QXYZ',
    'BitCoin:?lightning=lnbc1abc',
    '  bitcoin:bc1qxyz \n',
  ])('takes %s for one', text => {
    expect(isBitcoinUri(text)).toBe(true)
  })

  test.each([
    'bitcoin@usevoltz.app',
    'bitcoinx:bc1qxyz',
    'pay bitcoin:bc1qxyz',
    // A dotless i, which uppercases to an ASCII I.
    'b\u0131tcoin:bc1qxyz',
    'ana@usevoltz.app',
    'lnbc1abc',
  ])('takes %s for none', text => {
    expect(isBitcoinUri(text)).toBe(false)
  })
})
