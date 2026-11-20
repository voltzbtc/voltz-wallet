import { sendBalanceRows } from '../src/components/SendBalance'
import { BITCOIN_ASSET_ID } from '../src/wallet/assets'

test('shows a single Bitcoin row from the sat balance', () => {
  const rows = sendBalanceRows(12000)
  expect(rows).toHaveLength(1)
  expect(rows[0].assetId).toBe(BITCOIN_ASSET_ID)
  expect(rows[0].ticker).toBe('sats')
  // Raw digits, like every amount in the model; the screen groups them in the app language.
  expect(rows[0].amount).toBe('12000')
})
