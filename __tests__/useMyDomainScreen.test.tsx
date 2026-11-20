import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState, StyleSheet, Text, TextInput, View } from 'react-native'
import '../src/i18n'
import { UseMyDomainScreen } from '../src/screens/UseMyDomainScreen'
import { Field } from '../src/components/Field'
import { colors, radius, rhythm, space } from '../src/theme'
import i18n from 'i18next'
import { validateUsername } from '../src/wallet/lnaddress'
import {
  claimDomain,
  confirmDomain,
  fetchPrices,
  quoteDomain,
  savePendingPurchase,
} from '../src/wallet/domainOnboard'
import { sparkConfirmSend, sparkGetBalanceSat, sparkPrepareSend, sparkSyncedBalanceSat } from '../src/wallet/spark'
import { formatSats } from '../src/wallet/amount'
import { SpendHeldByExit } from '../src/wallet/errors'
import { setDomainFor } from '../src/wallet/lnurlDomainPref'
import { getActiveWalletId } from '../src/wallet/walletRegistry'

jest.mock('../src/wallet/spark', () => ({
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkPrepareSend: jest.fn(async () => ({ handle: 'h-1', amount: 199800, fee: 0 })),
  // Enough for every case that means to pay. The one about too little balance lowers it, which is
  // how a case tells a wallet that can afford the purchase from one that cannot.
  sparkSyncedBalanceSat: jest.fn(async () => 1_000_000),
  // The figure stored at the last sync, which the screen never decides on.
  sparkGetBalanceSat: jest.fn(async () => 1_000_000),
  sparkConfirmSend: jest.fn(async () => ({ status: 'complete' })),
}))

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'lnurl.usevoltz.app', getDistribution: () => 'direct' }))

// The proof of a payment is filed under the wallet that paid, so a case about two wallets has to be
// able to say which one is active. Null is what the real registry answers with no wallet chosen.
const mockActive = { id: null as string | null }
jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => mockActive.id),
}))

// The real hook needs a navigation container. No params is the first purchase, which is what every
// case in this file exercises; the renewal has its own file.
jest.mock('@react-navigation/native', () => ({ useRoute: () => ({ params: undefined }) }))

jest.mock('../src/wallet/domainOnboard', () => {
  const real = jest.requireActual('../src/wallet/domainOnboard')
  return {
    ...real,
    claimDomain: jest.fn(),
    quoteDomain: jest.fn(),
    confirmDomain: jest.fn(),
    // Wrapped rather than stubbed, so every case writes the real file and a case can read what the
    // screen saved.
    savePendingPurchase: jest.fn(real.savePendingPurchase),
    fetchPrices: jest.fn(),
  }
})

// The wallet takes a live domain by storing it and reconnecting. Wrapped so a case can make the store
// fail.
jest.mock('../src/wallet/lnurlDomainPref', () => {
  const real = jest.requireActual('../src/wallet/lnurlDomainPref')
  return { ...real, setDomainFor: jest.fn(real.setDomainFor) }
})

const prices = fetchPrices as jest.MockedFunction<typeof fetchPrices>
const claim = claimDomain as jest.MockedFunction<typeof claimDomain>
const quote = quoteDomain as jest.MockedFunction<typeof quoteDomain>
const confirm = confirmDomain as jest.MockedFunction<typeof confirmDomain>
const save = savePendingPurchase as jest.MockedFunction<typeof savePendingPurchase>

// For a purchase that landed, the gateway answers with the year bought and whether the domain had
// been taken off the edge before the payment.
const GRANTED = { expiresAt: 1_800_000_000, frozen: false }

// The box around the occupied-name warning, found from its text: a warning is a Notice, a card in the
// soft accent fill, never a tinted strip.
function occupiedBox(tree: ReactTestRenderer.ReactTestRenderer): Record<string, unknown> {
  const flat = (style: unknown): Record<string, unknown> =>
    Object.assign({}, ...[style].flat(Infinity).filter(x => x && typeof x === 'object'))
  const line = tree.root
    .findAllByType(Text)
    .find(node => String(node.props.children).includes('already points somewhere today'))!
  let node: ReactTestRenderer.ReactTestInstance | null = line.parent
  while (node && !(node.type === View && flat(node.props.style).backgroundColor === colors.primarySoft)) {
    node = node.parent
  }
  return node ? flat(node.props.style) : {}
}

const WARNING_BOX = {
  borderRadius: radius.lg,
  padding: space.lg,
  backgroundColor: colors.primarySoft,
}

// Every listener the app registered for AppState changes, called as the platform calls them.
function appMovesTo(state: 'active' | 'background'): void {
  for (const [event, listener] of jest.mocked(AppState.addEventListener).mock.calls) {
    if (event === 'change') {
      ;(listener as (next: string) => void)(state)
    }
  }
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function settle(tree?: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
      if (tree) {
        tree.update(<UseMyDomainScreen />)
      }
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<UseMyDomainScreen />)
  })
  await settle()
  return tree
}

async function type(
  tree: ReactTestRenderer.ReactTestRenderer,
  index: number,
  value: string,
): Promise<void> {
  const input = tree.root.findAllByType(TextInput)[index]!
  await ReactTestRenderer.act(async () => {
    input.props.onChangeText(value)
  })
  await settle()
}

// Pressable is not findable by type in RN 0.86, it becomes an inner View, so a button is located by
// the pair of an onPress prop and its label.
function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): void {
  const target = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!target) {
    throw new Error(`button not found: ${label}`)
  }
  target.props.onPress()
}

// The list of lines no view has shown, which also remembers what was shown, so no case inherits it.
const FS = (
  require('react-native-fs') as {
    default: { DocumentDirectoryPath: string; exists(p: string): Promise<boolean>; unlink(p: string): Promise<void> }
  }
).default
const LINES = `${FS.DocumentDirectoryPath}/released-lines.json`
const lines = jest.requireActual('../src/wallet/releasedLines') as typeof import('../src/wallet/releasedLines')

beforeEach(async () => {
  jest.clearAllMocks()
  // The price is the gateway's, so every case has to say what it answered. The default is the list
  // price; the cases about the price itself override it.
  prices.mockResolvedValue({ domain_tier: 9990 })
  for (const file of [LINES, `${LINES}.tmp`, `${LINES}.unreadable`]) {
    if (await FS.exists(file)) {
      await FS.unlink(file)
    }
  }
  jest.useFakeTimers()
})
afterEach(() => {
  jest.useRealTimers()
})

it('asks for the domain first, and says so when it is not one', async () => {
  const tree = await render()
  await type(tree, 0, 'not a domain')
  expect(texts(tree).join(' ')).toContain('not look like a domain')
})

it('shows the address taking shape while the customer types', async () => {
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  // The default subdomain is already filled in, so the preview is complete on the first keystroke.
  expect(texts(tree)).toContain('name@pay.bakery.com.br')
})

it('accepts a pasted url and keeps only the domain', async () => {
  const tree = await render()
  await type(tree, 0, 'https://Bakery.com.br/shop')
  expect(texts(tree)).toContain('name@pay.bakery.com.br')
})

it('drops the subdomain from the preview when it is cleared', async () => {
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await type(tree, 1, '')
  expect(texts(tree)).toContain('name@bakery.com.br')
})

it('shows the sample address in the language of the screen', async () => {
  await i18n.changeLanguage('pt-BR')
  try {
    const tree = await render()
    await type(tree, 0, 'bakery.com.br')
    expect(texts(tree)).toContain('nome@pay.bakery.com.br')
  } finally {
    await i18n.changeLanguage('en-US')
  }
})

// A Field under the place cards, whose label would otherwise sit at the group's 8 from the card.
it('sets the subdomain field apart from the card over it by the rhythm', async () => {
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  const field = tree.root.findAllByType(Field).find(n => n.props.label === i18n.t('useDomain.subdomainLabel'))!
  expect(StyleSheet.flatten(field.props.style).marginTop).toBe(rhythm.section - space.sm)
})

it('strips from the subdomain whatever a hostname cannot hold', async () => {
  // What is typed here becomes part of a lightning address, so anything a hostname cannot carry has
  // to go before the preview shows it, not after the server refuses it. Without the sanitiser
  // "My Shop!" would be offered as a subdomain.
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await type(tree, 1, 'My Shop!')
  expect(texts(tree)).toContain('name@myshop.bakery.com.br')
})

it('goes straight to the steps for a domain already paid for, without quoting again', async () => {
  claim.mockResolvedValue({
    host: 'pay.bakery.com.br',
    provider: 'hostinger',
    supportsRoot: false,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state: 'awaiting_dns',
  })
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)
  expect(quote).not.toHaveBeenCalled()
  expect(texts(tree).join(' ')).toContain('Points to: saas.usevoltz.app')
})

it('quotes, pays and only then shows the steps', async () => {
  claim.mockRejectedValueOnce(new Error('domain_tier_not_paid'))
  quote.mockResolvedValue({
    host: 'pay.bakery.com.br',
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'ref-1',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })
  confirm.mockResolvedValue(GRANTED)
  claim.mockResolvedValue({
    host: 'pay.bakery.com.br',
    provider: 'cloudflare',
    supportsRoot: true,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state: 'awaiting_dns',
  })

  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)
  expect(texts(tree)).toContain(`${formatSats(199_800)} sats`)

  await ReactTestRenderer.act(async () => {
    press(tree, 'Pay')
  })
  await settle(tree)
  expect(sparkPrepareSend).toHaveBeenCalledWith('lnbc1')
  expect(sparkConfirmSend).toHaveBeenCalledWith('h-1', undefined, undefined)
  expect(texts(tree).join(' ')).toContain('Type: CNAME')
})

it('offers the root as a choice instead of hiding it behind an empty field', async () => {
  // Clearing the subdomain field is a way to the root that nobody discovers, so both places are
  // addresses on screen, and picking one is what decides the host being bought.
  quote.mockResolvedValue({
    host: 'bakery.com.br',
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'ref-root',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })
  claim.mockRejectedValue(new Error('domain_tier_not_paid'))
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')

  const shown = texts(tree)
  expect(shown).toContain('name@bakery.com.br')
  expect(shown).toContain('name@pay.bakery.com.br')

  await ReactTestRenderer.act(async () => {
    press(tree, 'name@bakery.com.br')
  })
  await settle(tree)
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)
  // The root is what gets quoted, not the subdomain the field still remembers.
  expect(quote).toHaveBeenLastCalledWith(expect.anything(), 'bakery.com.br')
})

it('does not read an emptied label as choosing the root', async () => {
  // The label and the choice are separate pieces of state. As one, clearing the field to retype it
  // would move the purchase to the root without anybody asking for it: a different domain,
  // silently.
  quote.mockResolvedValue({
    host: 'pay.bakery.com.br',
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'ref-sub',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })
  claim.mockRejectedValue(new Error('domain_tier_not_paid'))
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await type(tree, 1, 'shop')
  expect(texts(tree)).toContain('name@shop.bakery.com.br')
  // Emptied to be retyped, and left that way. The address on screen is what must be bought, so an
  // empty label falls back to the same one it displays rather than quietly becoming the root, which
  // is a different domain and one nobody asked for here.
  await type(tree, 1, '')
  expect(texts(tree)).toContain('name@pay.bakery.com.br')
  expect(texts(tree)).not.toContain('name@.bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)
  expect(quote).toHaveBeenLastCalledWith(expect.anything(), 'pay.bakery.com.br')
})

it('says a domain is held by another wallet, and where the buyer can act on it', async () => {
  // The gateway answers this before the tier gate, so it reaches the screen where the domain is
  // chosen rather than only from the purchase route. Told merely that it was not paid, whoever owns
  // it goes on to buy a year that the purchase then refuses for this same reason, which is a dead
  // end wearing the shape of a next step.
  //
  // The sentence points at the buyer's own wallets and promises nothing beyond them: the move
  // screen picks from the wallets on this device, so there is no path from here to a stranger's
  // signature. Both refuse, which is what the gateway does: the quote route turns this owner away
  // for the same reason, and the claim saying it too is what moves the answer to before the money.
  claim.mockRejectedValue(new Error('domain_belongs_to_another_wallet'))
  quote.mockRejectedValue(new Error('domain_belongs_to_another_wallet'))
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)

  const shown = texts(tree).join(' ')
  expect(shown).toContain('already with another wallet')
  // The way out is named, because there is one and it is not "try again": only the wallet holding it
  // can hand it over, and the move screen picks from the wallets on this device.
  expect(shown).toContain('only whoever holds it can pass it on')
  expect(shown).not.toContain('has not been paid for')
})

// The claim and the quote stop on this device when the wallet gave its address up here, before
// anything is signed. Saying the payment failed would be false, and it hides the way back.
it('says a wallet whose address was given up here how to buy again', async () => {
  claim.mockRejectedValue(new Error('address_removed'))
  quote.mockRejectedValue(new Error('address_removed'))
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)

  const shown = texts(tree).join(' ')
  expect(shown).toContain('first tap Create the address again on the Lightning address screen')
  expect(shown).not.toContain(i18n.t('useDomain.payFailed'))
})

it('mints one price for two taps landing in the same batch', async () => {
  // `busy` is state, and state reaches the button after the second tap has already been handled, so
  // it guards nothing here. Each of these presses takes a hold on the domain and mints a real
  // invoice from the treasury, so two of them abandon a reference the buyer can no longer reach and
  // leave a second invoice payable.
  quote.mockResolvedValue({
    host: 'bakery.com.br',
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'ref-once',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })
  claim.mockRejectedValue(new Error('domain_tier_not_paid'))
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')

  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
    press(tree, 'Continue')
  })
  await settle(tree)

  expect(quote).toHaveBeenCalledTimes(1)
})

it('offers the way to keep a site only where it is the question being asked', async () => {
  // On the subdomain nothing of theirs is touched, so raising the possibility of losing a site there
  // would invent a worry. It belongs to the root, where it is real.
  claim.mockRejectedValue(new Error('domain_tier_not_paid'))
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  expect(texts(tree).join(' ')).not.toContain('I have a site on')

  await ReactTestRenderer.act(async () => {
    press(tree, 'name@bakery.com.br')
  })
  await settle(tree)
  expect(texts(tree).join(' ')).toContain('I have a site on bakery.com.br')

  await ReactTestRenderer.act(async () => {
    press(tree, 'I have a site on bakery.com.br')
  })
  await settle(tree)
  // Says it is possible and names the cheaper way out, rather than only warning.
  expect(texts(tree).join(' ')).toContain('can share the same root')
  expect(texts(tree).join(' ')).toContain('pick the subdomain above')
})

it('names the record the way the panel expects, and carries the proxy warning', async () => {
  claim.mockResolvedValue({
    host: 'pay.bakery.com.br',
    provider: 'cloudflare',
    supportsRoot: true,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state: 'awaiting_dns',
  })
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)
  // Compared whole rather than as a substring, because "Name: pay" also matches
  // "Name: pay.bakery.com.br", which is the wrong value and the one a panel would reject.
  expect(texts(tree)).toContain('Name: pay')
  // The one gotcha that silently breaks everything on this provider.
  expect(texts(tree).join(' ')).toContain('DNS only')
})

it("warns before a record that would take somebody's own site down", async () => {
  // A root that already carries addresses means the steps as written replace them. The panel
  // refuses the record while they stand, and deleting them to get past that is what takes the site
  // off the air, so the screen warns about both before the record is added.
  claim.mockResolvedValue({
    host: 'bakery.com.br',
    provider: 'cloudflare',
    supportsRoot: true,
    isRoot: true,
    target: 'saas.usevoltz.app',
    state: 'awaiting_dns',
    occupied: true,
  })
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)

  const shown = texts(tree).join(' ')
  expect(shown).toContain('already points somewhere today')
  // The way out has to name a subdomain of theirs, or it is a warning with nothing to do about it.
  expect(shown).toContain('pay.bakery.com.br')
  // The record is still shown, since whoever knows the address is free replaces it on purpose.
  expect(shown).toContain('Type: CNAME')
  expect(occupiedBox(tree)).toMatchObject(WARNING_BOX)
})

it('stays quiet about an occupied name when the gateway never said it was', async () => {
  // A gateway older than the field omits it. Absent has to read as "not known to be occupied", since
  // warning every customer that their site is about to go down would be worse than the gap it closes.
  claim.mockResolvedValue({
    host: 'pay.bakery.com.br',
    provider: 'cloudflare',
    supportsRoot: true,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state: 'awaiting_dns',
  })
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Type: CNAME')
  expect(shown).not.toContain('already points somewhere today')
})

it('tells a waiting customer to wait, and a misconfigured one what to fix', async () => {
  // The two are kept apart because telling somebody to keep waiting for something that will never
  // happen is the worse failure.
  claim.mockResolvedValue({
    host: 'pay.bakery.com.br',
    provider: 'generic',
    supportsRoot: false,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state: 'awaiting_dns',
  })
  const waiting = await render()
  await type(waiting, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(waiting, 'Continue')
  })
  await settle(waiting)
  expect(texts(waiting).join(' ')).toContain('usually takes a few minutes')

  claim.mockResolvedValue({
    host: 'pay.bakery.com.br',
    provider: 'generic',
    supportsRoot: false,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state: 'wrong_target',
  })
  const misconfigured = await render()
  await type(misconfigured, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(misconfigured, 'Continue')
  })
  await settle(misconfigured)
  expect(texts(misconfigured).join(' ')).toContain('points to the wrong place')
})

it('does not tell a customer who already paid that nothing was charged', async () => {
  // This is only reachable past the payment, because the poll runs on the DNS step, which is where
  // a buyer stands after paying. The general refusal text ends with "Nothing was charged", and that
  // is the one thing certainly false here. The year is paid, so a poll the gateway refuses says only
  // that the domain could not be checked (docs/store-bridge.md, I4).
  claim.mockResolvedValueOnce({
    host: 'pay.bakery.com.br',
    provider: 'generic',
    supportsRoot: false,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state: 'awaiting_dns',
  })
  claim.mockRejectedValue(new Error('domain_tier_not_paid'))
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)

  const shown = texts(tree).join(' ')
  expect(shown).toContain("This domain's status could not be checked just now")
  expect(shown).not.toContain('This domain has not been paid for')
  expect(shown).not.toContain('Nothing was charged')
})

it('says the domain is mid-purchase instead of reporting a failed payment', async () => {
  // Somebody else holds it for the length of their quote and it clears on its own. The general
  // failure text gives no reason to come back, which is the whole difference here.
  claim.mockRejectedValue(new Error('domain_tier_not_paid'))
  quote.mockRejectedValueOnce(new Error('domain is being bought by someone else'))
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)

  expect(texts(tree).join(' ')).toContain('Somebody else is buying this domain')
})

it('says it is done and offers the proof once it is live', async () => {
  claim.mockResolvedValue({
    host: 'pay.bakery.com.br',
    provider: 'generic',
    supportsRoot: false,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state: 'active',
  })
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)
  const all = texts(tree).join(' ')
  expect(all).toContain('Your address is working')
  expect(all).toContain('Send 1 sat')
})

// The address works only once the wallet issues it on the domain, which needs the domain stored and
// the wallet reconnected. Until both answered nothing says it works, and a failure says so with a way
// to try again rather than ending without a word.
it('says the address works only once the wallet took the domain, and offers Try again when it could not', async () => {
  claim.mockResolvedValue({
    host: 'pay.bakery.com.br',
    provider: 'generic',
    supportsRoot: false,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state: 'active',
  })
  jest.mocked(setDomainFor).mockRejectedValueOnce(new Error('disk full'))
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)
  let all = texts(tree).join(' ')
  expect(all).toContain('could not be set up on it yet')
  expect(all).not.toContain('Your address is working')
  expect(all).not.toContain('Send 1 sat')

  await ReactTestRenderer.act(async () => {
    press(tree, 'Try again')
  })
  await settle(tree)
  all = texts(tree).join(' ')
  expect(all).toContain('Your address is working')
  expect(all).toContain('Send 1 sat')
  expect(all).not.toContain('could not be set up on it yet')
  expect(setDomainFor).toHaveBeenCalledTimes(2)
})

it('never offers a button that says the customer has finished', async () => {
  // Pressing one before DNS has spread shows an error for something merely not ready, which is
  // where a non-technical customer decides they did it wrong.
  claim.mockResolvedValue({
    host: 'pay.bakery.com.br',
    provider: 'generic',
    supportsRoot: false,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state: 'awaiting_dns',
  })
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)
  expect(texts(tree).join(' ')).not.toMatch(/already did|check now|verify|I have|done configuring/i)
})

// The price is anchored in dollars and charged in sats, so the sats figure is only good while the
// quote is. Without saying so, somebody pays an invoice that already lapsed and is then told the
// purchase did not take.
it('says how long the price is held, and offers a new one once it lapses', async () => {
  claim.mockRejectedValueOnce(new Error('domain_tier_not_paid'))
  quote.mockResolvedValue({
    host: 'pay.bakery.com.br',
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'ref-1',
    expiresAt: Math.floor(Date.now() / 1000) + 90,
  })
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)
  expect(texts(tree).join(' ')).toMatch(/Price held for 1:3\d/)

  // Past the deadline the button stops offering to pay a price that no longer exists.
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(95_000)
  })
  await settle(tree)
  const shownAfter = texts(tree).join(' ')
  expect(shownAfter).toContain('This price expired')
  expect(shownAfter).toContain('New price')
  expect(shownAfter).not.toContain('Price held for')
})

// The price is the gateway's, not the app's. A constant here would be a second source of truth: the
// gateway prices from a table, so any change there would leave this screen advertising the old
// number. It still goes through the app formatter, since a literal string would give every
// locale a Portuguese comma decimal.
it('shows the price the gateway charges, formatted by the app', async () => {
  prices.mockResolvedValue({ domain_tier: 300 })
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await settle(tree)
  const all = texts(tree).join(' ')
  expect(all).toMatch(/3\.00/)
  expect(all).not.toContain('99')
  expect(all).not.toContain('3,00')
})

it('says no price at all rather than one it could not confirm', async () => {
  // A constant answering here would show somebody deciding a number that nothing has checked
  // against what they will actually be charged.
  prices.mockRejectedValue(new Error('offline'))
  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  await settle(tree)
  const all = texts(tree).join(' ')
  expect(all).not.toMatch(/US\$/)
  // The way forward is still offered: the price is one tap away, at the quote.
  expect(all).toContain('Continue')
})

describe('money already sent', () => {
  // The mock is an ES default export, so the CommonJS require hands back the module wrapper.
  const RNFS = (
    require('react-native-fs') as {
      default: {
        DocumentDirectoryPath: string
        exists(p: string): Promise<boolean>
        unlink(p: string): Promise<void>
      }
    }
  ).default
  const FILE = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`
  const real = jest.requireActual(
    '../src/wallet/domainOnboard',
  ) as typeof import('../src/wallet/domainOnboard')

  const aQuote = {
    host: 'pay.bakery.com.br',
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'ref-1',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  }

  beforeEach(async () => {
    mockActive.id = null
    if (await RNFS.exists(FILE)) {
      await RNFS.unlink(FILE)
    }
  })

  async function atThePayment(): Promise<ReactTestRenderer.ReactTestRenderer> {
    claim.mockRejectedValueOnce(new Error('domain_tier_not_paid'))
    quote.mockResolvedValue(aQuote)
    const tree = await render()
    await type(tree, 0, 'bakery.com.br')
    await ReactTestRenderer.act(async () => {
      press(tree, 'Continue')
    })
    await settle(tree)
    return tree
  }

  it('writes the payment proof before the money moves', async () => {
    // It is the only proof the purchase is owed if the app dies, so it has to exist first.
    confirm.mockResolvedValue(GRANTED)
    claim.mockResolvedValue({
      host: 'pay.bakery.com.br',
      provider: 'generic',
      supportsRoot: false,
      isRoot: false,
      target: 'saas.usevoltz.app',
      state: 'awaiting_dns',
    })
    const order: string[] = []
    ;(sparkConfirmSend as jest.Mock).mockImplementation(async () => {
      order.push('pagou')
      return 'complete'
    })
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)
    expect(order).toEqual(['pagou'])
    // Cleared once the purchase completes, so it is not retried forever.
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  // The screen's own grant clears the proof as delivered, with the year it answered, so a view waiting
  // on that reference shows the year bought rather than offering it again. Heard through a listener,
  // since every view on screen takes a delivered clear and a gone one alike for this screen's own wait.
  it('its own grant tells the views that the year was delivered, and which year', async () => {
    confirm.mockResolvedValue(GRANTED)
    claim.mockResolvedValue({
      host: 'pay.bakery.com.br',
      provider: 'generic',
      supportsRoot: false,
      isRoot: false,
      target: 'saas.usevoltz.app',
      state: 'awaiting_dns',
    })
    const heard: [string, unknown][] = []
    const off = real.onPendingPurchaseGone((reference, left) => heard.push([reference, left]))
    try {
      const tree = await atThePayment()
      await ReactTestRenderer.act(async () => {
        press(tree, 'Pay')
      })
      await settle(tree)
      expect(texts(tree).join(' ')).toContain('Type: CNAME')
      expect(heard).toEqual([['ref-1', { reason: 'granted', year: GRANTED }]])
    } finally {
      off()
    }
  })

  it('refuses a purchase the wallet cannot cover, instead of filing a proof for it', async () => {
    // Preparing can succeed for a send the wallet cannot cover, and confirming then throws
    // SdkError.SparkError, which names nothing at all. Read as "the money may have gone out", that
    // throw writes a proof of a payment that never happened and leaves the wallet unable to buy
    // anything again, since the proof blocks the next purchase and tells the buyer their money is
    // on its way. So the balance is checked before the send.
    // Both are restored at the end, because clearAllMocks clears calls and not implementations, so
    // a balance left low or a send left rejecting would follow this case into the next ones.
    // The stored figure says enough, as one left from before a spend made on another device would.
    jest.mocked(sparkSyncedBalanceSat).mockResolvedValue(1000)
    ;(sparkConfirmSend as jest.Mock).mockRejectedValue(new Error('SdkError.SparkError'))
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    expect(texts(tree).join(' ')).toContain('Not enough balance')
    // Nothing was dispatched, so nothing may stand for a payment.
    expect(sparkConfirmSend).not.toHaveBeenCalled()
    expect(await RNFS.exists(FILE)).toBe(false)
    jest.mocked(sparkSyncedBalanceSat).mockResolvedValue(1_000_000)
    ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
  })

  it('pays on the synced balance when the stored one is too low', async () => {
    // Stored before a receive the first sync has not brought in yet.
    jest.mocked(sparkGetBalanceSat).mockResolvedValue(1000)
    ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
    try {
      const tree = await atThePayment()
      await ReactTestRenderer.act(async () => {
        press(tree, 'Pay')
      })
      await settle(tree)

      expect(texts(tree).join(' ')).not.toContain('Not enough balance')
      expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
    } finally {
      jest.mocked(sparkGetBalanceSat).mockResolvedValue(1_000_000)
    }
  })

  it('sends nothing until the synced balance answers', async () => {
    let answer!: (sat: number | null) => void
    jest
      .mocked(sparkSyncedBalanceSat)
      .mockImplementationOnce(() => new Promise<number | null>(resolve => (answer = resolve)))
    ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)
    expect(sparkSyncedBalanceSat).toHaveBeenCalledTimes(1)
    expect(sparkConfirmSend).not.toHaveBeenCalled()

    await ReactTestRenderer.act(async () => answer(1_000_000))
    await settle(tree)
    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
  })

  it('sends nothing without a synced balance, and says it could not be checked', async () => {
    // Offline, or the first sync did not come within its wait: only the stored figure is there.
    jest.mocked(sparkSyncedBalanceSat).mockResolvedValueOnce(null)
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    expect(texts(tree).join(' ')).toContain('Your balance could not be checked with the network yet.')
    expect(texts(tree).join(' ')).not.toContain('Not enough balance')
    expect(sparkConfirmSend).not.toHaveBeenCalled()
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  it('does not walk on when the send failed outright', async () => {
    ;(sparkConfirmSend as jest.Mock).mockResolvedValue('failed')
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)
    const all = texts(tree).join(' ')
    expect(all).toContain('did not go through')
    expect(all).not.toContain('Type: CNAME')
    expect(confirm).not.toHaveBeenCalled()
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  it('does not claim nothing was charged when the refusal is one it cannot read', async () => {
    // The test above is the only case where "Nothing was charged" is true: the SDK reported the send
    // as failed. Here the send went out and the gateway refused with a code this build has never
    // seen, which is the case a newer gateway produces, and the money is exactly what is unknown.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    // Set explicitly rather than inherited, because the case above pins this mock to 'failed' and
    // nothing in the file resets it, so a send that succeeds has to say so here or this reads the
    // wrong branch.
    ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
    // Rejected twice rather than persistently, because the retry has to run into the same refusal
    // to read its text and a persistent mock would follow this case into the next one.
    confirm.mockRejectedValueOnce(new Error('code_this_build_has_never_seen'))
    confirm.mockRejectedValueOnce(new Error('code_this_build_has_never_seen'))
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)
    // The refusal itself leaves the buyer on the awaiting card rather than an error, since the proof
    // on disk outranks it. The fallback text is what their retry runs into, which is where the claim
    // about the money is actually read.
    expect(texts(tree).join(' ')).toContain('without paying twice')
    await ReactTestRenderer.act(async () => {
      press(tree, 'Check again')
    })
    await settle(tree)

    const all = texts(tree).join(' ')
    expect(all).not.toContain('Nothing was charged')
    expect(all).toContain('the app completes it')
    warn.mockRestore()
  })

  it('says the payment is settling instead of dead-ending', async () => {
    // confirmDomain returning false must reach the screen, or the buyer gets no error, no retry
    // and no message.
    ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
    confirm.mockResolvedValue(null)
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)
    expect(texts(tree).join(' ')).toContain('Waiting for it to be seen')
    // The proof stays on disk precisely because the purchase is unfinished.
    expect(await RNFS.exists(FILE)).toBe(true)
  })

  // A 402 on the confirmation means the payment is still landing, not that it was lost. The hold
  // lapses while the buyer waits, and the button that then offered a new price is what charged them
  // twice: paying the second invoice writes its reference over the first one's, which is the only
  // thing on the device that says the first payment happened.
  it('offers to check the payment instead of a new price once the hold lapses', async () => {
    ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
    confirm.mockResolvedValue(null)
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(601_000)
    })
    await settle(tree)

    const shown = texts(tree)
    expect(shown).toContain('Check again')
    expect(shown).not.toContain('New price')
    // Nothing on screen offers to charge again, the price included.
    expect(shown).not.toContain(`${formatSats(199_800)} sats`)

    await ReactTestRenderer.act(async () => {
      press(tree, 'Check again')
    })
    await settle(tree)

    // One invoice was ever minted, and the payment made against it still has its proof.
    expect(quote).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenLastCalledWith(expect.anything(), 'pay.bakery.com.br', 'ref-1')
    expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })

    // And the purchase still completes the moment the gateway sees the payment.
    confirm.mockResolvedValue(GRANTED)
    claim.mockResolvedValue({
      host: 'pay.bakery.com.br',
      provider: 'generic',
      supportsRoot: false,
      isRoot: false,
      target: 'saas.usevoltz.app',
      state: 'awaiting_dns',
    })
    await ReactTestRenderer.act(async () => {
      press(tree, 'Check again')
    })
    await settle(tree)
    expect(texts(tree).join(' ')).toContain('Type: CNAME')
    expect(quote).toHaveBeenCalledTimes(1)
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  // Preparing a send moves no money, and it throws for the commonest reason there is: too little
  // balance. A proof left behind by that throw stands for a payment nobody made, and the screen
  // reads it back on every open, hides every price behind it and waits on a gateway that answers
  // 402 forever, so the wallet can never buy or renew a domain again.
  it('offers the price again after a send that never left, instead of a wait that never ends', async () => {
    ;(sparkPrepareSend as jest.Mock).mockRejectedValueOnce(new Error('insufficient balance'))
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    // Nothing was dispatched, so there is nothing on disk to be owed and nothing to wait for.
    expect(sparkConfirmSend).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(await RNFS.exists(FILE)).toBe(false)
    const afterFailing = texts(tree)
    expect(afterFailing).not.toContain('Check again')
    expect(afterFailing).toContain(`${formatSats(199_800)} sats`)

    // And the next press buys the domain rather than asking after a payment that never happened.
    confirm.mockResolvedValue(GRANTED)
    claim.mockResolvedValue({
      host: 'pay.bakery.com.br',
      provider: 'generic',
      supportsRoot: false,
      isRoot: false,
      target: 'saas.usevoltz.app',
      state: 'awaiting_dns',
    })
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)
    expect(sparkConfirmSend).toHaveBeenCalledWith('h-1', undefined, undefined)
    expect(texts(tree).join(' ')).toContain('Type: CNAME')
  })

  // The same lockout seen from the next open, which is where a buyer who gave up and came back
  // stands. A record for a payment that never happened would take the screen over before the
  // domain question is ever asked, on a domain they are no longer buying.
  it('lets the next open buy a different domain after a send that never left', async () => {
    ;(sparkPrepareSend as jest.Mock).mockRejectedValueOnce(new Error('insufficient balance'))
    const paying = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(paying, 'Pay')
    })
    await settle(paying)

    claim.mockRejectedValue(new Error('domain_tier_not_paid'))
    quote.mockResolvedValue({ ...aQuote, host: 'pay.other.com.br', reference: 'ref-2' })
    const reopened = await render()
    const onOpening = texts(reopened)
    expect(onOpening).not.toContain('Check again')
    expect(onOpening).not.toContain('pay.bakery.com.br')

    await type(reopened, 0, 'other.com.br')
    await ReactTestRenderer.act(async () => {
      press(reopened, 'Continue')
    })
    await settle(reopened)
    expect(texts(reopened)).toContain(`${formatSats(199_800)} sats`)
    expect(confirm).not.toHaveBeenCalled()
  })

  // The app killed while the invoice is being prepared, which leaves whatever was written and runs
  // no cleanup at all. Nothing was dispatched, so a record left there as a proof locks the next open
  // onto a payment nobody made: what is written before the send has to read as no payment.
  it('lets the next open buy after the app died while the send was being prepared', async () => {
    // Never resolves, standing for the process ending here, so nothing after the write in pay()
    // runs.
    ;(sparkPrepareSend as jest.Mock).mockImplementationOnce(() => new Promise(() => undefined))
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)
    expect(sparkConfirmSend).not.toHaveBeenCalled()

    claim.mockRejectedValue(new Error('domain_tier_not_paid'))
    const reopened = await render()
    expect(texts(reopened)).not.toContain('Check again')
    expect(confirm).not.toHaveBeenCalled()

    await type(reopened, 0, 'bakery.com.br')
    await ReactTestRenderer.act(async () => {
      press(reopened, 'Continue')
    })
    await settle(reopened)
    expect(texts(reopened)).toContain(`${formatSats(199_800)} sats`)
  })

  // The slot can change hands while the send is being prepared: the recovery sweep files a proof for
  // any charge the gateway says this wallet is owed, and preparing is a round trip long enough for
  // one to land. Giving up a send that never left has to give up this purchase's own record and no
  // other, or the commonest failure there is deletes the only thing pointing at money that did move.
  it('leaves a payment that took the slot while the send was being prepared', async () => {
    const landed = { host: 'pay.other.com.br', reference: 'ref-9', amountSats: 199800 }
    ;(sparkPrepareSend as jest.Mock).mockImplementationOnce(async () => {
      await real.savePendingPurchase(landed)
      throw new Error('insufficient balance')
    })
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    expect(await real.loadPendingPurchase()).toEqual(landed)
    // And the buyer is put on the payment that is owed rather than left beside a price for it.
    const shown = texts(tree)
    expect(shown).toContain('pay.other.com.br')
    expect(shown).toContain('Check again')
    expect(shown).not.toContain(`${formatSats(199_800)} sats`)
  })

  // Two presses can land in one tick, before the button has re-rendered as busy, and each carries a
  // copy of the state that says nobody is paying. Dispatching both sends one invoice twice, and the
  // send that loses the race reports a failure that drops the proof of the one that won.
  it('sends once when the pay button is pressed twice in one tick', async () => {
    ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
    confirm.mockResolvedValue(null)
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
      press(tree, 'Pay')
    })
    await settle(tree)

    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)
    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
    // And the one payment that did go out still has its proof.
    expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
  })

  // The promotion after the send is what a crash between paying and confirming rests on: a record
  // still marked as standing for no payment reads as nothing on the next open, and the money that
  // left has nothing pointing back at it.
  it('keeps the proof of a dispatched send for the next open to finish', async () => {
    ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
    confirm.mockResolvedValue(null)
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)
    expect(await real.loadPendingPurchase()).toMatchObject({
      host: 'pay.bakery.com.br',
      reference: 'ref-1',
    })

    const reopened = await render()
    const shown = texts(reopened)
    expect(shown).toContain('Check again')
    expect(shown).toContain('pay.bakery.com.br')
    expect(quote).toHaveBeenCalledTimes(1)
  })

  // A throw once the send was dispatched says nothing about whether the money left, so the proof
  // stays and the screen stays on the payment. A price still on offer there is the other road to two
  // payments for one purchase.
  it('stays on the payment when the send threw after it was dispatched', async () => {
    ;(sparkConfirmSend as jest.Mock).mockRejectedValueOnce(new Error('Network request failed'))
    claim.mockRejectedValue(new Error('domain_tier_not_paid'))
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    expect(await RNFS.exists(FILE)).toBe(true)
    expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
    const shown = texts(tree)
    expect(shown).toContain('Check again')
    expect(shown).not.toContain(`${formatSats(199_800)} sats`)

    // And the one press left finishes that payment rather than minting anything.
    confirm.mockResolvedValue(null)
    await ReactTestRenderer.act(async () => {
      press(tree, 'Check again')
    })
    await settle(tree)
    expect(confirm).toHaveBeenCalledWith(expect.anything(), 'pay.bakery.com.br', 'ref-1')
    expect(quote).toHaveBeenCalledTimes(1)
  })

  // Preparing a send does not discover a balance too small for the invoice: the dispatch does, by
  // throwing. The record is promoted before the dispatch, so that throw finds a proof standing for
  // a payment nobody made, and left in place it hides every later price behind a wait that never
  // ends while telling the buyer their money is on its way.
  it('offers the price again when the send refused for too little balance', async () => {
    ;(sparkConfirmSend as jest.Mock).mockRejectedValueOnce(
      new Error('PaymentError.InsufficientFunds: not enough funds'),
    )
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    // Nothing was dispatched, so there is nothing owed and nothing to wait for.
    expect(await RNFS.exists(FILE)).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    const shown = texts(tree)
    expect(shown.join(' ')).toContain('did not go through')
    expect(shown).not.toContain('Check again')
    expect(shown).toContain(`${formatSats(199_800)} sats`)
  })

  // spark.ts refuses before the SDK while an exit holds the wallet, so nothing was dispatched: the
  // proof goes, and the line says why in Send's words.
  it.each([
    ['exit', 'emergencyExit.spendHeld'],
    ['unread', 'emergencyExit.spendHeldUnread'],
  ] as const)('drops the proof and says why when an exit holds the send (%s)', async (hold, key) => {
    ;(sparkConfirmSend as jest.Mock).mockRejectedValueOnce(new SpendHeldByExit(hold))
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    expect(await RNFS.exists(FILE)).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    const shown = texts(tree)
    expect(shown).toContain(i18n.t(key))
    expect(shown).not.toContain('Check again')
  })

  // Refused because the invoice is the wallet's own, which the gateway can mint against a treasury
  // sharing the key. Decided before anything is dispatched, exactly like too little balance.
  it('offers the price again when the send refused an invoice of its own', async () => {
    ;(sparkConfirmSend as jest.Mock).mockRejectedValueOnce(
      new Error('PaymentError.SelfTransferNotSupported'),
    )
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    expect(await RNFS.exists(FILE)).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    const shown = texts(tree)
    expect(shown.join(' ')).toContain('did not go through')
    expect(shown).not.toContain('Check again')
    expect(shown).toContain(`${formatSats(199_800)} sats`)
  })

  // The hold and the invoice lapse together, and a send dispatched a moment late is refused rather
  // than paid. Nothing left, so the proof of it must not stay either.
  it('offers the price again when the send refused a lapsed invoice', async () => {
    ;(sparkConfirmSend as jest.Mock).mockRejectedValueOnce(new Error('invoice expired'))
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    expect(await RNFS.exists(FILE)).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    const shown = texts(tree)
    // The lapse is named and the one press left asks for a new price, rather than a generic failure
    // over a Pay button bound to the same dead invoice.
    expect(shown).toContain(i18n.t('useDomain.quoteExpired'))
    expect(shown).not.toContain(i18n.t('useDomain.payFailed'))
    expect(shown).toContain(i18n.t('useDomain.requote'))
    expect(shown).not.toContain(i18n.t('useDomain.pay'))
    expect(shown).not.toContain('Check again')
    expect(shown).toContain(`${formatSats(199_800)} sats`)
  })

  // The slot can change hands after the record is promoted, since the recovery sweep files a proof
  // for any charge the gateway says this wallet is owed. A refusal decided before the dispatch gives
  // up this purchase's own record and no other, or the commonest failure there is answers money that
  // did move with an error about an attempt that never left.
  it('leaves a payment that took the slot when the send refused for too little balance', async () => {
    const landed = { host: 'pay.other.com.br', reference: 'ref-9', amountSats: 199800 }
    ;(sparkConfirmSend as jest.Mock).mockImplementationOnce(async () => {
      await real.clearPendingPurchase(aQuote.reference)
      await real.savePendingPurchase(landed)
      throw new Error('PaymentError.InsufficientFunds: not enough funds')
    })
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    expect(await real.loadPendingPurchase()).toEqual(landed)
    // And the buyer is put on the payment that is owed rather than told this attempt failed.
    const shown = texts(tree)
    expect(shown).toContain('pay.other.com.br')
    expect(shown).toContain('Check again')
    expect(shown).not.toContain(`${formatSats(199_800)} sats`)
  })

  // A refusal the classifier cannot place says nothing about whether the money left. Dropping the
  // record there is the same lie the other way round: a payment that did go out, with nothing on the
  // device pointing back at it.
  it('stays on the payment when the send refused for a reason that answers nothing', async () => {
    ;(sparkConfirmSend as jest.Mock).mockRejectedValueOnce(
      new Error('PaymentError.Generic: unexpected response'),
    )
    claim.mockRejectedValue(new Error('domain_tier_not_paid'))
    const tree = await atThePayment()
    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    expect(await RNFS.exists(FILE)).toBe(true)
    expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
    const shown = texts(tree)
    expect(shown).toContain('Check again')
    expect(shown).not.toContain(`${formatSats(199_800)} sats`)
  })

  // A payment can reach the slot while a price sits on screen, since the recovery on the Home screen
  // files a proof for every charge the gateway says this wallet is owed. Asking for a new price from
  // there is the other road to two payments for one purchase, and it has to end at the payment
  // already owed.
  it('finishes the payment already owed instead of minting the new price it offers', async () => {
    // Refused every time, so nothing short of the guard stops the press from reaching a quote: the
    // claim is what would otherwise send an already paid domain to the DNS steps instead.
    claim.mockRejectedValue(new Error('domain_tier_not_paid'))
    confirm.mockResolvedValue(null)
    const tree = await atThePayment()
    await real.savePendingPurchase({
      host: 'pay.bakery.com.br',
      reference: 'ref-1',
      amountSats: 199800,
    })

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(601_000)
    })
    await settle(tree)
    await ReactTestRenderer.act(async () => {
      press(tree, 'New price')
    })
    await settle(tree)

    expect(quote).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith(expect.anything(), 'pay.bakery.com.br', 'ref-1')
    expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
    expect(texts(tree)).toContain('Check again')
  })

  // The proof file refuses to take a second payment while the first is still owed, and answers with
  // the one it kept. A caller that paid anyway would leave that money with no record at all, which
  // is worse than overwriting it.
  it('does not send money when the proof file already holds another payment', async () => {
    const tree = await atThePayment()
    // Filed after the screen opened, as the recovery sweep files one, so the Pay is what meets it.
    await real.savePendingPurchase({ host: 'pay.other.com.br', reference: 'ref-9', amountSats: 199800 })
    confirm.mockResolvedValue(null)

    await ReactTestRenderer.act(async () => {
      press(tree, 'Pay')
    })
    await settle(tree)

    expect(sparkPrepareSend).not.toHaveBeenCalled()
    // The payment already owed is the one asked after, and the one named on screen.
    expect(confirm).toHaveBeenCalledWith(expect.anything(), 'pay.other.com.br', 'ref-9')
    expect(texts(tree)).toContain('pay.other.com.br')
  })

  // A payment can only be confirmed by the wallet that made it, since the gateway matches the
  // charge against the paying key. So a proof another wallet is still owed must not take this
  // screen over: doing so shows this buyer somebody else's domain, offers them a retry that is
  // refused every time, and leaves them unable to buy a domain of their own at all.
  it("does not hold one wallet hostage to another wallet's payment", async () => {
    mockActive.id = 'wallet-a'
    await real.savePendingPurchase({
      host: 'pay.other.com.br',
      reference: 'ref-9',
      amountSats: 199800,
    })
    mockActive.id = 'wallet-b'
    quote.mockResolvedValue(aQuote)
    claim.mockRejectedValue(new Error('domain_tier_not_paid'))

    const tree = await render()
    await settle(tree)
    const shown = texts(tree)
    expect(shown).not.toContain('pay.other.com.br')
    expect(shown).not.toContain('Check again')
    expect(confirm).not.toHaveBeenCalled()

    // And it can still buy its own.
    await type(tree, 0, 'bakery.com.br')
    await ReactTestRenderer.act(async () => {
      press(tree, 'Continue')
    })
    await settle(tree)
    expect(texts(tree)).toContain(`${formatSats(199_800)} sats`)

    // The other wallet's proof is still on disk for it to finish.
    mockActive.id = 'wallet-a'
    expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-9' })
  })

  it('picks up a purchase left unfinished by a previous run', async () => {
    await real.savePendingPurchase({
      host: 'pay.bakery.com.br',
      reference: 'ref-1',
      amountSats: 199800,
    })
    confirm.mockResolvedValue(GRANTED)
    claim.mockResolvedValue({
      host: 'pay.bakery.com.br',
      provider: 'generic',
      supportsRoot: false,
      isRoot: false,
      target: 'saas.usevoltz.app',
      state: 'active',
    })
    const tree = await render()
    await settle(tree)
    // Resumed instead of quoting a second invoice for something already paid for.
    expect(confirm).toHaveBeenCalledWith(expect.anything(), 'pay.bakery.com.br', 'ref-1')
    expect(quote).not.toHaveBeenCalled()
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  // A Pay files its record, promotes it before the send and drops it on every way out before the money
  // moves or after a send that failed, all in the slot of the wallet its press started on. A switch right
  // after the press moves the registry to another wallet, whose slot none of those writes touch.
  describe('a Pay after a switch right after its press', () => {
    const recordOf = async (walletId: string): Promise<unknown> => {
      if (!(await RNFS.exists(FILE))) {
        return undefined
      }
      const read = (RNFS as unknown as { readFile(p: string, e: string): Promise<string> }).readFile
      return (JSON.parse(await read(FILE, 'utf8')) as Record<string, unknown>)[walletId]
    }

    // The press reads the wallet it starts on, and every read after it answers the wallet switched to.
    async function payThenSwitch(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
      jest.mocked(getActiveWalletId).mockResolvedValueOnce('wallet-a')
      mockActive.id = 'wallet-b'
      await ReactTestRenderer.act(async () => {
        press(tree, 'Pay')
      })
      await settle(tree)
    }

    afterEach(() => {
      mockActive.id = null
    })

    it.each([
      ['a send that failed', true, () => (sparkConfirmSend as jest.Mock).mockResolvedValueOnce('failed')],
      ['a send that threw for want of balance', true, () => (sparkConfirmSend as jest.Mock).mockRejectedValueOnce(new Error('insufficient balance'))],
      ['a prepare that threw', false, () => (sparkPrepareSend as jest.Mock).mockRejectedValueOnce(new Error('SdkError.NetworkError'))],
      ['a balance that could not be read', false, () => (sparkSyncedBalanceSat as jest.Mock).mockRejectedValueOnce(new Error('offline'))],
      ['a balance too low', false, () => (sparkSyncedBalanceSat as jest.Mock).mockResolvedValueOnce(0)],
    ] as const)('%s drops the record in the slot of the wallet that pressed', async (_, sent, fail) => {
      mockActive.id = 'wallet-a'
      const tree = await atThePayment()
      fail()
      await payThenSwitch(tree)
      expect(sparkConfirmSend).toHaveBeenCalledTimes(sent ? 1 : 0)
      expect(await recordOf('wallet-a')).toBeUndefined()
      expect(await recordOf('wallet-b')).toBeUndefined()
    })

    // A press that could not read which wallet it starts on has no slot to file the record in, so
    // nothing is filed and nothing is sent, whatever the registry answers after it.
    it('a press that could not read its wallet files and sends nothing', async () => {
      mockActive.id = 'wallet-a'
      const tree = await atThePayment()
      jest.mocked(getActiveWalletId).mockRejectedValueOnce(new Error('registry unreadable'))
      await ReactTestRenderer.act(async () => {
        press(tree, 'Pay')
      })
      await settle(tree)
      expect(sparkPrepareSend).not.toHaveBeenCalled()
      expect(sparkConfirmSend).not.toHaveBeenCalled()
      expect(await recordOf('wallet-a')).toBeUndefined()
      expect(texts(tree).join(' ')).toContain(i18n.t('recover.recordUnread'))
    })

    // A send that threw is read against the record of the wallet that pressed, never the one a switch
    // made active: that wallet's record of another payment would take the screen and skip the drop of a
    // record standing for a send refused before it left. Each case runs with no switch as its control.
    describe('a send that threw', () => {
      const B_PROOF = { host: 'shop.example.com', reference: 'ref-b', amountSats: 199800 }

      async function thrown(err: Error, switches: boolean): Promise<ReactTestRenderer.ReactTestRenderer> {
        mockActive.id = 'wallet-a'
        await real.savePendingPurchase(B_PROOF, 'wallet-b')
        ;(sparkConfirmSend as jest.Mock).mockRejectedValueOnce(err)
        const tree = await atThePayment()
        if (switches) {
          await payThenSwitch(tree)
        } else {
          await ReactTestRenderer.act(async () => {
            press(tree, 'Pay')
          })
          await settle(tree)
        }
        expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
        expect(await real.loadPendingPurchase('wallet-b')).toEqual(B_PROOF)
        expect(texts(tree).join(' ')).not.toContain('shop.example.com')
        return tree
      }

      it.each([true, false])('for want of balance drops the record of the wallet that pressed (switch %s)', async switches => {
        await thrown(new Error('insufficient balance'), switches)
        expect(await recordOf('wallet-a')).toBeUndefined()
      })

      it.each([true, false])('after it left keeps the record of the wallet that pressed on screen (switch %s)', async switches => {
        const tree = await thrown(new Error('Network request failed'), switches)
        expect(await real.loadPendingPurchase('wallet-a')).toMatchObject({ reference: 'ref-1' })
        expect(texts(tree)).toContain('Check again')
        expect(texts(tree).join(' ')).toContain('pay.bakery.com.br')
      })
    })

    // The question a Pay asks once its money left reads, marks, releases and clears the record of the
    // wallet the press started on, and keeps the line its answer leaves for that wallet, whichever wallet
    // a switch while the send was out made active. The wallet switched to holds a record of its own,
    // which nothing here touches. Each case runs with no switch as its control.
    describe('the question after the send', () => {
      const B_PROOF = { host: 'shop.example.com', reference: 'ref-b', amountSats: 199800 }
      const A_PROOF = { host: 'pay.bakery.com.br', reference: 'ref-1', amountSats: 199800, isRoot: false }

      async function paid(switches: boolean): Promise<ReactTestRenderer.ReactTestRenderer> {
        mockActive.id = 'wallet-a'
        await real.savePendingPurchase(B_PROOF, 'wallet-b')
        const tree = await atThePayment()
        if (switches) {
          await payThenSwitch(tree)
        } else {
          await ReactTestRenderer.act(async () => {
            press(tree, 'Pay')
          })
          await settle(tree)
        }
        expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(await real.loadPendingPurchase('wallet-b')).toEqual(B_PROOF)
        return tree
      }

      afterEach(() => {
        confirm.mockReset()
      })

      it.each([true, false])('a year granted clears the record of the wallet that pressed (switch %s)', async switches => {
        confirm.mockResolvedValue(GRANTED)
        claim.mockResolvedValue({
          host: 'pay.bakery.com.br',
          provider: 'generic',
          supportsRoot: false,
          isRoot: false,
          target: 'saas.usevoltz.app',
          state: 'awaiting_dns',
        })
        const tree = await paid(switches)
        expect(await recordOf('wallet-a')).toBeUndefined()
        expect(texts(tree).join(' ')).toContain('Type: CNAME')
      })

      it.each([
        // A wait leaves the record owed with no mark, and a refusal for good marks it.
        ['coming', () => Object.assign(new Error('paid_but_not_granted'), { final: false }), {}],
        ['kept', () => Object.assign(new Error('paid_but_not_granted'), { repaid: false }), { refusedForGood: true }],
      ] as const)('a %s answer marks the record of the wallet that pressed, with a switch and without', async (_, answer, mark) => {
        for (const switches of [true, false]) {
          confirm.mockReset().mockRejectedValue(answer())
          ;(sparkConfirmSend as jest.Mock).mockClear()
          const tree = await paid(switches)
          expect(await recordOf('wallet-a')).toEqual({ ...A_PROOF, ...mark })
          await ReactTestRenderer.act(async () => {
            tree.unmount()
          })
          await RNFS.unlink(FILE)
        }
      })

      it.each([true, false])('a repaid answer keeps its line and gives up the slot of the wallet that pressed (switch %s)', async switches => {
        confirm.mockRejectedValue(Object.assign(new Error('paid_but_not_granted'), { repaid: true }))
        const tree = await paid(switches)
        expect(await recordOf('wallet-a')).toBeUndefined()
        expect(texts(tree).join(' ')).toContain(i18n.t('recover.repaidBody'))
        // Said on screen, so no line is left for a later view of either wallet.
        expect(await lines.listLines('wallet-a')).toEqual([])
        expect(await lines.listLines('wallet-b')).toEqual([])
      })

      // A payment the sweep filed after the price went on screen, or while the send was being prepared,
      // holds the slot the press files or promotes in, so nothing is sent and that payment is asked
      // about, on the wallet that pressed.
      it.each([
        [true, 'before the press'],
        [false, 'before the press'],
        [true, 'while preparing'],
        [false, 'while preparing'],
      ] as const)('an older payment found by the press is asked about on the wallet that pressed (switch %s, filed %s)', async (switches, when) => {
        const OLD = { host: 'old.bakery.com.br', reference: 'ref-old', amountSats: 199800 }
        confirm.mockResolvedValue(GRANTED)
        claim.mockResolvedValue({
          host: 'old.bakery.com.br',
          provider: 'generic',
          supportsRoot: false,
          isRoot: false,
          target: 'saas.usevoltz.app',
          state: 'awaiting_dns',
        })
        mockActive.id = 'wallet-a'
        await real.savePendingPurchase(B_PROOF, 'wallet-b')
        const tree = await atThePayment()
        if (when === 'before the press') {
          await real.savePendingPurchase(OLD, 'wallet-a')
        } else {
          ;(sparkPrepareSend as jest.Mock).mockImplementationOnce(async () => {
            await real.savePendingPurchase(OLD, 'wallet-a')
            return { handle: 'h-1', amount: 199800, fee: 0 }
          })
        }
        if (switches) {
          await payThenSwitch(tree)
        } else {
          await ReactTestRenderer.act(async () => {
            press(tree, 'Pay')
          })
          await settle(tree)
        }
        expect(sparkConfirmSend).not.toHaveBeenCalled()
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(confirm.mock.calls[0]?.slice(1)).toEqual(['old.bakery.com.br', 'ref-old'])
        expect(await recordOf('wallet-a')).toBeUndefined()
        expect(await real.loadPendingPurchase('wallet-b')).toEqual(B_PROOF)
      })
    })
  })

  // Final answers that name more than a person giving the sats back. A refusal says the sats came back
  // only on this charge's `repaid: true`, and nothing offers to check again, a price or a second
  // payment. An answer that owes nothing gives the slot up once its line is on screen, so the next
  // opening offers the form and asks nothing more; one still owed keeps its proof and is
  // asked again at each opening.
  describe('a paid year the gateway answers for good in other words', () => {
    const recover = (i18n.getResourceBundle('en-US', 'translation') as { recover: Record<string, string> }).recover
    const PROOF = { host: 'pay.bakery.com.br', reference: 'ref-1', amountSats: 199800 }
    const answers = {
      boughtBefore: () => Object.assign(new Error('bought_before'), { final: true }),
      repaid: () => Object.assign(new Error('paid_but_not_granted'), { repaid: true }),
      repaidFalse: () => Object.assign(new Error('paid_but_not_granted'), { repaid: false }),
      repaidAbsent: () => new Error('paid_but_not_granted'),
    }
    type Which = keyof typeof answers
    const LINES_SAID: Record<Which, string> = {
      boughtBefore: recover.boughtBeforeBody!.replace('{{subject}}', 'pay.bakery.com.br'),
      repaid: recover.repaidBody!,
      repaidFalse: recover.blockedBody!,
      repaidAbsent: recover.blockedBody!,
    }
    const OWED: Record<Which, boolean> = { boughtBefore: false, repaid: false, repaidFalse: true, repaidAbsent: true }

    afterEach(async () => {
      confirm.mockReset()
      if (await RNFS.exists(FILE)) {
        await RNFS.unlink(FILE)
      }
    })

    function expectFinal(shown: string, which: Which): void {
      expect(shown).toContain(LINES_SAID[which])
      expect(shown).toContain('pay.bakery.com.br')
      expect(shown.includes('Send to support')).toBe(OWED[which])
      expect(shown.includes(recover.repaidBody!)).toBe(which === 'repaid')
      expect(shown).not.toContain(recover.boughtBeforeNameBody!)
      expect(shown).not.toContain('Waiting for it to be seen')
      expect(shown).not.toContain('Check again')
      expect(shown).not.toContain(`${formatSats(199_800)} sats`)
    }

    // The proof an owed answer keeps, and none at all, not even on file, for one that owes nothing.
    async function expectSlot(which: Which): Promise<void> {
      const held = await real.loadPendingPurchase()
      if (!OWED[which]) {
        expect(held).toBeNull()
        expect(await RNFS.exists(FILE)).toBe(false)
        return
      }
      expect(held).toMatchObject({ reference: 'ref-1', refusedForGood: true })
      expect(held?.finalAnswer).toBeUndefined()
    }

    for (const which of Object.keys(answers) as Which[]) {
      it(`after paying, ${which} says what the payment came to and offers nothing more`, async () => {
        ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
        confirm.mockRejectedValue(answers[which]())
        const tree = await atThePayment()
        await ReactTestRenderer.act(async () => {
          press(tree, 'Pay')
        })
        await settle(tree)

        expectFinal(texts(tree).join(' '), which)
        expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
        expect(confirm).toHaveBeenCalledTimes(1)
        await expectSlot(which)
      })

      it(`on opening, ${which} is asked again ${OWED[which] ? 'at each opening' : 'never'}, also after a restart`, async () => {
        await real.savePendingPurchase(PROOF)
        confirm.mockRejectedValue(answers[which]())
        const tree = await render()
        await settle(tree)
        expectFinal(texts(tree).join(' '), which)
        expect(quote).not.toHaveBeenCalled()
        expect(confirm).toHaveBeenCalledTimes(1)
        await expectSlot(which)

        confirm.mockRejectedValue(new Error('Network request failed'))
        await ReactTestRenderer.act(async () => {
          tree.unmount()
        })
        const restarted = await render()
        await settle(restarted)
        expect(confirm).toHaveBeenCalledTimes(OWED[which] ? 2 : 1)
        const shown = texts(restarted).join(' ')
        if (OWED[which]) {
          expectFinal(shown, which)
        } else {
          // The next opening is the form, and the line was said in the view that heard it.
          expect(shown).not.toContain(LINES_SAID[which])
          expect(shown).toContain('What is your domain?')
        }
        expect(quote).not.toHaveBeenCalled()
        expect(sparkConfirmSend).not.toHaveBeenCalled()
      })
    }

    // A released slot offers only a fresh quote, which the gateway mints anew.
    it('after an answer that owes nothing, the next opening quotes afresh and pays only the new invoice', async () => {
      ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
      confirm.mockRejectedValue(answers.repaid())
      const first = await atThePayment()
      await ReactTestRenderer.act(async () => {
        press(first, 'Pay')
      })
      await settle(first)
      await ReactTestRenderer.act(async () => {
        first.unmount()
      })
      confirm.mockResolvedValue(null)
      claim.mockRejectedValueOnce(new Error('domain_tier_not_paid'))
      quote.mockResolvedValue({ ...aQuote, invoice: 'lnbc2', reference: 'ref-2' })
      const tree = await render()
      await type(tree, 0, 'bakery.com.br')
      await ReactTestRenderer.act(async () => {
        press(tree, 'Continue')
      })
      await settle(tree)
      expect(quote).toHaveBeenCalledTimes(2)
      await ReactTestRenderer.act(async () => {
        press(tree, 'Pay')
      })
      await settle(tree)
      expect((sparkPrepareSend as jest.Mock).mock.calls.map(call => call[0])).toEqual(['lnbc1', 'lnbc2'])
      expect((await real.loadPendingPurchase())?.reference).toBe('ref-2')
    })

    // An answer that releases the slot heard after the screen closed is kept as a line before the slot
    // is given up, and said once, by the next screen, with no question to the gateway, and never again.
    it.each(['repaid', 'boughtBefore'] as const)('%s heard after the screen closed is said once by the next one', async which => {
      await real.savePendingPurchase(PROOF)
      let answer!: (err: Error) => void
      confirm.mockImplementation(() => new Promise((_, reject) => (answer = reject)))
      const tree = await render()
      await settle(tree)
      expect(confirm).toHaveBeenCalledTimes(1)
      await ReactTestRenderer.act(async () => {
        tree.unmount()
      })
      await ReactTestRenderer.act(async () => {
        answer(answers[which]())
      })
      await settle()
      expect(await real.loadPendingPurchase()).toBeNull()
      expect(await lines.listLines()).toEqual([
        { kind: 'tier', reference: 'ref-1', answer: which, subject: 'pay.bakery.com.br' },
      ])

      const next = await render()
      await settle(next)
      expectFinal(texts(next).join(' '), which)
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(await lines.listLines()).toEqual([])
      expect(await RNFS.exists(FILE)).toBe(false)
      await ReactTestRenderer.act(async () => {
        next.unmount()
      })

      const third = await render()
      await settle(third)
      const shown = texts(third).join(' ')
      expect(shown).not.toContain(LINES_SAID[which])
      expect(shown).toContain('What is your domain?')
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    // A list file that cannot be read answers a claim as unknown, and the screen still says the answer
    // it heard itself, writing nothing over the file.
    it('a mounted screen says its own fresh year answer when the list cannot be read, and leaves the file', async () => {
      await real.savePendingPurchase(PROOF)
      const torn = '{"primary": [{"kind": "ti'
      const file = RNFS as unknown as {
        readFile(p: string, e: string): Promise<string>
        writeFile(p: string, c: string, e: string): Promise<void>
      }
      await file.writeFile(LINES, torn, 'utf8')
      confirm.mockRejectedValue(answers.repaid())
      const tree = await render()
      await settle(tree)
      expectFinal(texts(tree).join(' '), 'repaid')
      expect(await real.loadPendingPurchase()).toBeNull()
      expect(await file.readFile(LINES, 'utf8')).toBe(torn)
    })

    // A screen gone when the answer lands keeps the line before it gives the slot up, so a
    // process ended between the two leaves the proof, whose next confirmation hears the same answer.
    it('a screen gone when a year answer lands keeps the line while the slot still holds its proof', async () => {
      await real.savePendingPurchase(PROOF)
      let answer!: (err: Error) => void
      confirm.mockImplementation(() => new Promise((_, reject) => (answer = reject)))
      const tree = await render()
      await settle(tree)
      await ReactTestRenderer.act(async () => {
        tree.unmount()
      })
      const realNote = lines.noteLine
      const heldAtNote: (string | null)[] = []
      const note = jest.spyOn(lines, 'noteLine').mockImplementation(async (kept, scope) => {
        heldAtNote.push((await real.loadPendingPurchase())?.reference ?? null)
        await realNote(kept, scope)
      })
      await ReactTestRenderer.act(async () => {
        answer(answers.repaid())
      })
      await settle()
      note.mockRestore()
      expect(heldAtNote).toEqual(['ref-1'])
      expect(await real.loadPendingPurchase()).toBeNull()
    })

    // The line of an answer heard by a screen gone is kept for the wallet the question was asked
    // on, and a line a screen took goes back to the wallet it was taken from, never to one a switch
    // made active meanwhile.
    it('a screen gone when a year answer lands after a switch keeps the line on the wallet that asked', async () => {
      mockActive.id = 'wallet-a'
      try {
        await real.savePendingPurchase(PROOF)
        let answer!: (err: Error) => void
        confirm.mockImplementation(() => new Promise((_, reject) => (answer = reject)))
        const tree = await render()
        await settle(tree)
        await ReactTestRenderer.act(async () => {
          tree.unmount()
        })
        mockActive.id = 'wallet-b'
        await ReactTestRenderer.act(async () => {
          answer(answers.repaid())
        })
        await settle()
        expect(await lines.listLines('wallet-a')).toEqual([
          { kind: 'tier', reference: 'ref-1', answer: 'repaid', subject: 'pay.bakery.com.br' },
        ])
        expect(await lines.listLines('wallet-b')).toEqual([])
      } finally {
        mockActive.id = null
      }
    })

    // The record an answer gives up belongs to the wallet the question was asked on. The wallet switched
    // to holds a proof of its own, which the answer never touches. The release names the reference, so
    // one sent to the wallet switched to would land nowhere and leave the asked wallet's proof held.
    it.each([
      ['open', true, true],
      ['gone', false, true],
      ['open, with no switch,', true, false],
      ['gone, with no switch,', false, false],
    ] as const)('a screen %s when a year answer lands gives up the record of the wallet that asked', async (_, open, switches) => {
      const B_PROOF = { host: 'shop.example.com', reference: 'ref-b', amountSats: 199800 }
      mockActive.id = 'wallet-a'
      try {
        await real.savePendingPurchase(B_PROOF, 'wallet-b')
        await real.savePendingPurchase(PROOF)
        let answer!: (err: Error) => void
        confirm.mockImplementation(() => new Promise((__, reject) => (answer = reject)))
        const tree = await render()
        await settle(tree)
        if (!open) {
          await ReactTestRenderer.act(async () => {
            tree.unmount()
          })
        }
        if (switches) {
          mockActive.id = 'wallet-b'
        }
        await ReactTestRenderer.act(async () => {
          answer(answers.repaid())
        })
        await settle()
        expect(await real.loadPendingPurchase('wallet-a')).toBeNull()
        expect(await real.loadPendingPurchase('wallet-b')).toEqual(B_PROOF)
      } finally {
        mockActive.id = null
      }
    })

    it('a screen gone while it takes a line puts it back on the wallet it took it from after a switch', async () => {
      const kept = { kind: 'tier', reference: 'ref-7', answer: 'repaid', subject: 'pay.bakery.com.br' } as const
      mockActive.id = 'wallet-a'
      const realTake = lines.takeLine
      let taken!: () => void
      const held = new Promise<void>(resolve => (taken = resolve))
      const take = jest.spyOn(lines, 'takeLine').mockImplementationOnce(async (kind, scope) => {
        const line = await realTake(kind, scope)
        await held
        return line
      })
      try {
        await lines.noteLine(kept, lines.scopeOn('wallet-a'))
        const tree = await render()
        await settle(tree)
        expect(take).toHaveBeenCalledTimes(1)
        await ReactTestRenderer.act(async () => {
          tree.unmount()
        })
        mockActive.id = 'wallet-b'
        await ReactTestRenderer.act(async () => {
          taken()
        })
        await settle()
        expect(await lines.listLines('wallet-a')).toEqual([kept])
        expect(await lines.listLines('wallet-b')).toEqual([])
      } finally {
        take.mockRestore()
        mockActive.id = null
      }
    })

    // A mount that takes a kept line gives the slot of its reference up as shown, which a clear that
    // never landed after the release left marked on file.
    it('a mount that says a kept year line drops the marked proof of its reference', async () => {
      await real.savePendingPurchase(PROOF)
      await real.recordPurchaseRefusal('ref-1', true, 'repaid')
      await lines.noteLine({ kind: 'tier', reference: 'ref-1', answer: 'repaid', subject: 'pay.bakery.com.br' }, await lines.activeScope())
      const read = (RNFS as unknown as { readFile(p: string, e: string): Promise<string> }).readFile
      const onFile = async (): Promise<boolean> => (await RNFS.exists(FILE)) && (await read(FILE, 'utf8')).includes('ref-1')
      expect(await onFile()).toBe(true)
      const tree = await render()
      await settle(tree)
      expectFinal(texts(tree).join(' '), 'repaid')
      expect(confirm).not.toHaveBeenCalled()
      expect(await onFile()).toBe(false)
    })

    // A screen in an app sent to the background is seen by nobody, so the answer heard there is kept
    // for the next screen and said once by it.
    it('a year answer heard while the app is in the background is said once by the next screen', async () => {
      await real.savePendingPurchase(PROOF)
      let answer!: (err: Error) => void
      confirm.mockImplementation(() => new Promise((_, reject) => (answer = reject)))
      const tree = await render()
      await settle(tree)
      appMovesTo('background')
      await ReactTestRenderer.act(async () => {
        answer(answers.repaid())
      })
      await settle(tree)
      expect(texts(tree).join(' ')).not.toContain(LINES_SAID.repaid)
      expect(await real.loadPendingPurchase()).toBeNull()
      expect(await lines.listLines()).toEqual([
        { kind: 'tier', reference: 'ref-1', answer: 'repaid', subject: 'pay.bakery.com.br' },
      ])
      appMovesTo('active')
      await ReactTestRenderer.act(async () => {
        tree.unmount()
      })
      const next = await render()
      await settle(next)
      expectFinal(texts(next).join(' '), 'repaid')
      expect(await lines.listLines()).toEqual([])
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    // A screen takes only a year's line, and only with no proof held; a name's line is the sheet's.
    it('a kept year line is said on mount, and a name line is left for the sheet', async () => {
      await lines.noteLine({ kind: 'name', reference: 'ref-n', answer: 'repaid', subject: 'alice@lnurl.usevoltz.app' }, await lines.activeScope())
      await lines.noteLine({ kind: 'tier', reference: 'ref-9', answer: 'boughtBefore', subject: 'pay.bakery.com.br' }, await lines.activeScope())
      const tree = await render()
      await settle(tree)
      expectFinal(texts(tree).join(' '), 'boughtBefore')
      expect(confirm).not.toHaveBeenCalled()
      expect((await lines.listLines()).map(line => line.reference)).toEqual(['ref-n'])
    })

    it('a proof held on mount is asked about, and a kept year line waits for a mount with none', async () => {
      await lines.noteLine({ kind: 'tier', reference: 'ref-9', answer: 'repaid', subject: 'pay.bakery.com.br' }, await lines.activeScope())
      await real.savePendingPurchase(PROOF)
      confirm.mockResolvedValue(null)
      const tree = await render()
      await settle(tree)
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(await lines.listLines()).toHaveLength(1)
      await ReactTestRenderer.act(async () => {
        tree.unmount()
      })
      await real.clearPendingPurchase('ref-1')
      const next = await render()
      await settle(next)
      expectFinal(texts(next).join(' '), 'repaid')
      expect(await lines.listLines()).toEqual([])
    })

    // A Pay with a line kept is paid as any other, and the line stays for the next mount.
    it('a Pay with a line kept sends its own invoice', async () => {
      const tree = await atThePayment()
      await lines.noteLine({ kind: 'tier', reference: 'ref-9', answer: 'repaid', subject: 'pay.bakery.com.br' }, await lines.activeScope())
      confirm.mockResolvedValue(null)
      await ReactTestRenderer.act(async () => {
        press(tree, 'Pay')
      })
      await settle(tree)
      expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
      expect((await real.loadPendingPurchase())?.reference).toBe('ref-1')
      expect(await lines.listLines()).toHaveLength(1)
    })

    // A crash between keeping the line and giving the slot up leaves the proof, which the next mount
    // confirms again; it says the answer it heard and takes the kept copy out.
    it('a crash between keeping a line and giving the slot up says the line once', async () => {
      await real.savePendingPurchase(PROOF)
      await lines.noteLine({ kind: 'tier', reference: 'ref-1', answer: 'repaid', subject: 'pay.bakery.com.br' }, await lines.activeScope())
      confirm.mockRejectedValue(answers.repaid())
      const tree = await render()
      await settle(tree)
      expectFinal(texts(tree).join(' '), 'repaid')
      expect(await lines.listLines()).toEqual([])
      expect(await real.loadPendingPurchase()).toBeNull()
    })

    // A mark that owes nothing whose clear never landed reads as no proof, after a restart too.
    it('a proof marked as owing nothing whose clear never landed is not asked about and holds no form back', async () => {
      await real.savePendingPurchase(PROOF)
      await real.recordPurchaseRefusal('ref-1', true, 'boughtBefore')
      const tree = await render()
      await settle(tree)
      expect(confirm).not.toHaveBeenCalled()
      const shown = texts(tree).join(' ')
      expect(shown).not.toContain(LINES_SAID.boughtBefore)
      expect(shown).toContain('What is your domain?')
    })

    // Only the reader that claimed a reference shows its line, so a year's released line is said
    // exactly once whichever of this screen and a due sweep hears it first.
    describe('said by the reader that claimed it', () => {
      const says = (tree: ReactTestRenderer.ReactTestRenderer): boolean =>
        texts(tree).join(' ').includes(LINES_SAID.repaid)
      // A due sweep beside the screen, on the screen's own wallet, with no earlier case's ask on file to
      // hold it back. A sweep keeps and claims lines for the wallet it asks for.
      async function sweep(): Promise<unknown> {
        const { recoverPurchases } = jest.requireActual('../src/wallet/recover') as typeof import('../src/wallet/recover')
        const asked = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`
        if (await RNFS.exists(asked)) {
          await RNFS.unlink(asked)
        }
        const charges = [{ reference: 'ref-1', kind: 'tier', domain: 'lnurl.usevoltz.app', subject: PROOF.host, amountSats: PROOF.amountSats }]
        return recoverPurchases({
          walletId: 'primary',
          lines: lines.scopeOn('primary'),
          pubkey: `02${'a'.repeat(64)}`,
          sign: async () => 'sig',
          request: (async () => ({ ok: true, status: 200, json: async () => ({ charges }) })) as unknown as typeof fetch,
        })
      }

      beforeEach(async () => {
        await real.savePendingPurchase(PROOF)
      })

      it('a line the sweep heard first is its card, and the screen hearing it after does not say it', async () => {
        let screenAnswer!: (err: Error) => void
        confirm.mockImplementationOnce(() => new Promise((_, reject) => (screenAnswer = reject)))
        confirm.mockImplementationOnce(async () => {
          throw answers.repaid()
        })
        const tree = await render()
        await settle(tree)
        expect(await sweep()).toMatchObject({ status: 'repaid', kind: 'tier', reference: 'ref-1' })
        await ReactTestRenderer.act(async () => {
          screenAnswer(answers.repaid())
        })
        await settle(tree)
        expect(says(tree)).toBe(false)
        expect(texts(tree).join(' ')).toContain('What is your domain?')
        expect(await lines.listLines()).toEqual([])
        expect(await real.loadPendingPurchase()).toBeNull()
        expect(confirm).toHaveBeenCalledTimes(2)
      })

      it('a line the screen heard first is said there, and the sweep hearing it after has no card', async () => {
        let screenAnswer!: (err: Error) => void
        let sweepAnswer!: (err: Error) => void
        confirm.mockImplementationOnce(() => new Promise((_, reject) => (screenAnswer = reject)))
        confirm.mockImplementationOnce(() => new Promise((_, reject) => (sweepAnswer = reject)))
        const tree = await render()
        await settle(tree)
        const card = sweep()
        await settle(tree)
        expect(confirm).toHaveBeenCalledTimes(2)
        await ReactTestRenderer.act(async () => {
          screenAnswer(answers.repaid())
        })
        await settle(tree)
        expectFinal(texts(tree).join(' '), 'repaid')
        sweepAnswer(answers.repaid())
        expect(await card).toBeNull()
        expect(await lines.listLines()).toEqual([])
        expectFinal(texts(tree).join(' '), 'repaid')
      })

      // A screen gone while its claim is out paints nothing and leaves the line for the next screen.
      it('a screen gone while it claims leaves the line for the next screen, which says it once', async () => {
        let answer!: (err: Error) => void
        confirm.mockImplementationOnce(() => new Promise((_, reject) => (answer = reject)))
        const tree = await render()
        await settle(tree)
        // Holds the claim's read of the list, the first the screen makes, until the screen is gone.
        const realExists = FS.exists.bind(FS)
        let claimed!: () => void
        const gate = new Promise<void>(resolve => (claimed = resolve))
        let reading = false
        const exists = jest.spyOn(FS, 'exists').mockImplementation(async path => {
          if (path === LINES && !reading) {
            reading = true
            await gate
          }
          return realExists(path)
        })
        await ReactTestRenderer.act(async () => {
          answer(answers.repaid())
        })
        await settle()
        // Read now and checked once the claim is let go, so a failure leaves no read of the list held.
        const duringClaim = says(tree)
        await ReactTestRenderer.act(async () => {
          tree.unmount()
        })
        await ReactTestRenderer.act(async () => {
          claimed()
        })
        await settle()
        exists.mockRestore()
        expect(reading).toBe(true)
        expect(duringClaim).toBe(false)
        expect(await lines.listLines()).toEqual([
          { kind: 'tier', reference: 'ref-1', answer: 'repaid', subject: 'pay.bakery.com.br' },
        ])
        expect(await real.loadPendingPurchase()).toBeNull()
        const next = await render()
        await settle(next)
        expectFinal(texts(next).join(' '), 'repaid')
        expect(await lines.listLines()).toEqual([])
        await ReactTestRenderer.act(async () => {
          next.unmount()
        })
        const third = await render()
        await settle(third)
        expect(says(third)).toBe(false)
        expect(confirm).toHaveBeenCalledTimes(1)
      })

      // A Pay whose answer the sweep said first passes over the line to the form, where a fresh quote
      // starts, rather than leaving a payment step with no quote on it.
      it('a Pay whose released answer the sweep said first goes back to the form', async () => {
        await real.clearPendingPurchase('ref-1')
        const tree = await atThePayment()
        let payAnswer!: (err: Error) => void
        confirm.mockImplementationOnce(() => new Promise((_, reject) => (payAnswer = reject)))
        confirm.mockImplementationOnce(async () => {
          throw answers.repaid()
        })
        await ReactTestRenderer.act(async () => {
          press(tree, 'Pay')
        })
        await settle(tree)
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(await sweep()).toMatchObject({ status: 'repaid', reference: 'ref-1' })
        await ReactTestRenderer.act(async () => {
          payAnswer(answers.repaid())
        })
        await settle(tree)
        expect(says(tree)).toBe(false)
        expect(texts(tree).join(' ')).toContain('What is your domain?')
        expect(await real.loadPendingPurchase()).toBeNull()
      })

      // A crash between saying the line and giving the slot up leaves the reference recorded as shown
      // and the proof held; the next screen confirms again, as the residue allows, and says nothing.
      it('a fresh answer to a reference shown before a restart is not said again', async () => {
        expect(await lines.claimLine('ref-1', await lines.activeScope())).toEqual({ outcome: 'claimed', line: null })
        confirm.mockRejectedValueOnce(answers.repaid())
        const tree = await render()
        await settle(tree)
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(says(tree)).toBe(false)
        expect(texts(tree).join(' ')).toContain('What is your domain?')
        expect(await real.loadPendingPurchase()).toBeNull()
      })

      // A wait is about a proof in the record, and the sweep shares the record: once it gives the proof
      // up, no line says the year is coming and no confirmation goes out for it.
      describe('a wait whose proof the sweep gave up', () => {
        const spark = jest.requireMock('../src/wallet/spark') as Record<string, jest.Mock>
        // The sweep beside the screen, its writes inside act so the screen hears them as the app does.
        // `seen` false is a sweep whose card nobody can see, which keeps the line for the next view.
        async function sweepGivesUp(seen = true): Promise<unknown> {
          confirm.mockRejectedValueOnce(answers.repaid())
          const asked = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`
          if (await RNFS.exists(asked)) {
            await RNFS.unlink(asked)
          }
          const { recoverPurchases } = jest.requireActual('../src/wallet/recover') as typeof import('../src/wallet/recover')
          const charges = [{ reference: 'ref-1', kind: 'tier', domain: 'lnurl.usevoltz.app', subject: PROOF.host, amountSats: PROOF.amountSats }]
          let card: unknown
          await ReactTestRenderer.act(async () => {
            card = await recoverPurchases({
              walletId: 'primary',
              lines: lines.scopeOn('primary'),
              pubkey: `02${'a'.repeat(64)}`,
              sign: async () => 'sig',
              onScreen: () => seen,
              request: (async () => ({ ok: true, status: 200, json: async () => ({ charges }) })) as unknown as typeof fetch,
            })
          })
          expect(await real.loadPendingPurchase()).toBeNull()
          return card
        }
        // The screen's first question lost to the network, which leaves it waiting on the payment.
        async function waiting(): Promise<ReactTestRenderer.ReactTestRenderer> {
          confirm.mockRejectedValueOnce(new Error('Network request failed'))
          const tree = await render()
          await settle(tree)
          expect(texts(tree).join(' ')).toContain('Waiting for it to be seen')
          expect(texts(tree).join(' ')).toContain('Check again')
          return tree
        }
        // The wallet's identity read of the next question, held until the case lets it go. A mount
        // reads the identity for the price first, which `after` lets through.
        function holdIdentity(after = 0): () => Promise<void> {
          let answer!: () => void
          const key = `02${'a'.repeat(64)}`
          for (let i = 0; i < after; i++) {
            spark.sparkGetIdentityPubkey!.mockImplementationOnce(async () => key)
          }
          spark.sparkGetIdentityPubkey!.mockImplementationOnce(() => new Promise(resolve => (answer = () => resolve(key))))
          return () =>
            ReactTestRenderer.act(async () => {
              answer()
            })
        }
        function expectForm(tree: ReactTestRenderer.ReactTestRenderer): void {
          const shownNow = texts(tree).join(' ')
          expect(shownNow).not.toContain('Waiting for it to be seen')
          expect(shownNow).not.toContain('Check again')
          expect(shownNow).toContain('What is your domain?')
        }

        // The twin of the address sheet's probe, on a screen that stays open.
        it('a screen left open drops its wait once the sweep gives the proof up', async () => {
          const tree = await waiting()
          expect(await sweepGivesUp()).toMatchObject({ status: 'repaid', reference: 'ref-1' })
          await settle(tree)
          expectForm(tree)
          expect(says(tree)).toBe(false)
          expect(confirm).toHaveBeenCalledTimes(2)
        })

        // The proof given up while Check again reads the wallet, so the press is past the line's drop.
        it('a Check again whose proof the sweep gives up meanwhile sends no confirmation', async () => {
          const tree = await waiting()
          const letIdentity = holdIdentity()
          await ReactTestRenderer.act(async () => {
            press(tree, 'Check again')
          })
          await sweepGivesUp()
          await letIdentity()
          await settle(tree)
          expectForm(tree)
          expect(confirm).toHaveBeenCalledTimes(2)
        })

        // The mount read the proof, which the sweep gave up before the question, keeping the line for
        // the next view. The mount goes on as one that read no proof, so it takes that line and says it.
        it('a mount whose proof the sweep gives up before it asks sends nothing and says the kept line once', async () => {
          const letIdentity = holdIdentity(1)
          const tree = await render()
          expect(await sweepGivesUp(false)).toBeNull()
          expect(await lines.listLines()).toHaveLength(1)
          await letIdentity()
          await settle(tree)
          expect(confirm).toHaveBeenCalledTimes(1)
          expectFinal(texts(tree).join(' '), 'repaid')
          expect(await lines.listLines()).toEqual([])
        })

        // The same mount whose question fails at the identity read instead: the record read after the
        // failure finds the proof gone, so the mount still goes on as one that read none.
        it('a mount whose identity read fails after the sweep gave its proof up says the kept line once', async () => {
          let fail!: () => void
          spark.sparkGetIdentityPubkey!.mockImplementationOnce(async () => `02${'a'.repeat(64)}`)
          spark.sparkGetIdentityPubkey!.mockImplementationOnce(
            () => new Promise((_, reject) => (fail = () => reject(new Error('spark not connected')))),
          )
          const tree = await render()
          expect(await sweepGivesUp(false)).toBeNull()
          expect(await lines.listLines()).toHaveLength(1)
          await ReactTestRenderer.act(async () => {
            fail()
          })
          await settle(tree)
          expect(confirm).toHaveBeenCalledTimes(1)
          expectFinal(texts(tree).join(' '), 'repaid')
          expect(await lines.listLines()).toEqual([])
        })

        // A Pay asks right after its send, with nothing awaited on screen yet. A proof the sweep gave up
        // meanwhile takes the paid quote with it, and a first year goes back to the form.
        it('a Pay whose proof the sweep gives up before it asks sends nothing and leaves no price', async () => {
          await real.clearPendingPurchase('ref-1')
          const tree = await atThePayment()
          expect(texts(tree).join(' ')).toContain(`${formatSats(199_800)} sats`)
          const letIdentity = holdIdentity()
          await ReactTestRenderer.act(async () => {
            press(tree, 'Pay')
          })
          await settle(tree)
          expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
          await sweepGivesUp()
          await letIdentity()
          await settle(tree)
          expectForm(tree)
          expect(texts(tree).join(' ')).not.toContain(`${formatSats(199_800)} sats`)
          expect(confirm).toHaveBeenCalledTimes(1)
        })

        // A Pay whose write meets another payment's proof asks about that one instead of paying,
        // and the question stands on that proof only while the record holds it. The quote on screen is
        // another reference, so what the Pay finds in the record is the sweep's charge.
        describe('a Pay that finds another proof in the record', () => {
          async function atAnotherPayment(): Promise<ReactTestRenderer.ReactTestRenderer> {
            await real.clearPendingPurchase('ref-1')
            claim.mockRejectedValueOnce(new Error('domain_tier_not_paid'))
            quote.mockResolvedValueOnce({ ...aQuote, invoice: 'lnbc2', reference: 'ref-2' })
            const tree = await render()
            await type(tree, 0, 'bakery.com.br')
            await ReactTestRenderer.act(async () => {
              press(tree, 'Continue')
            })
            await settle(tree)
            expect(texts(tree).join(' ')).toContain(`${formatSats(199_800)} sats`)
            return tree
          }
          // The sweep gives the proof up while the question reads the wallet, so no confirmation for it
          // goes out and the screen waits on nothing. Neither this quote nor the other is paid.
          async function expectNothingAsked(tree: ReactTestRenderer.ReactTestRenderer, letIdentity: () => Promise<void>): Promise<void> {
            expect(confirm).not.toHaveBeenCalled()
            await sweepGivesUp()
            await letIdentity()
            await settle(tree)
            const shownNow = texts(tree).join(' ')
            expect(shownNow).not.toContain('Waiting for it to be seen')
            expect(shownNow).not.toContain('Check again')
            expect(confirm).toHaveBeenCalledTimes(1)
            expect(sparkConfirmSend).not.toHaveBeenCalled()
            expect(quote).toHaveBeenCalledTimes(1)
            expect(await real.loadPendingPurchase()).toBeNull()
          }

          // Another reader filed the proof before the press, so the Pay's first write finds it.
          it('a Pay whose first write finds a proof the sweep then gives up asks nothing', async () => {
            const tree = await atAnotherPayment()
            await real.savePendingPurchase(PROOF)
            const letIdentity = holdIdentity()
            await ReactTestRenderer.act(async () => {
              press(tree, 'Pay')
            })
            await settle(tree)
            expect(sparkPrepareSend).not.toHaveBeenCalled()
            await expectNothingAsked(tree, letIdentity)
          })

          // The proof filed while the invoice is prepared, over this quote's unpaid one, so the write
          // that promotes it before the send finds it.
          it('a Pay whose promoting write finds a proof the sweep then gives up asks nothing', async () => {
            const tree = await atAnotherPayment()
            ;(sparkPrepareSend as jest.Mock).mockImplementationOnce(async () => {
              await real.savePendingPurchase(PROOF)
              return { handle: 'h-1', amount: 199800, fee: 0 }
            })
            const letIdentity = holdIdentity()
            await ReactTestRenderer.act(async () => {
              press(tree, 'Pay')
            })
            await settle(tree)
            expect(sparkPrepareSend).toHaveBeenCalledTimes(1)
            await expectNothingAsked(tree, letIdentity)
          })
        })

        // A record that cannot be read is not a proof gone: nothing is asked and the screen says it
        // cannot tell, never that the year is coming.
        it('a Check again whose read of the record fails sends nothing and says no year is coming', async () => {
          const tree = await waiting()
          await (RNFS as unknown as { writeFile(p: string, c: string, e: string): Promise<void> }).writeFile(
            FILE,
            '{"primary":',
            'utf8',
          )
          await ReactTestRenderer.act(async () => {
            press(tree, 'Check again')
          })
          await settle(tree)
          const shownNow = texts(tree).join(' ')
          expect(shownNow).toContain(recover.recordUnread!)
          expect(shownNow).not.toContain('Waiting for it to be seen')
          expect(shownNow).not.toContain('What is your domain?')
          expect(confirm).toHaveBeenCalledTimes(1)
        })

        // The line a failed press leaves promises the payment completes later, which is false once the
        // sats came back, so it goes with the wait.
        const LATER = 'the app completes it the next time you open it'

        it('a Check again that failed says nothing of completing once the sweep gives the proof up', async () => {
          const tree = await waiting()
          confirm.mockRejectedValueOnce(new Error('Network request failed'))
          await ReactTestRenderer.act(async () => {
            press(tree, 'Check again')
          })
          await settle(tree)
          expect(texts(tree).join(' ')).toContain(LATER)
          await sweepGivesUp()
          await settle(tree)
          expectForm(tree)
          expect(texts(tree).join(' ')).not.toContain(LATER)
          expect(confirm).toHaveBeenCalledTimes(3)
        })

        // The same line from a Check again whose question was out when the sweep gave the proof up, and
        // which then lost to the network.
        it('a Check again out when the sweep gives the proof up, and failing after, says nothing of completing', async () => {
          const tree = await waiting()
          let fail!: (err: Error) => void
          confirm.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
          await ReactTestRenderer.act(async () => {
            press(tree, 'Check again')
          })
          await settle(tree)
          await sweepGivesUp()
          await ReactTestRenderer.act(async () => {
            fail(new Error('Network request failed'))
          })
          await settle(tree)
          expectForm(tree)
          expect(texts(tree).join(' ')).not.toContain(LATER)
        })

        // A send that failed gives its proof up, which the screen hears; paying the same quote again
        // writes it back, so a question after it that fails still stands on that payment.
        it('a quote paid again after a send that failed keeps its wait through a failed confirmation', async () => {
          await real.clearPendingPurchase('ref-1')
          const tree = await atThePayment()
          ;(sparkConfirmSend as jest.Mock).mockResolvedValueOnce('failed')
          await ReactTestRenderer.act(async () => {
            press(tree, 'Pay')
          })
          await settle(tree)
          expect(texts(tree).join(' ')).toContain('The payment did not go through')
          confirm.mockRejectedValueOnce(new Error('Network request failed'))
          await ReactTestRenderer.act(async () => {
            press(tree, 'Pay')
          })
          await settle(tree)
          const shownNow = texts(tree).join(' ')
          expect(shownNow).toContain('Waiting for it to be seen')
          expect(shownNow).not.toContain('What is your domain?')
          expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
        })

        // How a proof left decides only what a drop shows, never that a wait drops: the question after
        // that Pay fails at the wallet's identity read, before it reads the record, and the record read
        // after the failure still holds the proof the Pay wrote, so the wait stands as it did before
        // proofs could leave, with no line from the Pay and no fresh quote.
        async function paidAgain(fail: () => Promise<string>): Promise<ReactTestRenderer.ReactTestRenderer> {
          await real.clearPendingPurchase('ref-1')
          const tree = await atThePayment()
          ;(sparkConfirmSend as jest.Mock).mockResolvedValueOnce('failed')
          await ReactTestRenderer.act(async () => {
            press(tree, 'Pay')
          })
          await settle(tree)
          expect(texts(tree).join(' ')).toContain('The payment did not go through')
          spark.sparkGetIdentityPubkey!.mockImplementationOnce(fail)
          await ReactTestRenderer.act(async () => {
            press(tree, 'Pay')
          })
          await settle(tree)
          expect(sparkConfirmSend).toHaveBeenCalledTimes(2)
          return tree
        }

        it('a quote paid again after a send that failed keeps its wait when its identity read fails', async () => {
          const confirms = confirm.mock.calls.length
          const tree = await paidAgain(async () => {
            throw new Error('spark not connected')
          })
          const shownNow = texts(tree).join(' ')
          expect(shownNow).toContain('Waiting for it to be seen')
          expect(shownNow).toContain('Check again')
          expect(shownNow).not.toContain('What is your domain?')
          expect(shownNow).not.toContain('The payment did not go through')
          expect(shownNow).not.toContain(LATER)
          expect(quote).toHaveBeenCalledTimes(1)
          expect(confirm).toHaveBeenCalledTimes(confirms)
          expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
        })

        // The same failure with a record that cannot be read after it drops nothing either: the screen
        // says it cannot tell, and nothing is asked.
        it('a quote paid again whose identity read fails, with the record unreadable after, says it cannot tell', async () => {
          const confirms = confirm.mock.calls.length
          const tree = await paidAgain(async () => {
            await (RNFS as unknown as { writeFile(p: string, c: string, e: string): Promise<void> }).writeFile(
              FILE,
              '{"primary":',
              'utf8',
            )
            throw new Error('spark not connected')
          })
          const shownNow = texts(tree).join(' ')
          expect(shownNow).toContain(recover.recordUnread!)
          expect(shownNow).not.toContain('What is your domain?')
          expect(shownNow).not.toContain(`${formatSats(199_800)} sats`)
          expect(quote).toHaveBeenCalledTimes(1)
          expect(confirm).toHaveBeenCalledTimes(confirms)
          expect(await RNFS.exists(FILE)).toBe(true)
        })

        // A proof heard gone and filed back, as the sweep files back a charge the gateway lists, is met by
        // Continue, whose question fails at the identity read. The record read after holds it, so the
        // wait stands with the press's own line, and no price is quoted beside a payment owed.
        it('a Continue on a proof filed back after one gone keeps its wait when its identity read fails', async () => {
          await real.clearPendingPurchase('ref-1')
          quote.mockResolvedValue(aQuote)
          const tree = await render()
          await settle(tree)
          await ReactTestRenderer.act(async () => {
            await real.savePendingPurchase(PROOF)
            await real.clearPendingPurchase('ref-1')
            await real.savePendingPurchase(PROOF)
          })
          await type(tree, 0, 'bakery.com.br')
          spark.sparkGetIdentityPubkey!.mockRejectedValueOnce(new Error('spark not connected'))
          const confirms = confirm.mock.calls.length
          await ReactTestRenderer.act(async () => {
            press(tree, 'Continue')
          })
          await settle(tree)
          const shownNow = texts(tree).join(' ')
          expect(shownNow).toContain('Waiting for it to be seen')
          expect(shownNow).toContain(LATER)
          expect(shownNow).not.toContain('What is your domain?')
          expect(quote).not.toHaveBeenCalled()
          expect(confirm).toHaveBeenCalledTimes(confirms)
          expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
        })

        // The sweep can grant the year while the screen waits on it. Its clear says the year was
        // delivered, and the screen shows what its own grant shows, from the year the sweep's grant
        // answered: the DNS steps of a first year, with no form, no price and nothing asked again.
        describe('a wait whose year the sweep delivered', () => {
          const STEPS = 'One step left, in the panel that runs your domain'
          async function sweepDelivers(): Promise<unknown> {
            confirm.mockResolvedValueOnce(GRANTED)
            const asked = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`
            if (await RNFS.exists(asked)) {
              await RNFS.unlink(asked)
            }
            const { recoverPurchases } = jest.requireActual('../src/wallet/recover') as typeof import('../src/wallet/recover')
            const charges = [{ reference: 'ref-1', kind: 'tier', domain: 'lnurl.usevoltz.app', subject: PROOF.host, amountSats: PROOF.amountSats }]
            let card: unknown
            await ReactTestRenderer.act(async () => {
              card = await recoverPurchases({
                walletId: 'primary',
                lines: lines.scopeOn('primary'),
                pubkey: `02${'a'.repeat(64)}`,
                sign: async () => 'sig',
                onScreen: () => true,
                request: (async () => ({ ok: true, status: 200, json: async () => ({ charges }) })) as unknown as typeof fetch,
              })
            })
            expect(await real.loadPendingPurchase()).toBeNull()
            return card
          }
          // `polled` false is a screen whose poll of the domain did not answer, which offers its own Check
          // again for the domain's status, never for the payment.
          function expectSteps(tree: ReactTestRenderer.ReactTestRenderer, polled = true): void {
            const shownNow = texts(tree).join(' ')
            expect(shownNow).toContain(STEPS)
            expect(shownNow).not.toContain('Waiting for it to be seen')
            if (polled) {
              expect(shownNow).not.toContain('Check again')
            }
            expect(shownNow).not.toContain('What is your domain?')
            expect(shownNow).not.toContain(LATER)
            expect(shownNow).not.toContain(`${formatSats(199_800)} sats`)
          }

          it('a screen left open shows the DNS steps once the sweep delivers its year', async () => {
            const tree = await waiting()
            expect(await sweepDelivers()).toMatchObject({ status: 'ready', kind: 'tier', reference: 'ref-1' })
            await settle(tree)
            expectSteps(tree)
            expect(confirm).toHaveBeenCalledTimes(2)
          })

          it('a failed Check again gives way to the DNS steps once the sweep delivers the year', async () => {
            const tree = await waiting()
            confirm.mockRejectedValueOnce(new Error('Network request failed'))
            await ReactTestRenderer.act(async () => {
              press(tree, 'Check again')
            })
            await settle(tree)
            expect(texts(tree).join(' ')).toContain(LATER)
            await sweepDelivers()
            await settle(tree)
            expectSteps(tree)
          })

          // The year delivered while Check again reads the wallet, so the press finds the record empty.
          it('a Check again whose year the sweep delivers meanwhile asks nothing and shows the DNS steps', async () => {
            const tree = await waiting()
            const letIdentity = holdIdentity()
            await ReactTestRenderer.act(async () => {
              press(tree, 'Check again')
            })
            await sweepDelivers()
            await letIdentity()
            await settle(tree)
            expectSteps(tree)
            expect(confirm).toHaveBeenCalledTimes(2)
          })

          // A Continue meets a proof the sweep filed, and the sweep delivers its year before the question,
          // so the press takes the screen with the delivered year and mints no price.
          it('a Continue whose proof the sweep delivers before it asks mints no price', async () => {
            // A domain not paid for yet, whose Continue goes on to a price unless the press was taken.
            const claimed = claim.getMockImplementation()
            claim.mockRejectedValue(new Error('domain_tier_not_paid'))
            try {
              await real.clearPendingPurchase('ref-1')
              const tree = await render()
              await type(tree, 0, 'bakery.com.br')
              await real.savePendingPurchase(PROOF)
              const letIdentity = holdIdentity()
              await ReactTestRenderer.act(async () => {
                press(tree, 'Continue')
              })
              await sweepDelivers()
              await letIdentity()
              await settle(tree)
              expectSteps(tree, false)
              expect(quote).not.toHaveBeenCalled()
              expect(confirm).toHaveBeenCalledTimes(1)
            } finally {
              claim.mockImplementation(claimed)
            }
          })

          // A Pay asks right after its send, with nothing awaited on screen yet.
          it('a Pay whose year the sweep delivers before it asks shows the DNS steps and no price', async () => {
            await real.clearPendingPurchase('ref-1')
            const tree = await atThePayment()
            const letIdentity = holdIdentity()
            await ReactTestRenderer.act(async () => {
              press(tree, 'Pay')
            })
            await settle(tree)
            expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
            await sweepDelivers()
            await letIdentity()
            await settle(tree)
            expectSteps(tree)
            expect(confirm).toHaveBeenCalledTimes(1)
          })
        })
      })
    })
  })

  // A Pay that fails and finds another purchase's proof waits on that purchase, and says of this quote
  // only what is true whether its payment went or not, beside the awaited purchase's own line.
  describe('a Pay that fails onto another purchase', () => {
    const useDomain = (i18n.getResourceBundle('en-US', 'translation') as { useDomain: Record<string, string> }).useDomain
    const recover = (i18n.getResourceBundle('en-US', 'translation') as { recover: Record<string, string> }).recover
    const landed = { host: 'pay.other.com.br', reference: 'ref-9', amountSats: 199800 }
    const otherLine = (): string => useDomain.otherPurchase!.replace('{{host}}', save.mock.calls[0]![0].host)

    afterEach(async () => {
      if (await RNFS.exists(FILE)) {
        await RNFS.unlink(FILE)
      }
    })

    async function payOnto(refusedForGood: boolean, at: 'prepare' | 'send'): Promise<ReactTestRenderer.ReactTestRenderer> {
      const file = async (): Promise<void> => {
        if (at === 'send') {
          // The send's own proof is gone, as the sweep's expired list drops it, before another is filed.
          await real.clearPendingPurchase('ref-1')
        }
        await real.savePendingPurchase(landed)
        if (refusedForGood) {
          await real.recordPurchaseRefusal('ref-9', true)
        }
      }
      if (at === 'prepare') {
        ;(sparkPrepareSend as jest.Mock).mockImplementationOnce(async () => {
          await file()
          throw new Error('insufficient balance')
        })
      } else {
        ;(sparkConfirmSend as jest.Mock).mockImplementationOnce(async () => {
          await file()
          throw new Error('Network request failed')
        })
      }
      const tree = await atThePayment()
      await ReactTestRenderer.act(async () => {
        press(tree, 'Pay')
      })
      await settle(tree)
      return tree
    }

    for (const at of ['prepare', 'send'] as const) {
      it(`a failure at the ${at} says this quote's outcome is unknown and keeps the wait's own line`, async () => {
        const tree = await payOnto(false, at)
        const shown = texts(tree).join(' ')
        expect(shown).toContain(otherLine())
        expect(shown).toContain('pay.other.com.br')
        expect(shown).toContain('Check again')
        expect(shown).not.toContain(`${formatSats(199_800)} sats`)
        expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-9' })
      })
    }

    it('beside a refusal for good, both lines show and neither replaces the other', async () => {
      const tree = await payOnto(true, 'prepare')
      const shown = texts(tree).join(' ')
      expect(shown).toContain(otherLine())
      expect(shown).toContain(recover.blockedBody!)
      expect(shown).toContain('Send to support')
      expect(shown).not.toContain('Check again')
    })

    it('control: a Pay that fails onto its own proof says nothing of another purchase', async () => {
      ;(sparkConfirmSend as jest.Mock).mockRejectedValueOnce(new Error('Network request failed'))
      const tree = await atThePayment()
      await ReactTestRenderer.act(async () => {
        press(tree, 'Pay')
      })
      await settle(tree)
      const shown = texts(tree).join(' ')
      expect(shown).toContain('Check again')
      expect(shown).not.toContain(useDomain.otherPurchase!.split('{{host}}')[1]!.trim())
    })
  })

  // The gateway answers a paid confirmation of a year it cannot grant with no `final`, which says
  // nothing about whether a later one grants it. The screen never says the year is coming then, nor
  // that checking again finishes it, and keeps the proof and the screen on the payment.
  describe('a paid year the gateway will not grant', () => {
    const KEPT = (i18n.getResourceBundle('en-US', 'translation') as { recover: Record<string, string> }).recover
      .blockedBody!
    const refusal = (final?: boolean): Error =>
      Object.assign(new Error('paid_but_not_granted'), final === undefined ? {} : { final })
    const PROOF = { host: 'pay.bakery.com.br', reference: 'ref-1', amountSats: 199800 }

    // Every case here leaves the proof on disk and a confirmation double behind, and the cases after
    // this group open the screen fresh.
    afterEach(async () => {
      confirm.mockReset()
      if (await RNFS.exists(FILE)) {
        await RNFS.unlink(FILE)
      }
    })

    function expectKept(shown: string): void {
      expect(shown).toContain(KEPT)
      expect(shown).toContain('Send to support')
      expect(shown).toContain('pay.bakery.com.br')
      expect(shown).not.toContain('Waiting for it to be seen')
      expect(shown).not.toContain('Check again')
      expect(shown).not.toContain('completes it')
      expect(shown).not.toContain(`${formatSats(199_800)} sats`)
    }

    it('after paying, sends the buyer to a person and keeps the proof', async () => {
      ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
      confirm.mockRejectedValue(refusal())
      const tree = await atThePayment()
      await ReactTestRenderer.act(async () => {
        press(tree, 'Pay')
      })
      await settle(tree)

      expectKept(texts(tree).join(' '))
      expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
      expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
    })

    it('on opening, says nothing about the payment until the gateway answers, then sends it to a person', async () => {
      await real.savePendingPurchase(PROOF)
      let answer!: (err: Error) => void
      confirm.mockImplementation(() => new Promise((_, reject) => (answer = reject)))
      const tree = await render()
      await settle(tree)
      expect(texts(tree).join(' ')).not.toContain('Waiting for it to be seen')
      expect(texts(tree).join(' ')).not.toContain(`${formatSats(199_800)} sats`)

      await ReactTestRenderer.act(async () => {
        answer(refusal(true))
      })
      await settle(tree)
      expectKept(texts(tree).join(' '))
      expect(quote).not.toHaveBeenCalled()
      expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
    })

    // A lost network is no answer about the payment, so the open's question ends in the wait.
    it('on opening, a confirmation that cannot be reached leaves the wait', async () => {
      await real.savePendingPurchase(PROOF)
      confirm.mockRejectedValue(new Error('Network request failed'))
      const tree = await render()
      await settle(tree)
      const shown = texts(tree).join(' ')
      expect(shown).toContain('Waiting for it to be seen')
      expect(shown).toContain('Check again')
    })

    it('a refusal that may still clear is the wait', async () => {
      await real.savePendingPurchase(PROOF)
      confirm.mockRejectedValue(refusal(false))
      const tree = await render()
      await settle(tree)
      const shown = texts(tree).join(' ')
      expect(shown).toContain('Waiting for it to be seen')
      expect(shown).toContain('Check again')
      expect(shown).not.toContain(KEPT)
    })

    it('a wait that turns into a refusal takes the screen on the next check', async () => {
      await real.savePendingPurchase(PROOF)
      confirm.mockResolvedValue(null)
      const tree = await render()
      await settle(tree)
      expect(texts(tree).join(' ')).toContain('Waiting for it to be seen')

      confirm.mockRejectedValue(refusal())
      await ReactTestRenderer.act(async () => {
        press(tree, 'Check again')
      })
      await settle(tree)
      expectKept(texts(tree).join(' '))
      expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1' })
    })

    it('the support mail carries the reference', async () => {
      const { Linking } = require('react-native') as typeof import('react-native')
      const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
      await real.savePendingPurchase(PROOF)
      confirm.mockRejectedValue(refusal())
      const tree = await render()
      await settle(tree)
      await ReactTestRenderer.act(async () => {
        press(tree, 'Send to support')
      })
      await settle(tree)
      expect(decodeURIComponent(String(open.mock.calls[0]?.[0]))).toContain('ref-1')
      open.mockRestore()
    })

    // The open's question and a Check again pressed while it is out can answer in either order. The
    // gateway's last word is on screen, and a lost network says nothing over it.
    for (const last of ['open', 'check'] as const) {
      it(`two reads of one payment, the ${last} answering last with no word on the payment`, async () => {
        await real.savePendingPurchase(PROOF)
        const answers: Array<{ ok: (v: null) => void; fail: (err: Error) => void }> = []
        confirm.mockImplementation(() => new Promise((ok, fail) => answers.push({ ok, fail })))
        const tree = await render()
        await settle(tree)
        await ReactTestRenderer.act(async () => {
          press(tree, 'Check again')
        })
        await settle(tree)
        expect(answers).toHaveLength(2)

        const [open, check] = answers as [(typeof answers)[0], (typeof answers)[0]]
        const [first, second] = last === 'open' ? [check, open] : [open, check]
        await ReactTestRenderer.act(async () => {
          first.fail(refusal())
        })
        await settle(tree)
        await ReactTestRenderer.act(async () => {
          second.fail(new Error('Network request failed'))
        })
        await settle(tree)
        expectKept(texts(tree).join(' '))
      })

      it(`two reads of one payment, the ${last} answering last that it may still clear`, async () => {
        await real.savePendingPurchase(PROOF)
        const answers: Array<{ ok: (v: null) => void; fail: (err: Error) => void }> = []
        confirm.mockImplementation(() => new Promise((ok, fail) => answers.push({ ok, fail })))
        const tree = await render()
        await settle(tree)
        await ReactTestRenderer.act(async () => {
          press(tree, 'Check again')
        })
        await settle(tree)

        const [open, check] = answers as [(typeof answers)[0], (typeof answers)[0]]
        const [first, second] = last === 'open' ? [check, open] : [open, check]
        await ReactTestRenderer.act(async () => {
          first.fail(refusal())
        })
        await settle(tree)
        await ReactTestRenderer.act(async () => {
          second.fail(refusal(false))
        })
        await settle(tree)
        const shown = texts(tree).join(' ')
        expect(shown).toContain('Waiting for it to be seen')
        expect(shown).not.toContain(KEPT)
      })
    }

    // The screen's memory of an answer ends with the process, and the proof on disk does not. With
    // no fresh answer the screen says what the gateway last said about the payment, never the wait
    // for a year a person has to sort out.
    describe('with no fresh answer', () => {
      const offline = (): void => {
        confirm.mockRejectedValue(new Error('Network request failed'))
      }

      // Unmounts the screen and mounts a new one, which knows only what is on disk.
      async function restart(tree: ReactTestRenderer.ReactTestRenderer): Promise<ReactTestRenderer.ReactTestRenderer> {
        await ReactTestRenderer.act(async () => {
          tree.unmount()
        })
        const fresh = await render()
        await settle(fresh)
        return fresh
      }

      async function expectProofIntact(): Promise<void> {
        const held = await real.loadPendingPurchase()
        expect(held).toMatchObject(PROOF)
        expect(held).not.toHaveProperty('unpaid')
      }

      for (const final of [true, undefined]) {
        it(`a refusal for good heard on opening, final ${String(final)}, outlives the process`, async () => {
          await real.savePendingPurchase(PROOF)
          confirm.mockRejectedValue(refusal(final))
          const before = await render()
          await settle(before)
          expectKept(texts(before).join(' '))

          offline()
          const tree = await restart(before)
          expectKept(texts(tree).join(' '))
          await expectProofIntact()
        })
      }

      it('a refusal for good heard after paying outlives the process', async () => {
        ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
        confirm.mockRejectedValue(refusal())
        const before = await atThePayment()
        await ReactTestRenderer.act(async () => {
          press(before, 'Pay')
        })
        await settle(before)
        expectKept(texts(before).join(' '))

        offline()
        const tree = await restart(before)
        expectKept(texts(tree).join(' '))
        expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
        expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1', amountSats: 199800 })
      })

      // A price that fails to arrive reads the slot again, and the payment the recovery filed there
      // meanwhile, refused for good, takes the screen as the gateway left it.
      it('a payment filed while the price was out shows the refusal for good it carries', async () => {
        const landed = { host: 'pay.other.com.br', reference: 'ref-9', amountSats: 199800 }
        claim.mockRejectedValue(new Error('domain_tier_not_paid'))
        quote.mockImplementationOnce(async () => {
          await real.savePendingPurchase(landed)
          await real.recordPurchaseRefusal(landed.reference, true)
          throw new Error('Network request failed')
        })
        const tree = await render()
        await type(tree, 0, 'bakery.com.br')
        await ReactTestRenderer.act(async () => {
          press(tree, 'Continue')
        })
        await settle(tree)

        const shown = texts(tree).join(' ')
        expect(shown).toContain(KEPT)
        expect(shown).toContain('Send to support')
        expect(shown).toContain('pay.other.com.br')
        expect(shown).not.toContain('Waiting for it to be seen')
        expect(confirm).not.toHaveBeenCalled()
        expect(await real.loadPendingPurchase()).toMatchObject(landed)
      })

      it('a payment that took the slot during the send shows the refusal for good it carries', async () => {
        const landed = { host: 'pay.other.com.br', reference: 'ref-9', amountSats: 199800 }
        ;(sparkConfirmSend as jest.Mock).mockImplementationOnce(async () => {
          await real.clearPendingPurchase(aQuote.reference)
          await real.savePendingPurchase(landed)
          await real.recordPurchaseRefusal(landed.reference, true)
          throw new Error('PaymentError.InsufficientFunds: not enough funds')
        })
        const tree = await atThePayment()
        await ReactTestRenderer.act(async () => {
          press(tree, 'Pay')
        })
        await settle(tree)

        const shown = texts(tree).join(' ')
        expect(shown).toContain(KEPT)
        expect(shown).toContain('pay.other.com.br')
        expect(shown).not.toContain('Waiting for it to be seen')
        expect(await real.loadPendingPurchase()).toMatchObject(landed)
      })

      it('this payment refused for good while its send failed to say anything shows that refusal', async () => {
        ;(sparkConfirmSend as jest.Mock).mockImplementationOnce(async () => {
          await real.recordPurchaseRefusal('ref-1', true)
          throw new Error('PaymentError.Generic: unexpected response')
        })
        const tree = await atThePayment()
        await ReactTestRenderer.act(async () => {
          press(tree, 'Pay')
        })
        await settle(tree)

        expectKept(texts(tree).join(' '))
        expect(await real.loadPendingPurchase()).toMatchObject({ reference: 'ref-1', amountSats: 199800 })
      })

      it('a wait heard after a refusal for good takes it back', async () => {
        await real.savePendingPurchase(PROOF)
        confirm.mockRejectedValue(refusal())
        let tree = await render()
        await settle(tree)

        confirm.mockRejectedValue(refusal(false))
        tree = await restart(tree)
        expect(texts(tree).join(' ')).toContain('Waiting for it to be seen')

        offline()
        tree = await restart(tree)
        const shown = texts(tree).join(' ')
        expect(shown).toContain('Waiting for it to be seen')
        expect(shown).toContain('Check again')
        expect(shown).not.toContain(KEPT)
        await expectProofIntact()
      })

      it('a refusal for good heard after a wait takes it over', async () => {
        await real.savePendingPurchase(PROOF)
        confirm.mockRejectedValue(refusal(false))
        let tree = await render()
        await settle(tree)
        expect(texts(tree).join(' ')).toContain('Waiting for it to be seen')

        confirm.mockRejectedValue(refusal())
        await ReactTestRenderer.act(async () => {
          press(tree, 'Check again')
        })
        await settle(tree)

        offline()
        tree = await restart(tree)
        expectKept(texts(tree).join(' '))
        await expectProofIntact()
      })

      it('a grant drops the proof', async () => {
        await real.savePendingPurchase(PROOF)
        confirm.mockRejectedValue(refusal())
        const before = await render()
        await settle(before)

        confirm.mockResolvedValue(GRANTED)
        claim.mockResolvedValue({
          host: 'pay.bakery.com.br',
          provider: 'generic',
          supportsRoot: false,
          isRoot: false,
          target: 'saas.usevoltz.app',
          state: 'awaiting_dns',
        })
        const tree = await restart(before)
        expect(texts(tree).join(' ')).not.toContain(KEPT)
        expect(await RNFS.exists(FILE)).toBe(false)
      })
    })
  })
})

// LUD-16 restricts the local part to [a-z0-9._-], so a language keeps its own word for the sample only
// where that word fits, and the languages in another alphabet keep a Latin one, which locales.test.ts
// holds for every locale.
it('previews a sample address the language reads and the server can register', async () => {
  const english = await render()
  await type(english, 0, 'bakery.com.br')
  const shownInEnglish = texts(english).filter(line => line.includes('@bakery.com.br'))
  expect(shownInEnglish.length).toBeGreaterThan(0)

  await i18n.changeLanguage('pt-BR')
  try {
    const portuguese = await render()
    await type(portuguese, 0, 'bakery.com.br')
    const shownInPortuguese = texts(portuguese).filter(line => line.includes('@bakery.com.br'))
    expect(shownInPortuguese).toEqual(shownInEnglish.map(line => line.replace('name@', 'nome@')))
    for (const line of shownInPortuguese) {
      expect(validateUsername(line.split('@')[0]!)).toBe(true)
    }
  } finally {
    await i18n.changeLanguage('en-US')
  }

  for (const line of shownInEnglish) {
    expect(validateUsername(line.split('@')[0]!)).toBe(true)
  }
})

it('says the root already answers before taking the money, not after', async () => {
  // The choice between root and subdomain is made before anything has been asked of the gateway,
  // and the fact that decides it is whether a site already answers there. So it arrives before the
  // year is bought, not on the DNS step, where going back costs what was paid.
  const refusal = Object.assign(new Error('domain_tier_not_paid'), {
    facts: { provider: 'cloudflare', supportsRoot: true, isRoot: false, rootOccupied: true },
  })
  claim.mockRejectedValue(refusal)
  quote.mockResolvedValue({
    host: 'bakery.com.br',
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'r-1',
    expiresAt: 1_800_000_000,
  })

  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  press(tree, 'name@bakery.com.br')
  await settle(tree)

  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)

  expect(texts(tree).join(' ')).toContain('already points somewhere today')
  // The fact arrives before any price is quoted.
  expect(quote).not.toHaveBeenCalled()
  expect(occupiedBox(tree)).toMatchObject(WARNING_BOX)
})

it('lets the second press through, because the fact was the thing they were missing', async () => {
  // Somebody whose root serves a site is not making a mistake. Warned once and blocked forever, the
  // customer who does know what they are doing has no way to buy the thing they came for.
  claim.mockRejectedValue(
    Object.assign(new Error('domain_tier_not_paid'), {
      facts: { supportsRoot: true, isRoot: false, rootOccupied: true },
    }),
  )
  quote.mockResolvedValue({
    host: 'bakery.com.br',
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'r-1',
    expiresAt: 1_800_000_000,
  })

  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  press(tree, 'name@bakery.com.br')
  await settle(tree)
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)

  expect(quote).toHaveBeenCalled()
})

it('says nothing about a root nobody measured, and does not stand in the way', async () => {
  // Absent is unmeasured. A silence read as "free" would be the same blind purchase with an extra
  // step, and a silence read as "busy" would warn every customer whose DNS did not answer in time.
  claim.mockRejectedValue(
    Object.assign(new Error('domain_tier_not_paid'), { facts: { supportsRoot: true } }),
  )
  quote.mockResolvedValue({
    host: 'bakery.com.br',
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'r-1',
    expiresAt: 1_800_000_000,
  })

  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  press(tree, 'name@bakery.com.br')
  await settle(tree)
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)

  expect(texts(tree).join(' ')).not.toContain('already points somewhere today')
  expect(quote).toHaveBeenCalled()
})

it('leaves the subdomain alone, since a name picked for this is theirs to repoint', async () => {
  claim.mockRejectedValue(
    Object.assign(new Error('domain_tier_not_paid'), {
      facts: { supportsRoot: true, isRoot: false, rootOccupied: true },
    }),
  )
  quote.mockResolvedValue({
    host: 'bakery.com.br',
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'r-1',
    expiresAt: 1_800_000_000,
  })

  const tree = await render()
  await type(tree, 0, 'bakery.com.br')
  // The subdomain is the default, so this is the common path and nothing should change on it.
  await ReactTestRenderer.act(async () => {
    press(tree, 'Continue')
  })
  await settle(tree)

  expect(texts(tree).join(' ')).not.toContain('already points somewhere today')
  expect(quote).toHaveBeenCalled()
})
