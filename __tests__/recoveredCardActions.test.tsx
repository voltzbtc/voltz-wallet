import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import i18n from '../src/i18n'
import { RecoveredPurchaseCard } from '../src/components/RecoveredPurchaseCard'
import { Card } from '../src/components/Card'
import { GradientButton } from '../src/components/GradientButton'
import type { Recovery } from '../src/wallet/recover'

const base = {
  kind: 'name' as const,
  subject: 'bakery@usevoltz.app',
  reference: 'ref-1',
  pubkey: `02${'a'.repeat(64)}`,
}

function render(result: Recovery): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <RecoveredPurchaseCard result={result} onDismiss={jest.fn()} onChooseName={jest.fn()} />,
    )
  })
  return tree
}

// The card states what happened and the buttons are what to do about it, as on the domain notice.
// Inside an alarm-coloured box a button reads as part of the alarm.
test.each([
  ['stuck', 'recover.sendToSupport'],
  ['credit', 'recover.chooseName'],
] as const)('a %s card keeps its button and Dismiss below the box, not inside it', (status, key) => {
  const tree = render({ ...base, status } as Recovery)
  const card = tree.root.findByType(Card)

  expect(tree.root.findAllByType(GradientButton).map(b => b.props.label)).toEqual([i18n.t(key)])
  expect(card.findAllByType(GradientButton)).toHaveLength(0)
  const inCard = card.findAllByType(Text).map(n => n.props.children)
  expect(inCard).not.toContain(i18n.t('recover.dismiss'))
})
