import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The Android half of the store bridge holds to rules that Jest cannot run but can read. Each check
// also finds something it must find, so a path or pattern that drifts fails instead of passing on an
// empty match.

const ROOT = join(__dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
// Comments name what the code must not do, so only code is searched.
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const BILLING = 'android/app/src/main/java/app/usevoltz/store/StoreBilling.kt'
const MODULE = 'android/app/src/main/java/app/usevoltz/store/NativeVoltzStoreModule.kt'

// The gateway consumes a Play purchase after it delivers. Consuming or acknowledging on the device
// would race it, and a consumed product can be bought again before anything was delivered.
test('the Android bridge never consumes nor acknowledges a purchase', () => {
  const sources = [code(read(BILLING)), code(read(MODULE))]
  expect(sources[0]).toMatch(/\.launchBillingFlow\(/)
  expect(sources[0]).toMatch(/\.queryPurchasesAsync\(/)
  for (const source of sources) {
    expect(source).not.toMatch(/consumeAsync|acknowledgePurchase|ConsumeParams|AcknowledgePurchaseParams/)
  }
})

test('the Android app registers the store package', () => {
  expect(code(read('android/app/src/main/java/app/usevoltz/MainApplication.kt'))).toMatch(
    /add\(NativeVoltzStorePackage\(\)\)/,
  )
})

// Dependency verification fails the build on a version it holds no checksum for, and CI builds the
// APK only after merging, so the pair is checked here as well.
test('the Play Billing version in the build has checksums in the verification metadata', () => {
  const version = /implementation\("com\.android\.billingclient:billing:([^"]+)"\)/.exec(read('android/app/build.gradle'))?.[1]
  expect(version).toBeDefined()
  const metadata = read('android/gradle/verification-metadata.xml')
  expect(metadata).toContain(`<component group="com.android.billingclient" name="billing" version="${version}">`)
  expect(metadata).toContain(`<artifact name="billing-${version}.aar"><sha256 value="`)
})

// Google has no refund sheet: the gateway asks Google itself, so the module opens nothing.
test('the Android bridge answers the refund sheet as unsupported and opens nothing', () => {
  const source = code(read(MODULE))
  const start = source.indexOf('override fun beginRefundRequest(transactionId: String, promise: Promise)')
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf('\n  override ', start + 1))
  expect(body).toMatch(/putString\("status", "failed"\)/)
  expect(body).toMatch(/putString\("code", "unsupported"\)/)
  expect(body).not.toMatch(/StoreBilling|launch/)
})
