import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Animated, Text, View } from 'react-native'
import i18n from '../src/i18n'
import { PinScreen } from '../src/screens/PinScreen'
import { DollarModeProvider } from '../src/wallet/dollarMode'
import { TabIcon } from '../src/components/TabIcon'
import { isBiometricUnlockEnabled, unlockWithBiometrics } from '../src/wallet/biometrics'
import { clearPinFailures, enterPin, pinWaitLeft, verifyPin } from '../src/wallet/pin'
import { colors, textScale } from '../src/theme'

// The keypad's check, over the comparison each case decides, with no wrong-PIN wait.
jest.mock('../src/wallet/pin', () => {
  const compare = jest.fn(async (_pin: string) => false)
  return {
    verifyPin: compare,
    enterPin: jest.fn(async (pin: string) => ((await compare(pin)) ? { ok: true } : { ok: false, waitMs: 0 })),
    pinWaitLeft: jest.fn(async () => 0),
    clearPinFailures: jest.fn(async () => undefined),
  }
})
jest.mock('../src/wallet/biometrics', () => ({
  isBiometricUnlockEnabled: jest.fn(async () => true),
  getBiometryKind: jest.fn(async () => 'face'),
  unlockWithBiometrics: jest.fn(async () => false),
}))
// The provider asks the SDK whether the dollar wallet is on; here it is, and nothing else reports.
jest.mock('../src/wallet/spark', () => ({
  sparkGetStableBalance: jest.fn(async () => true),
  onSparkConnected: () => () => undefined,
  onStableBalanceChanged: () => () => undefined,
  sparkSubscribeToPayments: jest.fn(async () => () => undefined),
}))
jest.mock('../src/wallet/wallet', () => ({ onActiveWalletChanged: () => () => undefined }))
jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn(async () => null) }))

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(node: React.JSX.Element): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(node)
  })
  await settle()
  return tree
}

const lock = () => <PinScreen mode="enter" onDone={() => undefined} />

function key(tree: ReactTestRenderer.ReactTestRenderer, digit: string) {
  return tree.root
    .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === digit))!
}

async function pressDigit(tree: ReactTestRenderer.ReactTestRenderer, digit: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    key(tree, digit).props.onPress()
  })
  await settle()
}

// The six dots are the 16pt circles; an empty one is on the variant fill, a filled one on the accent.
function dotStyles(tree: ReactTestRenderer.ReactTestRenderer): Record<string, unknown>[] {
  return tree.root
    .findAllByType(View)
    .map(n => flat(n.props.style))
    .filter(s => s.width === 16 && s.height === 16)
}

const biometricMark = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(TabIcon).find(icon => icon.props.name === 'faceid')!

function filledColours(tree: ReactTestRenderer.ReactTestRenderer): unknown[] {
  return dotStyles(tree)
    .map(s => s.backgroundColor)
    .filter(colour => colour !== colors.surfaceVariant)
}

// The PIN screen is drawn inside the navigator, under the provider, once a wallet is open, and the
// accent there is green while the dollar wallet is on. The boot lock and onboarding sit outside it.
describe('the accent', () => {
  it('fills the dots and draws the biometric mark green inside the provider with dollar mode on', async () => {
    const tree = await render(<DollarModeProvider initial>{lock()}</DollarModeProvider>)
    await pressDigit(tree, '1')
    expect(filledColours(tree)).toEqual([colors.dollar])
    expect(biometricMark(tree).props.color).toBe(colors.dollar)
  })

  it('stays orange outside the provider, where the boot lock draws it', async () => {
    const tree = await render(lock())
    await pressDigit(tree, '1')
    expect(filledColours(tree)).toEqual([colors.primary])
    expect(biometricMark(tree).props.color).toBe(colors.primary)
  })
})

// A phone keypad reads 1 2 3 from the left in Arabic and Hebrew too, and a grid that follows the
// layout direction would draw 3 2 1 there.
it('lays the keypad out left to right whatever the language direction', async () => {
  const tree = await render(lock())
  let node = key(tree, '1').parent
  while (node && flat(node.props.style).flexWrap !== 'wrap') {
    node = node.parent
  }
  expect(node).toBeTruthy()
  expect(flat(node!.props.style).direction).toBe('ltr')
})

// The twelve slots as a screen reader meets them: the delete key by what it does, and the empty slot
// and the delete key before any digit not at all.
describe('the keypad read aloud', () => {
  // The press targets, one per slot, in keypad order.
  const slots = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(
      n =>
        typeof n.type === 'string' &&
        n.props.accessibilityRole === 'button' &&
        n.props.accessibilityLabel !== i18n.t('pin.biometricPrompt'),
    )

  it('names the delete key and hides the slots that do nothing', async () => {
    const tree = await render(lock())
    expect(slots(tree)).toHaveLength(12)
    const hidden = () =>
      slots(tree).filter(n => n.props.accessible === false && n.props.importantForAccessibility === 'no-hide-descendants')
    // Before any digit both the empty slot and the delete key are inert.
    expect(hidden()).toHaveLength(2)

    await pressDigit(tree, '1')
    expect(hidden()).toHaveLength(1)
    const del = slots(tree).filter(n => n.props.accessibilityLabel === i18n.t('common.backspace'))
    expect(del).toHaveLength(1)
    expect(del[0]!.props.accessible).not.toBe(false)
  })
})

// At the largest text sizes an uncapped 24pt digit outgrows its 72pt key and is cut in half. A keypad
// caps its digits, as the system keypads do, while the title above keeps following the text size.
it('caps the keypad digits inside their keys and lets the title scale', async () => {
  const tree = await render(lock())
  const texts = tree.root.findAllByType(Text)
  const digits = texts.filter(n => /^[0-9]$/.test(String(n.props.children)))
  expect(digits).toHaveLength(10)
  for (const digit of digits) {
    expect(digit.props.maxFontSizeMultiplier).toBe(textScale.keypadMax)
    // A line of system type is about 1.2 times its size; 1.25 leaves room for either platform's face.
    const line = Number(flat(digit.props.style).fontSize) * textScale.keypadMax * 1.25
    let box = digit.parent
    while (box && flat(box.props.style).height === undefined) {
      box = box.parent
    }
    expect(line).toBeLessThanOrEqual(Number(flat(box!.props.style).height))
  }
  const title = texts.find(n => n.props.children === i18n.t('pin.enter'))!
  expect(title.props.maxFontSizeMultiplier).toBeUndefined()
})

// A wrong PIN still has to read as rejected when the shake is gone, so the error text carries it.
describe('with reduced motion', () => {
  afterEach(() => jest.restoreAllMocks())

  async function lockWith(reduced: boolean) {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced)
    return render(lock())
  }

  // The row of dots, the one box that holds the six 16pt circles.
  const dotsRow = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.find(
      n =>
        typeof n.type === 'string' &&
        n.children.filter(c => typeof c !== 'string' && flat(c.props.style).width === 16).length === 6,
    )

  async function typeWrongPin(tree: ReactTestRenderer.ReactTestRenderer) {
    for (const digit of ['1', '2', '3', '4', '5', '6']) {
      await pressDigit(tree, digit)
    }
  }

  it('shakes the dots and springs the keys with full motion', async () => {
    const sequence = jest.spyOn(Animated, 'sequence')
    const spring = jest.spyOn(Animated, 'spring')
    const tree = await lockWith(false)
    expect(flat(dotsRow(tree).props.style).transform).toBeDefined()
    ReactTestRenderer.act(() => key(tree, '5').props.onPressIn())
    expect(spring).toHaveBeenCalled()

    await typeWrongPin(tree)
    expect(sequence).toHaveBeenCalled()
  })

  it('rejects a wrong PIN without the shake, with the dots cleared and the error shown', async () => {
    const sequence = jest.spyOn(Animated, 'sequence')
    const spring = jest.spyOn(Animated, 'spring')
    const tree = await lockWith(true)
    expect(flat(dotsRow(tree).props.style).transform).toBeUndefined()
    ReactTestRenderer.act(() => key(tree, '5').props.onPressIn())
    ReactTestRenderer.act(() => key(tree, '5').props.onPressOut())
    expect(spring).not.toHaveBeenCalled()

    await typeWrongPin(tree)
    expect(sequence).not.toHaveBeenCalled()
    expect(filledColours(tree)).toHaveLength(0)
    const shown = tree.root.findAllByType(Text).map(n => n.props.children)
    expect(shown).toContain(i18n.t('pin.wrong'))

    // Every reject says it, the second one too.
    await typeWrongPin(tree)
    expect(tree.root.findAllByType(Text).map(n => n.props.children)).toContain(i18n.t('pin.wrong'))
  })

  it('draws the keys with no scale to animate', async () => {
    const tree = await lockWith(true)
    const scaled = tree.root
      .findAll(n => typeof n.type === 'string')
      .filter(n => flat(n.props.style).transform !== undefined)
    expect(scaled).toHaveLength(0)
  })
})

describe('drawn with no outline', () => {
  it('tells a dot empty from filled by its fill alone', async () => {
    const tree = await render(lock())
    await pressDigit(tree, '1')

    const dots = dotStyles(tree)
    expect(dots).toHaveLength(6)
    expect(dots.map(dot => dot.backgroundColor)).toEqual([
      colors.primary,
      ...Array(5).fill(colors.surfaceVariant),
    ])
    expect(dots.filter(dot => dot.borderWidth !== undefined || dot.borderColor !== undefined)).toEqual([])
  })

  it('draws no key with a border, resting or pressed', async () => {
    const tree = await render(lock())
    const boxes = () => tree.root.findAll(n => typeof n.type === 'string').map(n => flat(n.props.style))

    expect(boxes().filter(style => Number(style.borderWidth ?? 0) > 0)).toEqual([])
  })
})

describe('the keypad holds still', () => {
  const boxesAround = (tree: ReactTestRenderer.ReactTestRenderer) => {
    let column = key(tree, '1').parent
    while (column && flat(column.props.style).flex !== 1) {
      column = column.parent
    }
    return column!.children.filter(child => typeof child !== 'string').length
  }

  it('has the same rows around it after a reject', async () => {
    const tree = await render(lock())
    const before = boxesAround(tree)
    for (const digit of ['1', '2', '3', '4', '5', '6']) {
      await pressDigit(tree, digit)
    }

    expect(tree.root.findAllByType(Text).map(n => n.props.children)).toContain(i18n.t('pin.wrong'))
    expect(boxesAround(tree)).toBe(before)
  })

  it('has the same rows on a gate with no biometrics and no way out', async () => {
    const set = await render(<PinScreen mode="set" onDone={() => undefined} />)
    const gate = await render(<PinScreen mode="enter" onDone={() => undefined} onForgot={() => undefined} />)

    expect(boxesAround(set)).toBe(boxesAround(gate))
  })
})

describe('read aloud', () => {
  it('says how many digits went in, in the app language', async () => {
    const tree = await render(lock())
    await pressDigit(tree, '1')
    await pressDigit(tree, '2')

    const row = tree.root.findAll(n => n.props.accessibilityValue !== undefined && typeof n.type === 'string')
    expect(row[0].props.accessibilityValue.text).toBe(i18n.t('pin.dotsValue', { count: 2, total: 6 }))
    expect(i18n.t('pin.dotsValue', { count: 2, total: 6 })).toContain('2')
  })

  // The alert role says nothing by itself on React Native 0.86, so the line is announced, and a
  // second wrong PIN, whose first digit cleared the line, is said again.
  it('announces an error when it appears, and again on the next wrong PIN', async () => {
    const heard = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined)
    heard.mockClear()
    const tree = await render(lock())
    for (const digit of ['1', '2', '3', '4', '5', '6']) {
      await pressDigit(tree, digit)
    }

    const error = tree.root.findAllByType(Text).find(n => n.props.children === i18n.t('pin.wrong'))
    expect(error?.props.accessibilityRole).toBe('alert')
    const wrong = () => heard.mock.calls.filter(([line]) => line === i18n.t('pin.wrong')).length
    expect(wrong()).toBe(1)

    for (const digit of ['1', '2', '3', '4', '5', '6']) {
      await pressDigit(tree, digit)
    }
    expect(wrong()).toBe(2)
    heard.mockRestore()
  })

  it('draws the delete key with the icon, under its name', async () => {
    const tree = await render(lock())
    await pressDigit(tree, '1')

    expect(tree.root.findAllByType(TabIcon).some(icon => icon.props.name === 'backspace')).toBe(true)
    expect(tree.root.findAllByType(Text).some(text => text.props.children === '⌫')).toBe(false)
  })
})

describe('a biometric success', () => {
  const unlock = jest.mocked(unlockWithBiometrics)
  const STEP = 30

  async function steps(ms: number): Promise<void> {
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(ms)
    })
  }
  async function open(node: React.JSX.Element): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(node)
    })
    await steps(0)
    return tree
  }

  beforeEach(() => {
    jest.useFakeTimers()
    jest.mocked(verifyPin).mockClear()
    unlock.mockResolvedValue(true)
  })

  afterEach(() => {
    jest.useRealTimers()
    unlock.mockResolvedValue(false)
    jest.restoreAllMocks()
  })

  it('fills the dots in turn, and the app opens on the last, 180 ms in all', async () => {
    const onDone = jest.fn()
    const tree = await open(<PinScreen mode="enter" onDone={onDone} />)
    expect(filledColours(tree)).toHaveLength(1)

    await steps(STEP)
    expect(filledColours(tree)).toHaveLength(2)

    await steps(4 * STEP)
    expect(filledColours(tree)).toHaveLength(6)
    expect(onDone).not.toHaveBeenCalled()

    await steps(STEP - 1)
    expect(onDone).not.toHaveBeenCalled()

    await steps(1)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith('')
  })

  it('fills nothing until the system says yes, and nothing on a no', async () => {
    let say!: (yes: boolean) => void
    unlock.mockReturnValue(new Promise(resolve => (say = resolve)))
    const onDone = jest.fn()
    const tree = await open(<PinScreen mode="enter" onDone={onDone} />)
    await steps(1_000)
    expect(filledColours(tree)).toHaveLength(0)

    await ReactTestRenderer.act(async () => say(false))
    await steps(1_000)

    expect(filledColours(tree)).toHaveLength(0)
    expect(onDone).not.toHaveBeenCalled()
  })

  // The owner's biometric ends a run of wrong PINs, as the right PIN does.
  it('clears the wrong-PIN count, and a no clears nothing', async () => {
    jest.mocked(clearPinFailures).mockClear()
    let say!: (yes: boolean) => void
    unlock.mockReturnValue(new Promise(resolve => (say = resolve)))
    const tree = await open(<PinScreen mode="enter" onDone={jest.fn()} />)
    await ReactTestRenderer.act(async () => say(false))
    expect(clearPinFailures).not.toHaveBeenCalled()

    unlock.mockResolvedValue(true)
    await ReactTestRenderer.act(async () =>
      tree.root.findByProps({ accessibilityLabel: i18n.t('pin.biometricPrompt') }).props.onPress(),
    )
    expect(clearPinFailures).toHaveBeenCalledTimes(1)
  })

  it('opens at once with reduced motion, with no fill', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true)
    let say!: (yes: boolean) => void
    unlock.mockReturnValue(new Promise(resolve => (say = resolve)))
    const onDone = jest.fn()
    await open(<PinScreen mode="enter" onDone={onDone} />)

    await ReactTestRenderer.act(async () => say(true))

    expect(onDone).toHaveBeenCalledTimes(1)
  })

  describe('when what follows fails', () => {
    const failing = () => jest.fn(async () => Promise.reject(new Error('read failed')))
    const biometricKey = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findByProps({ accessibilityLabel: i18n.t('pin.biometricPrompt') })

    beforeEach(() => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    it('empties the dots, and the keypad answers again', async () => {
      const tree = await open(<PinScreen mode="enter" onDone={failing()} />)
      await steps(6 * STEP)
      expect(filledColours(tree)).toHaveLength(0)

      for (const digit of ['1', '2', '3', '4', '5', '6']) {
        await ReactTestRenderer.act(async () => key(tree, digit).props.onPress())
      }

      expect(verifyPin).toHaveBeenCalledWith('123456')
    })

    it('the biometric key answers again, and a second yes opens', async () => {
      const onDone = jest.fn<Promise<void>, [string]>().mockRejectedValueOnce(new Error('read failed'))
      const tree = await open(<PinScreen mode="enter" onDone={onDone} />)
      await steps(6 * STEP)
      expect(onDone).toHaveBeenCalledTimes(1)

      await ReactTestRenderer.act(async () => biometricKey(tree).props.onPress())
      await steps(6 * STEP)

      expect(onDone).toHaveBeenCalledTimes(2)
    })

    it('the same with reduced motion, where nothing fills', async () => {
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true)
      let say!: (yes: boolean) => void
      unlock.mockReturnValue(new Promise(resolve => (say = resolve)))
      const tree = await open(<PinScreen mode="enter" onDone={failing()} />)
      await ReactTestRenderer.act(async () => say(true))
      await steps(0)

      for (const digit of ['1', '2', '3', '4', '5', '6']) {
        await ReactTestRenderer.act(async () => key(tree, digit).props.onPress())
      }

      expect(verifyPin).toHaveBeenCalledWith('123456')
    })
  })

  it('takes no digit while the dots fill, and opens once', async () => {
    const onDone = jest.fn()
    const tree = await open(<PinScreen mode="enter" onDone={onDone} />)

    for (const digit of ['1', '2', '3', '4', '5', '6']) {
      await ReactTestRenderer.act(async () => key(tree, digit).props.onPress())
    }
    await steps(1_000)

    expect(verifyPin).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith('')
  })

  it('stops with the screen', async () => {
    const onDone = jest.fn()
    const tree = await open(<PinScreen mode="enter" onDone={onDone} />)

    ReactTestRenderer.act(() => tree.unmount())
    await steps(1_000)

    expect(onDone).not.toHaveBeenCalled()
  })
})

// An entry whose key a new enrollment invalidated is removed by the unlock that finds it, after the
// keypad read it as on, and the key would then prompt for nothing.
describe('a biometric entry the unlock found gone', () => {
  const biometricKeys = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.props.accessibilityLabel === i18n.t('pin.biometricPrompt'))

  afterEach(() => {
    jest.mocked(isBiometricUnlockEnabled).mockResolvedValue(true)
  })

  it('takes the biometric key away', async () => {
    jest.mocked(isBiometricUnlockEnabled).mockResolvedValueOnce(true).mockResolvedValue(false)
    const tree = await render(lock())
    expect(unlockWithBiometrics).toHaveBeenCalled()
    expect(biometricKeys(tree)).toHaveLength(0)
  })

  it('keeps it after a no while the entry is still there', async () => {
    const tree = await render(lock())
    expect(unlockWithBiometrics).toHaveBeenCalled()
    expect(biometricKeys(tree).length).toBeGreaterThan(0)
  })
})

describe('the way out of a forgotten PIN', () => {
  test('is drawn only where the caller gives it, and a press reaches the caller', async () => {
    const onForgot = jest.fn()
    const tree = await render(<PinScreen mode="enter" onDone={() => undefined} onForgot={onForgot} />)
    const link = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(t => t.props.children === i18n.t('pin.forgot')))!
    await ReactTestRenderer.act(async () => {
      link.props.onPress()
    })
    expect(onForgot).toHaveBeenCalledTimes(1)
  })

  test('is absent from a gate with no onForgot and from setting a PIN', async () => {
    const shown = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAllByType(Text).some(t => t.props.children === i18n.t('pin.forgot'))
    expect(shown(await render(lock()))).toBe(false)
    expect(shown(await render(<PinScreen mode="set" onDone={() => undefined} />))).toBe(false)
  })
})

// Six digits fall to automation in days at a few tries a second, so after too many wrong PINs the
// keypad takes none until the wait wallet/pin.ts sets has run.
describe('the wait after too many wrong PINs', () => {
  const allText = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
    tree.root.findAllByType(Text).flatMap(n => (typeof n.props.children === 'string' ? [n.props.children] : []))
  const typeSix = async (tree: ReactTestRenderer.ReactTestRenderer): Promise<void> => {
    for (const digit of '123456') {
      await pressDigit(tree, digit)
    }
  }
  let steady = 5_000

  beforeEach(() => {
    steady = 5_000
    jest.spyOn(performance, 'now').mockImplementation(() => steady)
    jest.mocked(enterPin).mockClear()
  })

  afterEach(() => {
    jest.mocked(pinWaitLeft).mockResolvedValue(0)
    jest.restoreAllMocks()
  })

  it('says how long to wait and checks nothing typed until the wait ends', async () => {
    jest.mocked(enterPin).mockResolvedValueOnce({ ok: false, waitMs: 30_000 })
    const tree = await render(lock())
    await typeSix(tree)
    expect(enterPin).toHaveBeenCalledTimes(1)
    expect(allText(tree)).toContain(i18n.t('pin.wait', { time: '0:30' }))

    await typeSix(tree)
    expect(enterPin).toHaveBeenCalledTimes(1)
    expect(filledColours(tree)).toEqual([])
  })

  it('takes digits again once the wait has run', async () => {
    // The steady clock stays this test's own; only the screen's once-a-second tick is faked.
    jest.useFakeTimers({ doNotFake: ['performance'] })
    try {
      jest.mocked(enterPin).mockResolvedValueOnce({ ok: false, waitMs: 2_000 })
      const tree = await render(lock())
      await typeSix(tree)
      steady += 2_000
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(1_000)
      })
      expect(allText(tree)).not.toContain(i18n.t('pin.wait', { time: '0:02' }))
      await typeSix(tree)
      expect(enterPin).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('takes no digit while a typed PIN is being checked', async () => {
    let answer!: (entry: { ok: false; waitMs: number }) => void
    jest.mocked(enterPin).mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    const tree = await render(lock())
    await typeSix(tree)
    // Backspace and a digit would make six again and start a second check alongside the first.
    for (let i = 0; i < 3; i++) {
      const backspace = tree.root.findAll(
        n => n.props.accessibilityLabel === i18n.t('common.backspace') && typeof n.props.onPress === 'function',
      )[0]
      if (backspace) {
        await ReactTestRenderer.act(async () => {
          backspace.props.onPress()
        })
      }
      await pressDigit(tree, '7')
    }
    expect(enterPin).toHaveBeenCalledTimes(1)
    await ReactTestRenderer.act(async () => {
      answer({ ok: false, waitMs: 0 })
    })
    await typeSix(tree)
    expect(enterPin).toHaveBeenCalledTimes(2)
  })

  // A PIN refused because a wait runs was never compared, so it is not called wrong.
  it('neither shakes nor calls wrong a PIN refused because a wait runs', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
    const sequence = jest.spyOn(Animated, 'sequence')
    jest.mocked(enterPin).mockResolvedValueOnce({ ok: false, waitMs: 30_000, waiting: true })
    const tree = await render(lock())
    await typeSix(tree)
    expect(sequence).not.toHaveBeenCalled()
    expect(allText(tree)).toContain(i18n.t('pin.wait', { time: '0:30' }))

    // A wrong PIN that starts a wait does shake, so the spy can see one.
    jest.mocked(enterPin).mockResolvedValueOnce({ ok: false, waitMs: 30_000 })
    await typeSix(await render(lock()))
    expect(sequence).toHaveBeenCalled()
  })

  // A press can reach a handler drawn before the answer that starts the wait has been drawn.
  it('takes no digit from a press that lands before the wait is drawn', async () => {
    jest.mocked(enterPin).mockResolvedValueOnce({ ok: false, waitMs: 30_000 })
    const tree = await render(lock())
    const early = key(tree, '1').props.onPress
    await typeSix(tree)
    await ReactTestRenderer.act(async () => {
      early()
    })
    await settle()
    expect(filledColours(tree)).toEqual([])
    expect(allText(tree)).toContain(i18n.t('pin.wait', { time: '0:30' }))
  })

  // A Keychain that fails on the check leaves nothing to compare; the keypad says so and takes the
  // next try rather than hold six dots in silence.
  it('says a check that could not run, without the shake, and takes the next PIN', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const sequence = jest.spyOn(Animated, 'sequence')
    jest.mocked(enterPin).mockRejectedValueOnce(new Error('keystore unavailable'))
    const tree = await render(lock())
    await typeSix(tree)
    expect(allText(tree)).toContain(i18n.t('pin.checkFailed'))
    expect(filledColours(tree)).toEqual([])
    expect(sequence).not.toHaveBeenCalled()

    await typeSix(tree)
    expect(enterPin).toHaveBeenCalledTimes(2)
  })

  it('opens on a wait still running when the keypad comes up', async () => {
    jest.mocked(pinWaitLeft).mockResolvedValue(60_000)
    const tree = await render(lock())
    expect(allText(tree)).toContain(i18n.t('pin.wait', { time: '1:00' }))
    await typeSix(tree)
    expect(enterPin).not.toHaveBeenCalled()
  })
})
