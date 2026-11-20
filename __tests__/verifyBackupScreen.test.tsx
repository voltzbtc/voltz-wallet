import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Animated, StyleSheet, Text } from 'react-native'
import i18n from '../src/i18n'
import { VerifyBackupScreen } from '../src/screens/VerifyBackupScreen'
import { BackSlot } from '../src/components/BackHeader'
import * as backup from '../src/wallet/backup'
import { askedPosition, missQuiz, offered, pickWord } from './support/backupQuiz'

const PHRASE =
  'abandon ability able about above absent absorb abstract absurd abuse access accident'
const WORDS = PHRASE.split(' ')

type Tree = ReactTestRenderer.ReactTestRenderer

afterEach(async () => {
  jest.restoreAllMocks()
  await ReactTestRenderer.act(async () => {
    await i18n.changeLanguage('en-US')
  })
})

async function render(
  props: Partial<React.ComponentProps<typeof VerifyBackupScreen>> = {},
): Promise<Tree> {
  let tree!: Tree
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <VerifyBackupScreen mnemonic={PHRASE} onVerified={() => undefined} {...props} />,
    )
  })
  return tree
}

const texts = (tree: Tree): unknown[] =>
  tree.root.findAllByType(Text).map(node => node.props.children)

const progress = (tree: Tree): string =>
  tree.root.find(node => node.props.testID === 'quiz-progress' && typeof node.type === 'string')
    .props.accessibilityLabel

function pinPositions(...draws: number[][]): jest.SpyInstance {
  const spy = jest.spyOn(backup, 'pickPositions')
  for (const positions of draws) {
    spy.mockReturnValueOnce(positions)
  }
  return spy
}

test('asks one numbered word at a time, among four words of the phrase', async () => {
  pinPositions([1, 6, 10])
  const tree = await render()
  expect(texts(tree)).toContain('What is word number 2?')
  expect(progress(tree)).toBe('Question 1 of 3')
  const options = offered(tree)
  expect(options).toHaveLength(4)
  expect(options).toContain(WORDS[1])
  expect(options.every(word => WORDS.includes(word))).toBe(true)
  // The question is the screen's heading, read as one by a screen reader.
  const headings = tree.root.findAll(node => node.props.accessibilityRole === 'header')
  expect(headings.map(node => node.props.children)).toContain('What is word number 2?')
})

test('three right picks in a row pass, one tap each, with no button to press', async () => {
  pinPositions([1, 6, 10])
  const onVerified = jest.fn()
  const tree = await render({ onVerified })

  await pickWord(tree, WORDS[1]!)
  expect(progress(tree)).toBe('Question 2 of 3')
  expect(askedPosition(tree)).toBe(6)
  await pickWord(tree, WORDS[6]!)
  expect(progress(tree)).toBe('Question 3 of 3')
  expect(onVerified).not.toHaveBeenCalled()
  await pickWord(tree, WORDS[10]!)

  expect(onVerified).toHaveBeenCalledTimes(1)
})

test('each new question is said to a screen reader, as the focus stays on the option', async () => {
  pinPositions([1, 6, 10])
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
  announce.mockClear()
  const tree = await render()
  expect(announce).not.toHaveBeenCalledWith('What is word number 2?')
  await pickWord(tree, WORDS[1]!)
  expect(announce).toHaveBeenCalledWith('What is word number 7?')
})

describe('a wrong pick', () => {
  test('passes nothing, names the word it missed, and starts over at new positions', async () => {
    const draws = pinPositions([1, 6, 10], [2, 5, 9])
    const onVerified = jest.fn()
    const tree = await render({ onVerified })
    await pickWord(tree, WORDS[1]!)
    await pickWord(tree, WORDS[6]!)

    // The third question, missed after two right ones.
    await missQuiz(tree, WORDS)

    expect(onVerified).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('backup.quizWrong', { number: '11' }))
    expect(draws).toHaveBeenCalledTimes(2)
    expect(progress(tree)).toBe('Question 1 of 3')
    expect(askedPosition(tree)).toBe(2)
  })

  // Trying the options one by one, which a person without the words would do, never gets through.
  test('cannot be retried on the same question', async () => {
    const onVerified = jest.fn()
    const tree = await render({ onVerified })
    for (let attempt = 0; attempt < 30; attempt++) {
      const position = askedPosition(tree)!
      const wrong = offered(tree).find(word => word !== WORDS[position])!
      await pickWord(tree, wrong)
      expect(progress(tree)).toBe('Question 1 of 3')
    }
    expect(onVerified).not.toHaveBeenCalled()
  })

  test('the error line goes with the next right pick', async () => {
    pinPositions([1, 6, 10], [2, 5, 9])
    const tree = await render()
    await missQuiz(tree, WORDS)
    expect(texts(tree)).toContain(i18n.t('backup.quizWrong', { number: '2' }))
    await pickWord(tree, WORDS[2]!)
    expect(texts(tree)).not.toContain(i18n.t('backup.quizWrong', { number: '2' }))
  })

  test('offers the words again once a pick was wrong, where the caller can show them', async () => {
    const onShowWords = jest.fn()
    const tree = await render({ onShowWords })
    expect(texts(tree)).not.toContain(i18n.t('backup.showWords'))
    await missQuiz(tree, WORDS)
    const [link] = tree.root.findAll(
      node =>
        typeof node.props.onPress === 'function' &&
        node.findAllByType(Text).some(text => text.props.children === i18n.t('backup.showWords')),
      { deep: false },
    )
    await ReactTestRenderer.act(async () => link!.props.onPress())
    expect(onShowWords).toHaveBeenCalledTimes(1)

    const without = await render()
    await missQuiz(without, WORDS)
    expect(texts(without)).not.toContain(i18n.t('backup.showWords'))
  })

  // A rejection still has to read as rejected when the shake is gone, so the error line carries it.
  async function missWith(reduced: boolean) {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced)
    const sequence = jest.spyOn(Animated, 'sequence')
    const tree = await render()
    await missQuiz(tree, WORDS)
    const options = tree.root.find(
      node => node.props.testID === 'quiz-options' && typeof node.type === 'string',
    )
    return { sequence, options: StyleSheet.flatten(options.props.style), tree }
  }

  test('shakes the options with full motion', async () => {
    const { sequence, options } = await missWith(false)
    expect(sequence).toHaveBeenCalled()
    expect(options.transform).toBeDefined()
  })

  test('with reduced motion it does not shake, and the error line still says so', async () => {
    const { sequence, options, tree } = await missWith(true)
    expect(sequence).not.toHaveBeenCalled()
    expect(options.transform).toBeUndefined()
    expect(
      texts(tree).some(text => typeof text === 'string' && text.startsWith("That wasn't word")),
    ).toBe(true)
  })
})

test('a word the phrase repeats passes at any of its positions', async () => {
  const repeated =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  pinPositions([2, 5, 11])
  const onVerified = jest.fn()
  const tree = await render({ mnemonic: repeated, onVerified })
  await pickWord(tree, 'abandon')
  await pickWord(tree, 'abandon')
  await pickWord(tree, 'about')
  expect(onVerified).toHaveBeenCalledTimes(1)
})

// A locale whose numbers have digits of their own, as Arabic in Egypt does.
test('numbers the question in the digits of the language on screen', async () => {
  await ReactTestRenderer.act(async () => {
    await i18n.changeLanguage('ar-EG')
  })
  pinPositions([1, 6, 10])
  const tree = await render()
  expect(texts(tree)).toContain(i18n.t('backup.quizQuestion', { number: '٢' }))
})

describe('the way back', () => {
  test('inside a navigator the header carries it, and the step draws no back', async () => {
    const tree = await render({ headerTitled: true, onBack: jest.fn() })
    expect(tree.root.findAllByType(BackSlot)[0]?.props.onBack).toBeUndefined()
  })

  test('outside a navigator the question carries the back', async () => {
    const onBack = jest.fn()
    const tree = await render({ onBack })
    expect(tree.root.findByType(BackSlot).props.onBack).toBe(onBack)
  })
})

// A second tap on the last right word, landing before the screen leaves, would keep the confirmation
// twice.
test('the last right pick passes once, however many taps land on it', async () => {
  pinPositions([1, 6, 10])
  const onVerified = jest.fn()
  const tree = await render({ onVerified })
  await pickWord(tree, WORDS[1]!)
  await pickWord(tree, WORDS[6]!)
  const last = tree.root
    .findAll(node => node.props.testID === 'quiz-option' && typeof node.props.onPress === 'function', {
      deep: false,
    })
    .find(node => node.findByType(Text).props.children === WORDS[10])!
  await ReactTestRenderer.act(async () => {
    last.props.onPress()
    last.props.onPress()
  })
  expect(onVerified).toHaveBeenCalledTimes(1)
})

test('the same word missed twice in a row is said twice', async () => {
  pinPositions([1, 6, 10], [1, 5, 9], [2, 5, 9])
  // The setup's double keeps its calls from earlier tests.
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
  announce.mockClear()
  const tree = await render()
  await missQuiz(tree, WORDS)
  await missQuiz(tree, WORDS)
  const line = i18n.t('backup.quizWrong', { number: '2' })
  expect(announce.mock.calls.filter(([said]) => said === line)).toHaveLength(2)
})
