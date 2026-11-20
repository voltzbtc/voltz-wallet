import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

// On an iPhone, React Native Firebase's requestPermission registers with APNs after any answer, a
// refusal included, and its registerDeviceForRemoteMessages returns early once UIKit says
// registered, which leaves a later launch with no APNs token. The app asks and registers through its
// own bridge instead (specs/NativeVoltzNotifications.ts). Jest never runs the Objective-C side, so the
// sources are read here: no app code may reach the two Firebase calls, the native request may never
// register, and the module has to be compiled into the app, or the prompt never shows on a device
// while every suite stays green.

const ROOT = join(__dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const NATIVE = 'ios/VoltzWallet/Notifications/RCTNativeVoltzNotifications.mm'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return sources(path)
    }
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const appSources = [...sources(join(ROOT, 'src')), join(ROOT, 'App.tsx')].map(path => relative(ROOT, path))

// The body of one Objective-C method, from its selector to the method that follows.
function method(text: string, selector: string): string {
  const start = text.indexOf(`- (void)${selector}:`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = text.indexOf('\n- (', start + 1)
  return text.slice(start, next === -1 ? text.indexOf('@end', start) : next)
}

test('the app sources are read', () => {
  expect(appSources).toEqual(expect.arrayContaining(['App.tsx', 'src/wallet/pushToken.ts']))
})

test.each(['requestPermission', 'registerDeviceForRemoteMessages'])(
  'no app source calls Firebase Messaging %s',
  name => {
    // Comments may name them, as pushToken.ts does to say why they are not used.
    const callers = appSources.filter(file => {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      return code.includes('@react-native-firebase/messaging') && new RegExp(`\\b${name}\\b`).test(code)
    })
    expect(callers).toEqual([])
  },
)

test('the native request asks for alerts and sounds and never registers with APNs', () => {
  const request = method(read(NATIVE), 'requestAuthorization')
  expect(request).toContain('requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)')
  expect(request).not.toContain('registerForRemoteNotifications')
})

test('the native registration runs on the main thread on every call', () => {
  const register = method(read(NATIVE), 'registerForRemoteNotifications')
  expect(register).toContain('dispatch_get_main_queue()')
  expect(register).toContain('[[UIApplication sharedApplication] registerForRemoteNotifications]')
  expect(register).not.toContain('isRegisteredForRemoteNotifications')
})

test('the module is named as the spec asks for it and compiled into the app', () => {
  expect(read('specs/NativeVoltzNotifications.ts')).toContain("TurboModuleRegistry.get<Spec>('NativeVoltzNotifications')")
  expect(read(NATIVE)).toContain('return @"NativeVoltzNotifications";')
  const codegen = JSON.parse(read('package.json')).codegenConfig
  expect(codegen.jsSrcsDir).toBe('specs')
  expect(codegen.ios.modulesProvider.NativeVoltzNotifications).toBe('RCTNativeVoltzNotifications')
  // The app target's Sources phase, by its id, which the test target's phase does not share.
  const project = read('ios/VoltzWallet.xcodeproj/project.pbxproj')
  const sourcesPhase = project.slice(project.indexOf('13B07F871A680F5B00A75B9A /* Sources */ = {'))
  expect(sourcesPhase.slice(0, sourcesPhase.indexOf(');'))).toContain('RCTNativeVoltzNotifications.mm in Sources')
})
