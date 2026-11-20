import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, StyleSheet, Text, View } from 'react-native'
import '../src/i18n'
import { expectMailFallback, expectNoMailFallback, mailBody, pressCopy } from './support/mailFallback'
import { RecoveredPurchaseCard } from '../src/components/RecoveredPurchaseCard'
import type { Recovery } from '../src/wallet/recover'
import { colors, touch } from '../src/theme'

const PUBKEY = `02${'a'.repeat(64)}`

const base = {
  kind: 'name' as const,
  subject: 'bakery@usevoltz.app',
  reference: 'ref-1',
  pubkey: PUBKEY,
}

function render(result: Recovery | null, onDismiss = jest.fn()): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <RecoveredPurchaseCard result={result} onDismiss={onDismiss} />,
    )
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

function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): void {
  const target = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === label))
  if (!target) {
    throw new Error(`not found: ${label}`)
  }
  ReactTestRenderer.act(() => {
    target.props.onPress()
  })
}

beforeEach(() => {
  jest.restoreAllMocks()
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
})

// Almost every wallet on almost every open. No toast, no empty state, no "we checked".
test('nothing recovered draws nothing at all', () => {
  expect(render(null).toJSON()).toBeNull()
})

test('a recovered name says what it was, without anybody tapping to find out', () => {
  const tree = render({ ...base, status: 'ready' })
  expect(texts(tree)).toContain('Your address is ready')
  expect(texts(tree)).toContain(
    'You paid for bakery@usevoltz.app and it did not finish last time. It is yours now.',
  )
  // Nothing to press. The address is already on the wallet by the time this draws.
  expect(texts(tree)).not.toContain('Send to support')
})

test('a recovered year on a domain reads as a domain, not as an address', () => {
  const tree = render({ ...base, status: 'ready', kind: 'tier', subject: 'bakery.com.br' })
  expect(texts(tree)).toContain('bakery.com.br is paid for')
  expect(texts(tree)).toContain('It did not finish last time. Your year on it starts now.')
})

test('a payment still landing is being finished, and is never called a failure', () => {
  const shown = texts(render({ ...base, status: 'settling' })).join(' ')
  expect(shown).toContain('A payment is still landing')
  expect(shown).toContain('Nothing was lost')
  expect(shown).toContain('Open the app again in a few minutes')
  expect(shown).not.toMatch(/failed|did not go through/i)
})

test('a grant that never happened offers a person, and says nothing was lost', () => {
  const tree = render({ ...base, status: 'stuck' })
  expect(texts(tree)).toContain('Your payment needs a hand')
  expect(texts(tree).join(' ')).toContain('Nothing was lost')
  expect(texts(tree)).toContain('Send to support')
})

// The name may have been registered by somebody else in the meantime. There is no refund path
// anywhere in the service, so the copy must never imply the money comes back.
test('a name that could not be taken names the thing and promises no money back', () => {
  const shown = texts(render({ ...base, status: 'blocked' })).join(' ')
  expect(shown).toContain('bakery@usevoltz.app could not be set up')
  expect(shown).toContain('it could not be put on your wallet')
  expect(shown).not.toMatch(/refund|money back|reimburse/i)
})

test('the support mail carries the key and the reference, so nothing is read out loud', () => {
  press(render({ ...base, status: 'stuck' }), 'Send to support')
  const url = jest.mocked(Linking.openURL).mock.calls[0][0]
  expect(url.startsWith('mailto:support@usevoltz.app?')).toBe(true)
  expect(decodeURIComponent(url)).toContain(`Wallet: ${PUBKEY}`)
  expect(decodeURIComponent(url)).toContain('Payment: ref-1')
})

test.each(['stuck', 'blocked'] as const)(
  'a %s mail that does not open leaves the address, the mail text and Copy',
  async status => {
    const open = jest.mocked(Linking.openURL).mockClear().mockRejectedValue(new Error('no mail app'))
    const tree = render({ ...base, status })
    expectNoMailFallback(tree)
    await ReactTestRenderer.act(async () => {
      press(tree, 'Send to support')
    })
    const body = mailBody(open.mock.calls[0]?.[0])
    expect(body).toContain('Payment: ref-1')
    expectMailFallback(tree, body)
    expect(await pressCopy(tree)).toBe(body)
  },
)

// A mail app can open and still send nothing, as a Gmail signed in to no account does.
test('a mail that opens still leaves the address, the mail text and Copy', async () => {
  jest.mocked(Linking.openURL).mockClear()
  const tree = render({ ...base, status: 'stuck' })
  expectNoMailFallback(tree)
  await ReactTestRenderer.act(async () => {
    press(tree, 'Send to support')
  })
  expect(Linking.openURL).toHaveBeenCalledTimes(1)
  const body = mailBody(jest.mocked(Linking.openURL).mock.calls[0]?.[0])
  expect(body).toContain('Payment: ref-1')
  expectMailFallback(tree, body, 'opened')
  expect(await pressCopy(tree)).toBe(body)
})

// Home keeps the card mounted while a dismiss or a later sweep changes the purchase it shows, so a
// mail about one purchase never leaves its text, or what Copy copies, beside another.
test.each([
  ['opened', true],
  ['refused', false],
])('a %s mail about one purchase leaves no card beside the next', async (_case, opens) => {
  if (!opens) {
    jest.mocked(Linking.openURL).mockRejectedValue(new Error('no mail app'))
  }
  const tree = render({ ...base, status: 'stuck' })
  await ReactTestRenderer.act(async () => {
    press(tree, 'Send to support')
  })
  const first = mailBody(jest.mocked(Linking.openURL).mock.calls[0]?.[0])
  expectMailFallback(tree, first, opens ? 'opened' : 'refused')

  ReactTestRenderer.act(() => {
    tree.update(<RecoveredPurchaseCard result={null} onDismiss={jest.fn()} />)
  })
  ReactTestRenderer.act(() => {
    tree.update(<RecoveredPurchaseCard result={{ ...base, reference: 'ref-2', status: 'stuck' }} onDismiss={jest.fn()} />)
  })
  expect(texts(tree).join(' ')).toContain('Send to support')
  expectNoMailFallback(tree)
  expect(texts(tree).join(' ')).not.toContain('ref-1')

  // Back on the first purchase, its own card is there again.
  ReactTestRenderer.act(() => {
    tree.update(<RecoveredPurchaseCard result={{ ...base, status: 'stuck' }} onDismiss={jest.fn()} />)
  })
  expectMailFallback(tree, first, opens ? 'opened' : 'refused')
})

test('dismissing is the only thing that takes the card away', () => {
  const onDismiss = jest.fn()
  press(render({ ...base, status: 'ready' }, onDismiss), 'Got it')
  expect(onDismiss).toHaveBeenCalledTimes(1)
})

// A name that was paid for and granted, and deliberately left off a wallet that already answers
// somewhere else. The card has to say the purchase is safe without naming an address the wallet does
// not answer on, and without sending anybody to support for something no person is needed for.
describe('a name that is waiting to be taken', () => {
  test('says the purchase is theirs and that nothing was changed for them', () => {
    const said = texts(render({ ...base, status: 'waiting' })).join(' ')
    expect(said).toContain('bakery@usevoltz.app')
    expect(said).toContain('still works')
    expect(said).not.toContain('could not')
  })

  test('is never dressed as a failure, and offers no person to write to', () => {
    const tree = render({ ...base, status: 'waiting' })
    const said = texts(tree).join(' ')
    expect(said).not.toContain('Send to support')
    expect(() => press(tree, 'Send to support')).toThrow()
  })

  test('promises no refund, in any of its words', () => {
    const said = texts(render({ ...base, status: 'waiting' })).join(' ').toLowerCase()
    for (const promise of ['refund', 'money back', 'reimburse', 'return your']) {
      expect(said).not.toContain(promise)
    }
  })
})

// A name bought through the store and never chosen, found by the recovery on a reinstalled app.
describe('a name paid for in the store and not chosen yet', () => {
  const credit = { ...base, status: 'credit' as const, subject: 'usevoltz.app', reference: '' }

  test('says it is waiting on the domain it was bought for, and sends nobody to support', () => {
    const tree = render(credit)
    expect(texts(tree)).toContain('A name is waiting for you')
    expect(texts(tree).join(' ')).toContain('an address on usevoltz.app')
    expect(texts(tree)).not.toContain('Send to support')
  })

  test('choosing a name is one press', () => {
    const onChooseName = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <RecoveredPurchaseCard result={credit} onDismiss={jest.fn()} onChooseName={onChooseName} />,
      )
    })
    press(tree, 'Choose a name')
    expect(onChooseName).toHaveBeenCalledTimes(1)
  })
})

const flat = (style: unknown): Record<string, unknown> =>
  StyleSheet.flatten(
    typeof style === 'function' ? style({ pressed: false }) : (style as never),
  ) as Record<string, unknown>

test('the title takes the width beside the icon, so a long one wraps inside the card', () => {
  for (const status of ['ready', 'stuck'] as const) {
    const tree = render({ ...base, status } as Recovery)
    const row = tree.root.findAll(n => n.type === View && flat(n.props.style).flexDirection === 'row')[0]!
    const title = row.findAllByType(Text)[0]!
    expect(flat(title.props.style).flex).toBe(1)
    expect(flat(title.props.style).color).toBe(status === 'stuck' ? colors.danger : colors.text)
  }
})

test('dismissing is a full 44pt target, not a line of text', () => {
  const tree = render({ ...base, status: 'ready' })
  const dismiss = tree.root
    // The pressable itself, whose style is the function Touch hands it.
    .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.style === 'function')
    .find(n => n.findAllByType(Text).some(x => x.props.children === 'Got it'))!
  expect(flat(dismiss.props.style).minHeight).toBe(touch.min)
})

// A final answer that names more than a person giving the sats back. Support is offered only where
// sats are still to be given back, and only the given-back cards say they came back.
describe('final answers in other words', () => {
  const recover = (require('../src/i18n/locales/en-US.json') as { recover: Record<string, string> }).recover
  const CAME_BACK = [recover.repaidBody!, recover.paidAgainRepaidBody!]

  test.each<[Recovery['status'], 'name' | 'tier', string, boolean]>([
    ['paidAgain', 'name', recover.paidAgainBody!, true],
    ['paidAgainRepaid', 'name', recover.paidAgainRepaidBody!, false],
    ['repaid', 'name', recover.repaidBody!, false],
    ['repaid', 'tier', recover.repaidBody!, false],
    ['boughtBefore', 'tier', recover.boughtBeforeBody!.replace('{{subject}}', 'bakery@usevoltz.app'), false],
    ['boughtBefore', 'name', recover.boughtBeforeNameBody!, false],
  ])('%s on a %s', (status, kind, body, support) => {
    const shown = texts(render({ ...base, kind, status })).join(' ')
    expect(shown).toContain(body)
    expect(shown.includes('Send to support')).toBe(support)
    for (const line of CAME_BACK) {
      expect(shown.includes(line)).toBe(line === body)
    }
    expect(shown).not.toContain(recover.readyNameBody!.replace('{{subject}}', 'bakery@usevoltz.app'))
  })
})

// A charge that bought what it was for before names a name as a name and a year as a year, never the
// other one.
test('a name bought before is said as the name, and a year bought before as the year', () => {
  const recover = (require('../src/i18n/locales/en-US.json') as { recover: Record<string, string> }).recover
  const name = texts(render({ ...base, kind: 'name', status: 'boughtBefore' })).join(' ')
  expect(name).toContain(recover.boughtBeforeNameTitle!.replace('{{subject}}', 'bakery@usevoltz.app'))
  expect(name).not.toContain(recover.boughtBeforeTitle!)
  expect(name).not.toContain(recover.boughtBeforeBody!.replace('{{subject}}', 'bakery@usevoltz.app'))
  const year = texts(render({ ...base, kind: 'tier', status: 'boughtBefore' })).join(' ')
  expect(year).toContain(recover.boughtBeforeTitle!)
  expect(year).not.toContain(recover.boughtBeforeNameBody!)
})
