import ReactTestRenderer from 'react-test-renderer'
import { ConfirmBody, type ConfirmRequest } from '../../src/components/ConfirmSheet'
import { GradientButton } from '../../src/components/GradientButton'

type Tree = ReactTestRenderer.ReactTestRenderer

// The question on screen now, whether in a ConfirmSheet or inside another sheet, or null.
export function question(tree: Tree): ConfirmRequest | null {
  return tree.root.findAllByType(ConfirmBody)[0]?.props.request ?? null
}

// Presses a button of the question by its label, as the person answering does.
export async function answerQuestion(tree: Tree, label: string): Promise<void> {
  const button = tree.root
    .findAllByType(ConfirmBody)[0]
    ?.findAllByType(GradientButton)
    .find(node => node.props.label === label)
  if (!button) {
    throw new Error(`no question button labelled ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    button.props.onPress()
  })
}

export async function confirmQuestion(tree: Tree): Promise<void> {
  const asked = question(tree)
  if (!asked) {
    throw new Error('no question on screen')
  }
  await answerQuestion(tree, asked.confirm)
}
