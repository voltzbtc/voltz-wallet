import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The spec itself, not the double jest.setup.js puts in its place.
function loadSpec(): { default: unknown } {
  let loaded: { default: unknown } | undefined
  jest.isolateModules(() => {
    loaded = jest.requireActual<{ default: unknown }>('../specs/NativeVoltzStore')
  })
  return loaded!
}

afterEach(() => {
  delete require('react-native').NativeModules.NativeVoltzStore
})

test('a binary without the store module reads it as absent instead of failing at import', () => {
  expect(() => loadSpec()).not.toThrow()
  expect(loadSpec().default).toBeNull()
})

test('a binary with the store module hands it over', () => {
  // The same load sees a module that is there, which makes the null above an absence.
  const registered = { buy: jest.fn() }
  require('react-native').NativeModules.NativeVoltzStore = registered
  expect(loadSpec().default).toBe(registered)
})

test('codegen registers the module under the name the spec asks for', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  const spec = readFileSync(join(__dirname, '..', 'specs', 'NativeVoltzStore.ts'), 'utf8')
  const asked = /TurboModuleRegistry\.get<Spec>\('([^']+)'\)/.exec(spec)?.[1]
  expect(asked).toBe('NativeVoltzStore')
  expect(pkg.codegenConfig.jsSrcsDir).toBe('specs')
  expect(pkg.codegenConfig.type).toBe('modules')
  // iOS finds the module by this key at run time; a key that drifts from the spec leaves the store
  // unavailable on every iPhone with no build error. The library holds other modules beside it.
  expect(pkg.codegenConfig.ios.modulesProvider[asked!]).toBe('RCTNativeVoltzStore')
})
