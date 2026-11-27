import React from 'react'
import fs from 'fs'
import path from 'path'
import ReactTestRenderer from 'react-test-renderer'
import { PixelRatio, Platform, Share } from 'react-native'
import RNFS from 'react-native-fs'
import { create } from 'qrcode'
import { AddressCard } from '../src/components/AddressCard'
import {
  CARD_FILE,
  CARD_SIZE,
  cardAddressFontSize,
  cardExportSize,
  cardQrPath,
  shareAddressText,
  shareCardImage,
} from '../src/wallet/addressCard'

// The card a lightning address is shared as: its code is the screen's code for the same text, and its
// PNG lives in the app's cache alone and leaves only through the system share sheet.

jest.mock('../specs/NativeVoltzShare')

const { shareSheet } = jest.requireMock('../specs/NativeVoltzShare') as {
  shareSheet: {
    shared: () => { path: string; text: string; title: string; content: string }[]
    rejects: (message: string) => void
    reset: () => void
  }
}

const LNURL =
  'lnurl1dp68gurn8ghj7ampd3kx2ar0veekzar0wd5xjtnrdakj7tnhv4kxctttdehhwm30d3h82unvwqhkx6rfvdjx2ctvxyk'
const ADDRESS = 'satoshi@usevoltz.app'
const PNG = 'iVBORw0KGgo='

// The dark cells a path draws, read back from its squares, as "row,col".
function cellsOf(d: string, side: number, count: number): Set<string> {
  const cell = side / count
  const cells = new Set<string>()
  for (const [, x, y] of d.matchAll(/M([\d.e-]+) ([\d.e-]+)h/g)) {
    cells.add(`${Math.round(Number(y) / cell)},${Math.round(Number(x) / cell)}`)
  }
  return cells
}

// The dark cells of the symbol react-native-qrcode-svg builds for `value` at its default level.
function symbolCells(value: string, level: 'L' | 'M'): { cells: Set<string>; count: number } {
  const modules = create(value, { errorCorrectionLevel: level }).modules
  const cells = new Set<string>()
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (modules.get(row, col)) {
        cells.add(`${row},${col}`)
      }
    }
  }
  return { cells, count: modules.size }
}

const originalOs = Platform.OS
const onAndroid = () =>
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true })

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  shareSheet.reset()
})

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true })
  jest.restoreAllMocks()
})

describe('the code on the card', () => {
  test('draws exactly the modules of the symbol the screen draws for the same text', () => {
    const { cells, count } = symbolCells(LNURL, 'M')
    expect(cellsOf(cardQrPath(LNURL, 480), 480, count)).toEqual(cells)
  })

  test('is not the symbol of another level, which would be another code for the same text', () => {
    const atM = symbolCells(LNURL, 'M')
    const atL = symbolCells(LNURL, 'L')
    expect(cellsOf(cardQrPath(LNURL, 480), 480, atM.count)).not.toEqual(atL.cells)
  })

  test('changes with the text it encodes', () => {
    expect(cardQrPath(`${LNURL}x`, 480)).not.toBe(cardQrPath(LNURL, 480))
  })

  // The screen's QRCode is given no level, so the library's default is the level of the app's code. A
  // library update that moved it would leave the card on another symbol than the screen.
  test('the screen code is drawn at react-native-qrcode-svg default level, which is the level the card uses', () => {
    const lib = fs.readFileSync(
      path.join(__dirname, '..', 'node_modules', 'react-native-qrcode-svg', 'src', 'index.js'),
      'utf8',
    )
    expect(lib).toMatch(/ecl = "M"/)
    const screen = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'screens', 'LnAddressScreen.tsx'),
      'utf8',
    )
    expect(screen).toMatch(/<QRCode value=\{lnAddr\.lnurl\} size=\{QR_SIZE\} \/>/)
  })

  test('the drawn card carries the code of the text it is given and the address in type', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <AddressCard
          address={ADDRESS}
          qrValue={LNURL}
          invite="Pay me in bitcoin"
          size={300}
          label="card"
        />,
      )
    })
    const [qr] = tree.root.findAll(
      node => node.props.testID === 'address-card-qr' && typeof node.props.d === 'string',
    )
    const d: string = qr.props.d
    const { cells, count } = symbolCells(LNURL, 'M')
    // The first cell is the top left finder's corner, always dark, and gives the cell's side.
    const cell = Number(/^M0 0h([\d.e-]+)/.exec(d)?.[1])
    expect(cellsOf(d, cell * count, count)).toEqual(cells)
    const texts = JSON.stringify(tree.toJSON())
    expect(texts).toContain(ADDRESS)
    expect(texts).toContain('Pay me in bitcoin')
    ReactTestRenderer.act(() => tree.unmount())
  })
})

describe('the address in type', () => {
  test('fills the width for a long address and stops at the ceiling for a short one', () => {
    expect(cardAddressFontSize('a@b.co', 888, 72)).toBe(72)
    const long = `${'n'.repeat(40)}@usevoltz.app`
    const size = cardAddressFontSize(long, 888, 72)
    expect(size).toBeLessThan(72)
    expect(size * 0.6 * long.length).toBeLessThanOrEqual(888)
  })
})

describe('the PNG', () => {
  test('is drawn at the card side in pixels on both platforms', () => {
    jest.spyOn(PixelRatio, 'get').mockReturnValue(3)
    expect(cardExportSize()).toEqual({ width: CARD_SIZE / 3, height: CARD_SIZE / 3 })
    onAndroid()
    expect(cardExportSize()).toEqual({ width: CARD_SIZE, height: CARD_SIZE })
  })

  test('lives in the app cache, never in Documents or a public folder', () => {
    expect(CARD_FILE.startsWith(`${RNFS.CachesDirectoryPath}/share/`)).toBe(true)
    expect(CARD_FILE.startsWith(RNFS.DocumentDirectoryPath)).toBe(false)
  })

  test('on iOS goes to the share sheet as a file URL with the text, and is removed once the sheet closes', async () => {
    const isFile = (RNFS as unknown as { __isFile: (p: string) => boolean }).__isFile
    let presentAtShare = false
    const share = jest.spyOn(Share, 'share').mockImplementation(async () => {
      presentAtShare = isFile(CARD_FILE)
      return { action: 'sharedAction' } as never
    })
    await shareCardImage(PNG, `Pay me in bitcoin at ${ADDRESS}`, 'Share your address')
    expect(share).toHaveBeenCalledWith(
      { url: `file://${CARD_FILE}`, message: `Pay me in bitcoin at ${ADDRESS}` },
      { subject: 'Share your address' },
    )
    expect(presentAtShare).toBe(true)
    expect(isFile(CARD_FILE)).toBe(false)
  })

  test('on iOS a sheet that fails still leaves no file, and the failure reaches the caller', async () => {
    const isFile = (RNFS as unknown as { __isFile: (p: string) => boolean }).__isFile
    jest.spyOn(Share, 'share').mockRejectedValue(new Error('no presenter'))
    await expect(shareCardImage(PNG, ADDRESS, 'title')).rejects.toThrow('no presenter')
    expect(isFile(CARD_FILE)).toBe(false)
  })

  test('on Android goes to the native share by its cache path, and stays for the app that reads it later', async () => {
    onAndroid()
    const share = jest.spyOn(Share, 'share')
    await shareCardImage(PNG, `Pay me in bitcoin at ${ADDRESS}`, 'Share your address')
    expect(shareSheet.shared()).toEqual([
      {
        path: CARD_FILE,
        text: `Pay me in bitcoin at ${ADDRESS}`,
        title: 'Share your address',
        content: PNG,
      },
    ])
    expect(share).not.toHaveBeenCalled()
    const isFile = (RNFS as unknown as { __isFile: (p: string) => boolean }).__isFile
    expect(isFile(CARD_FILE)).toBe(true)
  })

  test('on Android a second share overwrites the one file rather than adding another', async () => {
    onAndroid()
    await shareCardImage(PNG, ADDRESS, 'title')
    await shareCardImage('AAAA', ADDRESS, 'title')
    const listed = await RNFS.readDir(`${RNFS.CachesDirectoryPath}/share`)
    expect(listed.map(file => file.path)).toEqual([CARD_FILE])
    expect(await RNFS.readFile(CARD_FILE)).toBe('AAAA')
  })

  test('on Android a refused share reaches the caller', async () => {
    onAndroid()
    shareSheet.rejects('E_FAILED')
    await expect(shareCardImage(PNG, ADDRESS, 'title')).rejects.toThrow('E_FAILED')
  })

  test('calls no network on the way out', async () => {
    const fetched = jest.fn()
    const realFetch = global.fetch
    global.fetch = fetched as never
    try {
      jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never)
      await shareCardImage(PNG, ADDRESS, 'title')
      await shareAddressText(ADDRESS)
      onAndroid()
      await shareCardImage(PNG, ADDRESS, 'title')
    } finally {
      global.fetch = realFetch
    }
    expect(fetched).not.toHaveBeenCalled()
  })
})

test('the text share carries the message alone', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never)
  await shareAddressText(`Pay me in bitcoin at ${ADDRESS}`)
  expect(share).toHaveBeenCalledWith({ message: `Pay me in bitcoin at ${ADDRESS}` })
})
