import { dollarOffer, usdbBaseUnits } from '../src/wallet/dollarOffer'
import { USDB } from '../src/wallet/tokens'

const BASE = { available: true, modeOn: false, synced: true, balanceSat: 5000, usdb: 0, seen: 0 }

test('the line needs something the mode would hold', () => {
  expect(dollarOffer(BASE).line).toBe(true)
  expect(dollarOffer({ ...BASE, balanceSat: 0, usdb: 2_000_000 }).line).toBe(true)
  expect(dollarOffer({ ...BASE, balanceSat: 0 }).line).toBe(false)
})

test.each([
  ['the SDK is not on this wallet', { available: false }],
  ['the mode is on here', { modeOn: true }],
  ['the figure is not synced', { synced: false }],
])('neither shows when %s', (_name, change) => {
  expect(dollarOffer({ ...BASE, usdb: 2_000_000, ...change })).toEqual({ line: false, invite: false })
})

test('the invitation needs USDB above what was answered', () => {
  expect(dollarOffer({ ...BASE, usdb: 2_000_000 }).invite).toBe(true)
  expect(dollarOffer({ ...BASE, usdb: 2_000_000, seen: 2_000_000 }).invite).toBe(false)
  expect(dollarOffer({ ...BASE, usdb: 2_000_001, seen: 2_000_000 }).invite).toBe(true)
})

test('no invitation before the remembered value is read', () => {
  expect(dollarOffer({ ...BASE, usdb: 2_000_000, seen: null }).invite).toBe(false)
})

test('what a conversion leaves under a cent invites nobody', () => {
  expect(dollarOffer({ ...BASE, usdb: 9_999 }).invite).toBe(false)
  expect(dollarOffer({ ...BASE, usdb: 10_000 }).invite).toBe(true)
})

test('USDB is told by identifier, so a token that only shares the name is no USDB', () => {
  expect(usdbBaseUnits([{ identifier: 'btkn1fake', balanceBaseUnits: 9_000_000 }])).toBe(0)
  expect(usdbBaseUnits([{ identifier: USDB.identifier, balanceBaseUnits: 9_000_000 }])).toBe(9_000_000)
})
