import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The placeholders stand in for the real Firebase files in every build without them, CI included,
// so they keep the shape Firebase validates before it sends anything. On iOS that check is fatal.
// FirebaseApp.configure() creates Firebase Installations at launch (it registers as always eager),
// and its initializer raises on a key of the wrong length, first letter or alphabet (validateAPIKey in
// FIRInstallations.m), so a key such as "REPLACE_ME" stops the app at launch. Android starts with
// either shape, and a key of this shape reaches Firebase, which refuses it and leaves push off.

const ROOT = join(__dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

const ANDROID_EXAMPLE = 'android/app/google-services.example.json'
const ANDROID_TARGET = 'android/app/google-services.json'
const IOS_EXAMPLE = 'ios/VoltzWallet/GoogleService-Info.example.plist'
const IOS_TARGET = 'ios/VoltzWallet/GoogleService-Info.plist'

const client = JSON.parse(read(ANDROID_EXAMPLE)).client[0]
const plist = read(IOS_EXAMPLE)
const plistString = (key: string) =>
  plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1]

// Utils.isValidApiKeyFormat in Firebase Installations for Android. FIRInstallations validateAPIKey
// on iOS asks for the same length, first letter and alphabet.
const API_KEY_SHAPE = /^A[\w-]{38}$/

test('the Android placeholder passes the checks Firebase runs before any request', () => {
  expect(client.api_key[0].current_key).toMatch(API_KEY_SHAPE)
  expect(client.client_info.mobilesdk_app_id).toMatch(/^1:\d+:android:[0-9a-f]+$/)
})

test('the iOS placeholder passes the checks Firebase runs before any request', () => {
  expect(plistString('API_KEY')).toMatch(API_KEY_SHAPE)
  // FIRApp validateAppID wants version 1, a numeric project, the ios platform and a hex suffix.
  expect(plistString('GOOGLE_APP_ID')).toMatch(/^1:\d+:ios:[0-9a-f]+$/)
})

// The google-services plugin fails the build when no client in the file names the applicationId.
// Only the app's own build configurations count: the unit test bundle has an id of its own and runs
// inside the app, whose id is the one Firebase sees.
test('the placeholders name this app', () => {
  const applicationId = read('android/app/build.gradle').match(/applicationId "([^"]+)"/)?.[1]
  const appSettings = [
    ...read('ios/VoltzWallet.xcodeproj/project.pbxproj').matchAll(
      /isa = XCBuildConfiguration;[\s\S]*?buildSettings = \{([\s\S]*?)\n\t\t\t\};/g,
    ),
  ]
    .map(m => m[1])
    .filter(settings => settings.includes('INFOPLIST_FILE = VoltzWallet/Info.plist;'))
  const bundleIds = appSettings.map(settings => /PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/.exec(settings)?.[1])
  expect(applicationId).toBeDefined()
  expect(client.client_info.android_client_info.package_name).toBe(applicationId)
  // Debug and Release.
  expect(bundleIds).toHaveLength(2)
  for (const id of bundleIds) {
    expect(plistString('BUNDLE_ID')).toBe(id)
  }
})

// A Google API key starts with AIza, and one pasted into an example would be published with it.
test('the placeholders carry no real key', () => {
  expect(client.api_key[0].current_key.startsWith('AIza')).toBe(false)
  expect(plistString('API_KEY')?.startsWith('AIza')).toBe(false)
})

// A copy of the script runs in a scratch tree laid out like the repository, which keeps the real
// files of whoever runs the suite out of reach.
function withScratchTree(check: (dir: string, run: () => string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'firebase-config-'))
  try {
    for (const path of ['scripts/firebase-config.mjs', ANDROID_EXAMPLE, IOS_EXAMPLE]) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      copyFileSync(join(ROOT, path), join(dir, path))
    }
    const script = join(dir, 'scripts/firebase-config.mjs')
    check(dir, () => execFileSync(process.execPath, [script], { encoding: 'utf8' }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a missing configuration gets the placeholder and a notice that push is off', () => {
  withScratchTree((dir, run) => {
    expect(existsSync(join(dir, ANDROID_TARGET))).toBe(false)
    expect(existsSync(join(dir, IOS_TARGET))).toBe(false)
    const out = run()
    expect(readFileSync(join(dir, ANDROID_TARGET), 'utf8')).toBe(read(ANDROID_EXAMPLE))
    expect(readFileSync(join(dir, IOS_TARGET), 'utf8')).toBe(read(IOS_EXAMPLE))
    expect(out).toContain(`${ANDROID_TARGET} was missing`)
    expect(out).toContain(`${IOS_TARGET} was missing`)
    expect(out).toContain('Push notifications stay off')
  })
})

test('an existing configuration is never replaced', () => {
  withScratchTree((dir, run) => {
    writeFileSync(join(dir, ANDROID_TARGET), '{"configured":"android"}')
    writeFileSync(join(dir, IOS_TARGET), '<plist>configured</plist>')
    const out = run()
    expect(readFileSync(join(dir, ANDROID_TARGET), 'utf8')).toBe('{"configured":"android"}')
    expect(readFileSync(join(dir, IOS_TARGET), 'utf8')).toBe('<plist>configured</plist>')
    expect(out).toContain(`${ANDROID_TARGET} exists and is left as it is`)
    expect(out).not.toContain('Push notifications stay off')
  })
})

// firebase.json keeps Firebase Messaging from starting on its own at launch, before any consent.
// pushToken.ts switches it on once notifications are allowed. Nothing else belongs in the file.
describe('firebase.json', () => {
  const config = JSON.parse(read('firebase.json'))['react-native']
  const rnfb = (path: string) => read(`node_modules/@react-native-firebase/${path}`)

  test('starts messaging switched off on both platforms', () => {
    expect(config).toEqual({
      messaging_auto_init_enabled: false,
      messaging_ios_auto_register_for_remote_messages: false,
    })
  })

  // A key the installed React Native Firebase no longer reads would leave Firebase starting at
  // launch with the suite still green. These are the places that read each one.
  test('names keys the installed React Native Firebase reads', () => {
    expect(rnfb('messaging/android/build.gradle')).toContain("'messaging_auto_init_enabled'")
    expect(rnfb('app/ios_config.sh')).toContain('"messaging_auto_init_enabled"')
    expect(rnfb('messaging/ios/RNFBMessaging/RNFBMessaging+NSNotificationCenter.m')).toContain(
      '@"messaging_ios_auto_register_for_remote_messages"',
    )
  })
})
