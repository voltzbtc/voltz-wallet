import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import i18n from '../../src/i18n'

type Tree = ReactTestRenderer.ReactTestRenderer
type Node = ReactTestRenderer.ReactTestInstance

const texts = (tree: Tree): string[] =>
  tree.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .filter((child): child is string => typeof child === 'string')

// The position the check asks now, read from its question as a person reads it, or null when no
// question is on screen. Numbers are the en-US digits the suite runs in.
export function askedPosition(tree: Tree): number | null {
  const shown = new Set(texts(tree))
  for (let number = 1; number <= 24; number++) {
    if (shown.has(i18n.t('backup.quizQuestion', { number: String(number) }))) {
      return number - 1
    }
  }
  return null
}

export const onQuiz = (tree: Tree): boolean => askedPosition(tree) !== null

// The words the question offers, in the order drawn.
export function offered(tree: Tree): string[] {
  return optionNodes(tree).map(node => String(node.findByType(Text).props.children))
}

function optionNodes(tree: Tree): Node[] {
  // The outermost node that carries the id and the press, one per option.
  return tree.root.findAll(
    node => node.props.testID === 'quiz-option' && typeof node.props.onPress === 'function',
    {
      deep: false,
    },
  )
}

export async function pickWord(tree: Tree, word: string): Promise<void> {
  const option = optionNodes(tree).find(node => node.findByType(Text).props.children === word)
  if (!option) {
    throw new Error(`"${word}" is not offered; offered: ${offered(tree).join(', ')}`)
  }
  await ReactTestRenderer.act(async () => {
    option.props.onPress()
  })
}

// Answers every question with the word written down at its position.
export async function answerQuiz(tree: Tree, words: readonly string[]): Promise<void> {
  for (let question = 0; question < 3; question++) {
    const position = askedPosition(tree)
    if (position === null) {
      throw new Error('no question on screen')
    }
    await pickWord(tree, words[position]!)
  }
}

// Picks an offered word that is not the one at the asked position.
export async function missQuiz(tree: Tree, words: readonly string[]): Promise<void> {
  const position = askedPosition(tree)
  if (position === null) {
    throw new Error('no question on screen')
  }
  const wrong = offered(tree).find(word => word !== words[position])
  if (!wrong) {
    throw new Error('every option is the right word')
  }
  await pickWord(tree, wrong)
}
