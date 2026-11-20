import { bip21Address, buildBip21 } from '../src/wallet/bip21'

const ADDR = 'bc1p6symlkge5k60dttfs4y8vncx9spqyduz5ustaw5q3wkfmg45k79qnagp8y'
const INV = 'lnbc100u1p4873gqpp5g2z6aqymxu2lrmxdya2jhzn7yu0gmg4nqqwj5f5vjqa4d9uagnm'
const SPARK = 'sp1qsy7y9d9c4qjl0mxq0dpm8k6l3z2r7v9wgk5m2n8p4q6t8u0w2x4y6z8'

describe('buildBip21', () => {
  it('a bare address is a plain bitcoin: URI (no query)', () => {
    expect(buildBip21({ address: ADDR })).toBe(`bitcoin:${ADDR}`)
  })

  it('attaches a Lightning invoice as the unified lightning= param', () => {
    expect(buildBip21({ address: ADDR, lightning: INV })).toBe(`bitcoin:${ADDR}?lightning=${INV}`)
  })

  it('renders the amount in BTC (BIP21 unit), not sats', () => {
    // The BTC amount is written without trailing zeros.
    expect(buildBip21({ address: ADDR, amountSat: 10_000 })).toBe(`bitcoin:${ADDR}?amount=0.0001`)
  })

  it('combines amount + lightning, amount first', () => {
    expect(buildBip21({ address: ADDR, amountSat: 10_000, lightning: INV })).toBe(
      `bitcoin:${ADDR}?amount=0.0001&lightning=${INV}`,
    )
  })

  it('omits a zero or absent amount', () => {
    expect(buildBip21({ address: ADDR, amountSat: 0, lightning: INV })).toBe(
      `bitcoin:${ADDR}?lightning=${INV}`,
    )
  })

  it('renders a whole-BTC amount without trailing zeros', () => {
    expect(buildBip21({ address: ADDR, amountSat: 100_000_000 })).toBe(`bitcoin:${ADDR}?amount=1`)
  })

  it('attaches the Spark address as the optional spark= param, after amount and lightning', () => {
    expect(buildBip21({ address: ADDR, amountSat: 10_000, lightning: INV, spark: SPARK })).toBe(
      `bitcoin:${ADDR}?amount=0.0001&lightning=${INV}&spark=${SPARK}`,
    )
  })

  it('carries a Spark leg on a bare (amountless) request so a Voltz payer still gets the free rail', () => {
    expect(buildBip21({ address: ADDR, spark: SPARK })).toBe(`bitcoin:${ADDR}?spark=${SPARK}`)
  })
})

describe('bip21Address', () => {
  it('reads the address back from every URI buildBip21 writes', () => {
    expect(bip21Address(buildBip21({ address: ADDR }))).toBe(ADDR)
    expect(bip21Address(buildBip21({ address: ADDR, spark: SPARK }))).toBe(ADDR)
    expect(
      bip21Address(buildBip21({ address: ADDR, amountSat: 10_000, lightning: INV, spark: SPARK })),
    ).toBe(ADDR)
  })
})
