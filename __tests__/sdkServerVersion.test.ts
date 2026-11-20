import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Breez requires the LNURL server to be updated before the SDK of the apps that use it, since an SDK
// is not compatible with an older server (`crates/breez-sdk/lnurl/README.md`). The server is deployed
// apart from this repository, so nothing else here notices the app passing it. This pin is the server
// version the app talks to, it moves only after the server does, and an SDK above it fails the suite.
const LNURL_SERVER_VERSION = '0.25.0'

// The one pair allowed past the rule, spelled in full so it covers neither a newer SDK nor a newer
// server. The app sends the description explicitly on every register and claim, so no name
// registration depends on the newer server. Once the server reaches the SDK this goes back to null,
// which the suite then asks for.
const ACCEPTED_GAP: { sdk: string; server: string } | null = { sdk: '0.28.0', server: '0.25.0' }

const SDK = '@breeztech/breez-sdk-spark-react-native'
const ROOT = join(__dirname, '..')
const json = (file: string) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'))

const parts = (version: string): number[] => version.split('.').map(Number)

// Numeric by part, as a string comparison reads 0.9.0 as newer than 0.25.0.
function isAhead(sdk: string, server: string): boolean {
  const [a, b] = [parts(sdk), parts(server)]
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) {
      return a[i]! > b[i]!
    }
  }
  return false
}

// What package.json asks for, without its range mark, and what the lockfile installs, which a caret
// may put above it.
const declared = String(json('package.json').dependencies[SDK]).replace(/^[\^~]/, '')
const installed = String(json('package-lock.json').packages[`node_modules/${SDK}`].version)

describe('the order of a version', () => {
  it.each([
    ['0.28.0', '0.25.0', true],
    ['0.25.1', '0.25.0', true],
    ['1.0.0', '0.25.0', true],
    ['0.25.0', '0.25.0', false],
    ['0.24.9', '0.25.0', false],
    ['0.9.0', '0.25.0', false],
  ])('%s against %s', (sdk, server, ahead) => {
    expect(isAhead(sdk, server)).toBe(ahead)
  })
})

describe('the app and the LNURL server', () => {
  it('reads a version from both files', () => {
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/)
    expect(installed).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('never runs an SDK above the server it talks to', () => {
    for (const version of [declared, installed]) {
      const accepted = version === ACCEPTED_GAP?.sdk && LNURL_SERVER_VERSION === ACCEPTED_GAP?.server
      expect({ version, ahead: !accepted && isAhead(version, LNURL_SERVER_VERSION) }).toEqual({
        version,
        ahead: false,
      })
    }
  })

  it('drops the accepted gap as soon as the server closes it', () => {
    if (ACCEPTED_GAP) {
      expect(LNURL_SERVER_VERSION).toBe(ACCEPTED_GAP.server)
      expect(isAhead(ACCEPTED_GAP.sdk, ACCEPTED_GAP.server)).toBe(true)
    }
  })
})
