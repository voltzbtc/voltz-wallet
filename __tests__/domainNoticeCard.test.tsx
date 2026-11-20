import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, Text, View } from 'react-native'
import fs from 'fs'
import path from 'path'
import '../src/i18n'
import { DomainNoticeCard } from '../src/components/DomainNoticeCard'
import { formatDate } from '../src/wallet/history'
import type { DomainPhase } from '../src/wallet/domainTier'
import { colors, radius, space, touch } from '../src/theme'

const DOMAIN = 'pay.bakery.com.br'
// Deliberately far apart, so a card reading the wrong one prints a visibly different date.
const EXPIRES_AT = 1_800_000_000
const FROZEN_AT = 1_803_600_000
const prefs = { locale: 'en-US', use24Hour: false }

// The rendered words are compared against the locale file itself, never against t() again, so a
// title borrowed from the neighbouring phase cannot agree with the assertion.
const en = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8'),
) as { domain: Record<string, string> }

function copy(key: string, date = ''): string {
  return en.domain[key].replace(/\{\{domain\}\}/g, DOMAIN).replace(/\{\{date\}\}/g, date)
}

function render(phase: DomainPhase, props: Partial<React.ComponentProps<typeof DomainNoticeCard>> = {}) {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <DomainNoticeCard
        phase={phase}
        domain={DOMAIN}
        expiresAt={EXPIRES_AT}
        frozenAt={phase === 'frozen' ? FROZEN_AT : null}
        prefs={prefs}
        onRenew={jest.fn()}
        {...props}
      />,
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

// The card is the outermost element the component renders, so the first View in tree order is it.
function cardStyle(tree: ReactTestRenderer.ReactTestRenderer): Record<string, unknown> {
  return StyleSheet.flatten(tree.root.findAllByType(View)[0].props.style) as Record<string, unknown>
}

function pressRenew(tree: ReactTestRenderer.ReactTestRenderer): void {
  const button = tree.root.find(
    node =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === en.domain.renew &&
      typeof node.props.onPress === 'function',
  )
  ReactTestRenderer.act(() => button.props.onPress())
}

const VISIBLE: Array<{ phase: DomainPhase; title: string; body: string; dated: number | null }> = [
  { phase: 'ending', title: 'noticeEndingTitle', body: 'noticeEndingBody', dated: EXPIRES_AT },
  { phase: 'lastDay', title: 'noticeLastDayTitle', body: 'noticeLastDayBody', dated: null },
  { phase: 'expired', title: 'noticeExpiredTitle', body: 'noticeExpiredBody', dated: null },
  { phase: 'frozen', title: 'noticeFrozenTitle', body: 'noticeFrozenBody', dated: FROZEN_AT },
]

test('a paid-up domain renders nothing at all, not an empty card and not a spacer', () => {
  const tree = render('fine')

  expect(tree.toJSON()).toBeNull()
  expect(tree.root.findAllByType(View)).toHaveLength(0)
  expect(tree.root.findAllByType(Text)).toHaveLength(0)
})

test.each(VISIBLE)('the $phase card says the $phase words and no other phase\'s', ({ phase, title, body, dated }) => {
  const date = dated === null ? '' : formatDate(dated, prefs)
  const shown = texts(render(phase))

  expect(shown).toContain(copy(title, date))
  expect(shown).toContain(copy(body, date))
  const strangers = VISIBLE.filter(other => other.phase !== phase)
  for (const other of strangers) {
    expect(shown).not.toContain(copy(other.title, date))
  }
})

// The card carries no fee note. The note explains a price, and there is no price on the card, so it
// would read as the caption of a number that is not there. The reassurance lives on the screen that
// actually asks for money, next to the amount it is about.
test('offers the free way out only once the domain has actually stopped', () => {
  // A lapsed year leaves somebody unable to receive on their own domain, and the shared one works
  // right away at no cost, so the card offers it next to paying. Before the freeze the addresses
  // still work, so pointing them elsewhere would talk them out of what they paid for.
  const frozen = render('frozen', { onUseShared: jest.fn(), sharedDomain: 'usevoltz.app' })
  expect(texts(frozen).join(' ')).toContain('usevoltz.app')

  for (const { phase } of VISIBLE.filter(v => v.phase !== 'frozen')) {
    const other = render(phase, { onUseShared: jest.fn(), sharedDomain: 'usevoltz.app' })
    expect(texts(other).join(' ')).not.toContain('usevoltz.app')
  }
})

test('shows one action when the caller has nowhere to send them', () => {
  // The offer is optional, so a screen with no shared domain to fall back on draws the renewal
  // alone rather than a button that would do nothing.
  const shown = texts(render('frozen')).join(' ')
  expect(shown).toContain(en.domain.renew)
  expect(shown).not.toContain('usevoltz.app')
})

test.each(VISIBLE)('the $phase card explains no price, because it shows none', ({ phase }) => {
  const shown = texts(render(phase)).join(' ')
  expect(shown).not.toContain('yearly fee')
  expect(shown).not.toMatch(/US\$|\bsats\b/)
})

test.each(VISIBLE)('the $phase card offers the renewal and hands the tap back to the caller', ({ phase }) => {
  const onRenew = jest.fn()
  const tree = render(phase, { onRenew })

  expect(texts(tree)).toContain(en.domain.renew)
  pressRenew(tree)
  expect(onRenew).toHaveBeenCalledTimes(1)
})

test('a domain still running is orange, one already costing the owner money is red', () => {
  expect(cardStyle(render('ending'))).toMatchObject({
    backgroundColor: colors.primarySoft,
  })
  for (const phase of ['lastDay', 'expired', 'frozen'] as const) {
    expect(cardStyle(render(phase))).toMatchObject({
      backgroundColor: colors.dangerSoft,
    })
  }
})

test('the frozen card dates the pause, the ending card dates the paid year', () => {
  const frozen = texts(render('frozen'))
  expect(frozen).toContain(copy('noticeFrozenBody', formatDate(FROZEN_AT, prefs)))
  expect(frozen.join(' ')).not.toContain(formatDate(EXPIRES_AT, prefs))

  const ending = texts(render('ending'))
  expect(ending).toContain(copy('noticeEndingBody', formatDate(EXPIRES_AT, prefs)))
})

test('a phase arriving without its date says the rest of the sentence and invents no date', () => {
  const ending = texts(render('ending', { expiresAt: null }))
  const frozen = texts(render('frozen', { frozenAt: null }))
  const shown = ending.concat(frozen)

  // A date formatter handed a missing field does not print 'undefined', it prints the epoch, so the
  // owner would read that their domain lapsed in 1969. The sentence has to lose the date instead.
  expect(ending).toContain(copy('noticeEndingBody', ''))
  expect(frozen).toContain(copy('noticeFrozenBody', ''))
  expect(shown.join(' ')).not.toMatch(/\b19\d\d\b/)
  expect(shown.join(' ')).not.toContain('undefined')
  expect(shown).toContain(en.domain.renew)
})

test('the card geometry comes from the tokens, not from numbers typed into the file', () => {
  expect(cardStyle(render('ending'))).toMatchObject({
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    padding: space.lg,
    gap: space.sm,
  })
})

test('no colour or radius literal reaches the stylesheet', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'DomainNoticeCard.tsx'),
    'utf8',
  )
  const sheet = source.slice(source.indexOf('StyleSheet.create'))

  expect(sheet).not.toMatch(/#[0-9a-fA-F]{3}/)
  expect(sheet).not.toMatch(/rgba?\(/)
  expect(sheet).not.toMatch(/borderRadius:\s*[\d.]/)
})

const flat = (style: unknown): Record<string, unknown> =>
  StyleSheet.flatten(
    typeof style === 'function' ? style({ pressed: false }) : (style as never),
  ) as Record<string, unknown>

test('the title takes the width beside the icon, so a long one wraps inside the card', () => {
  for (const { phase } of VISIBLE) {
    const tree = render(phase)
    const row = tree.root.findAll(n => n.type === View && flat(n.props.style).flexDirection === 'row')[0]!
    const title = row.findAllByType(Text)[0]!
    expect(flat(title.props.style).flex).toBe(1)
    // The alarm colour still lands on top of the title's own style.
    expect(flat(title.props.style).color).toBe(phase === 'ending' ? colors.text : colors.danger)
  }
})

test('the way to the shared domain is a full 44pt target', () => {
  const tree = render('frozen', { onUseShared: jest.fn(), sharedDomain: 'usevoltz.app' })
  const button = tree.root
    // The pressable itself, whose style is the function Touch hands it.
    .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.style === 'function')
    .find(n => n.findAllByType(Text).some(x => String(x.props.children).includes('usevoltz.app')))!
  expect(flat(button.props.style).minHeight).toBe(touch.min)
})
