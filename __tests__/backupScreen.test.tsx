import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Dimensions, Text, View } from 'react-native'
import i18n from '../src/i18n'
import { BackupScreen } from '../src/screens/BackupScreen'
import { Skeleton } from '../src/components/Skeleton'
import { space, font } from '../src/theme'
import { formatFingerprint } from '../src/wallet/walletIdentity'

const PHRASE =
  'abandon ability able about above absent absorb abstract absurd abuse access accident'

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (c): c is string => typeof c === 'string',
    )
  })
}

function render(
  props: Partial<React.ComponentProps<typeof BackupScreen>> = {},
): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <BackupScreen
        mnemonic={PHRASE}
        fingerprint="0a1b2c3d"
        length={12}
        onLengthChange={() => undefined}
        onConfirm={() => undefined}
        {...props}
      />,
    )
  })
  return tree
}

it('shows every word of the phrase, in order', async () => {
  const shown = texts(render())
  for (const word of PHRASE.split(' ')) {
    expect(shown).toContain(word)
  }
  const positions = PHRASE.split(' ').map(w => shown.indexOf(w))
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
})

it('numbers them, since the phrase is written down in order', () => {
  const shown = texts(render())
  expect(shown).toContain('1')
  expect(shown).toContain('12')
})

it('shows the wallet fingerprint, which is how two wallets are told apart', () => {
  // The one thing on this screen saying which wallet the phrase belongs to. Without it a person
  // holding two wallets has two identical sheets of paper.
  expect(texts(render())).toContain(formatFingerprint('0a1b2c3d'))
})

describe('while the seed is still being derived', () => {
  it('draws a placeholder grid of the length asked for, and no words', () => {
    const tree = render({ mnemonic: '', length: 24 })
    expect(texts(tree)).not.toContain('abandon')
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(24)
  })

  it('draws each placeholder at the height a real cell will be', () => {
    // A placeholder even a point off the cell height moves every word when the phrase arrives, so
    // this is asserted against the same arithmetic the cell uses rather than a number.
    const tree = render({ mnemonic: '', length: 12 })
    const cells = tree.root.findAllByType(Skeleton).filter(s => s.props.borderRadius != null)
    expect(cells).toHaveLength(12)
    for (const cell of cells) {
      expect(cell.props.height).toBe(2 * space.md + font.leading.base)
    }
  })

  it('keeps the confirm button out of reach until there is a phrase to confirm', () => {
    const confirm = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root
        .findAll(n => typeof n.props.onPress === 'function')
        .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('backup.confirm')))!
    expect(confirm(render({ mnemonic: '' })).props.disabled).toBe(true)
    expect(confirm(render()).props.disabled).toBe(false)
  })
})

it('draws no wallet id where no fingerprint is given, as in the first run', () => {
  const shown = texts(render({ fingerprint: undefined, lockLength: true }))
  expect(shown).not.toContain(i18n.t('backup.walletId'))
})

it('takes the wallet id down while a passphrase, which changes it, is typed', async () => {
  const tree = render({ passphrase: true })
  expect(texts(tree)).toContain(i18n.t('backup.walletId'))

  const add = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('passphrase.add')))!
  await ReactTestRenderer.act(async () => add.props.onPress())
  expect(texts(tree)).toContain(i18n.t('backup.walletId'))

  await ReactTestRenderer.act(async () => {
    tree.root.findAll(n => typeof n.props.onChangeText === 'function')[0].props.onChangeText('words')
  })
  expect(texts(tree)).not.toContain(i18n.t('backup.walletId'))
})

it('offers the length choice, unless the seed is bound to one', () => {
  // A dice seed is rolled for a length, so switching would silently replace it with an RNG one.
  expect(texts(render()).join(' ')).toContain(i18n.t('welcome.words', { count: 24 }))
  expect(texts(render({ lockLength: true })).join(' ')).not.toContain(
    i18n.t('welcome.words', { count: 24 }),
  )
})

type Cell = {
  index: string
  word: string
  width: unknown
  gap: unknown
  pad: unknown
  boxPad: unknown
  indexStyle: Record<string, unknown>
  wordProps: Record<string, unknown>
}

const CELL_WIDTHS = ['100%', '50%', '33.33%']

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

const textOf = (node: ReactTestRenderer.ReactTestInstance): string =>
  [node.props.children].flat().map(String).join('')

// The cells of the seed word grid, read from what each one draws: its number, its word, the width
// it takes in the row and how the number sits beside the word.
function wordCells(tree: ReactTestRenderer.ReactTestRenderer): Cell[] {
  return tree.root
    .findAll(node => node.type === View && CELL_WIDTHS.includes(flat(node.props.style).width as string))
    .map(cell => {
      const [index, word] = cell.findAllByType(Text)
      const row = cell.findAll(node => node.type === View && flat(node.props.style).gap !== undefined)[0]
      return {
        index: textOf(index!),
        word: textOf(word!),
        width: flat(cell.props.style).width,
        gap: row ? flat(row.props.style).gap : undefined,
        pad: flat(cell.props.style).padding,
        boxPad: row ? flat(row.props.style).paddingHorizontal : undefined,
        indexStyle: flat(index!.props.style),
        wordProps: word!.props,
      }
    })
}

// The room a drawn cell leaves its word inside a grid of the given width: its share of the row, less
// what the cell, the word box, the number and the gap take.
function roomFor(cell: Cell, gridWidth: number): number {
  return (
    (gridWidth * parseFloat(cell.width as string)) / 100 -
    2 * (cell.pad as number) -
    2 * (cell.boxPad as number) -
    (cell.indexStyle.minWidth as number) -
    (cell.gap as number)
  )
}

// Hands the grid the width it is laid out at, as the device does once the screen has drawn it.
function layOut(tree: ReactTestRenderer.ReactTestRenderer, width: number): void {
  const grid = tree.root.find(
    node => node.type === View && typeof node.props.onLayout === 'function' && flat(node.props.style).flexWrap === 'wrap',
  )
  ReactTestRenderer.act(() => {
    grid.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 0 } } })
  })
}

// The padded screen's content width on a window of this width.
const contentOf = (windowWidth: number): number => windowWidth - 2 * space.xl

// "mushroom", the widest English BIP39 word, and its advance width in em in the wider of the two
// system faces: 5.0606 in SF Pro Semibold against 4.8459 in Roboto SemiBold (CoreText, 16pt).
const WIDEST_WORD = 'mushroom'
const WIDEST_WORD_EM = 5.0606

// The font scales React Native reports. iOS, from Extra Small up to the largest accessibility size
// (RCTAccessibilityManager's table); Android, the font size steps from 85% up to 200%.
const IOS_SCALES = [0.823, 0.882, 0.941, 1, 1.118, 1.235, 1.353, 1.786, 2.143, 2.643, 3.143, 3.571]
const ANDROID_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 1.8, 2]
const LARGEST_IOS = 3.571
const LARGEST_ANDROID = 2

// The first 24 wordlist entries, a fixture and not a phrase anyone holds.
const WORDS_24 =
  'abandon ability able about above absent absorb abstract absurd abuse access accident ' +
  'account accuse achieve acid acoustic acquire across act action actor actress actual'

describe('the word grid', () => {
  let dims: jest.SpyInstance | undefined
  function windowOf(width: number, fontScale: number): void {
    dims = jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 800, scale: 3, fontScale })
  }
  afterEach(() => {
    dims?.mockRestore()
    dims = undefined
  })

  it('shows every word of a 24-word phrase beside its own number', () => {
    const cells = wordCells(render({ mnemonic: WORDS_24, length: 24 }))
    expect(cells.map(c => c.word)).toEqual(WORDS_24.split(' '))
    expect(cells.map(c => c.index)).toEqual(Array.from({ length: 24 }, (_, i) => String(i + 1)))
  })

  it('draws three columns on a wide phone and two on a narrow one or at a large font size', () => {
    windowOf(402, 1)
    expect(new Set(wordCells(render()).map(c => c.width))).toEqual(new Set(['33.33%']))
    dims!.mockRestore()
    windowOf(360, 1)
    expect(new Set(wordCells(render()).map(c => c.width))).toEqual(new Set(['50%']))
    dims!.mockRestore()
    windowOf(402, 1.3)
    expect(new Set(wordCells(render()).map(c => c.width))).toEqual(new Set(['50%']))
    dims!.mockRestore()
    // An iPhone 11 at Extra Large text: a third of the width still holds the widest word at its
    // floor, and the grid draws two columns anyway, so the word is not squeezed to it.
    windowOf(414, 1.118)
    expect(new Set(wordCells(render()).map(c => c.width))).toEqual(new Set(['50%']))
  })

  it('lets a two-digit number grow with the type and keeps a gap before the word', () => {
    windowOf(402, 1.3)
    const cells = wordCells(render({ mnemonic: WORDS_24, length: 24 }))
    for (const cell of cells) {
      expect(cell.indexStyle.width).toBeUndefined()
      expect(cell.indexStyle.minWidth).toBeCloseTo(space.xl * 1.3)
      expect(cell.gap).toBe(space.xs)
    }
  })

  it('fits each word on one line inside its cell', () => {
    for (const cell of wordCells(render())) {
      expect(cell.wordProps.numberOfLines).toBe(1)
      expect(cell.wordProps.adjustsFontSizeToFit).toBe(true)
    }
  })

  it('draws one column at the largest iOS text size, where half the width cannot hold the widest word', () => {
    for (const width of [375, 402, 440]) {
      windowOf(width, LARGEST_IOS)
      const tree = render({ mnemonic: WORDS_24, length: 24 })
      layOut(tree, contentOf(width))
      const cells = wordCells(tree)
      expect(new Set(cells.map(c => c.width))).toEqual(new Set(['100%']))
      expect(cells.map(c => c.word)).toEqual(WORDS_24.split(' '))
      expect(cells.map(c => c.index)).toEqual(Array.from({ length: 24 }, (_, i) => String(i + 1)))
      dims!.mockRestore()
    }
  })

  it('draws one column at the largest Android font scale on a 360dp phone', () => {
    windowOf(360, LARGEST_ANDROID)
    const tree = render({ mnemonic: WORDS_24, length: 24 })
    layOut(tree, contentOf(360))
    expect(new Set(wordCells(tree).map(c => c.width))).toEqual(new Set(['100%']))
  })

  it('keeps two columns while half the width still holds the widest word', () => {
    windowOf(402, 1.786)
    expect(new Set(wordCells(render()).map(c => c.width))).toEqual(new Set(['50%']))
    dims!.mockRestore()
    windowOf(360, 1.5)
    expect(new Set(wordCells(render()).map(c => c.width))).toEqual(new Set(['50%']))
  })

  it('leaves the widest word room at its floor at every phone width and text size', () => {
    // The floor is the least the word shrinks to; below it the platform cuts the word with an
    // ellipsis, so this is the line between a word written down right and one written down wrong.
    // 320pt is the iPhone SE (first generation), which the iOS 15.1 deployment target still reaches.
    const widths = [320, 360, 375, 384, 390, 393, 402, 411, 414, 430, 440]
    const cut: string[] = []
    for (const fontScale of [...IOS_SCALES, ...ANDROID_SCALES]) {
      for (const width of widths) {
        windowOf(width, fontScale)
        const tree = render({ mnemonic: [WIDEST_WORD, ...PHRASE.split(' ').slice(1)].join(' ') })
        // Before the grid has a layout of its own, and after.
        for (const laidOut of [false, true]) {
          if (laidOut) {
            layOut(tree, contentOf(width))
          }
          const cell = wordCells(tree).find(c => c.word === WIDEST_WORD)!
          const floor = cell.wordProps.minimumFontScale as number
          const shrunk = WIDEST_WORD_EM * font.size.base * fontScale * floor
          if (!(floor > 0 && roomFor(cell, contentOf(width)) >= shrunk)) {
            cut.push(`${width}pt at ${fontScale}${laidOut ? ' laid out' : ''}`)
          }
        }
        tree.unmount()
        dims!.mockRestore()
      }
    }
    expect(cut).toEqual([])
  })

  it('shrinks a word no further than 0.6 of its size while there is more than one column', () => {
    for (const [width, fontScale] of [[402, 1], [402, 1.786], [360, 1.5]] as const) {
      windowOf(width, fontScale)
      for (const cell of wordCells(render())) {
        expect(cell.wordProps.minimumFontScale).toBe(0.6)
      }
      dims!.mockRestore()
    }
  })

  it('measures its own width, so a grid narrower than the screen drops a column sooner', () => {
    windowOf(402, 1.786)
    const tree = render()
    expect(new Set(wordCells(tree).map(c => c.width))).toEqual(new Set(['50%']))
    // A layout at no width is a grid that is not on screen, and decides nothing.
    layOut(tree, 0)
    expect(new Set(wordCells(tree).map(c => c.width))).toEqual(new Set(['50%']))
    layOut(tree, 240)
    expect(new Set(wordCells(tree).map(c => c.width))).toEqual(new Set(['100%']))
    // A later layout decides again, so a grid that widens takes its column back.
    layOut(tree, 354)
    expect(new Set(wordCells(tree).map(c => c.width))).toEqual(new Set(['50%']))
  })

  it('regroups when the window or the text size changes while it is on screen', () => {
    windowOf(402, 1)
    let changed: Parameters<typeof Dimensions.addEventListener>[1] | undefined
    const listen = jest.spyOn(Dimensions, 'addEventListener').mockImplementation((type, handler) => {
      if (type === 'change') {
        changed = handler
      }
      return { remove: () => undefined } as never
    })
    try {
      const tree = render()
      expect(new Set(wordCells(tree).map(c => c.width))).toEqual(new Set(['33.33%']))
      const fire = (width: number, fontScale: number) =>
        ReactTestRenderer.act(() => {
          const window = { width, height: 800, scale: 3, fontScale }
          changed!({ window, screen: window })
        })
      // A larger text size in the system settings.
      fire(402, 1.3)
      expect(new Set(wordCells(tree).map(c => c.width))).toEqual(new Set(['50%']))
      fire(402, 1)
      expect(new Set(wordCells(tree).map(c => c.width))).toEqual(new Set(['33.33%']))
      // A narrower window, such as a split screen.
      fire(360, 1)
      expect(new Set(wordCells(tree).map(c => c.width))).toEqual(new Set(['50%']))
    } finally {
      listen.mockRestore()
    }
  })

  it('reaches the gutters with the word boxes, by outsetting the grid by the padding of its cells', () => {
    const tree = render()
    const grid = tree.root.find(
      node => node.type === View && typeof node.props.onLayout === 'function' && flat(node.props.style).flexWrap === 'wrap',
    )
    const [cell] = wordCells(tree)
    expect(flat(grid.props.style).marginHorizontal).toBe(-(cell!.pad as number))
  })

  it('draws its placeholders in the columns the words will take, so nothing moves when they arrive', () => {
    windowOf(402, LARGEST_IOS)
    const placeholders = render({ mnemonic: '', length: 12 })
      .root.findAllByType(Skeleton)
      .filter(s => s.props.borderRadius != null)
      .map(s => flat(s.parent!.props.style).width)
    expect(new Set(placeholders)).toEqual(new Set(['100%']))
  })
})

