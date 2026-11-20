import { readFileSync } from 'fs'
import { join } from 'path'
import { version } from '../package.json'
import { APP_VERSION } from '../src/wallet/appVersion'

// The side menu shows package.json's version, while the stores read versionName on Android and
// MARKETING_VERSION on iOS. The three have to name the same release, or a reviewer sees two numbers.
const root = join(__dirname, '..')
const gradle = readFileSync(join(root, 'android/app/build.gradle'), 'utf8')
const pbxproj = readFileSync(join(root, 'ios/VoltzWallet.xcodeproj/project.pbxproj'), 'utf8')

function storeVersion(v: string): string {
  // The stores' "1.0" and package.json's "1.0.0" name the same release.
  return v.replace(/\.0$/, '')
}

test('the side menu, Android and iOS name the same release', () => {
  const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1]
  const marketing = [...pbxproj.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(m => m[1].trim())
  expect(versionName).toBeDefined()
  expect(marketing.length).toBeGreaterThan(0)
  expect(storeVersion(version)).toBe(versionName)
  for (const m of marketing) {
    expect(m).toBe(versionName)
  }
})

// The update notice compares this constant with what the stores serve, so a build that misnames
// itself raises the wrong banner, or none.
test('the constant the notice reads is the version each store ships', () => {
  const versionNames = [...gradle.matchAll(/^\s*versionName "([^"]+)"/gm)].map(m => m[1])
  const marketing = [...pbxproj.matchAll(/^\s*MARKETING_VERSION = ([^;]+);/gm)].map(m => m[1])
  expect(versionNames).toEqual([APP_VERSION])
  expect(marketing.length).toBeGreaterThanOrEqual(2)
  expect(new Set(marketing)).toEqual(new Set([APP_VERSION]))
})
