import ReactTestRenderer from 'react-test-renderer'
import { Text, View } from 'react-native'
import Clipboard from '@react-native-clipboard/clipboard'
import i18n from '../../src/i18n'
import { SUPPORT_EMAIL } from '../../src/wallet/recover'

type Tree = ReactTestRenderer.ReactTestRenderer

function shown(tree: Tree): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap(n => [n.props.children].flat().filter((c): c is string => typeof c === 'string'))
}

// The body a mailto link carried, decoded, or null for a link with none.
export function mailBody(url: unknown): string | null {
  const [, body] = String(url).split('&body=')
  return body === undefined ? null : decodeURIComponent(body)
}

// A line's strings in the order they are drawn, walking the rendered tree, so a run nested between
// two plain ones keeps its place.
function inOrder(node: ReactTestRenderer.ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(inOrder).join('')
}

// The text each card on screen carries, put back together from the lines it is drawn in: a line's
// runs in order, and a blank line between paragraphs as an empty one.
export function carriedTexts(tree: Tree): string[] {
  return tree.root
    // The host view, whose children are the lines; View itself renders one child, that host.
    .findAll(n => n.props.testID === 'support-mail-text' && typeof n.type === 'string')
    .map(card =>
      card.children.map(line => (typeof line === 'string' || line.type === View ? '' : inOrder(line))).join('\n'),
    )
}

const CAPTIONS = {
  refused: { text: 'support.mailFailed', address: 'support.mailFailedAddress' },
  opened: { text: 'support.mailOpened', address: 'support.mailOpenedAddress' },
} as const
const EVERY_CAPTION = Object.values(CAPTIONS).flatMap(c => [c.text, c.address])

// The card a support mail leaves: the one line that fits what became of the mail and whether it
// carried a text, the address, that text when there is one, and Copy. `none` is the card of a note no
// mail stands behind, which has no line about a mail, since nothing was sent for one to describe, and
// no text either, since no mail carried one.
export function expectMailFallback(tree: Tree, text: string | null, mail?: 'refused' | 'opened'): void
export function expectMailFallback(tree: Tree, text: null, mail: 'none'): void
export function expectMailFallback(
  tree: Tree,
  text: string | null,
  mail: 'refused' | 'opened' | 'none' = 'refused',
): void {
  if (mail === 'none' && text !== null) {
    throw new Error('a card no mail stands behind carries no text')
  }
  const texts = shown(tree)
  expect(texts).toContain(SUPPORT_EMAIL)
  expect(texts).toContain(i18n.t('support.copy'))
  const caption = mail === 'none' ? null : text === null ? CAPTIONS[mail].address : CAPTIONS[mail].text
  for (const key of EVERY_CAPTION) {
    if (key === caption) {
      expect(texts).toContain(i18n.t(key))
    } else {
      expect(texts).not.toContain(i18n.t(key))
    }
  }
  const carried = carriedTexts(tree)
  if (text === null) {
    expect(carried).toHaveLength(0)
  } else {
    expect(carried).toEqual([text])
  }
}

export function expectNoMailFallback(tree: Tree): void {
  const texts = shown(tree)
  expect(texts).not.toContain(SUPPORT_EMAIL)
  for (const key of EVERY_CAPTION) {
    expect(texts).not.toContain(i18n.t(key))
  }
}

// Presses the card's Copy and answers what reached the clipboard.
export async function pressCopy(tree: Tree): Promise<string | undefined> {
  jest.mocked(Clipboard.setString).mockClear()
  const button = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('support.copy')))
  if (!button) {
    throw new Error('Copy not found')
  }
  await ReactTestRenderer.act(async () => {
    button.props.onPress()
  })
  return jest.mocked(Clipboard.setString).mock.calls[0]?.[0]
}
