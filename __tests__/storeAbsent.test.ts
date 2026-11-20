import { buy, finish, loadProducts, openPurchases, storeAvailable, storeRefundSheetAvailable } from '../src/wallet/store'

// A binary built without the store module, where TurboModuleRegistry.get answers null.
jest.mock('../specs/NativeVoltzStore', () => ({ __esModule: true, default: null }))

const REFERENCE = 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f'

test('a build without the bridge has no store, and every call says so', async () => {
  expect(storeAvailable()).toBe(false)
  // On iOS too, where only the bridge opens Apple's refund sheet.
  expect(storeRefundSheetAvailable()).toBe(false)
  await expect(buy('name_standard', { reference: REFERENCE })).resolves.toEqual({
    kind: 'failed',
    code: 'storeUnavailable',
  })
  await expect(loadProducts(['name_standard'])).rejects.toMatchObject({ code: 'storeUnavailable' })
  await expect(openPurchases()).rejects.toMatchObject({ code: 'storeUnavailable' })
  await expect(
    finish({
      store: 'apple',
      productId: 'name_standard',
      state: 'purchased',
      purchasedAt: 0,
      reference: REFERENCE,
      key: '1',
      verified: true,
      revoked: false,
    }),
  ).resolves.toBeUndefined()
})
