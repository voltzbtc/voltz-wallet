import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { BackupScreen } from '../src/screens/BackupScreen'
import { captureWatched, onCapturedChange, onScreenshot, readCaptured } from '../src/wallet/screenCapture'

const root = join(__dirname, '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

function sources(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap(name => {
    const path = join(dir, name)
    return statSync(join(root, path)).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
  })
}

// Android runs no module, only FLAG_SECURE at the window, so there is nothing to wait for.
test('with no module the words are drawn on the first render', () => {
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<BackupScreen mnemonic={phrase} length={12} onConfirm={jest.fn()} />)
  })
  const drawn = tree.root.findAllByType(Text).map(node => node.props.children)
  expect(drawn).toContain('abandon')
  expect(drawn).toContain('accident')
})

test('with no module the reader answers without failing', async () => {
  expect(captureWatched()).toBe(false)
  await expect(readCaptured()).resolves.toBe(false)
  expect(() => onCapturedChange(() => undefined)()).not.toThrow()
  expect(() => onScreenshot(() => undefined)()).not.toThrow()
})

test('every screen that draws the word grid goes through the capture hook', () => {
  const callers = sources('src').filter(path =>
    /import \{[^}]*\bSeedWordGrid\b[^}]*\} from/.test(read(path)),
  )
  expect(callers.sort()).toEqual(['src/screens/BackupScreen.tsx', 'src/screens/RecoveryPhraseScreen.tsx'])
  callers.forEach(path => expect(read(path)).toMatch(/useScreenCapture\(/))
})

test('the bridge has one reader', () => {
  const readers = sources('src').filter(path => read(path).includes('specs/NativeVoltzCapture'))
  expect(readers).toEqual(['src/wallet/screenCapture.ts'])
})

test('iOS finds the module under the name the spec asks for, and the app target compiles it', () => {
  const asked = /TurboModuleRegistry\.get<Spec>\('([^']+)'\)/.exec(read('specs/NativeVoltzCapture.ts'))?.[1]
  expect(asked).toBe('NativeVoltzCapture')
  expect(JSON.parse(read('package.json')).codegenConfig.ios.modulesProvider[asked!]).toBe('RCTNativeVoltzCapture')
  const native = read('ios/VoltzWallet/Capture/RCTNativeVoltzCapture.mm')
  expect(native).toContain('return @"NativeVoltzCapture";')
  const project = read('ios/VoltzWallet.xcodeproj/project.pbxproj')
  const sourcesPhase = /isa = PBXSourcesBuildPhase;[\s\S]*?VoltzWallet\.app|13B07F871A680F5B00A75B9A \/\* Sources \*\/ = \{[\s\S]*?\};/.exec(project)?.[0]
  expect(sourcesPhase).toContain('RCTNativeVoltzCapture.mm in Sources')
})

// An emit before setEventEmitterCallback runs an empty std::function and aborts the app.
test('the observers start after the emitter callback is set, never from init', () => {
  const native = read('ios/VoltzWallet/Capture/RCTNativeVoltzCapture.mm')
  const code = native.replace(/\/\/.*$/gm, '')
  expect(code).not.toMatch(/- \(instancetype\)init/)
  const setter = code.indexOf('[super setEventEmitterCallback:')
  expect(setter).toBeGreaterThan(-1)
  expect(code.indexOf('addObserverForName')).toBeGreaterThan(setter)
})
