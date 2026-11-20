import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import Svg from 'react-native-svg'
import { Linking, Text, TextInput, View } from 'react-native'
import i18n from '../src/i18n'
import Clipboard from '@react-native-clipboard/clipboard'
import { ScanScreen } from '../src/screens/ScanScreen'
import { sparkClassify } from '../src/wallet/spark'
import { colors, space, touch } from '../src/theme'
import { Field } from '../src/components/Field'
import { Touch } from '../src/components/Touch'

jest.mock('../src/wallet/spark', () => ({ sparkClassify: jest.fn() }))
// A phone with a home indicator, so the bar's clearance over it is visible to the test.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('../__mocks__/react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}))

const mockReplace = jest.fn()
const mockNavigate = jest.fn()
const mockPopTo = jest.fn()
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: undefined }),
  useNavigation: () => ({ replace: mockReplace, navigate: mockNavigate, popTo: mockPopTo }),
  useFocusEffect: () => {},
  useIsFocused: () => true,
}))

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
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

function button(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  const found = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!found) {
    throw new Error(`button not found: ${label}`)
  }
  return found
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    button(tree, label).props.onPress()
  })
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

async function typeAndSubmit(
  tree: ReactTestRenderer.ReactTestRenderer,
  value: string,
): Promise<void> {
  await press(tree, 'Type')
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText(value)
  })
  await press(tree, 'Continue')
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(Clipboard.getString).mockResolvedValue('')
})

// A binary built before the reader, where TurboModuleRegistry.get answers null.
test('a build with no image reader offers no gallery', async () => {
  const tree = await render()
  expect(texts(tree)).toContain(i18n.t('scan.paste'))
  expect(texts(tree)).not.toContain(i18n.t('scan.gallery'))
})

test('a typed payable code routes to Send', async () => {
  jest.mocked(sparkClassify).mockResolvedValue('bolt11')
  const tree = await render()

  await typeAndSubmit(tree, 'lnbc1invoice')

  expect(sparkClassify).toHaveBeenCalledWith('lnbc1invoice')
  expect(mockPopTo).toHaveBeenCalledWith('Send', { destination: 'lnbc1invoice', picked: expect.any(Number) })
  expect(mockReplace).not.toHaveBeenCalled()
})

test('a bitcoin address routes to Send (SendSpark re-classifies + prepares it)', async () => {
  jest.mocked(sparkClassify).mockResolvedValue('bitcoinAddress')
  const tree = await render()

  await typeAndSubmit(tree, 'bc1qaddress')

  expect(mockPopTo).toHaveBeenCalledWith('Send', { destination: 'bc1qaddress', picked: expect.any(Number) })
})

test('a silent payment address routes to Send like a bitcoin address', async () => {
  jest.mocked(sparkClassify).mockResolvedValue('silentPaymentAddress')
  const tree = await render()

  await typeAndSubmit(tree, 'sp1qaddress')

  expect(mockPopTo).toHaveBeenCalledWith('Send', { destination: 'sp1qaddress', picked: expect.any(Number) })
})

test('an address for another network navigates nowhere and shows a hint', async () => {
  jest.mocked(sparkClassify).mockResolvedValue('wrongNetwork')
  const tree = await render()

  await typeAndSubmit(tree, 'tsp1qaddress')

  expect(mockPopTo).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
})

test('a withdraw voucher routes to Redeem, not Send', async () => {
  jest.mocked(sparkClassify).mockResolvedValue('lnurlWithdraw')
  const tree = await render()

  await typeAndSubmit(tree, 'lnurl1wd')

  expect(mockReplace).toHaveBeenCalledWith('Redeem', { destination: 'lnurl1wd' })
  expect(mockPopTo).not.toHaveBeenCalled()
})

test('an unrecognised code navigates nowhere and shows a hint', async () => {
  jest.mocked(sparkClassify).mockResolvedValue('other')
  const tree = await render()

  await typeAndSubmit(tree, 'random')

  expect(mockReplace).not.toHaveBeenCalled()
  expect(mockPopTo).not.toHaveBeenCalled()
  expect(texts(tree).join(' ')).toContain(i18n.t('errors.invalidInput'))
})

// Read whole and for another network, so it is said as Send says it, not as unrecognised.
test('an address for another network reads as Send reads it', async () => {
  jest.mocked(sparkClassify).mockResolvedValue('wrongNetwork')
  const tree = await render()

  await typeAndSubmit(tree, 'tsp1qaddress')

  expect(mockPopTo).not.toHaveBeenCalled()
  expect(texts(tree).join(' ')).toContain(i18n.t('send.unsupported'))
  expect(texts(tree).join(' ')).not.toContain(i18n.t('errors.invalidInput'))
})

// Whether the network or the address is at fault is for Send to tell, with its server to ask.
test.each([
  ['an address that failed to parse', 'other', 'ana@usevoltz.app'],
  ['an LNURL whose server stayed silent', 'unread', 'lnurl1dp68gurn8ghj7'],
] as const)('%s goes on to Send, never called unrecognised here', async (_case, kind, code) => {
  jest.mocked(sparkClassify).mockResolvedValue(kind)
  const tree = await render()

  await typeAndSubmit(tree, code)

  expect(mockPopTo).toHaveBeenCalledWith('Send', expect.objectContaining({ destination: code }))
  expect(texts(tree).join(' ')).not.toContain(i18n.t('errors.invalidInput'))
})

test('the paste button classifies the clipboard and routes', async () => {
  jest.mocked(Clipboard.getString).mockResolvedValue('lnbc1pasted')
  jest.mocked(sparkClassify).mockResolvedValue('bolt11')
  const tree = await render()

  await press(tree, 'Paste')

  expect(sparkClassify).toHaveBeenCalledWith('lnbc1pasted')
  expect(mockPopTo).toHaveBeenCalledWith('Send', { destination: 'lnbc1pasted', picked: expect.any(Number) })
})

describe('the manual-entry sheet', () => {
  const open = async (): Promise<ReactTestRenderer.ReactTestRenderer> => {
    const tree = await render()
    await ReactTestRenderer.act(async () => button(tree, i18n.t('scan.enter')).props.onPress())
    return tree
  }

  it('asks the field for focus once the sheet is on screen, not before', async () => {
    // On iOS a Modal's autoFocus fires before the sheet is presented and the keyboard comes up
    // against nothing, which is why Sheet forwards onShow. Without the handler the person has to
    // tap the field before they can type into it.
    const tree = await open()
    const withShow = tree.root.findAll(n => typeof n.props.onShow === 'function')
    expect(withShow.length).toBeGreaterThan(0)
  })

  it('will not confirm an empty entry', async () => {
    // The button submits whatever is typed straight into the parser, so an empty confirm is a
    // classify call on nothing.
    const tree = await open()
    expect(button(tree, i18n.t('scan.manualConfirm')).props.disabled).toBe(true)
  })

  it('confirms once something is typed', async () => {
    const tree = await open()
    const input = tree.root.findAllByType(TextInput).at(-1)!
    await ReactTestRenderer.act(async () => input.props.onChangeText('lnbc1abc'))
    expect(button(tree, i18n.t('scan.manualConfirm')).props.disabled).toBe(false)
  })
})

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

test('the bottom bar clears the home indicator, as every screen does', async () => {
  const tree = await render()
  const bar = tree.root.findAll(
    node =>
      node.type === View &&
      flat(node.props.style).paddingBottom !== undefined &&
      node.findAllByType(Text).some(text => text.props.children === 'Paste'),
  )
  expect(bar.map(node => flat(node.props.style).paddingBottom)).toEqual([space.xl + 34])
})

test('the typed entry is the app field, a fixed three lines like every destination field', async () => {
  const tree = await render()
  await press(tree, 'Type')
  expect(tree.root.findAllByType(Field)).toHaveLength(1)
  const style = flat(tree.root.findByType(TextInput).props.style)
  expect(style.height).toBe(touch.multiline)
  expect(style.borderWidth).toBeUndefined()
})

const flatStyle = (raw: unknown): Record<string, unknown> =>
  Object.assign({}, ...[raw].flat(Infinity).filter(x => x && typeof x === 'object'))

test('Paste and Enter answer a finger as buttons do, not as bare pressables', async () => {
  const tree = await render()
  for (const label of [i18n.t('scan.paste'), i18n.t('scan.enter')]) {
    const chip = tree.root
      .findAllByType(Touch)
      .find(node => node.findAllByType(Text).some(text => text.props.children === label))
    expect(chip?.props.feedback).toBe('surface')
  }
})

test('the camera shows clear only in the square, darkened around it and everywhere until measured', async () => {
  const tree = await render()
  const views = tree.root.findAllByType(View)
  const black = () => views.find(node => flatStyle(node.props.style).backgroundColor === colors.cameraMask)
  const host = tree.root.findAll(node => typeof node.props.onLayout === 'function')[0]!
  expect(black()).toBeDefined()

  await ReactTestRenderer.act(async () => {
    host.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 640 } } })
  })

  const mask = tree.root.findAll(node => node.props.fillRule === 'evenodd')[0]!
  // The whole area and a point past it, then a hole 240 square in the middle of the area.
  expect(mask.props.d).toMatch(/^M0 0H402V642H0Z/)
  expect(mask.props.d).toContain('M101 201')
  expect(mask.props.fill).toBe(colors.cameraMask)
})

// At density 2.625 a layout of 392.38 by 612.19 rounded to a native view a pixel short, and the camera
// showed in a line down the right edge and over the chips.
test.each([
  [392.38, 612.19],
  [411.43, 700.95],
  [360, 640],
])('the black overruns an area of %d by %d on every side', async (width, height) => {
  const tree = await render()
  const host = tree.root.findAll(node => typeof node.props.onLayout === 'function')[0]!
  await ReactTestRenderer.act(async () => {
    host.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } })
  })

  const svg = tree.root.findAll(node => node.type === Svg).find(node => node.props.width > 240)!
  const { top, left } = flatStyle(svg.props.style)
  expect(top).toBeLessThanOrEqual(-1)
  expect(left).toBeLessThanOrEqual(-1)
  expect(Number(left) + svg.props.width).toBeGreaterThanOrEqual(width + 1)
  expect(Number(top) + svg.props.height).toBeGreaterThanOrEqual(height + 1)
})

// On Android the code reader downloads on first use, and until it lands every frame fails with this,
// which VisionCamera passes to onError as an unknown error carrying ML Kit's message.
describe('while the code reader is still downloading', () => {
  const DOWNLOADING = 'Waiting for the barcode module to be downloaded. Please wait.'
  const downloading = {
    code: 'unknown/unknown',
    message: DOWNLOADING,
    cause: { message: DOWNLOADING, stacktrace: '' },
  }
  const camera = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType('Camera' as never)
  const shown = (tree: ReactTestRenderer.ReactTestRenderer) =>
    texts(tree).includes(i18n.t('scan.moduleDownloading'))
  let consoleError: jest.SpyInstance
  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    consoleError.mockRestore()
  })

  test('says so over the preview, in place of the instruction', async () => {
    const tree = await render()
    expect(shown(tree)).toBe(false)
    await ReactTestRenderer.act(async () => camera(tree).props.onError(downloading))
    expect(shown(tree)).toBe(true)
    expect(texts(tree)).not.toContain(i18n.t('scan.instruction'))
    expect(consoleError).not.toHaveBeenCalled()
    // Paste and typing stay where they were.
    expect(button(tree, i18n.t('scan.paste'))).toBeDefined()
    expect(button(tree, i18n.t('scan.enter'))).toBeDefined()
  })

  test('a failure on every frame sets the line once, not on every frame', async () => {
    const commits = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <React.Profiler id="scan" onRender={commits}>
          <ScanScreen />
        </React.Profiler>,
      )
    })
    await ReactTestRenderer.act(async () => camera(tree).props.onError(downloading))
    const afterFirst = commits.mock.calls.length
    for (let frame = 0; frame < 5; frame++) {
      await ReactTestRenderer.act(async () => camera(tree).props.onError(downloading))
    }
    expect(commits.mock.calls.length).toBe(afterFirst)
    expect(shown(tree)).toBe(true)
  })

  test('a code read once the reader is in clears the line', async () => {
    jest.mocked(sparkClassify).mockResolvedValue('other')
    const tree = await render()
    await ReactTestRenderer.act(async () => camera(tree).props.onError(downloading))
    await ReactTestRenderer.act(async () => {
      camera(tree).props.codeScanner.onCodeScanned([{ value: 'not-a-destination' }])
    })
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
    expect(shown(tree)).toBe(false)
  })

  test('any other camera error leaves the line alone and is logged as before', async () => {
    const tree = await render()
    const other = { code: 'device/camera-already-in-use', message: 'The camera is in use.' }
    await ReactTestRenderer.act(async () => camera(tree).props.onError(other))
    expect(shown(tree)).toBe(false)
    expect(texts(tree)).toContain(i18n.t('scan.instruction'))
    expect(consoleError).toHaveBeenCalledWith(other)
  })
})

describe('without the camera permission', () => {
  beforeEach(() => {
    jest.spyOn(require('react-native-vision-camera'), 'useCameraPermission').mockReturnValue({
      hasPermission: false,
      requestPermission: async () => false,
    })
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('Open settings is a 44pt target', async () => {
    const tree = await render()
    // The style the drawn view takes, which is where a floor shows.
    const drawn = button(tree, i18n.t('scan.openSettings')).findAll(node => typeof node.type === 'string')[0]
    expect(flatStyle(drawn.props.style).minHeight).toBeGreaterThanOrEqual(touch.min)
  })

  // Android shows the permission dialog as an activity over the app, which the relock times against
  // its own limit only inside the bracket.
  test("asks for the camera inside the bracket of the app's own activities", async () => {
    const device: { ownDepth: number } = jest.requireMock('../specs/NativeVoltzPrivacy').device
    const depths: number[] = []
    jest.spyOn(require('react-native-vision-camera'), 'useCameraPermission').mockReturnValue({
      hasPermission: false,
      requestPermission: async () => {
        depths.push(device.ownDepth)
        return false
      },
    })
    await render()
    expect(depths).toEqual([1])
    expect(device.ownDepth).toBe(0)
  })

  test('settings that refuse to open leave no rejection behind, and the line stays', async () => {
    jest.spyOn(Linking, 'openSettings').mockRejectedValue(new Error('no settings activity'))
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      await expect(button(tree, i18n.t('scan.openSettings')).props.onPress()).resolves.toBeUndefined()
    })
    expect(texts(tree)).toContain(i18n.t('scan.permission'))
  })
})

