import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT_IDS } from '../src/wallet/store'

// The iOS half of the store bridge holds to rules that Jest cannot run but can read. Each check also
// finds something it must find, so a path or pattern that drifts fails instead of passing on an empty
// match. ios/VoltzWalletTests runs the core itself against StoreKit's test environment.

const ROOT = join(__dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
// Comments name what the code must not do, so only code is searched.
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const CORE = 'ios/VoltzWallet/Store/VoltzStoreCore.swift'

// Apple finishes only what the gateway's answer names, so the one finish() call is the one behind
// finish(id).
test('the iOS core finishes a transaction only inside finish by id', () => {
  const source = code(read(CORE))
  const calls = [...source.matchAll(/\.finish\(\)/g)]
  expect(calls).toHaveLength(1)
  const byId = source.indexOf('public func finish(_ transactionId: String')
  expect(byId).toBeGreaterThan(-1)
  const next = source.indexOf('\n  public ', byId + 1)
  expect(calls[0].index).toBeGreaterThan(byId)
  expect(calls[0].index).toBeLessThan(next < 0 ? source.length : next)
})

test('the local StoreKit configuration sells exactly the app products, all consumable', () => {
  const config = JSON.parse(read('ios/VoltzWallet/Store/VoltzStore.storekit'))
  const products = config.products as Array<{ productID: string; type: string }>
  expect(products.map(p => p.productID).sort()).toEqual([...PRODUCT_IDS].sort())
  expect(new Set(products.map(p => p.type))).toEqual(new Set(['Consumable']))
  expect(config.subscriptionGroups).toEqual([])
  expect(config.nonRenewingSubscriptions).toEqual([])
})

// iOS finds the module by name at run time, through the class codegen maps it to, so a drift here
// leaves the store unavailable on every iPhone with no build error.
test('the iOS adapter answers the name the spec asks for, under the class codegen maps', () => {
  const pkg = JSON.parse(read('package.json'))
  const [[name, className]] = Object.entries(pkg.codegenConfig.ios.modulesProvider) as [[string, string]]
  expect(read('ios/VoltzWallet/Store/RCTNativeVoltzStore.mm')).toMatch(
    new RegExp(`\\+ \\(NSString \\*\\)moduleName\\s*\\{\\s*return @"${name}";`),
  )
  expect(read('ios/VoltzWallet/Store/RCTNativeVoltzStore.h')).toMatch(
    new RegExp(`@interface ${className} : NativeVoltzStoreSpecBase <NativeVoltzStoreSpec>`),
  )
})

// Apple hands the transactions left unfinished to the first Transaction.updates listener right after
// launch, so the core starts before React Native does.
test('the app delegate starts the store listener before React Native', () => {
  const source = code(read('ios/VoltzWallet/AppDelegate.swift'))
  const start = source.indexOf('VoltzStoreCore.shared.start()')
  const react = source.indexOf('factory.startReactNative(')
  expect(start).toBeGreaterThan(-1)
  expect(react).toBeGreaterThan(-1)
  expect(start).toBeLessThan(react)
})

// The refund sheet is Apple's own and shows on the window scene a purchase sheet would use; the core
// relays what became of it and decides nothing.
test('the iOS core opens the refund sheet for the id asked, on the active scene', () => {
  const source = code(read(CORE))
  const start = source.indexOf('public func beginRefundRequest(_ transactionId: String')
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('\n  static func refundCode', start))
  expect(body).toMatch(/UInt64\(transactionId\)/)
  expect(body).toMatch(/VoltzStoreCore\.activeScene\(\)/)
  expect(body).toMatch(/Transaction\.beginRefundRequest\(for: id, in: scene\)/)
  expect(body).toMatch(/case \.success:[\s\S]*"success"/)
  expect(body).toMatch(/case \.userCancelled:[\s\S]*"userCancelled"/)
  expect(source).toMatch(/case \.duplicateRequest:\s*return "duplicateRequest"/)
  expect([...source.matchAll(/beginRefundRequest\(for:/g)]).toHaveLength(1)
  expect(read('ios/VoltzWallet/Store/RCTNativeVoltzStore.mm')).toMatch(
    /- \(void\)beginRefundRequest:\(NSString \*\)transactionId[\s\S]*\[VoltzStoreCore\.shared beginRefundRequest:transactionId/,
  )
})
