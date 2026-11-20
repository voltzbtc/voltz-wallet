import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { Camera } from 'react-native-vision-camera'
import RNFS from 'react-native-fs'
import { launchImageLibrary } from 'react-native-image-picker'
import i18n from '../src/i18n'
import { ScanScreen } from '../src/screens/ScanScreen'
import { UnderLock } from '../src/components/UnderLock'
import { sparkClassify } from '../src/wallet/spark'
import { MODULE_DOWNLOADING, oneCode } from '../src/wallet/qrImage'

jest.mock('../specs/NativeVoltzQrImage')
jest.mock('../src/wallet/spark', () => ({ sparkClassify: jest.fn() }))
jest.mock('react-native-image-picker', () => ({ launchImageLibrary: jest.fn() }))

const { reader } = jest.requireMock('../specs/NativeVoltzQrImage') as {
  reader: typeof import('../specs/__mocks__/NativeVoltzQrImage').reader
}

let mockParams: { mode?: string; domain?: string } | undefined
let mockFocused = true
const mockReplace = jest.fn()
const mockNavigate = jest.fn()
const mockPopTo = jest.fn()
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: mockParams }),
  useNavigation: () => ({ replace: mockReplace, navigate: mockNavigate, popTo: mockPopTo }),
  useFocusEffect: () => {},
  useIsFocused: () => mockFocused,
}))

// The picker leaves a copy of the chosen photo in the app's own storage, as both platforms do.
const PICKED = `${RNFS.DocumentDirectoryPath}/rn_image_picker_lib_temp_1.jpg`

function picksPhoto(): void {
  jest.mocked(launchImageLibrary).mockImplementation((async () => {
    await RNFS.writeFile(PICKED, 'photo', 'utf8')
    return { assets: [{ uri: `file://${PICKED}` }] }
  }) as never)
}

async function act(run: () => void | Promise<void>): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await run()
  })
}

async function settle(): Promise<void> {
  await act(() => new Promise<void>(resolve => setTimeout(resolve, 0)))
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await act(() => {
    tree = ReactTestRenderer.create(<ScanScreen />)
  })
  return tree
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

function chip(tree: ReactTestRenderer.ReactTestRenderer) {
  const found = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === i18n.t('scan.gallery')))
  if (!found) {
    throw new Error('no gallery chip')
  }
  return found
}

async function pressGallery(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await act(() => chip(tree).props.onPress())
  await settle()
  await settle()
}

const leftTheScreen = () => [...mockPopTo.mock.calls, ...mockReplace.mock.calls, ...mockNavigate.mock.calls]

beforeEach(() => {
  jest.clearAllMocks()
  mockParams = undefined
  mockFocused = true
  reader.reset()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  picksPhoto()
})

describe('what an image decides', () => {
  it('reads one code', () => {
    expect(oneCode(['lnbc1one'])).toEqual({ kind: 'read', text: 'lnbc1one' })
  })

  it('counts the same code twice as one, spaces included', () => {
    expect(oneCode(['lnbc1one', ' lnbc1one\n'])).toEqual({ kind: 'read', text: 'lnbc1one' })
  })

  it('never picks between two different codes', () => {
    expect(oneCode(['lnbc1one', 'lnbc1two'])).toEqual({ kind: 'several' })
  })

  it('finds nothing in no code and in codes with nothing in them', () => {
    expect(oneCode([])).toEqual({ kind: 'none' })
    expect(oneCode(['', '  '])).toEqual({ kind: 'none' })
  })
})

describe('a read code takes the path of a scanned one', () => {
  it('goes to Send through the classifier, never past it', async () => {
    jest.mocked(sparkClassify).mockResolvedValue('bolt11')
    reader.finds(['lnbc1invoice'])
    const tree = await render()

    await pressGallery(tree)

    expect(sparkClassify).toHaveBeenCalledWith('lnbc1invoice')
    expect(mockPopTo).toHaveBeenCalledWith('Send', { destination: 'lnbc1invoice', picked: expect.any(Number) })
  })

  it('a voucher goes to Redeem', async () => {
    jest.mocked(sparkClassify).mockResolvedValue('lnurlWithdraw')
    reader.finds(['lnurl1wd'])
    const tree = await render()

    await pressGallery(tree)

    expect(mockReplace).toHaveBeenCalledWith('Redeem', { destination: 'lnurl1wd' })
  })

  it('text that pays nothing goes nowhere and says so', async () => {
    jest.mocked(sparkClassify).mockResolvedValue('other')
    reader.finds(['a shop loyalty code'])
    const tree = await render()

    await pressGallery(tree)

    expect(leftTheScreen()).toEqual([])
    expect(texts(tree)).toContain(i18n.t('errors.invalidInput'))
  })

  it('in the wallet mode the shape check applies, and no classifier runs', async () => {
    mockParams = { mode: 'wallet', domain: 'padaria.com' }
    reader.finds(['not a wallet key'])
    const tree = await render()

    await pressGallery(tree)

    expect(sparkClassify).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('errors.invalidInput'))
  })

  it('in the token mode the shape check applies too', async () => {
    mockParams = { mode: 'token' }
    reader.finds(['not a token id'])
    const tree = await render()

    await pressGallery(tree)

    expect(mockNavigate).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('errors.invalidInput'))
  })
})

describe('an image with no answer', () => {
  it('with two different codes picks neither', async () => {
    reader.finds(['lnbc1mine', 'lnbc1theirs'])
    const tree = await render()

    await pressGallery(tree)

    expect(sparkClassify).not.toHaveBeenCalled()
    expect(leftTheScreen()).toEqual([])
    expect(texts(tree)).toContain(i18n.t('scan.gallerySeveral'))
  })

  it('with no code says that', async () => {
    reader.finds([])
    const tree = await render()
    await pressGallery(tree)
    expect(texts(tree)).toContain(i18n.t('scan.galleryNone'))
  })

  it('that cannot be read says that', async () => {
    reader.rejects('The image is corrupt')
    const tree = await render()
    await pressGallery(tree)
    expect(texts(tree)).toContain(i18n.t('scan.galleryFailed'))
  })

  it('with a reader still downloading says to come back', async () => {
    reader.rejects(`Waiting for the ${MODULE_DOWNLOADING}.`)
    const tree = await render()
    await pressGallery(tree)
    expect(texts(tree)).toContain(i18n.t('scan.moduleDownloading'))
    expect(texts(tree)).not.toContain(i18n.t('scan.galleryFailed'))
  })

  it('with a picker that fails says the image could not be read', async () => {
    jest.mocked(launchImageLibrary).mockResolvedValue({ errorCode: 'others', errorMessage: 'no picker' } as never)
    const tree = await render()
    await pressGallery(tree)
    expect(texts(tree)).toContain(i18n.t('scan.galleryFailed'))
  })

  it('a cancelled picker says nothing at all', async () => {
    jest.mocked(launchImageLibrary).mockResolvedValue({ didCancel: true } as never)
    const tree = await render()
    const before = texts(tree)

    await pressGallery(tree)

    expect(texts(tree)).toEqual(before)
    expect(leftTheScreen()).toEqual([])
  })

  it('clears its line on the next try', async () => {
    reader.finds([])
    const tree = await render()
    await pressGallery(tree)
    expect(texts(tree)).toContain(i18n.t('scan.galleryNone'))

    jest.mocked(launchImageLibrary).mockResolvedValue({ didCancel: true } as never)
    await pressGallery(tree)

    expect(texts(tree)).not.toContain(i18n.t('scan.galleryNone'))
  })
})

describe('the wait', () => {
  it('opens one picker for two taps, and the camera stays off until it answers', async () => {
    jest.mocked(sparkClassify).mockResolvedValue('bolt11')
    reader.finds(['lnbc1invoice'])
    reader.holds()
    const tree = await render()
    const press = chip(tree).props.onPress

    await act(() => {
      press()
      press()
    })
    await settle()

    expect(launchImageLibrary).toHaveBeenCalledTimes(1)
    expect(tree.root.findByType(Camera).props.isActive).toBe(false)
    expect(chip(tree).props.disabled).toBe(true)

    await act(() => reader.release())
    await settle()
    await settle()
    expect(mockPopTo).toHaveBeenCalledTimes(1)
  })

  it('turns the camera back on after a cancelled pick', async () => {
    jest.mocked(launchImageLibrary).mockResolvedValue({ didCancel: true } as never)
    const tree = await render()
    await pressGallery(tree)
    expect(tree.root.findByType(Camera).props.isActive).toBe(true)
  })

  it('an answer that lands after the screen closed goes nowhere', async () => {
    jest.mocked(sparkClassify).mockResolvedValue('bolt11')
    reader.finds(['lnbc1invoice'])
    reader.holds()
    const tree = await render()
    await act(() => {
      chip(tree).props.onPress()
    })
    await settle()

    await act(() => tree.unmount())
    await act(() => reader.release())
    await settle()
    await settle()

    expect(sparkClassify).not.toHaveBeenCalled()
    expect(leftTheScreen()).toEqual([])
  })

  it('an answer that lands with another screen on top goes nowhere', async () => {
    jest.mocked(sparkClassify).mockResolvedValue('bolt11')
    reader.finds(['lnbc1invoice'])
    reader.holds()
    const tree = await render()
    await act(() => {
      chip(tree).props.onPress()
    })
    await settle()

    mockFocused = false
    await act(() => tree.update(<ScanScreen />))
    await act(() => reader.release())
    await settle()
    await settle()

    expect(leftTheScreen()).toEqual([])
  })
})

describe('under the lock', () => {
  it('keeps the camera off while the PIN is up, and turns it back on at the unlock', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await act(() => {
      tree = ReactTestRenderer.create(
        <UnderLock locked>
          <ScanScreen />
        </UnderLock>,
      )
    })
    expect(tree.root.findByType(Camera).props.isActive).toBe(false)

    await act(() => {
      tree.update(
        <UnderLock locked={false}>
          <ScanScreen />
        </UnderLock>,
      )
    })
    expect(tree.root.findByType(Camera).props.isActive).toBe(true)
  })
})

describe('the copy the picker leaves behind', () => {
  it('goes once the code is read', async () => {
    jest.mocked(sparkClassify).mockResolvedValue('bolt11')
    reader.finds(['lnbc1invoice'])
    const tree = await render()
    await pressGallery(tree)
    await expect(RNFS.exists(PICKED)).resolves.toBe(false)
    expect(mockPopTo).toHaveBeenCalled()
  })

  it('goes when the read fails too', async () => {
    reader.rejects('The image is corrupt')
    const tree = await render()
    await pressGallery(tree)
    await expect(RNFS.exists(PICKED)).resolves.toBe(false)
  })
})

describe('the picker', () => {
  it('asks for the image at full size, since a downscaled one can lose a dense code', async () => {
    jest.mocked(launchImageLibrary).mockResolvedValue({ didCancel: true } as never)
    const tree = await render()
    await pressGallery(tree)
    const [options] = jest.mocked(launchImageLibrary).mock.calls[0]
    expect(options).toEqual({ mediaType: 'photo', selectionLimit: 1 })
  })
})

describe('what ships', () => {
  const root = join(__dirname, '..')
  const read = (path: string): string => readFileSync(join(root, path), 'utf8')
  const sources = (dir: string): string[] =>
    readdirSync(join(root, dir)).flatMap(name => {
      const path = join(dir, name)
      return statSync(join(root, path)).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
    })

  it('asks for no storage permission', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml')
    expect(manifest).not.toMatch(/READ_MEDIA_/)
    expect(manifest).toMatch(/READ_EXTERNAL_STORAGE" tools:node="remove"/)
  })

  // A library's `implementation` stays off the app's compile classpath, so the app names the artifact
  // to compile against. It must be the one VisionCamera ships, and it must not ship a second time.
  it('compiles against the ML Kit VisionCamera ships, at its version, and adds nothing to the APK', () => {
    const camera = /implementation "(com\.google\.android\.gms:play-services-mlkit-barcode-scanning:[^"]+)"/.exec(
      read('node_modules/react-native-vision-camera/android/build.gradle'),
    )?.[1]
    expect(camera).toBeDefined()
    const gradle = read('android/app/build.gradle').replace(/\/\/.*$/gm, '')
    expect(gradle).toContain(`compileOnly("${camera}")`)
    expect(gradle.match(/mlkit/g)).toHaveLength(1)
    expect(read('android/gradle.properties')).not.toMatch(/VisionCamera_enableCodeScanner/)
  })

  it('leaves the bridge one reader', () => {
    expect(sources('src').filter(path => read(path).includes('specs/NativeVoltzQrImage'))).toEqual([
      'src/wallet/qrImage.ts',
    ])
  })

  it('registers the module on both platforms under the name the spec asks for', () => {
    const asked = /TurboModuleRegistry\.get<Spec>\('([^']+)'\)/.exec(read('specs/NativeVoltzQrImage.ts'))?.[1]
    expect(asked).toBe('NativeVoltzQrImage')
    expect(JSON.parse(read('package.json')).codegenConfig.ios.modulesProvider[asked!]).toBe('RCTNativeVoltzQrImage')
    expect(read('ios/VoltzWallet/QrImage/RCTNativeVoltzQrImage.mm')).toContain('return @"NativeVoltzQrImage";')
    const phase = /13B07F871A680F5B00A75B9A \/\* Sources \*\/ = \{[\s\S]*?\};/.exec(
      read('ios/VoltzWallet.xcodeproj/project.pbxproj'),
    )?.[0]
    expect(phase).toContain('RCTNativeVoltzQrImage.mm in Sources')
    expect(phase).toContain('VoltzQrImageCore.swift in Sources')
    expect(read('android/app/src/main/java/app/usevoltz/MainApplication.kt')).toContain('add(NativeVoltzQrImagePackage())')
  })
})
