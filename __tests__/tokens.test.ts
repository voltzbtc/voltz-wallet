import { DEPIX, USDB, byAssetOrder, knownToken, lookalikeOf } from '../src/wallet/tokens'

const OTHER_ID = `btkn1${'p'.repeat(58)}`

describe('lookalikeOf', () => {
  it('flags a token that takes a known ticker under another identifier, whatever the case', () => {
    expect(lookalikeOf({ identifier: OTHER_ID, ticker: 'depix', name: 'Something Else' })).toBe(DEPIX)
  })

  it('flags a token that takes a known name under another ticker', () => {
    expect(lookalikeOf({ identifier: OTHER_ID, ticker: 'DPX', name: ' decentralized pix ' })).toBe(DEPIX)
  })

  it('leaves the official tokens alone', () => {
    expect(lookalikeOf({ identifier: DEPIX.identifier, ticker: DEPIX.ticker, name: DEPIX.name })).toBeUndefined()
    expect(lookalikeOf({ identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name })).toBeUndefined()
  })

  // TesteEulen is a real token of another issuer on Spark, and it borrows neither name.
  it('leaves an unrelated token alone', () => {
    expect(lookalikeOf({ identifier: OTHER_ID, ticker: 'TSTE', name: 'TesteEulen' })).toBeUndefined()
  })
})

describe('knownToken', () => {
  it('finds DePix by its identifier with the real as its peg', () => {
    expect(knownToken(DEPIX.identifier)?.fiatId).toBe('BRL')
    expect(knownToken(OTHER_ID)).toBeUndefined()
  })
})

describe('byAssetOrder', () => {
  it('puts the dollars before the real and unknown tokens last, keeping their arrival order', () => {
    const keys = ['tkn-b', DEPIX.identifier, 'USDC', 'tkn-a', USDB.identifier, 'USDT']
    expect([...keys].sort(byAssetOrder)).toEqual([USDB.identifier, 'USDT', 'USDC', DEPIX.identifier, 'tkn-b', 'tkn-a'])
  })
})
