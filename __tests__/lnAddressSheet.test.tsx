import React, { useLayoutEffect } from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState, I18nManager, Linking, StyleSheet, Text, TextInput } from 'react-native'
import i18n from '../src/i18n'
import { LnAddressSheet } from '../src/components/LnAddressSheet'
import {
  sparkCheckLnAddress,
  sparkConfirmSend,
  sparkGetLnAddress,
  sparkRegisterLnAddress,
  sparkDeleteLnAddress,
} from '../src/wallet/spark'
import { formatSats } from '../src/wallet/amount'
import { formatDate, formatTime } from '../src/wallet/history'
import { deviceDateTimePrefs } from '../src/wallet/deviceLocale'
import fs from 'fs'
import { join } from 'path'
import { ConfirmBody } from '../src/components/ConfirmSheet'
import { Sheet } from '../src/components/Sheet'
import { answerQuestion, question } from './support/question'
import { ReceiveHeldByExit, SpendHeldByExit, walletErrorKey } from '../src/wallet/errors'

const en = JSON.parse(fs.readFileSync(join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as {
  store: Record<string, string>
  withdrawal: Record<string, string>
}

jest.mock('../src/wallet/spark', () => ({
  // The purchase reads the domain the session is on, so the double has to answer it.
  connectedLnurlDomain: jest.fn(() => undefined),
  sparkGetLnAddress: jest.fn(async () => null),
  sparkCheckLnAddress: jest.fn(async () => true),
  sparkRegisterLnAddress: jest.fn(),
  sparkTakeLnAddress: jest.fn((username: string, walletId?: string) =>
    (require('./support/takeLnAddress') as typeof import('./support/takeLnAddress')).takeLnAddress(username, walletId),
  ),
  sparkDeleteLnAddress: jest.fn(async () => undefined),
  // The session's wallet, the one the registry answers here, which a sweep's take must be asked for.
  sparkConnectedWalletId: jest.fn(() => 'primary'),
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkPrepareSend: jest.fn(async () => ({ handle: 'h-1', amount: 19800, fee: 0 })),
  sparkConfirmSend: jest.fn(async () => 'complete'),
}))

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'lnurl.usevoltz.app', getDistribution: () => 'direct' }))

jest.mock('../src/wallet/namePurchase', () => {
  const real = jest.requireActual('../src/wallet/namePurchase')
  return { ...real, quoteName: jest.fn(), confirmName: jest.fn() }
})

const quote = jest.requireMock('../src/wallet/namePurchase').quoteName as jest.Mock
const confirm = jest.requireMock('../src/wallet/namePurchase').confirmName as jest.Mock

const RNFS = (require('react-native-fs') as {
  default: {
    DocumentDirectoryPath: string
    exists(p: string): Promise<boolean>
    unlink(p: string): Promise<void>
    writeFile(p: string, c: string, e: string): Promise<void>
  }
}).default

const purchase = jest.requireActual('../src/wallet/purchase') as typeof import('../src/wallet/purchase')
const lines = jest.requireActual('../src/wallet/releasedLines') as typeof import('../src/wallet/releasedLines')
const registry = jest.requireActual('../src/wallet/walletRegistry') as typeof import('../src/wallet/walletRegistry')
const STORE = `${RNFS.DocumentDirectoryPath}/purchases.json`
const UNKEYED = `${RNFS.DocumentDirectoryPath}/purchase-name.json`
// The list of lines no view has shown, which also remembers what was shown, so no case inherits it.
const LINES_FILE = `${RNFS.DocumentDirectoryPath}/released-lines.json`

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

// The gateway's answer to a paid confirmation it cannot grant. `final` absent is what a year and a
// gateway older than the field send.
function paidRefusal(final?: boolean): Error {
  return Object.assign(new Error('paid_but_not_granted'), final === undefined ? {} : { final })
}

// The kept refusal's line, read from the locale so a reworded line does not pass by accident.
const KEPT = (JSON.parse(fs.readFileSync(join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as {
  recover: Record<string, string>
}).recover.blockedBody!

async function render(
  onRegistered: (addr: unknown) => void = jest.fn(),
  domain?: string,
  namesFree?: boolean,
  domainFrozen?: boolean,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <LnAddressSheet
        visible
        domain={domain}
        namesFree={namesFree}
        domainFrozen={domainFrozen}
        onClose={jest.fn()}
        onRegistered={onRegistered}
      />,
    )
  })
  return tree
}

async function type(tree: ReactTestRenderer.ReactTestRenderer, value: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText(value)
  })
}

// Real timers here, so settling means waiting past the 400ms availability debounce.
async function settle(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 450))
  })
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const btn = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === label))
  if (!btn) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    btn.props.onPress()
  })
  await ReactTestRenderer.act(async () => {
    await Promise.resolve()
  })
}

beforeEach(async () => {
  jest.clearAllMocks()
  jest.mocked(sparkCheckLnAddress).mockResolvedValue(true)
  // clearAllMocks clears calls, not implementations, so a send forced to fail in one test would
  // still be failing in the next.
  ;(jest.requireMock('../src/wallet/spark').sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
  ;(jest.requireMock('../src/wallet/spark').sparkPrepareSend as jest.Mock).mockResolvedValue({
    handle: 'h-1',
    amount: 19800,
    fee: 0,
  })
  quote.mockResolvedValue({
    username: 'alice',
    priceUsdCents: 990,
    amountSats: 19800,
    invoice: 'lnbc1',
    reference: 'ref-1',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })
  confirm.mockResolvedValue(true)
  for (const path of [STORE, UNKEYED, LINES_FILE, `${LINES_FILE}.tmp`, `${LINES_FILE}.unreadable`]) {
    if (await RNFS.exists(path)) {
      await RNFS.unlink(path)
    }
  }
})

// A name is bought before it is claimed: the price is shown first, and only a payment that settled
// reaches the register.
test('shows the price, then registers once it is paid', async () => {
  const onRegistered = jest.fn()
  jest.mocked(sparkRegisterLnAddress).mockResolvedValue({
    username: 'alice',
    address: 'alice@breez.tips',
    lnurl: 'lnurl1abc',
  })
  const tree = await render(onRegistered)

  await type(tree, 'alice')
  await settle()
  expect(sparkCheckLnAddress).toHaveBeenCalledWith('alice')
  expect(texts(tree).join(' ')).toContain('Available')

  await press(tree, 'See the price')
  expect(texts(tree).join(' ')).toContain(`alice costs ${formatSats(19_800)} sats`)
  // Above Pay, the sats rail's way to cancel, which is the one that gives the sats back.
  expect(texts(tree)).toContain(en.withdrawal.payLineSats)
  expect(texts(tree)).not.toContain(en.withdrawal.payLineApple)
  // Nothing is claimed before it is paid for.
  expect(sparkRegisterLnAddress).not.toHaveBeenCalled()

  await press(tree, 'Pay and take the name')

  // The change is one call. Freeing the current address first gives up the old name before the new
  // one exists, so a failed register leaves the wallet with none.
  expect(sparkDeleteLnAddress).not.toHaveBeenCalled()
  expect(sparkRegisterLnAddress).toHaveBeenCalledWith('alice', undefined, 'primary')
  expect(onRegistered).toHaveBeenCalledWith({
    username: 'alice',
    address: 'alice@breez.tips',
    lnurl: 'lnurl1abc',
  })
})

test('two taps on the price in one batch mint one invoice', async () => {
  // The helper above wraps each press in its own act, which is not the case that bites: `busy` is
  // state, and a second tap landing before it reaches the button reads a copy that still says
  // false. Both presses go inside one act here on purpose, because that is the double press a
  // person actually produces, and each one mints a real invoice from the treasury.
  const tree = await render(jest.fn())
  await type(tree, 'alice')
  await settle()

  const btn = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === 'See the price'))
  await ReactTestRenderer.act(async () => {
    btn!.props.onPress()
    btn!.props.onPress()
  })
  await settle()

  expect(quote).toHaveBeenCalledTimes(1)
})

test('closing on an unpaid price leaves somebody else\'s proof of payment alone', async () => {
  // The slot is shared: the recovery sweep files a proof there for any charge the gateway says is
  // owed, and it may belong to a purchase this sheet never made. Closing names the quote's own
  // reference, because `awaiting?.reference` is undefined on this branch, since a quote nobody paid
  // leaves nothing awaiting, and an undefined reference drops whatever the slot holds.
  const tree = await render(jest.fn())
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  // Filed while the sheet is open, which is when the recovery sweep runs and files a proof for any
  // charge the gateway says is owed. Filed before the sheet opened it would be offered for resuming
  // instead, which is a different path with its own test.
  await purchase.savePending({ kind: 'name', subject: 'bob', reference: 'ref-somebody-else', amountSats: 19800 })

  const backdrop = tree.root.findAll(n => n.props.accessibilityLabel === 'Back')[0]
  await ReactTestRenderer.act(async () => {
    backdrop!.props.onPress()
  })
  await settle()

  const held = await purchase.loadPending('name')
  expect(held?.reference).toBe('ref-somebody-else')
})

test('a send that failed outright neither claims nor blames the wallet', async () => {
  jest.mocked(sparkConfirmSend).mockResolvedValue('failed')
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  expect(texts(tree).join(' ')).toContain('did not go through')
  expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
  expect(onRegistered).not.toHaveBeenCalled()
})

// spark.ts refuses the confirm while an emergency exit holds the wallet, after the proof was promoted,
// and the purchase drops that proof as never sent. The buyer is told why the payment did not go.
test.each([['exit', 'exitHeld'] as const, ['unread', 'exitHeldUnread'] as const])(
  'a payment an exit holds (%s) says why and keeps no proof',
  async (hold, code) => {
    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(new SpendHeldByExit(hold))
    const tree = await render()
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await press(tree, 'Pay and take the name')

    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
    const shown = texts(tree).join(' ')
    expect(shown).toContain(i18n.t(walletErrorKey(code)))
    // Nothing left, so the quote stays on screen, unpaid, for when the exit is over.
    expect(shown).toContain(`alice costs ${formatSats(19_800)} sats`)
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    expect(await purchase.loadPending('name')).toBeNull()
  },
)

// The money has already left on this path, so a confirmation that has not landed yet is a wait, not
// a failure. It replaces the price step: leaving the price and the pay button on screen under a line
// saying the payment already went is what invites paying twice.
test('a payment not yet seen becomes a wait, not another chance to pay', async () => {
  confirm.mockResolvedValue(false)
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Payment made')
  expect(shown).toContain('Check again')
  expect(shown).not.toContain('costs')
  expect(shown).not.toContain('Pay and take the name')
  expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
  // The proof stays on disk precisely because the purchase is unfinished.
  expect(await purchase.loadPending('name')).not.toBeNull()
})

// Checking again is the whole point of the state, so it has to finish the purchase without asking
// for money a second time.
test('checking again finishes the purchase without paying twice', async () => {
  confirm.mockResolvedValue(false)
  jest.mocked(sparkRegisterLnAddress).mockResolvedValue({
    username: 'alice',
    address: 'alice@breez.tips',
    lnurl: 'lnurl1abc',
  })
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  const callsBefore = jest.mocked(sparkConfirmSend).mock.calls.length
  confirm.mockResolvedValue(true)
  await press(tree, 'Check again')

  expect(onRegistered).toHaveBeenCalled()
  // Nothing is sent a second time, because the money already left the first time.
  expect(jest.mocked(sparkConfirmSend).mock.calls.length).toBe(callsBefore)
})

test('does not offer a price for a name on a domain the customer already paid for', async () => {
  // The year on this domain is paid and the name is free, so pressing registers directly. A button
  // saying "See the price" there lies about what the press does, and reads as a second charge
  // coming.
  const tree = await render(jest.fn(), 'example.com', true)
  await type(tree, 'satoshi')
  await settle()

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Use this name')
  expect(shown).not.toContain('See the price')
})

test('shows the domain suffix so the full address reads as one line', async () => {
  const tree = await render(jest.fn(), 'breez.tips')

  expect(texts(tree).join('')).toContain('@breez.tips')
})

test('rejects an invalid username without hitting the server', async () => {
  const tree = await render()

  await type(tree, 'Alice!!') // uppercase normalizes away, leaving "!" as the only LUD-16 violation
  await settle()

  expect(sparkCheckLnAddress).not.toHaveBeenCalled()
  expect(texts(tree).join(' ')).toContain('Use letters')
})

test('does not call a name taken when the domain is what is paused', async () => {
  // A frozen domain refuses every name, and the refusal reaches the app as the same boolean a taken
  // name produces. Calling a free name taken there sends the customer off to invent worse names
  // when the one thing that helps is renewing.
  jest.mocked(sparkCheckLnAddress).mockResolvedValue(false)
  const tree = await render(jest.fn(), 'example.com', false, true)

  await type(tree, 'teste33333')
  await settle()

  const shown = texts(tree).join(' ')
  expect(shown).toContain('This domain is paused')
  expect(shown).not.toContain('Already taken')
})

test('shows when a username is taken and does not register it', async () => {
  jest.mocked(sparkCheckLnAddress).mockResolvedValue(false)
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)

  await type(tree, 'taken')
  await settle()

  expect(texts(tree).join(' ')).toContain('Already taken')
  // A taken name is never quoted, so nothing is ever charged for one.
  expect(
    tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .some(n => n.findAllByType(Text).some(t => t.props.children === 'See the price') && !n.props.disabled),
  ).toBe(false)
  expect(quote).not.toHaveBeenCalled()
  expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
  expect(onRegistered).not.toHaveBeenCalled()
})

test('says the check could not run instead of going quiet with a dead button', async () => {
  // A check that throws must not land in the same state as nothing typed: no message, and a button
  // that does not respond, which reads as the app being broken rather than as something to retry.
  jest.mocked(sparkCheckLnAddress).mockRejectedValue(new Error('SdkError.NetworkError'))
  const tree = await render()

  await type(tree, 'carol')
  await settle()

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Could not check')
  // Not the same thing as taken, which would tell them to pick another name for no reason.
  expect(shown).not.toContain('Already taken')
  expect(quote).not.toHaveBeenCalled()

  // The retry is what makes the message worth showing: the usual cause passes on a second try.
  jest.mocked(sparkCheckLnAddress).mockResolvedValue(true)
  await press(tree, 'Try again')
  await settle()
  expect(texts(tree).join(' ')).toContain('Available')
})

test('a failed change never costs the wallet the address it already had', async () => {
  const onRegistered = jest.fn()
  const tree = await render(onRegistered, 'breez.tips')
  jest.mocked(sparkCheckLnAddress).mockResolvedValue(true)
  jest.mocked(sparkRegisterLnAddress).mockRejectedValue(new Error('name taken'))

  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  // Nothing is released, so the wallet still answers at the address it holds.
  expect(sparkDeleteLnAddress).not.toHaveBeenCalled()
  expect(onRegistered).not.toHaveBeenCalled()
})

// A purchase left unfinished by a crash or a lost network in the seconds after paying. Picked up
// when the sheet opens, so the buyer is never charged twice for the same name.
test('picks up a name already paid for and finishes claiming it', async () => {
  await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
  jest.mocked(sparkRegisterLnAddress).mockResolvedValue({
    username: 'alice',
    address: 'alice@breez.tips',
    lnurl: 'lnurl1abc',
  })
  const onRegistered = jest.fn()
  await render(onRegistered)
  await settle()

  expect(confirm).toHaveBeenCalledWith(expect.anything(), 'alice', 'ref-1')
  expect(quote).not.toHaveBeenCalled()
  expect(sparkRegisterLnAddress).toHaveBeenCalledWith('alice', undefined, 'primary')
  expect(onRegistered).toHaveBeenCalled()
  expect(await purchase.loadPending('name')).toBeNull()
})

// On a domain the customer bought there is nothing left to sell, so charging there would be selling
// somebody something they already own.
test('a name on a customer domain is taken directly, without a price step', async () => {
  quote.mockRejectedValue(new Error('free_on_this_domain'))
  jest.mocked(sparkRegisterLnAddress).mockResolvedValue({
    username: 'bakery',
    address: 'bakery@pay.example.com',
    lnurl: 'lnurl1abc',
  })
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)
  await type(tree, 'bakery')
  await settle()
  await press(tree, 'See the price')

  expect(sparkRegisterLnAddress).toHaveBeenCalledWith('bakery', undefined, 'primary')
  expect(onRegistered).toHaveBeenCalled()
  expect(texts(tree).join(' ')).not.toContain('costs')
})

// A server string is untranslated, written for an operator, and reads to a person as though the app
// broke, so it never reaches the screen verbatim.
test('an unrecognised refusal is not shown to the user raw', async () => {
  quote.mockRejectedValue(new Error('some_internal_code_nobody_reads'))
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  const all = texts(tree).join(' ')
  expect(all).not.toContain('some_internal_code_nobody_reads')
  expect(all).toContain('Could not create the address')
})

// The gateway answers this after the payment, never before it, so the money has already left and
// telling the buyer nothing was charged would be false. With `final: false` another wallet's
// reservation is in the way and a later confirmation may still grant the name, so it is a wait with a
// way forward, not a failure.
test('a refusal after the payment that may still clear is a wait, not a claim that nothing was charged', async () => {
  confirm.mockRejectedValue(paidRefusal(false))
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  const all = texts(tree).join(' ')
  expect(all).toContain('Payment made')
  expect(all).toContain('Check again')
  expect(all).not.toContain('Could not create')
  expect(all).not.toContain('Send to support')
})

// The pending proof outlives the sheet. Discarding it on close sells the buyer the same name twice.
test('closing the sheet never discards a payment already made', async () => {
  await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
  confirm.mockResolvedValue(false)
  const onClose = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <LnAddressSheet visible domain="lnurl.usevoltz.app" onClose={onClose} onRegistered={jest.fn()} />,
    )
  })
  await settle()

  const backdrop = tree.root.findAll(n => typeof n.props.onPress === 'function')[0]!
  await ReactTestRenderer.act(async () => {
    backdrop.props.onPress()
  })
  await ReactTestRenderer.act(async () => {
    await Promise.resolve()
  })
  expect(await purchase.loadPending('name')).not.toBeNull()
})

// The gateway caps how often one wallet may move its address. The refusal has to read as a rule
// with a date attached, not as a failure to retry into.
test('a wallet that already changed today is told when it can change again', async () => {
  quote.mockRejectedValue(new Error('change_limit_reached'))
  const tree = await render(jest.fn())

  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  const shown = texts(tree).join(' ')
  expect(shown).toContain('You already changed your address today')
  expect(shown).not.toContain('change_limit_reached')
})

// An address given up on this device holds every purchase until "Create the address again", which
// only the address screen offers. The generic failure would send the buyer to try again into the
// same stop.
test('a wallet whose address was given up here is pointed to the way back', async () => {
  quote.mockRejectedValue(new Error('address_removed'))
  const tree = await render(jest.fn())

  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  const shown = texts(tree).join(' ')
  expect(shown).toContain('first tap Create the address again on the Lightning address screen')
  expect(shown).not.toContain('Could not create the address')
})

// The gateway refuses the quote before any invoice when another wallet already paid for the name.
// The name is taken, and a generic failure would send the buyer to try the same name again.
test('a name another wallet already paid for reads as taken', async () => {
  quote.mockRejectedValue(new Error('name_paid_by_another_wallet'))
  const tree = await render(jest.fn())

  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Already taken')
  expect(shown).not.toContain('name_paid_by_another_wallet')
  expect(shown).not.toContain('Could not create the address')
})

// A wallet that paid a store credit for the name holds it while that register resolves, and the
// gateway says when the hold clears (`retry_at`). The name is on hold until then, not taken.
test('a name held for a store credit reads as on hold until the second it clears', async () => {
  const clears = Math.floor(Date.now() / 1000) + 120
  quote.mockRejectedValue(Object.assign(new Error('name_held_for_credit'), { retryAt: clears }))
  const tree = await render(jest.fn())

  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  const shown = texts(tree)
  const prefs = deviceDateTimePrefs()
  const today = new Date(clears * 1000).toDateString() === new Date().toDateString()
  const time = today ? formatTime(clears, prefs) : `${formatDate(clears, prefs)} ${formatTime(clears, prefs)}`
  expect(shown).toContain(en.store.heldTryLater!.split('{{name}}').join('alice').split('{{time}}').join(time))
  expect(shown).not.toContain('Already taken')
})

// A name with no price is registered directly. Refused while another wallet holds it, the register
// says when the hold clears, as a quote's refusal does, rather than that the address failed.
test('a free name whose register is held says when', async () => {
  const clears = Math.floor(Date.now() / 1000) + 120
  quote.mockRejectedValue(new Error('free_name'))
  jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(
    Object.assign(new Error('SdkError.NetworkError'), {
      tag: 'NetworkError',
      inner: [`network request failed with status 409: {"error":"held_by_another_wallet","retry_at":${clears}}`],
    }),
  )
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await settle()

  const shown = texts(tree).join(' ')
  expect(shown).toContain('alice is on hold until')
  expect(shown).not.toContain('Could not create the address')
  expect(onRegistered).not.toHaveBeenCalled()
})

// The LNURL server's refusal of a register as SDK 0.27.2 throws it on React Native: the message is only
// the class name, and the status and the gateway's body ride in inner[0].
function serverRefusal(status: number, body: string): Error {
  return Object.assign(new Error('SdkError.NetworkError'), {
    tag: 'NetworkError',
    inner: Object.freeze([`network request failed with status ${status}: ${body}`]),
  })
}

const CHANGE_LIMIT = 'You already changed your address today. You can change it again tomorrow.'

// A domain the customer owns has no price and no quota at the gateway, so the server's own daily
// limit on registers is the refusal that owner meets, and it is the gateway's code in the body.
test('a free name refused for the daily change limit says so, not that the address failed', async () => {
  quote.mockRejectedValue(new Error('free_on_this_domain'))
  jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(serverRefusal(429, '{"error":"change_limit_reached"}'))
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await settle()

  const shown = texts(tree).join(' ')
  expect(shown).toContain(CHANGE_LIMIT)
  expect(shown).not.toContain('Could not create the address')
  expect(shown).not.toContain('SdkError')
  expect(onRegistered).not.toHaveBeenCalled()
})

// A body that is not the gateway's JSON, such as an edge page, names no refusal and gets the fallback.
test('a register refused with a body that is not the gateway\'s reads as the address failing', async () => {
  quote.mockRejectedValue(new Error('free_name'))
  jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(serverRefusal(502, '<html>Bad gateway</html>'))
  const tree = await render(jest.fn())
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await settle()

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Could not create the address')
  expect(shown).not.toContain('Bad gateway')
})

// After the payment the proof stays and the sheet waits on it, and the line says why the register
// was refused rather than the general one.
test('a paid name whose register meets the daily change limit says so and keeps the proof', async () => {
  jest.mocked(sparkRegisterLnAddress).mockRejectedValue(serverRefusal(429, '{"error":"change_limit_reached"}'))
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  expect(texts(tree).join(' ')).toContain(CHANGE_LIMIT)
  expect(await purchase.loadPending('name')).not.toBeNull()
})

// The line names a time that passes, and a closed sheet waits on nothing. Opened again, the sheet
// reads the name afresh rather than repeating a line about an earlier press.
test('a line about a hold does not survive closing and opening the sheet', async () => {
  const clears = Math.floor(Date.now() / 1000) + 120
  quote.mockRejectedValue(Object.assign(new Error('name_held_for_credit'), { retryAt: clears }))
  const tree = await render(jest.fn())
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  expect(texts(tree).join(' ')).toContain('alice is on hold')

  await reopen(tree)
  const shown = texts(tree).join(' ')
  expect(shown).not.toContain('alice is on hold')
  expect(shown).toContain('See the price')
})

// Without the second it clears there is nothing to say about when, and somebody else has the name.
test('a name held for a store credit with no time reads as taken', async () => {
  quote.mockRejectedValue(new Error('name_held_for_credit'))
  const tree = await render(jest.fn())

  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  expect(texts(tree)).toContain('Already taken')
})

// See the price answers for the name typed at the press. Once the field shows another, that answer
// is about a name nobody is looking at, and a price left on screen would charge for it.
describe('an answer to See the price that lands after another name was typed', () => {
  async function askThenRetype(answer: Promise<unknown>): Promise<ReactTestRenderer.ReactTestRenderer> {
    let land!: () => void
    const landed = new Promise<void>(resolve => (land = resolve))
    quote.mockImplementationOnce(async () => {
      await landed
      return answer
    })
    const tree = await render(jest.fn())
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    expect(quote).toHaveBeenCalledWith(expect.anything(), 'alice')
    await type(tree, 'bobby')
    await settle()
    await ReactTestRenderer.act(async () => {
      land()
    })
    await settle()
    expect(tree.root.findByType(TextInput).props.value).toBe('bobby')
    return tree
  }

  test('a held line lands nowhere', async () => {
    const clears = Math.floor(Date.now() / 1000) + 120
    const held = Promise.reject(Object.assign(new Error('name_held_for_credit'), { retryAt: clears }))
    held.catch(() => undefined)
    const tree = await askThenRetype(held)
    expect(texts(tree).filter(s => s.includes('alice'))).toEqual([])
    expect(texts(tree)).toContain('See the price')
  })

  test('a price lands nowhere, and nothing offers to pay for it', async () => {
    const tree = await askThenRetype(
      Promise.resolve({
        username: 'alice',
        priceUsdCents: 990,
        amountSats: 19800,
        invoice: 'lnbc1',
        reference: 'ref-1',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      }),
    )
    expect(texts(tree).filter(s => s.includes('alice'))).toEqual([])
    expect(texts(tree)).not.toContain('Pay and take the name')
    expect(texts(tree)).toContain('See the price')
  })
})

// A string like `SdkError.NetworkError` is untranslated, written for an operator, and reads to the
// person holding the phone as though the app broke. Nothing raw reaches the screen.
test('an SDK failure is shown as a message, never as its own error string', async () => {
  quote.mockRejectedValue(new Error('SdkError.NetworkError'))
  const tree = await render(jest.fn())

  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  const shown = texts(tree).join(' ')
  expect(shown).not.toContain('SdkError')
  expect(shown).toContain('Could not create the address')
})

// The quote says free and the register says pay, which is the two sides disagreeing about one name.
// A flat "could not create the address" leaves the buyer nothing to act on, when the answer is that
// the name has a price.
// An exit's hold refuses the register in spark.ts before the SDK is asked, on the wallet in front, and
// says so with the Receive lines rather than the address failing.
test.each([
  ['exit', 'emergencyExit.receiveHeld'],
  ['unread', 'emergencyExit.receiveHeldUnread'],
] as const)('a free name whose register an exit holds (%s) says why', async (hold, key) => {
  quote.mockRejectedValue(new Error('free_name'))
  jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(new ReceiveHeldByExit(hold))
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await settle()

  const shown = texts(tree)
  expect(shown).toContain(i18n.t(key))
  expect(shown.join(' ')).not.toContain('Could not create the address')
  expect(onRegistered).not.toHaveBeenCalled()
})

test('a name the server charges for says so, instead of a flat failure', async () => {
  quote.mockRejectedValue(new Error('free_name'))
  jest.mocked(sparkRegisterLnAddress).mockRejectedValue(new Error('payment_required'))
  const tree = await render(jest.fn())

  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  const shown = texts(tree).join(' ')
  expect(shown).toContain('This name has a price')
  expect(shown).not.toContain('payment_required')
})

// The address the generator hands out is free to claim, so the sheet must not put a price on one.
test('a name the generator could have produced is taken, not sold', async () => {
  quote.mockRejectedValue(new Error('free_name'))
  jest.mocked(sparkRegisterLnAddress).mockResolvedValue({
    username: 'swiftotter42',
    address: 'swiftotter42@usevoltz.app',
    lnurl: 'lnurl1abc',
  })
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)
  await type(tree, 'swiftotter42')
  await settle()
  await press(tree, 'See the price')

  expect(sparkRegisterLnAddress).toHaveBeenCalledWith('swiftotter42', undefined, 'primary')
  expect(onRegistered).toHaveBeenCalled()
  expect(texts(tree).join(' ')).not.toContain('costs')
})

// The register can fail after the money has already been taken. If the record went with the payment
// the buyer would be left with an entitlement nothing can reach, looking at a button offering to
// charge again.
test('a register that fails after paying keeps the proof of the purchase', async () => {
  jest.mocked(sparkRegisterLnAddress).mockRejectedValue(new Error('SdkError.NetworkError'))
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  expect(await purchase.loadPending('name')).not.toBeNull()
})

test('the proof is dropped only once the name exists', async () => {
  jest.mocked(sparkRegisterLnAddress).mockResolvedValue({
    username: 'alice',
    address: 'alice@breez.tips',
    lnurl: 'lnurl1abc',
  })
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  expect(await purchase.loadPending('name')).toBeNull()
})

// The sheet's own delivery clears the proof as delivered for its reference, so a view waiting on it
// shows the address rather than offering the name again. Heard through a listener, since every view on
// screen takes a delivered clear and a gone one alike for this sheet's own wait. Both ways a paid name
// reaches the wallet clear the same way: registered now, or already on it from an interrupted purchase.
describe("the sheet's own delivery", () => {
  const ALICE = { username: 'alice', address: 'alice@breez.tips', lnurl: 'lnurl1abc' }

  // clearAllMocks keeps implementations, and the cases after these open on a wallet with no address.
  afterEach(() => {
    jest.mocked(sparkGetLnAddress).mockImplementation(async () => null)
  })

  async function hearing(deliver: () => Promise<void>): Promise<[string, string, string][]> {
    const heard: [string, string, string][] = []
    const off = purchase.onPendingGone((kind, reference, reason) => heard.push([kind, reference, reason]))
    try {
      await deliver()
    } finally {
      off()
    }
    return heard
  }

  it('a name registered after its payment tells the views it was delivered', async () => {
    jest.mocked(sparkRegisterLnAddress).mockResolvedValue(ALICE)
    const onRegistered = jest.fn()
    const heard = await hearing(async () => {
      const tree = await render(onRegistered)
      await type(tree, 'alice')
      await settle()
      await press(tree, 'See the price')
      await press(tree, 'Pay and take the name')
    })
    expect(onRegistered).toHaveBeenCalledWith(ALICE)
    expect(heard).toEqual([['name', 'ref-1', 'granted']])
  })

  it('a paid name already on the wallet tells the views it was delivered', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 900 })
    jest.mocked(sparkGetLnAddress).mockResolvedValue(ALICE)
    const onRegistered = jest.fn()
    const heard = await hearing(async () => {
      await render(onRegistered)
    })
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    expect(onRegistered).toHaveBeenCalledWith(ALICE)
    expect(heard).toEqual([['name', 'ref-1', 'granted']])
  })
})

// A purchase whose register failed leaves the name paid for. The wallet owns it, so the sheet takes
// it instead of showing a price again.
test('a name already paid for is taken, not charged twice', async () => {
  quote.mockRejectedValue(new Error('already_paid'))
  jest.mocked(sparkRegisterLnAddress).mockResolvedValue({
    username: 'bakery',
    address: 'bakery@usevoltz.app',
    lnurl: 'lnurl1abc',
  })
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)
  await type(tree, 'bakery')
  await settle()
  await press(tree, 'See the price')

  expect(sparkRegisterLnAddress).toHaveBeenCalledWith('bakery', undefined, 'primary')
  expect(onRegistered).toHaveBeenCalled()
  expect(texts(tree).join(' ')).not.toContain('costs')
})

// A price belongs to the name it was asked for. Editing the field after seeing one and leaving the
// price on screen offers to charge for a name other than the one being shown.
test('editing the name drops the price quoted for the old one', async () => {
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  expect(texts(tree).join(' ')).toContain('costs')

  await type(tree, 'alicia')
  await settle()

  const shown = texts(tree).join(' ')
  expect(shown).not.toContain('costs')
  expect(shown).not.toContain('Pay and take the name')
})

// A purchase interrupted after the server took the name leaves a record for work already done.
// Registering it again counts as another change and is refused, putting an error on a purchase that
// worked and never letting the record go.
test('a purchase whose name already landed is finished, not registered again', async () => {
  await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 900 })
  confirm.mockResolvedValue(true)
  jest.mocked(sparkGetLnAddress).mockResolvedValue({
    username: 'alice',
    address: 'alice@breez.tips',
    lnurl: 'lnurl1abc',
  })
  const onRegistered = jest.fn()
  await render(onRegistered)

  expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
  expect(onRegistered).toHaveBeenCalled()
  expect(await purchase.loadPending('name')).toBeNull()
})

// An outage is not a refused name. Telling the buyer the address could not be created sends them
// off to pick another one that will fail exactly the same way.
test('a treasury outage says the shop is shut, not that the name failed', async () => {
  quote.mockRejectedValue(new Error('treasury_unavailable'))
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Buying is not available right now')
  expect(shown).not.toContain('Could not create the address')
})

// The payment is made and the gateway cannot be reached. Forgetting it here puts the price step
// back on screen, where the only button mints a second invoice for a name already paid for,
// and no part of the service can hand money back.
test('a purchase that cannot be finished stays a purchase, not another price', async () => {
  await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
  confirm.mockRejectedValue(new Error('SdkError.NetworkError'))
  const tree = await render()
  await settle()

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Payment made')
  expect(shown).toContain('Check again')
  expect(shown).not.toContain('See the price')
  expect(shown).not.toContain('Could not create the address')
  expect(quote).not.toHaveBeenCalled()
  expect(await purchase.loadPending('name')).not.toBeNull()
})

// The gateway holds no charge of this wallet under that reference, so this wallet cannot finish it.
// Telling somebody who has paid that the address could not be created sends them to buy a name they
// may already own, on a wallet that will refuse it again.
test('a payment this wallet cannot finish says so, instead of blaming the name', async () => {
  await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
  confirm.mockResolvedValue(false)
  const tree = await render()
  await settle()

  confirm.mockRejectedValue(new Error('reference does not belong to this purchase'))
  await press(tree, 'Check again')

  const shown = texts(tree).join(' ')
  expect(shown).toContain('does not match this wallet')
  expect(shown).not.toContain('Could not create the address')
  expect(shown).not.toContain('See the price')
  expect(shown).toContain('Check again')
  expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
  expect(await purchase.loadPending('name')).not.toBeNull()
})

// The edge refused the request, not the name. Anything about the address failing points the buyer at
// the one thing that is fine, and sends them off to pick another name that will fail the same way.
test('a request refused for coming too often does not read as the name failing', async () => {
  quote.mockRejectedValue(new Error('too many requests'))
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Too many attempts')
  expect(shown).not.toContain('Could not create the address')
  expect(shown).not.toContain('too many requests')
})

// The sheet can be holding a price from before a payment landed on this wallet, and the button under
// it would take a second amount for a name already bought. What is owed comes first.
test('paying is refused while this wallet still owes a name', async () => {
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  await purchase.savePending({ kind: 'name', subject: 'bakery', reference: 'ref-0', amountSats: 12000 })
  await press(tree, 'Pay and take the name')

  // Nothing was sent, and the proof of the payment already made is untouched.
  expect(sparkConfirmSend).not.toHaveBeenCalled()
  expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-0' })
  const shown = texts(tree).join(' ')
  expect(shown).toContain('Payment made')
  expect(shown).toContain('Check again')
  expect(shown).not.toContain('costs')
})

// A payment written before the store was keyed by wallet, which is what an update finds on a device
// that crashed mid purchase. It is picked up like any other, and only the wallet that finishes it
// retires it, since nothing on disk says whose it was.
test('a purchase left at the unkeyed path is finished and retired', async () => {
  await RNFS.writeFile(
    UNKEYED,
    JSON.stringify({ kind: 'name', subject: 'alice', reference: 'ref-old', amountSats: 19800 }),
    'utf8',
  )
  // Pinned, since mockResolvedValue survives clearAllMocks and an address left by an earlier test
  // would route this through the branch for a name the server already took.
  jest.mocked(sparkGetLnAddress).mockResolvedValue(null)
  jest.mocked(sparkRegisterLnAddress).mockResolvedValue({
    username: 'alice',
    address: 'alice@usevoltz.app',
    lnurl: 'lnurl1abc',
  })
  const onRegistered = jest.fn()
  await render(onRegistered)
  await settle()

  expect(confirm).toHaveBeenCalledWith(expect.anything(), 'alice', 'ref-old')
  expect(sparkRegisterLnAddress).toHaveBeenCalledWith('alice', undefined, 'primary')
  expect(onRegistered).toHaveBeenCalled()
  expect(await RNFS.exists(UNKEYED)).toBe(false)
  expect(await purchase.loadPending('name')).toBeNull()
})

// The send went out and the confirmation never answered. Reading that as a refusal puts the price
// back under the buyer, and the button beneath it charges a second time for the same name.
test('a confirmation lost after the send keeps the buyer on the payment', async () => {
  confirm.mockRejectedValue(new Error('SdkError.NetworkError'))
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Payment made')
  expect(shown).toContain('Check again')
  expect(shown).not.toContain('costs')
  expect(shown).not.toContain('Pay and take the name')
  expect(shown).not.toContain('Could not create the address')
  expect(await purchase.loadPending('name')).not.toBeNull()
})

// In the opposite case nothing was sent, so the buyer keeps the price and can pay once the balance
// is there, which is why the proof rather than the error decides.
test('a send that never left leaves the price, not a payment to wait for', async () => {
  ;(jest.requireMock('../src/wallet/spark').sparkPrepareSend as jest.Mock).mockRejectedValue(
    new Error('insufficient funds'),
  )
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  const shown = texts(tree).join(' ')
  expect(shown).not.toContain('Payment made')
  expect(shown).toContain('costs')
  expect(await purchase.loadPending('name')).toBeNull()
})

// The recovery sweep shares the slot, and a proof it files while the send is being prepared stands
// over this send's unpaid mark. That proof is another payment's, so it says nothing of this send: the
// sheet waits on that payment by its own name and reference, never on this quote's.
test('a send whose catch finds a proof of another reference waits on that proof, not on this quote', async () => {
  ;(jest.requireMock('../src/wallet/spark').sparkPrepareSend as jest.Mock).mockImplementationOnce(async () => {
    await purchase.savePending({ kind: 'name', subject: 'bob', reference: 'ref-9', amountSats: 19800 })
    throw new Error('insufficient funds')
  })
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  expect(tree.root.findByType(TextInput).props.value).toBe('bob')
  const shown = texts(tree).join(' ')
  expect(shown).toContain('Payment made')
  expect(shown).toContain('Check again')
  expect(shown).not.toContain('costs')
  expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-9' })

  confirm.mockResolvedValueOnce(false)
  await press(tree, 'Check again')
  expect(confirm.mock.calls.map(call => [call[1], call[2]])).toEqual([['bob', 'ref-9']])
})

// Nothing was charged, so the buyer picks another name. The price on screen belongs to the one they
// left behind, and the button under it pays that invoice: a name bought that nobody asked for, with
// no way to hand it back.
test('a send that never left does not leave the price stuck on the name the buyer moved off', async () => {
  ;(jest.requireMock('../src/wallet/spark').sparkPrepareSend as jest.Mock).mockRejectedValue(
    new Error('insufficient funds'),
  )
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  await type(tree, 'bob')
  await settle()

  const shown = texts(tree).join(' ')
  expect(shown).not.toContain('costs')
  expect(shown).not.toContain('Pay and take the name')
  expect(shown).toContain('See the price')
})

// Same again where the send went out and came back refused, which is the other way the sheet learns
// that nothing was charged.
test('a send refused outright does not leave the price stuck on the name the buyer moved off', async () => {
  ;(jest.requireMock('../src/wallet/spark').sparkConfirmSend as jest.Mock).mockResolvedValue('failed')
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')
  await press(tree, 'Pay and take the name')

  await type(tree, 'bob')
  await settle()

  const shown = texts(tree).join(' ')
  expect(shown).not.toContain('costs')
  expect(shown).toContain('See the price')
})

// The unkeyed record is shown to every wallet, since nothing on disk says whose it is. The gateway
// refusing the reference is proof this wallet did not pay it, and holding that wallet on a payment
// its key can never confirm locks it out of buying a name at all, on every open, for good.
test('a wallet the gateway disowns can still buy a name of its own', async () => {
  await RNFS.writeFile(
    UNKEYED,
    JSON.stringify({ kind: 'name', subject: 'alice', reference: 'ref-old', amountSats: 19800 }),
    'utf8',
  )
  confirm.mockRejectedValue(new Error('reference does not belong to this purchase'))
  const tree = await render()
  await settle()

  expect(texts(tree).join(' ')).toContain('does not match this wallet')
  expect(texts(tree).join(' ')).not.toContain('Check again')

  await type(tree, 'bob')
  await settle()
  await press(tree, 'See the price')

  expect(texts(tree).join(' ')).toContain('costs')
  // The record stays on disk for the wallet that did pay.
  expect(await RNFS.exists(UNKEYED)).toBe(true)
})


// Presses landing before the busy flag reaches the button all read it as unset, and each one pays
// the same invoice again. There is no refund path anywhere in the service.
test('presses landing together pay once', async () => {
  const tree = await render()
  await type(tree, 'alice')
  await settle()
  await press(tree, 'See the price')

  const pay = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(t => t.props.children === 'Pay and take the name'))
  await ReactTestRenderer.act(async () => {
    pay!.props.onPress()
    pay!.props.onPress()
    pay!.props.onPress()
  })
  await settle()

  expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
})

// What a refusal for good reads like. `final: true` is the gateway saying a person gives the sats
// back, and no `final` is a gateway older than the field, which sends the same code for that case and
// for a wait. Neither may say the name is coming or that checking again finishes it, and neither may
// drop the proof or show a price for a name already paid for.
describe('a paid name the gateway will not grant', () => {
  function expectKept(shown: string): void {
    expect(shown).toContain(KEPT)
    expect(shown).toContain('Send to support')
    expect(shown).not.toContain('Payment made')
    expect(shown).not.toContain('Check again')
    expect(shown).not.toContain('costs')
    expect(shown).not.toContain('Pay and take the name')
    expect(shown).not.toContain('See the price')
  }

  for (const final of [true, undefined]) {
    test(`after paying, with final ${String(final)}, sends the buyer to a person and keeps the proof`, async () => {
      confirm.mockRejectedValue(paidRefusal(final))
      const tree = await render()
      await type(tree, 'alice')
      await settle()
      await press(tree, 'See the price')
      await press(tree, 'Pay and take the name')

      expectKept(texts(tree).join(' '))
      expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
      expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-1' })
    })

    test(`on opening, with final ${String(final)}, sends the buyer to a person and keeps the proof`, async () => {
      await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
      confirm.mockRejectedValue(paidRefusal(final))
      const tree = await render()
      await settle()

      expectKept(texts(tree).join(' '))
      expect(quote).not.toHaveBeenCalled()
      expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-1' })
    })
  }

  // The open asks the gateway at once. Until it answers, nothing it has not said is on screen.
  test('says nothing about the payment before the open hears back', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    let answer!: (err: Error) => void
    confirm.mockImplementation(() => new Promise<boolean>((_, reject) => (answer = reject)))
    const tree = await render()
    await settle()

    expect(texts(tree).join(' ')).not.toContain('Payment made')
    expect(texts(tree).join(' ')).not.toContain('costs')
    await ReactTestRenderer.act(async () => {
      answer(paidRefusal(true))
    })
    expectKept(texts(tree).join(' '))
  })

  test('the support mail carries the wallet key and the payment reference', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    confirm.mockRejectedValue(paidRefusal(true))
    const tree = await render()
    await settle()
    await press(tree, 'Send to support')
    await settle()

    const url = decodeURIComponent(String(open.mock.calls[0]?.[0]))
    expect(url).toContain('mailto:support@usevoltz.app')
    expect(url).toContain('ref-1')
    expect(url).toContain(`02${'a'.repeat(64)}`)
    open.mockRestore()
  })

  // The gateway's window for another wallet's reservation can end in a refusal for good. The next
  // check or opening replaces the wait with it.
  test('a wait that turns final takes the line on the next check', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    confirm.mockRejectedValue(paidRefusal(false))
    const tree = await render()
    await settle()
    expect(texts(tree).join(' ')).toContain('Payment made')

    confirm.mockRejectedValue(paidRefusal(true))
    await press(tree, 'Check again')
    await settle()
    expectKept(texts(tree).join(' '))
    expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-1' })
  })

  test('a wait that turns final takes the line on the next opening', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    confirm.mockRejectedValue(paidRefusal(false))
    const tree = await render()
    await settle()
    expect(texts(tree).join(' ')).toContain('Payment made')

    confirm.mockRejectedValue(paidRefusal(true))
    await reopen(tree)
    expectKept(texts(tree).join(' '))
  })

  // A reopening asks again, and until it hears back the last answer is still the latest word.
  test('a reopening keeps the refusal for good on screen while it asks again', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    confirm.mockRejectedValue(paidRefusal(true))
    const tree = await render()
    await settle()
    expectKept(texts(tree).join(' '))

    confirm.mockImplementation(() => new Promise<boolean>(() => undefined))
    await reopen(tree, false)
    expectKept(texts(tree).join(' '))
  })

  // A lost network is no answer about the payment, so the refusal for good it follows stays.
  test('a reopening that cannot reach the gateway keeps the refusal for good', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    confirm.mockRejectedValue(paidRefusal(true))
    const tree = await render()
    await settle()

    confirm.mockRejectedValue(new Error('SdkError.NetworkError'))
    await reopen(tree)
    expectKept(texts(tree).join(' '))
  })

  // The recovery can drop a payment the gateway calls dead and file another in the slot. What the
  // gateway said about the first is nothing about the second.
  test('a reopening onto another payment says nothing about it before it hears back', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    confirm.mockRejectedValue(paidRefusal(true))
    const tree = await render()
    await settle()
    expectKept(texts(tree).join(' '))

    await purchase.clearPending('name', 'ref-1')
    await purchase.savePending({ kind: 'name', subject: 'bakery', reference: 'ref-2', amountSats: 12000 })
    confirm.mockImplementation(() => new Promise<boolean>(() => undefined))
    await reopen(tree, false)
    const shown = texts(tree).join(' ')
    expect(shown).not.toContain(KEPT)
    expect(shown).not.toContain('Payment made')
    expect(confirm).toHaveBeenLastCalledWith(expect.anything(), 'bakery', 'ref-2')
  })

  // The confirmation after paying can fail on the network after the open already heard the refusal
  // for good, and a failure that says nothing about the payment leaves it.
  test('a confirmation lost after the open heard the refusal for good keeps it', async () => {
    const answers: Array<(err: Error) => void> = []
    confirm.mockImplementation(() => new Promise<boolean>((_, reject) => answers.push(reject)))
    const tree = await render()
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await press(tree, 'Pay and take the name')
    await reopen(tree, false)
    await settle()
    const [pay, open] = answers as [(err: Error) => void, (err: Error) => void]
    await ReactTestRenderer.act(async () => {
      open(paidRefusal(true))
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      pay(new Error('SdkError.NetworkError'))
    })
    await settle()
    expectKept(texts(tree).join(' '))
  })

  // The confirmation after paying and the one the open sends can both be out, when the sheet is
  // closed and opened again while the first is still waiting. Whichever answers last is on screen.
  for (const order of ['open answers last', 'pay answers last'] as const) {
    for (const last of [true, false]) {
      test(`two reads of one payment, the ${order} with final ${String(last)}`, async () => {
        const answers: Array<(err: Error) => void> = []
        confirm.mockImplementation(() => new Promise<boolean>((_, reject) => answers.push(reject)))
        const tree = await render()
        await type(tree, 'alice')
        await settle()
        await press(tree, 'See the price')
        await press(tree, 'Pay and take the name')
        await reopen(tree, false)
        await settle()
        expect(answers).toHaveLength(2)

        const [pay, open] = answers as [(err: Error) => void, (err: Error) => void]
        const [first, second] = order === 'open answers last' ? [pay, open] : [open, pay]
        await ReactTestRenderer.act(async () => {
          first(paidRefusal(!last))
        })
        await settle()
        await ReactTestRenderer.act(async () => {
          second(paidRefusal(last))
        })
        await settle()

        const shown = texts(tree).join(' ')
        if (last) {
          expectKept(shown)
        } else {
          expect(shown).toContain('Payment made')
          expect(shown).toContain('Check again')
          expect(shown).not.toContain(KEPT)
        }
        expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-1' })
      })
    }
  }

  // The sheet's memory of an answer ends with the process, and the proof on disk does not. A fresh
  // mount that cannot reach the gateway says what the gateway last said about the payment, never a
  // wait for a name a person has to sort out.
  describe('across a restart', () => {
    const ALICE = { kind: 'name' as const, subject: 'alice', reference: 'ref-1', amountSats: 19800 }
    const SETTLING = (JSON.parse(fs.readFileSync(join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as {
      receive: Record<string, string>
    }).receive.lnSettling!

    // Unmounts the sheet and mounts a new one, which knows only what is on disk.
    async function restart(
      tree: ReactTestRenderer.ReactTestRenderer,
      onRegistered: (addr: unknown) => void = jest.fn(),
    ): Promise<ReactTestRenderer.ReactTestRenderer> {
      await ReactTestRenderer.act(async () => {
        tree.unmount()
      })
      const fresh = await render(onRegistered)
      await settle()
      return fresh
    }

    function offline(): void {
      confirm.mockRejectedValue(new Error('SdkError.NetworkError'))
    }

    async function expectProofIntact(): Promise<void> {
      const held = await purchase.loadPending('name')
      expect(held).toMatchObject({ subject: 'alice', reference: 'ref-1', amountSats: 19800 })
      expect(held).not.toHaveProperty('unpaid')
    }

    for (const final of [true, undefined]) {
      test(`a refusal for good heard on opening, final ${String(final)}, outlives the process`, async () => {
        await purchase.savePending(ALICE)
        confirm.mockRejectedValue(paidRefusal(final))
        const before = await render()
        await settle()
        expectKept(texts(before).join(' '))

        offline()
        const tree = await restart(before)
        const shown = texts(tree).join(' ')
        expectKept(shown)
        expect(shown).not.toContain(SETTLING)
        await expectProofIntact()
      })
    }

    test('a refusal for good heard after paying outlives the process', async () => {
      confirm.mockRejectedValue(paidRefusal(true))
      const before = await render()
      await type(before, 'alice')
      await settle()
      await press(before, 'See the price')
      await press(before, 'Pay and take the name')
      await settle()
      expectKept(texts(before).join(' '))

      offline()
      const tree = await restart(before)
      expectKept(texts(tree).join(' '))
      expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
      await expectProofIntact()
    })

    // The recovery or another open can hear the gateway refuse an older payment for good while a
    // price sits on this sheet. Pay then sends nothing and puts the buyer on that payment, as the
    // gateway last left it.
    test('the payment owed when Pay is pressed shows the refusal for good it carries', async () => {
      const tree = await render()
      await type(tree, 'alice')
      await settle()
      await press(tree, 'See the price')

      await purchase.savePending({ kind: 'name', subject: 'bakery', reference: 'ref-9', amountSats: 12000 })
      confirm.mockRejectedValue(paidRefusal(true))
      const other = await render()
      await settle()
      await ReactTestRenderer.act(async () => {
        other.unmount()
      })

      offline()
      await press(tree, 'Pay and take the name')
      await settle()
      expectKept(texts(tree).join(' '))
      expect(sparkConfirmSend).not.toHaveBeenCalled()
      expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-9', amountSats: 12000 })
    })

    test('a wait heard after a refusal for good takes it back', async () => {
      await purchase.savePending(ALICE)
      confirm.mockRejectedValue(paidRefusal(true))
      let tree = await render()
      await settle()

      confirm.mockRejectedValue(paidRefusal(false))
      tree = await restart(tree)
      expect(texts(tree).join(' ')).toContain('Payment made')

      offline()
      tree = await restart(tree)
      const shown = texts(tree).join(' ')
      expect(shown).toContain('Payment made')
      expect(shown).toContain('Check again')
      expect(shown).not.toContain(KEPT)
      await expectProofIntact()
    })

    test('a refusal for good heard after a wait takes it over', async () => {
      await purchase.savePending(ALICE)
      confirm.mockRejectedValue(paidRefusal(false))
      let tree = await render()
      await settle()
      expect(texts(tree).join(' ')).toContain('Payment made')

      confirm.mockRejectedValue(paidRefusal(true))
      await press(tree, 'Check again')
      await settle()

      offline()
      tree = await restart(tree)
      expectKept(texts(tree).join(' '))
      await expectProofIntact()
    })

    test('a grant finishes the name and drops the proof', async () => {
      await purchase.savePending(ALICE)
      confirm.mockRejectedValue(paidRefusal(true))
      const before = await render()
      await settle()

      confirm.mockResolvedValue(true)
      jest.mocked(sparkRegisterLnAddress).mockResolvedValue({
        username: 'alice',
        address: 'alice@lnurl.usevoltz.app',
        lnurl: 'lnurl1',
      })
      const onRegistered = jest.fn()
      await restart(before, onRegistered)
      expect(onRegistered).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }))
      expect(await purchase.loadPending('name')).toBeNull()
    })

    // Granted, the name only waits on the register. A refusal for good the proof still carried
    // would put the person's line over a name that is the buyer's, now and after the next restart.
    test('a grant whose register fails reads as the wait and keeps the proof', async () => {
      await purchase.savePending(ALICE)
      confirm.mockRejectedValue(paidRefusal(true))
      let tree = await render()
      await settle()

      confirm.mockResolvedValue(true)
      jest.mocked(sparkRegisterLnAddress).mockRejectedValue(new Error('SdkError.NetworkError'))
      tree = await restart(tree)
      let shown = texts(tree).join(' ')
      expect(shown).not.toContain(KEPT)
      expect(shown).toContain('Check again')
      await expectProofIntact()

      offline()
      tree = await restart(tree)
      shown = texts(tree).join(' ')
      expect(shown).not.toContain(KEPT)
      expect(shown).toContain('Payment made')
      await expectProofIntact()
    })

    // Every proof already on a device was written without the field, and none of them was refused
    // for good as far as the device knows.
    test('a proof written without the field reads as never refused', async () => {
      await RNFS.writeFile(STORE, JSON.stringify({ primary: { name: ALICE } }), 'utf8')
      offline()
      const tree = await render()
      await settle()
      const shown = texts(tree).join(' ')
      expect(shown).toContain('Payment made')
      expect(shown).toContain('Check again')
      expect(shown).not.toContain(KEPT)
      expect(await purchase.loadPending('name')).toEqual(ALICE)
    })
  })
})

// Final answers that name more than a person giving the sats back: no check again, no price, no second
// payment, and only this charge's `repaid: true` says the sats came back. Every final answer gives the
// slot up once its line is on screen, so the next opening offers a fresh quote and asks nothing more,
// except the two owed with nothing delivered: `kept`, and a paid-again answer whose name is gone since,
// which keep the proof until the sats come back. A holder's answer releases too, and puts the
// name on the wallet only while it answers on no address at all. The double throws what
// confirmName throws for each answer.
describe('a paid name the gateway answers for good in other words', () => {
  const recover = (JSON.parse(fs.readFileSync(join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as {
    recover: Record<string, string>
    receive: Record<string, string>
  }).recover
  const answers = {
    paidAgain: () => Object.assign(new Error('paid_again'), { paidAgain: true, final: true }),
    paidAgainGone: () => Object.assign(new Error('paid_but_not_granted'), { paidAgain: true }),
    paidAgainRepaid: () => Object.assign(new Error('paid_again'), { paidAgain: true, final: true, repaid: true }),
    paidAgainRepaidGone: () => Object.assign(new Error('paid_but_not_granted'), { paidAgain: true, repaid: true }),
    repaid: () => Object.assign(new Error('paid_but_not_granted'), { final: true, repaid: true }),
    repaidFalse: () => Object.assign(new Error('paid_but_not_granted'), { final: true, repaid: false }),
    boughtBefore: () => Object.assign(new Error('bought_before'), { final: true }),
  }
  type Which = keyof typeof answers
  const LINES: Record<Which, string> = {
    paidAgain: recover.paidAgainBody!,
    paidAgainGone: recover.paidAgainBody!,
    paidAgainRepaid: recover.paidAgainRepaidBody!,
    paidAgainRepaidGone: recover.paidAgainRepaidBody!,
    repaid: recover.repaidBody!,
    repaidFalse: KEPT,
    boughtBefore: recover.boughtBeforeNameBody!,
  }
  // The mark an answer that keeps the slot leaves on the proof; undefined is an answer that releases
  // it, which leaves no proof at all.
  const HELD: Record<Which, string | null | undefined> = {
    paidAgain: undefined,
    paidAgainGone: 'paidAgain',
    paidAgainRepaid: undefined,
    paidAgainRepaidGone: undefined,
    repaid: undefined,
    repaidFalse: null,
    boughtBefore: undefined,
  }
  const HOLDER: Record<Which, boolean> = {
    paidAgain: true,
    paidAgainGone: false,
    paidAgainRepaid: true,
    paidAgainRepaidGone: false,
    repaid: false,
    repaidFalse: false,
    boughtBefore: false,
  }
  const CAME_BACK = [recover.repaidBody!, recover.paidAgainRepaidBody!]
  // Whether the slot stays, and whether sats are still owed back, which only a person does.
  const owed = (which: Which): boolean => HELD[which] !== undefined
  const SUPPORT: Record<Which, boolean> = {
    paidAgain: true,
    paidAgainGone: true,
    paidAgainRepaid: false,
    paidAgainRepaidGone: false,
    repaid: false,
    repaidFalse: true,
    boughtBefore: false,
  }

  function expectFinal(shown: string, which: Which): void {
    expect(shown).toContain(LINES[which])
    expect(shown.includes('Send to support')).toBe(SUPPORT[which])
    for (const line of CAME_BACK) {
      expect(shown.includes(line)).toBe(line === LINES[which])
    }
    expect(shown).not.toContain(recover.boughtBeforeBody!.replace('{{subject}}', 'alice'))
    expect(shown).not.toContain('Payment made')
    expect(shown).not.toContain('Check again')
    expect(shown).not.toContain('costs')
    expect(shown).not.toContain('Pay and take the name')
    expect(shown).not.toContain('See the price')
  }

  // The proof an owed answer keeps, and none at all, not even on file, for one that owes nothing.
  async function expectSlot(which: Which): Promise<void> {
    const held = await purchase.loadPending('name')
    if (!owed(which)) {
      expect(held).toBeNull()
      expect((await RNFS.exists(STORE)) && fs.readFileSync(STORE, 'utf8').includes('ref-1')).toBe(false)
      return
    }
    expect(held).toMatchObject({ reference: 'ref-1', refusedForGood: true })
    expect(held?.finalAnswer).toBe(HELD[which] ?? undefined)
  }

  async function payInto(which: Which, onRegistered = jest.fn()): Promise<ReactTestRenderer.ReactTestRenderer> {
    confirm.mockRejectedValue(answers[which]())
    const tree = await render(onRegistered)
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await press(tree, 'Pay and take the name')
    await settle()
    return tree
  }

  for (const which of Object.keys(answers) as Which[]) {
    test(`after paying, ${which} says what the payment came to and never reads as the name bought`, async () => {
      const onRegistered = jest.fn()
      const tree = await payInto(which, onRegistered)

      expectFinal(texts(tree).join(' '), which)
      expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
      expect(confirm).toHaveBeenCalledTimes(1)
      // The wallet holds the name on a holder's answer, so it goes on the address; the sheet stays
      // on the line about this payment rather than closing as a purchase would.
      expect(jest.mocked(sparkRegisterLnAddress).mock.calls).toEqual(HOLDER[which] ? [['alice']] : [])
      expect(onRegistered).not.toHaveBeenCalled()
      await expectSlot(which)
    })

    test(`on opening, ${which} is asked again ${owed(which) ? 'at each opening' : 'never'}, also after a restart`, async () => {
      await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
      confirm.mockRejectedValue(answers[which]())
      const tree = await render()
      await settle()
      expectFinal(texts(tree).join(' '), which)
      expect(quote).not.toHaveBeenCalled()
      expect(confirm).toHaveBeenCalledTimes(1)
      await expectSlot(which)

      await reopen(tree)
      expect(confirm).toHaveBeenCalledTimes(owed(which) ? 2 : 1)
      if (owed(which)) {
        expectFinal(texts(tree).join(' '), which)
      } else {
        // The next opening offers a fresh quote, and the line was said in the view that heard it.
        const shown = texts(tree).join(' ')
        expect(shown).not.toContain(LINES[which])
        expect(shown).toContain('See the price')
      }

      confirm.mockRejectedValue(new Error('SdkError.NetworkError'))
      await ReactTestRenderer.act(async () => {
        tree.unmount()
      })
      const restarted = await render()
      await settle()
      expect(confirm).toHaveBeenCalledTimes(owed(which) ? 3 : 1)
      const shown = texts(restarted).join(' ')
      if (owed(which)) {
        expectFinal(shown, which)
      } else {
        expect(shown).not.toContain(LINES[which])
        expect(shown).toContain('See the price')
      }
      expect(quote).not.toHaveBeenCalled()
      expect(sparkConfirmSend).not.toHaveBeenCalled()
    })
  }

  // An owed answer heard again once its sats came back gives the slot up then.
  test('a payment whose name is gone since keeps its proof until the gateway says its sats came back', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    confirm.mockRejectedValue(answers.paidAgainGone())
    const tree = await render()
    await settle()
    expectFinal(texts(tree).join(' '), 'paidAgainGone')
    confirm.mockRejectedValue(answers.paidAgainRepaidGone())
    await reopen(tree)
    expectFinal(texts(tree).join(' '), 'paidAgainRepaidGone')
    expect(await purchase.loadPending('name')).toBeNull()
    await reopen(tree)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(texts(tree).join(' ')).toContain('See the price')
  })

  // The Pay's own confirmation lost after a reopening heard the payment bought nothing leaves that line,
  // which no later confirmation changes, rather than a wait for a name that is not coming.
  test('a confirmation lost after the open heard the payment bought nothing keeps that line', async () => {
    const pending: Array<(err: Error) => void> = []
    confirm.mockImplementation(() => new Promise<boolean>((_, reject) => pending.push(reject)))
    const tree = await render()
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await press(tree, 'Pay and take the name')
    await reopen(tree, false)
    await settle()
    const [pay, open] = pending as [(err: Error) => void, (err: Error) => void]
    await ReactTestRenderer.act(async () => {
      open(answers.paidAgainGone())
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      pay(new Error('SdkError.NetworkError'))
    })
    await settle()
    expectFinal(texts(tree).join(' '), 'paidAgainGone')
    await expectSlot('paidAgainGone')
  })

  // An opening that takes a kept line gives the slot of its reference up as shown, which a clear that
  // never landed after the release left marked on file.
  test('an opening that says a kept line drops the marked proof of its reference', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    await purchase.recordRefusal('name', 'ref-1', true, 'repaid')
    await lines.noteLine({ kind: 'name', reference: 'ref-1', answer: 'repaid', subject: 'alice@lnurl.usevoltz.app' }, await lines.activeScope())
    const read = (RNFS as unknown as { readFile(p: string, e: string): Promise<string> }).readFile
    const onFile = async (): Promise<boolean> => (await RNFS.exists(STORE)) && (await read(STORE, 'utf8')).includes('ref-1')
    expect(await onFile()).toBe(true)
    const tree = await render()
    await settle()
    expect(texts(tree).join(' ')).toContain(LINES.repaid)
    expect(confirm).not.toHaveBeenCalled()
    expect(await onFile()).toBe(false)
  })

  // A released slot offers only a fresh quote, which the gateway mints anew. The paid quote and its
  // invoice are gone with the slot.
  test('after an answer that owes nothing, the next opening asks a fresh price and pays only its invoice', async () => {
    const tree = await payInto('repaid')
    quote.mockResolvedValue({
      username: 'alice',
      priceUsdCents: 990,
      amountSats: 19800,
      invoice: 'lnbc2',
      reference: 'ref-2',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    })
    confirm.mockResolvedValue(false)
    await reopen(tree)
    expect(texts(tree).join(' ')).not.toContain('Pay and take the name')
    await press(tree, 'See the price')
    expect(quote).toHaveBeenCalledTimes(2)
    await press(tree, 'Pay and take the name')
    await settle()
    const spark = jest.requireMock('../src/wallet/spark') as Record<string, jest.Mock>
    expect(spark.sparkPrepareSend!.mock.calls.map(call => call[0])).toEqual(['lnbc1', 'lnbc2'])
    expect((await purchase.loadPending('name'))?.reference).toBe('ref-2')
  })

  // A holder's answer registers only what the address does not already say.
  test('a holder answer leaves an address that already says the name as it is', async () => {
    jest.mocked(sparkGetLnAddress).mockResolvedValueOnce({ username: 'alice', address: 'alice@breez.tips', lnurl: 'l' })
    await payInto('paidAgain')
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    expect(await purchase.loadPending('name')).toBeNull()
  })

  // The wallet answers on bob, chosen since, here or on another device. No holder's answer for alice
  // swaps it, whether heard after paying, on opening, after a restart, and the slot is given up
  // at the first answer, so no later opening asks again.
  test.each(['paidAgain', 'paidAgainRepaid'] as const)('a holder answer, %s, never swaps an address in use', async which => {
    jest.mocked(sparkGetLnAddress).mockResolvedValue({ username: 'bob', address: 'bob@breez.tips', lnurl: 'l' })
    const tree = await payInto(which)
    expectFinal(texts(tree).join(' '), which)
    expect(await purchase.loadPending('name')).toBeNull()

    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-3', amountSats: 19800 })
    await reopen(tree)
    expectFinal(texts(tree).join(' '), which)
    expect(await purchase.loadPending('name')).toBeNull()

    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-4', amountSats: 19800 })
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    const restarted = await render()
    await settle()
    expectFinal(texts(restarted).join(' '), which)
    expect(await purchase.loadPending('name')).toBeNull()

    await reopen(restarted)
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    jest.mocked(sparkGetLnAddress).mockResolvedValue(null)
  })

  // A register that fails leaves the line, and the name stays the wallet's to take from the sheet for
  // free (already_paid), so the slot is given up all the same and no later opening registers.
  test('a holder answer whose register fails says its line once and asks nothing more', async () => {
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(new Error('SdkError.NetworkError'))
    const tree = await payInto('paidAgain')
    expectFinal(texts(tree).join(' '), 'paidAgain')
    expect(await purchase.loadPending('name')).toBeNull()
    await reopen(tree)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(jest.mocked(sparkRegisterLnAddress).mock.calls).toEqual([['alice']])
    expect(texts(tree).join(' ')).not.toContain(LINES.paidAgain)
  })

  // An opening while a holder's answer is still being taken asks nothing and registers nothing, since
  // the answer is read inside the guard of the opening that asked; the line stays on screen.
  test('a holder answer still being taken holds a second opening back from asking and registering', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    confirm.mockRejectedValue(answers.paidAgain())
    let readAddress!: (value: null) => void
    jest.mocked(sparkGetLnAddress).mockImplementationOnce(() => new Promise(resolve => (readAddress = resolve)))
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    })
    await reopen(tree)
    await ReactTestRenderer.act(async () => {
      readAddress(null)
    })
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(jest.mocked(sparkRegisterLnAddress).mock.calls).toEqual([['alice']])
    expectFinal(texts(tree).join(' '), 'paidAgain')
    expect(await purchase.loadPending('name')).toBeNull()
  })

  // A Pay and an opening can both be asking about one payment. Both answers say the line, and the
  // name a holder's answer puts on the wallet is registered once.
  test('a Pay and an opening both answered as the holder register the name once', async () => {
    const asked: Array<(err: Error) => void> = []
    confirm.mockImplementation(() => new Promise((_, reject) => asked.push(reject)))
    let readAddress!: (value: null) => void
    jest.mocked(sparkGetLnAddress).mockImplementationOnce(() => new Promise(resolve => (readAddress = resolve)))
    const tree = await render()
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await press(tree, 'Pay and take the name')
    await reopen(tree, false)
    await settle()
    expect(asked).toHaveLength(2)
    const [pay, open] = asked as [(err: Error) => void, (err: Error) => void]
    await ReactTestRenderer.act(async () => {
      pay(answers.paidAgain())
    })
    await ReactTestRenderer.act(async () => {
      open(answers.paidAgain())
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      readAddress(null)
    })
    await settle()
    expect(jest.mocked(sparkRegisterLnAddress).mock.calls).toEqual([['alice']])
    expectFinal(texts(tree).join(' '), 'paidAgain')
    expect(await purchase.loadPending('name')).toBeNull()
  })

  // An answer that releases the slot heard after the sheet closed is kept as a line before the slot
  // is given up, and said once, at the next opening, with no question to the gateway, and never again,
  // also after a restart.
  test.each(['paidAgain', 'repaid', 'boughtBefore', 'paidAgainRepaid'] as const)(
    '%s heard after the sheet closed is said once at the next opening',
    async which => {
      await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
      let answer!: (err: Error) => void
      confirm.mockImplementation(() => new Promise((_, reject) => (answer = reject)))
      const tree = await render()
      await ReactTestRenderer.act(async () => {
        await Promise.resolve()
      })
      await ReactTestRenderer.act(async () => {
        tree.update(<LnAddressSheet visible={false} onClose={jest.fn()} onRegistered={jest.fn()} />)
      })
      await ReactTestRenderer.act(async () => {
        answer(answers[which]())
      })
      await settle()
      expect(await purchase.loadPending('name')).toBeNull()
      expect(await lines.listLines()).toEqual([
        { kind: 'name', reference: 'ref-1', answer: which, subject: 'alice@lnurl.usevoltz.app' },
      ])

      await ReactTestRenderer.act(async () => {
        tree.update(<LnAddressSheet visible onClose={jest.fn()} onRegistered={jest.fn()} />)
      })
      await settle()
      expectFinal(texts(tree).join(' '), which)
      expect(await lines.listLines()).toEqual([])

      await reopen(tree)
      expect(texts(tree).join(' ')).not.toContain(LINES[which])
      expect(texts(tree).join(' ')).toContain('See the price')
      await ReactTestRenderer.act(async () => {
        tree.unmount()
      })
      const restarted = await render()
      await settle()
      expect(texts(restarted).join(' ')).not.toContain(LINES[which])
      expect(confirm).toHaveBeenCalledTimes(1)
    },
  )

  // The same when the screen holding the sheet is gone before the answer.
  test('a released answer heard after the sheet unmounted is said once by the next sheet', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    let answer!: (err: Error) => void
    confirm.mockImplementation(() => new Promise((_, reject) => (answer = reject)))
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    await ReactTestRenderer.act(async () => {
      answer(answers.repaid())
    })
    await settle()
    expect(await lines.listLines()).toHaveLength(1)
    const next = await render()
    await settle()
    expectFinal(texts(next).join(' '), 'repaid')
    expect(await lines.listLines()).toEqual([])
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  // An opening with no proof held takes the oldest line kept and says it, with no question to the
  // gateway; one with a proof held asks about the proof and leaves the line for later.
  test('a kept line is said by an opening with no proof held, and waits out a proof in the slot', async () => {
    await lines.noteLine({ kind: 'name', reference: 'ref-9', answer: 'repaid', subject: 'carol@lnurl.usevoltz.app' }, await lines.activeScope())
    confirm.mockResolvedValue(false)
    const tree = await render()
    await settle()
    expectFinal(texts(tree).join(' '), 'repaid')
    expect(confirm).not.toHaveBeenCalled()
    expect(await lines.listLines()).toEqual([])

    await lines.noteLine({ kind: 'name', reference: 'ref-8', answer: 'boughtBefore', subject: 'dave@lnurl.usevoltz.app' }, await lines.activeScope())
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    await reopen(tree)
    expect(texts(tree).join(' ')).not.toContain(LINES.boughtBefore)
    expect(await lines.listLines()).toHaveLength(1)
    await purchase.clearPending('name', 'ref-1')
    await reopen(tree)
    expectFinal(texts(tree).join(' '), 'boughtBefore')
    expect(await lines.listLines()).toEqual([])
    expect(sparkConfirmSend).not.toHaveBeenCalled()
  })

  test('a Pay with a line kept sends its own invoice and leaves the line for the next opening', async () => {
    const tree = await render()
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await lines.noteLine({ kind: 'name', reference: 'ref-9', answer: 'repaid', subject: 'carol@lnurl.usevoltz.app' }, await lines.activeScope())
    confirm.mockResolvedValue(false)
    await press(tree, 'Pay and take the name')
    await settle()
    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
    expect((await purchase.loadPending('name'))?.reference).toBe('ref-1')
    expect(await lines.listLines()).toHaveLength(1)
  })

  // The sheet's opening takes and says the line while the recovery sweep's questions are out, and the
  // card the sweep answers with afterwards is not that line, so the home screen does not say it a
  // second time.
  test('a line the sheet says while the sweep is out is not the sweep\'s card', async () => {
    const { recoverPurchases } = jest.requireActual('../src/wallet/recover') as typeof import('../src/wallet/recover')
    await lines.noteLine({ kind: 'name', reference: 'ref-a', answer: 'repaid', subject: 'carol@lnurl.usevoltz.app' }, await lines.activeScope())
    let answer!: () => void
    const gate = new Promise<void>(resolve => (answer = resolve))
    const sweep = recoverPurchases({
      walletId: 'w_a',
      lines: lines.scopeOn('w_a'),
      pubkey: `02${'a'.repeat(64)}`,
      sign: async () => 'sig',
      request: (async () => {
        await gate
        return { ok: true, status: 200, json: async () => ({ charges: [] }) }
      }) as unknown as typeof fetch,
    })
    const tree = await render()
    await settle()
    expectFinal(texts(tree).join(' '), 'repaid')
    answer()
    expect(await sweep).toBeNull()
    expect(await lines.listLines()).toEqual([])
  })

  // A crash between keeping the line and giving the slot up leaves the proof, which the next opening
  // confirms again. It says the answer it heard and takes the kept copy out, so nothing says it twice.
  test('a crash between keeping a line and giving the slot up says the line once', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    await lines.noteLine({ kind: 'name', reference: 'ref-1', answer: 'repaid', subject: 'alice@lnurl.usevoltz.app' }, await lines.activeScope())
    confirm.mockRejectedValue(answers.repaid())
    const tree = await render()
    await settle()
    expectFinal(texts(tree).join(' '), 'repaid')
    expect(await lines.listLines()).toEqual([])
    expect(await purchase.loadPending('name')).toBeNull()
    await lines.noteLine({ kind: 'name', reference: 'ref-1', answer: 'repaid', subject: 'alice@lnurl.usevoltz.app' }, await lines.activeScope())
    expect(await lines.listLines()).toEqual([])
  })

  // An opening closed while it takes a line puts the line back for the next view, so it is never lost.
  test('a sheet closed while it takes a line leaves it for the next opening', async () => {
    await lines.noteLine({ kind: 'name', reference: 'ref-9', answer: 'repaid', subject: 'carol@lnurl.usevoltz.app' }, await lines.activeScope())
    const realTake = lines.takeLine
    const take = jest.spyOn(lines, 'takeLine')
    let taken!: () => void
    const held = new Promise<void>(resolve => (taken = resolve))
    take.mockImplementationOnce(async (kind, scope) => {
      const line = await realTake(kind, scope)
      await held
      return line
    })
    const tree = await render()
    await settle()
    await ReactTestRenderer.act(async () => {
      tree.update(<LnAddressSheet visible={false} onClose={jest.fn()} onRegistered={jest.fn()} />)
    })
    await ReactTestRenderer.act(async () => {
      taken()
    })
    await settle()
    take.mockRestore()
    expect(await lines.listLines()).toHaveLength(1)
    await ReactTestRenderer.act(async () => {
      tree.update(<LnAddressSheet visible onClose={jest.fn()} onRegistered={jest.fn()} />)
    })
    await settle()
    expectFinal(texts(tree).join(' '), 'repaid')
    expect(await lines.listLines()).toEqual([])
  })

  // A line the sheet took goes back to the wallet it was taken from, never to one a switch made active
  // while the take was out.
  test('a sheet closed while it takes a line puts it back on the wallet it took it from after a switch', async () => {
    await lines.noteLine({ kind: 'name', reference: 'ref-9', answer: 'repaid', subject: 'carol@lnurl.usevoltz.app' }, lines.scopeOn('primary'))
    const realTake = lines.takeLine
    const take = jest.spyOn(lines, 'takeLine')
    let taken!: () => void
    const held = new Promise<void>(resolve => (taken = resolve))
    take.mockImplementationOnce(async (kind, scope) => {
      const line = await realTake(kind, scope)
      await held
      return line
    })
    const tree = await render()
    await settle()
    await ReactTestRenderer.act(async () => {
      tree.update(<LnAddressSheet visible={false} onClose={jest.fn()} onRegistered={jest.fn()} />)
    })
    const switched = jest.spyOn(registry, 'getActiveWalletId').mockResolvedValue('w_b')
    try {
      await ReactTestRenderer.act(async () => {
        taken()
      })
      await settle()
    } finally {
      switched.mockRestore()
      take.mockRestore()
    }
    expect(await lines.listLines('primary')).toEqual([
      { kind: 'name', reference: 'ref-9', answer: 'repaid', subject: 'carol@lnurl.usevoltz.app' },
    ])
    expect(await lines.listLines('w_b')).toEqual([])
  })

  // A mark that owes nothing whose clear never landed reads as no proof, after a restart too.
  test('a proof marked as owing nothing whose clear never landed is not asked about and holds no price back', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    await purchase.recordRefusal('name', 'ref-1', true, 'repaid')
    const tree = await render()
    await settle()
    expect(confirm).not.toHaveBeenCalled()
    expect(texts(tree).join(' ')).not.toContain(recover.repaidBody!)
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    expect(texts(tree).join(' ')).toContain('Pay and take the name')
  })

  // A proof whose answer was never heard says nothing came back, whatever an earlier build wrote.
  test('a restart with no answer onto a proof refused for good with no answer named says a person gives the sats back', async () => {
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    await purchase.recordRefusal('name', 'ref-1', true)
    confirm.mockRejectedValue(new Error('SdkError.NetworkError'))
    const tree = await render()
    await settle()
    const shown = texts(tree).join(' ')
    expect(shown).toContain(KEPT)
    for (const line of CAME_BACK) {
      expect(shown).not.toContain(line)
    }
  })

  // A grant from a gateway older than paidAgain reads as it always did.
  test('a holder answer without paidAgain registers the name as before', async () => {
    const onRegistered = jest.fn()
    jest.mocked(sparkRegisterLnAddress).mockResolvedValue({ username: 'alice', address: 'alice@breez.tips', lnurl: 'lnurl1abc' })
    confirm.mockResolvedValue(true)
    const tree = await render(onRegistered)
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await press(tree, 'Pay and take the name')
    expect(onRegistered).toHaveBeenCalled()
    expect(await purchase.loadPending('name')).toBeNull()
  })

  // Only the reader that claimed a reference shows its line, so a released line is said exactly
  // once whichever reader hears it first and whenever the sheet closes.
  describe('said by the reader that claimed it', () => {
    const shown = async (tree: ReactTestRenderer.ReactTestRenderer, visible: boolean): Promise<void> => {
      await ReactTestRenderer.act(async () => {
        tree.update(<LnAddressSheet visible={visible} onClose={jest.fn()} onRegistered={jest.fn()} />)
      })
    }
    const says = (tree: ReactTestRenderer.ReactTestRenderer, which: Which): boolean =>
      texts(tree).join(' ').includes(LINES[which])
    const ADDRESS = { username: 'bob', address: 'bob@lnurl.usevoltz.app', lnurl: 'l' }
    // The address the holder's answer reads before anything is said, held until the case lets it go.
    function holdAddressRead(): () => Promise<void> {
      let readAddress!: (value: unknown) => void
      jest.mocked(sparkGetLnAddress).mockImplementationOnce(() => new Promise(resolve => (readAddress = resolve)) as never)
      return () =>
        ReactTestRenderer.act(async () => {
          readAddress(ADDRESS)
        })
    }
    // A due sweep beside the sheet, on the sheet's own wallet, with no earlier case's ask on file to
    // hold it back. A sweep keeps and claims lines for the wallet it asks for.
    async function sweep(charges: unknown[]): Promise<unknown> {
      const { recoverPurchases } = jest.requireActual('../src/wallet/recover') as typeof import('../src/wallet/recover')
      const asked = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`
      if (await RNFS.exists(asked)) {
        await RNFS.unlink(asked)
      }
      return recoverPurchases({
        walletId: 'primary',
        lines: lines.scopeOn('primary'),
        pubkey: `02${'a'.repeat(64)}`,
        sign: async () => 'sig',
        request: (async () => ({ ok: true, status: 200, json: async () => ({ charges }) })) as unknown as typeof fetch,
      })
    }
    const CHARGE = { reference: 'ref-1', kind: 'name', domain: 'lnurl.usevoltz.app', subject: 'alice', amountSats: 19800 }

    beforeEach(async () => {
      await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    })

    // Nothing is said while the address is read, so a sheet closed then keeps the line for the next
    // opening, which says it once.
    test('a holder answer whose sheet closed during the address read is said once, by the next opening', async () => {
      confirm.mockRejectedValue(answers.paidAgain())
      const letRead = holdAddressRead()
      const tree = await render()
      await settle()
      const sights = [says(tree, 'paidAgain')]
      await shown(tree, false)
      await letRead()
      await settle()
      expect(await lines.listLines()).toEqual([
        { kind: 'name', reference: 'ref-1', answer: 'paidAgain', subject: 'alice@lnurl.usevoltz.app' },
      ])
      expect(await purchase.loadPending('name')).toBeNull()
      await shown(tree, true)
      await settle()
      sights.push(says(tree, 'paidAgain'))
      await reopen(tree)
      sights.push(says(tree, 'paidAgain'))
      expect(sights).toEqual([false, true, false])
      expect(await lines.listLines()).toEqual([])
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    })

    // The same read with the sheet closed and opened again before it ends, so the answer is decided
    // on the reopened sheet, which says it once.
    test('a holder answer whose sheet closed and opened again during the address read is said once', async () => {
      confirm.mockRejectedValue(answers.paidAgain())
      const letRead = holdAddressRead()
      const tree = await render()
      await settle()
      const sights = [says(tree, 'paidAgain')]
      await reopen(tree)
      sights.push(says(tree, 'paidAgain'))
      await letRead()
      await settle()
      sights.push(says(tree, 'paidAgain'))
      expect(await lines.listLines()).toEqual([])
      await reopen(tree)
      sights.push(says(tree, 'paidAgain'))
      expect(sights).toEqual([false, false, true, false])
      expect(await lines.listLines()).toEqual([])
      expect(await purchase.loadPending('name')).toBeNull()
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    // A sheet that said the line, closed and opened again before the slot was given up reads the proof
    // as held. Once the slot is given up it goes on to a fresh quote, never saying the line again.
    test('a sheet opened again after saying a line, before the slot was given up, goes on to a fresh quote', async () => {
      confirm.mockRejectedValue(answers.repaid())
      const realRelease = purchase.releasePending
      let released!: () => void
      const gate = new Promise<void>(resolve => (released = resolve))
      const release = jest.spyOn(purchase, 'releasePending').mockImplementationOnce(async (...args) => {
        await gate
        await realRelease(...args)
      })
      const tree = await render()
      await settle()
      const sights = [says(tree, 'repaid')]
      await reopen(tree)
      sights.push(says(tree, 'repaid'))
      await ReactTestRenderer.act(async () => {
        released()
      })
      await settle()
      release.mockRestore()
      sights.push(says(tree, 'repaid'))
      expect(sights).toEqual([true, false, false])
      expect(texts(tree).join(' ')).toContain('See the price')
      expect(await purchase.loadPending('name')).toBeNull()
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    // A price asked on a released slot belongs to the name it was asked for, so the field moving to
    // another name drops it, and no Pay can buy a name the field no longer shows.
    async function expectFreshQuoteFollowsTheField(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
      quote.mockImplementation(async (_deps: unknown, name: string) => ({
        username: name,
        priceUsdCents: 990,
        amountSats: 19800,
        invoice: `lnbc-${name}`,
        reference: `ref-${name}`,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      }))
      await type(tree, 'xavier')
      await settle()
      await press(tree, 'See the price')
      expect(texts(tree).join(' ')).toContain('xavier costs')
      await type(tree, 'yara')
      await settle()
      const shownNow = texts(tree).join(' ')
      expect(shownNow).not.toContain('xavier costs')
      expect(shownNow).not.toContain('Pay and take the name')
      const spark = jest.requireMock('../src/wallet/spark') as Record<string, jest.Mock>
      expect(spark.sparkPrepareSend).not.toHaveBeenCalled()
      // Closing on that field leaves no proof of a quote nobody paid.
      const back = tree.root.findAll(n => n.props.accessibilityLabel === 'Back')[0]
      await ReactTestRenderer.act(async () => {
        back!.props.onPress()
      })
      await settle()
      expect(await purchase.loadPending('name')).toBeNull()
    }

    // The reopened opening read the proof as held, which marks the sheet as paid; the slot given up
    // after it leaves the sheet unpaid.
    test('a sheet opened again before the slot was given up drops a fresh price when the field changes', async () => {
      confirm.mockRejectedValue(answers.repaid())
      const realRelease = purchase.releasePending
      let released!: () => void
      const gate = new Promise<void>(resolve => (released = resolve))
      const release = jest.spyOn(purchase, 'releasePending').mockImplementationOnce(async (...args) => {
        await gate
        await realRelease(...args)
      })
      const tree = await render()
      await settle()
      await reopen(tree)
      await ReactTestRenderer.act(async () => {
        released()
      })
      await settle()
      release.mockRestore()
      expect(texts(tree).join(' ')).toContain('See the price')
      await expectFreshQuoteFollowsTheField(tree)
    })

    // A sheet closed and opened again while its claim is out reads the proof as held, then says the
    // line; the next opening finds the slot given up and offers a price that follows the field.
    test('a sheet opened again while it claims, then opened once more, drops a fresh price when the field changes', async () => {
      let answer!: (err: Error) => void
      confirm.mockImplementationOnce(() => new Promise((_, reject) => (answer = reject)))
      const tree = await render()
      await settle()
      const realExists = RNFS.exists.bind(RNFS)
      let claimed!: () => void
      const gate = new Promise<void>(resolve => (claimed = resolve))
      let reading = false
      const exists = jest.spyOn(RNFS, 'exists').mockImplementation(async path => {
        if (path === LINES_FILE && !reading) {
          reading = true
          await gate
        }
        return realExists(path)
      })
      await ReactTestRenderer.act(async () => {
        answer(answers.repaid())
      })
      await settle()
      await reopen(tree)
      await ReactTestRenderer.act(async () => {
        claimed()
      })
      await settle()
      exists.mockRestore()
      expect(reading).toBe(true)
      expect(says(tree, 'repaid')).toBe(true)
      await reopen(tree)
      expect(says(tree, 'repaid')).toBe(false)
      expect(texts(tree).join(' ')).toContain('See the price')
      await expectFreshQuoteFollowsTheField(tree)
    })

    // An opening while the Pay prepares its send reads the unpaid record as no proof. The send goes out
    // after it, so closing on the settling payment keeps its proof.
    test('a sheet opened again while its Pay prepares the send keeps the proof of the payment it makes', async () => {
      await purchase.clearPending('name', 'ref-1')
      const spark = jest.requireMock('../src/wallet/spark') as Record<string, jest.Mock>
      let prepared!: () => void
      spark.sparkPrepareSend!.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            prepared = () => resolve({ handle: 'h-1', amount: 19800, fee: 0 })
          }),
      )
      confirm.mockResolvedValue(false)
      const tree = await render()
      await type(tree, 'alice')
      await settle()
      await press(tree, 'See the price')
      await press(tree, 'Pay and take the name')
      await reopen(tree)
      await ReactTestRenderer.act(async () => {
        prepared()
      })
      await settle()
      expect(texts(tree).join(' ')).toContain('Check again')
      const back = tree.root.findAll(n => n.props.accessibilityLabel === 'Back')[0]
      await ReactTestRenderer.act(async () => {
        back!.props.onPress()
      })
      await settle()
      expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-1', subject: 'alice' })
    })

    // An opening that read the proof marks the sheet as paid on it, and the grant clears the slot. The
    // sheet stays mounted after the name is registered, so its next opening reads no proof and stands
    // on no payment.
    test('a sheet opened again after a resumed name was granted offers a price that follows the field', async () => {
      jest.mocked(sparkRegisterLnAddress).mockResolvedValueOnce({ username: 'alice', address: 'alice@lnurl.usevoltz.app', lnurl: 'l' })
      const onRegistered = jest.fn()
      const tree = await render(onRegistered)
      await settle()
      expect(onRegistered).toHaveBeenCalledTimes(1)
      expect(await purchase.loadPending('name')).toBeNull()
      await reopen(tree)
      expect(texts(tree).join(' ')).toContain('See the price')
      await expectFreshQuoteFollowsTheField(tree)
    })

    // A line said before is on no frame the sheet opened again commits. Each commit is read in a layout
    // effect beside the sheet, which runs before anything the commit schedules is drawn.
    test('a sheet opened again commits no frame with the line it said before', async () => {
      confirm.mockRejectedValue(answers.repaid())
      const frames: boolean[] = []
      let tree!: ReactTestRenderer.ReactTestRenderer
      function Frames(): null {
        useLayoutEffect(() => {
          frames.push(says(tree, 'repaid'))
        })
        return null
      }
      const shownWith = (visible: boolean) => (
        <>
          <LnAddressSheet visible={visible} onClose={jest.fn()} onRegistered={jest.fn()} />
          <Frames />
        </>
      )
      await ReactTestRenderer.act(async () => {
        tree = ReactTestRenderer.create(shownWith(true))
      })
      await settle()
      expect(says(tree, 'repaid')).toBe(true)
      await ReactTestRenderer.act(async () => {
        tree.update(shownWith(false))
      })
      frames.length = 0
      await ReactTestRenderer.act(async () => {
        tree.update(shownWith(true))
      })
      await settle()
      expect(frames.length).toBeGreaterThan(0)
      expect(frames).not.toContain(true)
      expect(texts(tree).join(' ')).toContain('See the price')
    })

    // A sheet closed when the answer lands keeps the line before it gives the slot up, so a
    // process ended between the two leaves the proof, whose next confirmation hears the same answer.
    test('a sheet closed when the answer lands keeps the line while the slot still holds its proof', async () => {
      let answer!: (err: Error) => void
      confirm.mockImplementationOnce(() => new Promise((_, reject) => (answer = reject)))
      const tree = await render()
      await settle()
      await shown(tree, false)
      const realNote = lines.noteLine
      const heldAtNote: (string | null)[] = []
      const note = jest.spyOn(lines, 'noteLine').mockImplementation(async (kept, scope) => {
        heldAtNote.push((await purchase.loadPending('name'))?.reference ?? null)
        await realNote(kept, scope)
      })
      await ReactTestRenderer.act(async () => {
        answer(answers.repaid())
      })
      await settle()
      note.mockRestore()
      expect(heldAtNote).toEqual(['ref-1'])
      expect(await purchase.loadPending('name')).toBeNull()
    })

    // The line of an answer heard by a closed sheet is kept for the wallet the question was asked on,
    // never for one a switch made active while the question was out.
    test('a sheet closed when the answer lands after a switch keeps the line on the wallet that asked', async () => {
      let answer!: (err: Error) => void
      confirm.mockImplementationOnce(() => new Promise((_, reject) => (answer = reject)))
      const tree = await render()
      await settle()
      await shown(tree, false)
      const switched = jest.spyOn(registry, 'getActiveWalletId').mockResolvedValue('w_b')
      try {
        await ReactTestRenderer.act(async () => {
          answer(answers.repaid())
        })
        await settle()
      } finally {
        switched.mockRestore()
      }
      expect(await lines.listLines('primary')).toEqual([
        { kind: 'name', reference: 'ref-1', answer: 'repaid', subject: 'alice@lnurl.usevoltz.app' },
      ])
      expect(await lines.listLines('w_b')).toEqual([])
    })

    // The slot an answer gives up, or the mark it leaves, belongs to the wallet the question was asked
    // on. The wallet switched to holds a proof of its own, which the answer never touches. The release
    // and the mark name the reference, so one sent to the wallet switched to would land nowhere and leave
    // the asked wallet's proof held and unmarked.
    const B_PROOF = { kind: 'name' as const, subject: 'bob', reference: 'ref-b', amountSats: 19800 }
    test.each([
      ['open', 'gives up', 'repaid', true, true],
      ['closed', 'gives up', 'repaid', false, true],
      ['open', 'marks for good', 'repaidFalse', true, true],
      ['open', 'gives up, with no switch,', 'repaid', true, false],
      ['closed', 'gives up, with no switch,', 'repaid', false, false],
    ] as const)('a sheet %s when the answer lands %s the slot of the wallet that asked', async (_, __, which, open, switches) => {
      await purchase.savePending(B_PROOF, 'w_b')
      let answer!: (err: Error) => void
      confirm.mockImplementationOnce(() => new Promise((___, reject) => (answer = reject)))
      const tree = await render()
      await settle()
      if (!open) {
        await shown(tree, false)
      }
      const switched = switches ? jest.spyOn(registry, 'getActiveWalletId').mockResolvedValue('w_b') : null
      try {
        await ReactTestRenderer.act(async () => {
          answer(answers[which]())
        })
        await settle()
      } finally {
        switched?.mockRestore()
      }
      if (which === 'repaid') {
        expect(await purchase.loadPending('name', 'primary')).toBeNull()
      } else {
        expect(await purchase.loadPending('name', 'primary')).toMatchObject({ reference: 'ref-1', refusedForGood: true })
      }
      expect(await purchase.loadPending('name', 'w_b')).toEqual(B_PROOF)
    })

    // A list file that cannot be read answers a claim as unknown, and the sheet still says the answer it
    // heard itself, writing nothing over the file.
    test('an open sheet says its own fresh answer when the list cannot be read, and leaves the file', async () => {
      const torn = '{"primary": [{"kind": "na'
      await RNFS.writeFile(LINES_FILE, torn, 'utf8')
      confirm.mockRejectedValue(answers.repaid())
      const tree = await render()
      await settle()
      expect(says(tree, 'repaid')).toBe(true)
      expect(await purchase.loadPending('name')).toBeNull()
      const read = (RNFS as unknown as { readFile(p: string, e: string): Promise<string> }).readFile
      expect(await read(LINES_FILE, 'utf8')).toBe(torn)
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    // A holder's paid-again answer releases the slot though it owes the sats back, so a clear that never
    // lands after it leaves a record marked as given up, which no later opening confirms or says again,
    // as the record of an answer that owes nothing already was.
    test.each(['paidAgain', 'repaid'] as const)('a %s answer whose clear never landed is neither asked about nor said again', async which => {
      confirm.mockRejectedValue(answers[which]())
      const realUnlink = RNFS.unlink.bind(RNFS)
      let refused = false
      // The removal of the emptied store, which the clear makes. A write renames its copy over the store
      // and never unlinks it, so this is the only unlink of the store there is to refuse.
      const unlink = jest.spyOn(RNFS, 'unlink').mockImplementation(async path => {
        if (path === STORE && !refused) {
          refused = true
          throw new Error('EIO')
        }
        return realUnlink(path)
      })
      const tree = await render()
      await settle()
      unlink.mockRestore()
      expect(refused).toBe(true)
      expect(says(tree, which)).toBe(true)
      expect(await RNFS.exists(STORE)).toBe(true)
      expect(await purchase.loadPending('name')).toBeNull()
      await reopen(tree)
      expect(says(tree, which)).toBe(false)
      expect(texts(tree).join(' ')).toContain('See the price')
      await ReactTestRenderer.act(async () => {
        tree.unmount()
      })
      const restarted = await render()
      await settle()
      expect(says(restarted, which)).toBe(false)
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    // An open sheet in an app sent to the background is seen by nobody, so the answer heard there is
    // kept for the next view and said once by it.
    test('an answer heard while the app is in the background is kept for the next opening, which says it once', async () => {
      let answer!: (err: Error) => void
      confirm.mockImplementationOnce(() => new Promise((_, reject) => (answer = reject)))
      const tree = await render()
      await settle()
      appMovesTo('background')
      await ReactTestRenderer.act(async () => {
        answer(answers.repaid())
      })
      await settle()
      const sights = [says(tree, 'repaid')]
      expect(await lines.listLines()).toEqual([
        { kind: 'name', reference: 'ref-1', answer: 'repaid', subject: 'alice@lnurl.usevoltz.app' },
      ])
      expect(await purchase.loadPending('name')).toBeNull()
      appMovesTo('active')
      await reopen(tree)
      sights.push(says(tree, 'repaid'))
      await reopen(tree)
      sights.push(says(tree, 'repaid'))
      expect(sights).toEqual([false, true, false])
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    // The app sent to the background while the claim is out paints nothing, as a closing sheet does.
    test('an app sent to the background while the sheet claims leaves the line for the next opening', async () => {
      let answer!: (err: Error) => void
      confirm.mockImplementationOnce(() => new Promise((_, reject) => (answer = reject)))
      const tree = await render()
      await settle()
      const realExists = RNFS.exists.bind(RNFS)
      let claimed!: () => void
      const gate = new Promise<void>(resolve => (claimed = resolve))
      let reading = false
      const exists = jest.spyOn(RNFS, 'exists').mockImplementation(async path => {
        if (path === LINES_FILE && !reading) {
          reading = true
          await gate
        }
        return realExists(path)
      })
      await ReactTestRenderer.act(async () => {
        answer(answers.repaid())
      })
      await settle()
      appMovesTo('background')
      await ReactTestRenderer.act(async () => {
        claimed()
      })
      await settle()
      exists.mockRestore()
      expect(reading).toBe(true)
      const sights = [says(tree, 'repaid')]
      expect(await lines.listLines()).toEqual([
        { kind: 'name', reference: 'ref-1', answer: 'repaid', subject: 'alice@lnurl.usevoltz.app' },
      ])
      appMovesTo('active')
      await reopen(tree)
      sights.push(says(tree, 'repaid'))
      expect(sights).toEqual([false, true])
    })

    // A sheet closed while its claim is out paints nothing and leaves the line for the next opening.
    test('a sheet closed while it claims leaves the line for the next opening, which says it once', async () => {
      let answer!: (err: Error) => void
      confirm.mockImplementationOnce(() => new Promise((_, reject) => (answer = reject)))
      const tree = await render()
      await settle()
      // Holds the claim's read of the list, the first the sheet makes with a proof held.
      const realExists = RNFS.exists.bind(RNFS)
      let claimed!: () => void
      const gate = new Promise<void>(resolve => (claimed = resolve))
      let reading = false
      const exists = jest.spyOn(RNFS, 'exists').mockImplementation(async path => {
        if (path === LINES_FILE && !reading) {
          reading = true
          await gate
        }
        return realExists(path)
      })
      await ReactTestRenderer.act(async () => {
        answer(answers.repaid())
      })
      await settle()
      const sights = [says(tree, 'repaid')]
      await shown(tree, false)
      await ReactTestRenderer.act(async () => {
        claimed()
      })
      await settle()
      exists.mockRestore()
      expect(reading).toBe(true)
      expect(await lines.listLines()).toEqual([
        { kind: 'name', reference: 'ref-1', answer: 'repaid', subject: 'alice@lnurl.usevoltz.app' },
      ])
      await shown(tree, true)
      await settle()
      sights.push(says(tree, 'repaid'))
      await reopen(tree)
      sights.push(says(tree, 'repaid'))
      expect(sights).toEqual([false, true, false])
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    // Left open through the address read, the line is said once it is read.
    test('a holder answer whose sheet stays open through the address read is said once', async () => {
      confirm.mockRejectedValue(answers.paidAgain())
      const letRead = holdAddressRead()
      const tree = await render()
      await settle()
      const sights = [says(tree, 'paidAgain')]
      await letRead()
      await settle()
      sights.push(says(tree, 'paidAgain'))
      await reopen(tree)
      sights.push(says(tree, 'paidAgain'))
      expect(sights).toEqual([false, true, false])
      expect(await lines.listLines()).toEqual([])
    })

    // Heard while the sheet is closed, and the sheet opened again while the line is noted. The
    // reopened sheet takes the line, so the next opening does not say it again.
    test('an answer kept while the sheet was closed and said by the sheet reopened meanwhile is said once', async () => {
      let answer!: (err: Error) => void
      confirm.mockImplementationOnce(() => new Promise((_, reject) => (answer = reject)))
      const realNote = lines.noteLine
      let noted!: () => void
      const gate = new Promise<void>(resolve => (noted = resolve))
      const note = jest.spyOn(lines, 'noteLine').mockImplementationOnce(async (line, scope) => {
        await realNote(line, scope)
        await gate
      })
      const tree = await render()
      await settle()
      await shown(tree, false)
      await ReactTestRenderer.act(async () => {
        answer(answers.repaid())
      })
      await settle()
      await shown(tree, true)
      await settle()
      await ReactTestRenderer.act(async () => {
        noted()
      })
      await settle()
      note.mockRestore()
      const sights = [says(tree, 'repaid')]
      expect(await lines.listLines()).toEqual([])
      await reopen(tree)
      sights.push(says(tree, 'repaid'))
      expect(sights).toEqual([true, false])
      expect(await purchase.loadPending('name')).toBeNull()
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    // A due sweep asks about the charge of the proof the open sheet asks about, and hears first. Its
    // card says the line, and the sheet passes over it to a fresh quote.
    test('a line the sweep heard first is its card, and the open sheet hearing it after does not say it', async () => {
      let sheetAnswer!: (err: Error) => void
      confirm.mockImplementationOnce(() => new Promise((_, reject) => (sheetAnswer = reject)))
      confirm.mockImplementationOnce(async () => {
        throw answers.repaid()
      })
      const tree = await render()
      await settle()
      const card = await sweep([CHARGE])
      expect(card).toMatchObject({ status: 'repaid', reference: 'ref-1' })
      await ReactTestRenderer.act(async () => {
        sheetAnswer(answers.repaid())
      })
      await settle()
      expect(says(tree, 'repaid')).toBe(false)
      expect(texts(tree).join(' ')).toContain('See the price')
      expect(await lines.listLines()).toEqual([])
      expect(await purchase.loadPending('name')).toBeNull()
      expect(confirm).toHaveBeenCalledTimes(2)
    })

    // With the open sheet hearing first, the sheet says it, and the sweep hearing it after keeps
    // nothing, so its card is not that line.
    test('a line the open sheet heard first is said there, and the sweep hearing it after has no card', async () => {
      let sheetAnswer!: (err: Error) => void
      let sweepAnswer!: (err: Error) => void
      confirm.mockImplementationOnce(() => new Promise((_, reject) => (sheetAnswer = reject)))
      confirm.mockImplementationOnce(() => new Promise((_, reject) => (sweepAnswer = reject)))
      const tree = await render()
      await settle()
      const card = sweep([CHARGE])
      await settle()
      expect(confirm).toHaveBeenCalledTimes(2)
      await ReactTestRenderer.act(async () => {
        sheetAnswer(answers.repaid())
      })
      await settle()
      expect(says(tree, 'repaid')).toBe(true)
      sweepAnswer(answers.repaid())
      expect(await card).toBeNull()
      expect(await lines.listLines()).toEqual([])
      expect(says(tree, 'repaid')).toBe(true)
    })

    // A sweep that lists nothing leaves the sheet to say the line once.
    test('a sweep that lists nothing leaves the line to the open sheet', async () => {
      let sheetAnswer!: (err: Error) => void
      confirm.mockImplementationOnce(() => new Promise((_, reject) => (sheetAnswer = reject)))
      const tree = await render()
      await settle()
      expect(await sweep([])).toBeNull()
      await ReactTestRenderer.act(async () => {
        sheetAnswer(answers.repaid())
      })
      await settle()
      expect(says(tree, 'repaid')).toBe(true)
    })

    // A crash between saying the line and giving the slot up leaves the reference recorded as shown
    // and the proof held. The next opening confirms again, as the residue allows, and does not say the
    // line again.
    test('a fresh answer to a reference shown before a restart is not said again', async () => {
      expect(await lines.claimLine('ref-1', await lines.activeScope())).toEqual({ outcome: 'claimed', line: null })
      confirm.mockRejectedValue(answers.repaid())
      const tree = await render()
      await settle()
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(says(tree, 'repaid')).toBe(false)
      expect(texts(tree).join(' ')).toContain('See the price')
      expect(await purchase.loadPending('name')).toBeNull()
      expect(await lines.listLines()).toEqual([])
    })

    // A wait is about a proof in the slot, and the sweep shares the slot: once it gives the proof up,
    // no line says the name is coming and no confirmation goes out for it.
    describe('a wait whose proof the sweep gave up', () => {
      const RECORD_UNREAD = recover.recordUnread!
      const SETTLING = (JSON.parse(fs.readFileSync(join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as {
        receive: Record<string, string>
      }).receive.lnSettling!
      const spark = jest.requireMock('../src/wallet/spark') as Record<string, jest.Mock>
      // The sweep beside the sheet, its writes inside act so the sheet hears them as the app does.
      // `seen` false is a sweep whose card nobody can see, which keeps the line for the next view.
      async function sweepGivesUp(seen = true): Promise<unknown> {
        confirm.mockRejectedValueOnce(answers.repaid())
        const asked = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`
        if (await RNFS.exists(asked)) {
          await RNFS.unlink(asked)
        }
        const { recoverPurchases } = jest.requireActual('../src/wallet/recover') as typeof import('../src/wallet/recover')
        let card: unknown
        await ReactTestRenderer.act(async () => {
          card = await recoverPurchases({
            walletId: 'primary',
            lines: lines.scopeOn('primary'),
            pubkey: `02${'a'.repeat(64)}`,
            sign: async () => 'sig',
            onScreen: () => seen,
            request: (async () => ({ ok: true, status: 200, json: async () => ({ charges: [CHARGE] }) })) as unknown as typeof fetch,
          })
        })
        expect(await purchase.loadPending('name')).toBeNull()
        return card
      }
      // The sheet's first question lost to the network, which leaves it waiting on the payment.
      async function waiting(): Promise<ReactTestRenderer.ReactTestRenderer> {
        confirm.mockRejectedValueOnce(new Error('SdkError.NetworkError'))
        const tree = await render()
        await settle()
        expect(texts(tree).join(' ')).toContain('Payment made')
        expect(texts(tree).join(' ')).toContain('Check again')
        return tree
      }
      // The wallet's identity read of the next question, held until the case lets it go.
      function holdIdentity(): () => Promise<void> {
        let answer!: () => void
        spark.sparkGetIdentityPubkey!.mockImplementationOnce(
          () => new Promise(resolve => (answer = () => resolve(`02${'a'.repeat(64)}`))),
        )
        return () =>
          ReactTestRenderer.act(async () => {
            answer()
          })
      }
      function expectFresh(tree: ReactTestRenderer.ReactTestRenderer): void {
        const shownNow = texts(tree).join(' ')
        expect(shownNow).not.toContain('Payment made')
        expect(shownNow).not.toContain('Check again')
        expect(shownNow).not.toContain('Pay and take the name')
        expect(shownNow).toContain('See the price')
      }

      // The cleanup review's probe: the sheet's question lost to the network, the sweep heard the
      // sats came back and gave the slot up, and the sheet opened again.
      test('a sheet opened again after the sweep gave its proof up offers a fresh quote and asks nothing', async () => {
        const tree = await waiting()
        await shown(tree, false)
        expect(await sweepGivesUp()).toMatchObject({ status: 'repaid', reference: 'ref-1' })
        await shown(tree, true)
        await settle()
        expectFresh(tree)
        expect(says(tree, 'repaid')).toBe(false)
        expect(confirm).toHaveBeenCalledTimes(2)
      })

      test('a sheet left open drops its wait once the sweep gives the proof up', async () => {
        const tree = await waiting()
        expect(await sweepGivesUp()).toMatchObject({ status: 'repaid', reference: 'ref-1' })
        await settle()
        expectFresh(tree)
        expect(confirm).toHaveBeenCalledTimes(2)
      })

      // The proof given up while Check again reads the wallet, so the press is past the line's drop.
      test('a Check again whose proof the sweep gives up meanwhile sends no confirmation', async () => {
        const tree = await waiting()
        const letIdentity = holdIdentity()
        await press(tree, 'Check again')
        await sweepGivesUp()
        await letIdentity()
        await settle()
        expectFresh(tree)
        expect(confirm).toHaveBeenCalledTimes(2)
      })

      // The opening read the proof, which the sweep gave up before the question, keeping the line for
      // the next view. The opening goes on as one that read no proof, so it takes that line and says it.
      test('an opening whose proof the sweep gives up before it asks sends nothing and says the kept line once', async () => {
        const letIdentity = holdIdentity()
        const tree = await render()
        expect(await sweepGivesUp(false)).toBeNull()
        expect(await lines.listLines()).toHaveLength(1)
        await letIdentity()
        await settle()
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(says(tree, 'repaid')).toBe(true)
        expect(texts(tree).join(' ')).not.toContain('Payment made')
        expect(await lines.listLines()).toEqual([])
        await reopen(tree)
        expectFresh(tree)
        expect(confirm).toHaveBeenCalledTimes(1)
      })

      // A Pay that met the sweep's proof sent nothing and waits on that proof, with its own quote behind
      // the wait and the field naming the awaited name. Once the sweep gives that proof up, neither the
      // quote nor the paid flag it left stays, so no price for one name sits under a field showing
      // another, and a fresh price follows the field.
      test('a Pay that met the sweep\'s proof leaves no price behind once the sweep gives it up', async () => {
        await purchase.clearPending('name', 'ref-1')
        quote.mockImplementation(async (_deps: unknown, name: string) => ({
          username: name,
          priceUsdCents: 990,
          amountSats: 19800,
          invoice: `lnbc-${name}`,
          reference: `ref-${name}`,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        }))
        const tree = await render()
        await type(tree, 'bob')
        await settle()
        await press(tree, 'See the price')
        expect(texts(tree).join(' ')).toContain('bob costs')
        await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
        await press(tree, 'Pay and take the name')
        await settle()
        expect(texts(tree).join(' ')).toContain('Payment made')
        expect(spark.sparkPrepareSend).not.toHaveBeenCalled()
        await sweepGivesUp()
        await settle()
        expectFresh(tree)
        expect(texts(tree).join(' ')).not.toContain('bob costs')
        await expectFreshQuoteFollowsTheField(tree)
      })

      // Whatever emptied the slot, an opening that reads no proof shows no wait it still carries.
      test('an opening that reads no proof drops the wait it still carries', async () => {
        const tree = await waiting()
        await shown(tree, false)
        await RNFS.unlink(STORE)
        await shown(tree, true)
        await settle()
        expectFresh(tree)
        expect(confirm).toHaveBeenCalledTimes(1)
      })

      // A slot that cannot be read is not a proof gone: nothing is asked and the sheet says it cannot
      // tell, never that the name is coming.
      test('a Check again whose read of the slot fails sends nothing and says no name is coming', async () => {
        const tree = await waiting()
        await RNFS.writeFile(STORE, '{"primary":', 'utf8')
        await press(tree, 'Check again')
        await settle()
        const shownNow = texts(tree).join(' ')
        expect(shownNow).toContain(RECORD_UNREAD)
        expect(shownNow).not.toContain('Payment made')
        expect(shownNow).not.toContain('See the price')
        expect(confirm).toHaveBeenCalledTimes(1)
      })

      // A Check again whose question was out when the sweep gave the proof up, and which then lost to
      // the network, says nothing of the payment, whose line would read that the name is coming.
      test('a Check again out when the sweep gives the proof up, and failing after, leaves no line that the name is coming', async () => {
        const tree = await waiting()
        let fail!: (err: Error) => void
        confirm.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
        await press(tree, 'Check again')
        await sweepGivesUp()
        await ReactTestRenderer.act(async () => {
          fail(new Error('SdkError.NetworkError'))
        })
        await settle()
        expectFresh(tree)
        expect(confirm).toHaveBeenCalledTimes(3)
      })

      // A send that failed gives its proof up, which the sheet hears; paying the same quote again writes
      // it back, so a later question that fails still stands on that payment.
      test('a quote paid again after a send that failed keeps its wait through a failed Check again', async () => {
        await purchase.clearPending('name', 'ref-1')
        const tree = await render()
        await type(tree, 'alice')
        await settle()
        await press(tree, 'See the price')
        jest.mocked(sparkConfirmSend).mockResolvedValueOnce('failed')
        await press(tree, 'Pay and take the name')
        await settle()
        expect(texts(tree).join(' ')).toContain('alice costs')
        confirm.mockRejectedValueOnce(new Error('SdkError.NetworkError'))
        await press(tree, 'Pay and take the name')
        await settle()
        expect(texts(tree).join(' ')).toContain('Payment made')
        confirm.mockRejectedValueOnce(new Error('SdkError.NetworkError'))
        await press(tree, 'Check again')
        await settle()
        const shownNow = texts(tree).join(' ')
        expect(shownNow).toContain('Payment made')
        expect(shownNow).toContain('Check again')
        expect(shownNow).not.toContain('See the price')
        expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-1' })
      })

      // A send reported failed whose charge the gateway lists after all: the sweep files its proof back,
      // and a question about it that fails still stands on that payment.
      test('a proof the sweep files back after a send that failed keeps its wait through a failed question', async () => {
        await purchase.clearPending('name', 'ref-1')
        const tree = await render()
        await type(tree, 'alice')
        await settle()
        await press(tree, 'See the price')
        jest.mocked(sparkConfirmSend).mockResolvedValueOnce('failed')
        await press(tree, 'Pay and take the name')
        await settle()
        await shown(tree, false)
        confirm.mockResolvedValueOnce(false)
        const asked = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`
        if (await RNFS.exists(asked)) {
          await RNFS.unlink(asked)
        }
        const { recoverPurchases } = jest.requireActual('../src/wallet/recover') as typeof import('../src/wallet/recover')
        await ReactTestRenderer.act(async () => {
          await recoverPurchases({
            walletId: 'primary',
            lines: lines.scopeOn('primary'),
            pubkey: `02${'a'.repeat(64)}`,
            sign: async () => 'sig',
            onScreen: () => false,
            request: (async () => ({ ok: true, status: 200, json: async () => ({ charges: [CHARGE] }) })) as unknown as typeof fetch,
          })
        })
        expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-1' })
        confirm.mockRejectedValueOnce(new Error('SdkError.NetworkError'))
        await shown(tree, true)
        await settle()
        const shownNow = texts(tree).join(' ')
        expect(shownNow).toContain('Payment made')
        expect(shownNow).toContain('Check again')
        expect(shownNow).not.toContain('See the price')
        expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-1' })
      })

      // How a proof left decides only what a drop shows, never that a wait drops. A send reported failed
      // leaves the sheet having heard its proof gone, and the sweep files it back while the sheet is
      // closed; the opening's question then fails at the wallet's identity read, before it reads the
      // slot. The slot read after the failure still holds the proof, so the wait stands with the line
      // the opening says for a failure, and no price.
      // Answers the sheet and the confirmations sent before it opened, the sweep's among them.
      async function filedBackThenOpened(fail: () => Promise<string>): Promise<[ReactTestRenderer.ReactTestRenderer, number]> {
        await purchase.clearPending('name', 'ref-1')
        const tree = await render()
        await type(tree, 'alice')
        await settle()
        await press(tree, 'See the price')
        jest.mocked(sparkConfirmSend).mockResolvedValueOnce('failed')
        await press(tree, 'Pay and take the name')
        await settle()
        await shown(tree, false)
        confirm.mockResolvedValueOnce(false)
        const asked = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`
        if (await RNFS.exists(asked)) {
          await RNFS.unlink(asked)
        }
        const { recoverPurchases } = jest.requireActual('../src/wallet/recover') as typeof import('../src/wallet/recover')
        await ReactTestRenderer.act(async () => {
          await recoverPurchases({
            walletId: 'primary',
            lines: lines.scopeOn('primary'),
            pubkey: `02${'a'.repeat(64)}`,
            sign: async () => 'sig',
            onScreen: () => false,
            request: (async () => ({ ok: true, status: 200, json: async () => ({ charges: [CHARGE] }) })) as unknown as typeof fetch,
          })
        })
        expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-1' })
        spark.sparkGetIdentityPubkey!.mockImplementationOnce(fail)
        const confirms = confirm.mock.calls.length
        await shown(tree, true)
        await settle()
        return [tree, confirms]
      }

      test('a proof the sweep files back after a send that failed keeps its wait when the identity read fails', async () => {
        const [tree, confirms] = await filedBackThenOpened(async () => {
          throw new Error('spark not connected')
        })
        const shownNow = texts(tree).join(' ')
        expect(shownNow).toContain(SETTLING)
        expect(shownNow).toContain('Check again')
        expect(shownNow).not.toContain('See the price')
        expect(shownNow).not.toContain('Pay and take the name')
        expect(confirm).toHaveBeenCalledTimes(confirms)
        expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-1' })
      })

      // The same failure with a slot that cannot be read after it drops nothing either: the sheet says it
      // cannot tell, and nothing is asked.
      test('a proof filed back whose identity read fails, with the slot unreadable after, says the sheet cannot tell', async () => {
        const [tree, confirms] = await filedBackThenOpened(async () => {
          await RNFS.writeFile(STORE, '{"primary":', 'utf8')
          throw new Error('spark not connected')
        })
        const shownNow = texts(tree).join(' ')
        expect(shownNow).toContain(RECORD_UNREAD)
        expect(shownNow).not.toContain('See the price')
        expect(shownNow).not.toContain('Pay and take the name')
        expect(confirm).toHaveBeenCalledTimes(confirms)
        expect(await RNFS.exists(STORE)).toBe(true)
      })

      // A Pay for another name that meets a proof heard gone and filed back waits on that proof, which a
      // Check again then asks about. Its question fails at the identity read, the slot read after still
      // holds the proof, and the wait stands with the press's line and no price.
      test('a Pay that meets a proof heard gone and filed back keeps that wait through a Check again whose identity read fails', async () => {
        await purchase.clearPending('name', 'ref-1')
        quote.mockImplementation(async (_deps: unknown, name: string) => ({
          username: name,
          priceUsdCents: 990,
          amountSats: 19800,
          invoice: `lnbc-${name}`,
          reference: `ref-${name}`,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        }))
        const tree = await render()
        await type(tree, 'bob')
        await settle()
        await press(tree, 'See the price')
        const alice = { kind: 'name' as const, subject: 'alice', reference: 'ref-1', amountSats: 19800 }
        await ReactTestRenderer.act(async () => {
          await purchase.savePending(alice)
          await purchase.clearPending('name', 'ref-1')
          await purchase.savePending(alice)
        })
        await press(tree, 'Pay and take the name')
        await settle()
        expect(texts(tree).join(' ')).toContain('Payment made')
        spark.sparkGetIdentityPubkey!.mockRejectedValueOnce(new Error('spark not connected'))
        const confirms = confirm.mock.calls.length
        await press(tree, 'Check again')
        await settle()
        const shownNow = texts(tree).join(' ')
        expect(shownNow).toContain(SETTLING)
        expect(shownNow).toContain('Check again')
        expect(shownNow).not.toContain('See the price')
        expect(shownNow).not.toContain('bob costs')
        expect(confirm).toHaveBeenCalledTimes(confirms)
        expect(await purchase.loadPending('name')).toMatchObject({ reference: 'ref-1' })
      })

      // An opening whose question fails at the identity read after the sweep gave its proof up reads the
      // slot after the failure, finds the proof gone, and goes on as an opening that read none, so it
      // takes the line kept for it.
      test('an opening whose identity read fails after the sweep gave its proof up says the kept line once', async () => {
        let fail!: () => void
        spark.sparkGetIdentityPubkey!.mockImplementationOnce(
          () => new Promise((_, reject) => (fail = () => reject(new Error('spark not connected')))),
        )
        const tree = await render()
        expect(await sweepGivesUp(false)).toBeNull()
        expect(await lines.listLines()).toHaveLength(1)
        await ReactTestRenderer.act(async () => {
          fail()
        })
        await settle()
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(says(tree, 'repaid')).toBe(true)
        expect(texts(tree).join(' ')).not.toContain('Payment made')
        expect(texts(tree).join(' ')).not.toContain(SETTLING)
        expect(await lines.listLines()).toEqual([])
      })

      // The same quote paid again and failing before anything is sent keeps its price and says so, since
      // the proof the earlier send gave up says nothing of this Pay.
      test('a quote paid again after a send that failed keeps its price when the next Pay sends nothing', async () => {
        await purchase.clearPending('name', 'ref-1')
        const tree = await render()
        await type(tree, 'alice')
        await settle()
        await press(tree, 'See the price')
        jest.mocked(sparkConfirmSend).mockResolvedValueOnce('failed')
        await press(tree, 'Pay and take the name')
        await settle()
        ;(spark.sparkPrepareSend as jest.Mock).mockRejectedValueOnce(new Error('SdkError.NetworkError'))
        await press(tree, 'Pay and take the name')
        await settle()
        const shownNow = texts(tree).join(' ')
        expect(shownNow).toContain('alice costs')
        expect(shownNow).not.toContain('Payment made')
        expect(await purchase.loadPending('name')).toBeNull()
      })

      // The sweep can grant the name and put it on the wallet while the sheet waits on it. Its
      // clear says the name was delivered, and the sheet shows what its own grant shows: the address,
      // handed to the screen, with no price and nothing asked again.
      describe('a wait whose name the sweep delivered', () => {
        const DELIVERED = { username: 'alice', address: 'alice@lnurl.usevoltz.app', lnurl: 'l' }
        afterEach(() => {
          jest.mocked(sparkGetLnAddress).mockImplementation(async () => null)
          jest.mocked(sparkRegisterLnAddress).mockReset()
        })

        // The sweep reads no address, registers the name, and clears its proof as delivered. `read` is
        // what the sheet's own read of the address answers after.
        async function sweepDelivers(read: () => Promise<unknown> = async () => DELIVERED, seen = true): Promise<unknown> {
          confirm.mockResolvedValueOnce(true)
          jest.mocked(sparkGetLnAddress).mockResolvedValueOnce(null).mockImplementationOnce(read as never)
          jest.mocked(sparkRegisterLnAddress).mockResolvedValueOnce(DELIVERED)
          const asked = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`
          if (await RNFS.exists(asked)) {
            await RNFS.unlink(asked)
          }
          const { recoverPurchases } = jest.requireActual('../src/wallet/recover') as typeof import('../src/wallet/recover')
          let card: unknown
          await ReactTestRenderer.act(async () => {
            card = await recoverPurchases({
              walletId: 'primary',
              lines: lines.scopeOn('primary'),
              pubkey: `02${'a'.repeat(64)}`,
              sign: async () => 'sig',
              onScreen: () => seen,
              request: (async () => ({ ok: true, status: 200, json: async () => ({ charges: [CHARGE] }) })) as unknown as typeof fetch,
            })
          })
          expect(await purchase.loadPending('name')).toBeNull()
          return card
        }
        async function waitingFor(onRegistered: jest.Mock): Promise<ReactTestRenderer.ReactTestRenderer> {
          confirm.mockRejectedValueOnce(new Error('SdkError.NetworkError'))
          const tree = await render(onRegistered)
          await settle()
          expect(texts(tree).join(' ')).toContain('Payment made')
          return tree
        }
        // The sheet as its own grant leaves it: no wait, no price, and an empty field whose press is off.
        function expectNoOffer(tree: ReactTestRenderer.ReactTestRenderer): void {
          const shownNow = texts(tree).join(' ')
          expect(shownNow).not.toContain('Payment made')
          expect(shownNow).not.toContain('Check again')
          expect(shownNow).not.toContain('alice costs')
          expect(tree.root.findByType(TextInput).props.value).toBe('')
          const offers = tree.root
            .findAll(n => typeof n.props.onPress === 'function' && !n.props.disabled)
            .filter(n => n.findAllByType(Text).some(t => t.props.children === 'See the price' || t.props.children === 'Pay and take the name'))
          expect(offers).toEqual([])
        }

        test('a sheet left open hands the address on once the sweep delivers its name', async () => {
          const onRegistered = jest.fn()
          const tree = await waitingFor(onRegistered)
          expect(await sweepDelivers()).toMatchObject({ status: 'ready', reference: 'ref-1' })
          await settle()
          expect(onRegistered).toHaveBeenCalledWith(DELIVERED)
          expectNoOffer(tree)
          expect(confirm).toHaveBeenCalledTimes(2)
          expect(sparkRegisterLnAddress).toHaveBeenCalledTimes(1)
        })

        test('a Check again whose name the sweep delivers meanwhile asks nothing and hands the address on', async () => {
          const onRegistered = jest.fn()
          const tree = await waitingFor(onRegistered)
          const letIdentity = holdIdentity()
          await press(tree, 'Check again')
          await sweepDelivers()
          await letIdentity()
          await settle()
          expect(onRegistered).toHaveBeenCalledWith(DELIVERED)
          expectNoOffer(tree)
          expect(confirm).toHaveBeenCalledTimes(2)
        })

        // The opening read the proof, which the sweep delivered before the question. The opening hands the
        // address on and takes no line kept for the next view, since the sheet is closing on the address.
        test('an opening whose name the sweep delivers before it asks takes no kept line', async () => {
          const kept = { kind: 'name' as const, reference: 'ref-0', answer: 'repaid' as const, subject: 'bob@lnurl.usevoltz.app' }
          await lines.noteLine(kept, await lines.activeScope())
          const onRegistered = jest.fn()
          const letIdentity = holdIdentity()
          await render(onRegistered)
          await sweepDelivers(undefined, false)
          await letIdentity()
          await settle()
          expect(onRegistered).toHaveBeenCalledWith(DELIVERED)
          expect(await lines.listLines()).toEqual([kept])
          expect(confirm).toHaveBeenCalledTimes(1)
        })

        // An opening reads no proof while the delivered address is still being read, and the address is
        // handed on all the same rather than the wait dropping to a fresh quote.
        test('a sheet opened again while the delivered address is read still hands it on', async () => {
          const onRegistered = jest.fn()
          const tree = await waitingFor(onRegistered)
          let answer!: (value: unknown) => void
          await sweepDelivers(() => new Promise(resolve => (answer = resolve)))
          const sheet = (visible: boolean) => (
            <LnAddressSheet visible={visible} onClose={jest.fn()} onRegistered={onRegistered} />
          )
          await ReactTestRenderer.act(async () => {
            tree.update(sheet(false))
          })
          await ReactTestRenderer.act(async () => {
            tree.update(sheet(true))
          })
          await settle()
          await ReactTestRenderer.act(async () => {
            answer(DELIVERED)
          })
          await settle()
          expect(onRegistered).toHaveBeenCalledWith(DELIVERED)
          expectNoOffer(tree)
        })

        // The sheet then closes all the same, and the screen reads the address again on its close.
        test('a delivered name whose address the sheet cannot read closes the sheet with no price', async () => {
          const onRegistered = jest.fn()
          const tree = await waitingFor(onRegistered)
          await sweepDelivers(async () => {
            throw new Error('offline')
          })
          await settle()
          expect(tree.root.findByType(LnAddressSheet).props.onClose).toHaveBeenCalled()
          expect(onRegistered).not.toHaveBeenCalled()
          expectNoOffer(tree)
        })

        // A Pay whose question was out when the sweep delivered the name, and which then lost to the
        // network, finds the slot empty; the name it paid for is on the wallet.
        test('a Pay out when the sweep delivers the name, and failing after, hands the address on', async () => {
          await purchase.clearPending('name', 'ref-1')
          const onRegistered = jest.fn()
          const tree = await render(onRegistered)
          await type(tree, 'alice')
          await settle()
          await press(tree, 'See the price')
          let fail!: (err: Error) => void
          confirm.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
          await press(tree, 'Pay and take the name')
          await settle()
          await sweepDelivers()
          await ReactTestRenderer.act(async () => {
            fail(new Error('SdkError.NetworkError'))
          })
          await settle()
          expect(onRegistered).toHaveBeenCalledWith(DELIVERED)
          expectNoOffer(tree)
          expect(texts(tree).join(' ')).not.toContain('alice costs')
        })
      })
    })
  })
})

// A Pay that fails and finds another purchase's proof waits on that purchase, and says of this quote
// only what is true whether its payment went or not, beside the awaited purchase's own line.
describe('a Pay that fails onto another purchase', () => {
  const OTHER = (JSON.parse(fs.readFileSync(join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as {
    receive: Record<string, string>
  }).receive.lnOtherPurchase!
  const otherLine = OTHER.replace('{{name}}', 'alice')

  async function payOnto(refusedForGood: boolean, at: 'prepare' | 'send'): Promise<ReactTestRenderer.ReactTestRenderer> {
    const file = async (): Promise<void> => {
      if (at === 'send') {
        // The send's own proof is gone, as the sweep's expired list drops it, before another is filed.
        await purchase.clearPending('name', 'ref-1')
      }
      await purchase.savePending({ kind: 'name', subject: 'bob', reference: 'ref-9', amountSats: 19800 })
      if (refusedForGood) {
        await purchase.recordRefusal('name', 'ref-9', true)
      }
    }
    const spark = jest.requireMock('../src/wallet/spark') as Record<string, jest.Mock>
    if (at === 'prepare') {
      spark.sparkPrepareSend!.mockImplementationOnce(async () => {
        await file()
        throw new Error('insufficient funds')
      })
    } else {
      spark.sparkConfirmSend!.mockImplementationOnce(async () => {
        await file()
        throw new Error('SdkError.NetworkError')
      })
    }
    confirm.mockImplementation(() => new Promise<boolean>(() => undefined))
    const tree = await render()
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await press(tree, 'Pay and take the name')
    return tree
  }

  for (const at of ['prepare', 'send'] as const) {
    test(`a failure at the ${at} says this quote's outcome is unknown and keeps the wait's own line`, async () => {
      const tree = await payOnto(false, at)
      const shown = texts(tree).join(' ')
      expect(shown).toContain(otherLine)
      expect(shown).toContain('Payment made')
      expect(shown).toContain('Check again')
      expect(shown).not.toContain('The payment did not go through')
      expect(shown).not.toContain('costs')
      expect(tree.root.findByType(TextInput).props.value).toBe('bob')
    })
  }

  test('beside a refusal for good, both lines show and neither replaces the other', async () => {
    const tree = await payOnto(true, 'prepare')
    const shown = texts(tree).join(' ')
    expect(shown).toContain(otherLine)
    expect(shown).toContain(KEPT)
    expect(shown).toContain('Send to support')
    expect(shown).not.toContain('Payment made')
  })

  test('a reopening drops the line, since what the open reads is what is true now', async () => {
    const tree = await payOnto(false, 'prepare')
    expect(texts(tree).join(' ')).toContain(otherLine)
    await reopen(tree, false)
    expect(texts(tree).join(' ')).not.toContain(otherLine)
  })

  // The awaited purchase ends in this opening, and a later Pay in it waits on its own payment, beside
  // which the line about the earlier quote would be a stale one.
  async function payCarol(tree: ReactTestRenderer.ReactTestRenderer): Promise<string> {
    quote.mockImplementation(async (_deps: unknown, name: string) => ({
      username: name,
      priceUsdCents: 990,
      amountSats: 19800,
      invoice: `lnbc-${name}`,
      reference: `ref-${name}`,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    }))
    confirm.mockResolvedValue(false)
    await type(tree, 'carol')
    await settle()
    await press(tree, 'See the price')
    await press(tree, 'Pay and take the name')
    await settle()
    return texts(tree).join(' ')
  }

  test('a grant of the awaited purchase drops the line, so a later wait in that opening says nothing of it', async () => {
    const tree = await payOnto(false, 'prepare')
    expect(texts(tree).join(' ')).toContain(otherLine)
    confirm.mockResolvedValueOnce(true)
    jest.mocked(sparkRegisterLnAddress).mockResolvedValueOnce({ username: 'bob', address: 'bob@lnurl.usevoltz.app', lnurl: 'l' })
    await press(tree, 'Check again')
    await settle()
    expect(sparkRegisterLnAddress).toHaveBeenCalledWith('bob', undefined, 'primary')
    const shown = await payCarol(tree)
    expect(shown).toContain('Payment made')
    expect(shown).not.toContain(otherLine)
  })

  // Only a record written before proofs were keyed by wallet is disowned, so the awaited purchase is
  // one, found when the Pay's prepare fails.
  test('the awaited purchase disowned drops the line, so a later wait in that opening says nothing of it', async () => {
    const spark = jest.requireMock('../src/wallet/spark') as Record<string, jest.Mock>
    spark.sparkPrepareSend!.mockImplementationOnce(async () => {
      await RNFS.writeFile(
        UNKEYED,
        JSON.stringify({ kind: 'name', subject: 'bob', reference: 'ref-9', amountSats: 19800 }),
        'utf8',
      )
      throw new Error('insufficient funds')
    })
    confirm.mockImplementation(() => new Promise<boolean>(() => undefined))
    const tree = await render()
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await press(tree, 'Pay and take the name')
    expect(texts(tree).join(' ')).toContain(otherLine)
    confirm.mockRejectedValueOnce(new Error('reference does not belong to this purchase'))
    await press(tree, 'Check again')
    await settle()
    expect(texts(tree).join(' ')).toContain('does not match this wallet')
    expect(await purchase.loadPending('name')).toBeNull()
    const shown = await payCarol(tree)
    expect(shown).toContain('Payment made')
    expect(shown).not.toContain(otherLine)
  })

  test('control: a Pay that fails onto its own proof says nothing of another purchase', async () => {
    ;(jest.requireMock('../src/wallet/spark').sparkConfirmSend as jest.Mock).mockRejectedValueOnce(
      new Error('SdkError.NetworkError'),
    )
    const tree = await render()
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await press(tree, 'Pay and take the name')
    expect(texts(tree).join(' ')).not.toContain(otherLine)
  })
})

// Closes the sheet and opens it again, the way the address screen does, and waits for the open's
// reads unless told not to.
async function reopen(tree: ReactTestRenderer.ReactTestRenderer, wait = true): Promise<void> {
  const shown = (visible: boolean) => (
    <LnAddressSheet visible={visible} onClose={jest.fn()} onRegistered={jest.fn()} />
  )
  await ReactTestRenderer.act(async () => {
    tree.update(shown(false))
  })
  await ReactTestRenderer.act(async () => {
    tree.update(shown(true))
  })
  if (wait) {
    await settle()
  }
}

// The name field is the app's Field: one box with the focus edge, the 44pt floor and a label for a
// screen reader, with the domain inside the same box.
describe('the name field', () => {
  const { Modal, View } = jest.requireActual('react-native') as typeof import('react-native')
  const flatStyle = (style: unknown): Record<string, unknown> =>
    Object.assign({}, ...[style].flat(Infinity).filter(x => x && typeof x === 'object'))

  it('is the shared Field, labelled, with the domain inside its box', async () => {
    const { Field } = jest.requireActual('../src/components/Field') as typeof import('../src/components/Field')
    const tree = await render(jest.fn(), 'usevoltz.app')
    const field = tree.root.findByType(Field)
    expect(field.findByType(TextInput).props.accessibilityLabel).toBe('Choose the name for your address')
    const suffix = field.findAllByType(Text).find(n => [n.props.children].flat().join('') === '@usevoltz.app')
    expect(suffix).toBeDefined()
    // The suffix sits in the same row as the input, which is the box Field draws.
    const box = tree.root
      .findAllByType(View)
      .filter(n => flatStyle(n.props.style).flexDirection === 'row')
      .find(n => n.findAllByType(TextInput).length === 1 && n.findAll(x => x === suffix).length === 1)
    expect(box).toBeDefined()
  })

  // On iOS autoFocus inside a Modal fires before the window is presented, so the keyboard rises
  // against nothing. The field takes focus only once the sheet reports itself shown.
  it('asks for focus only once the sheet is on screen', async () => {
    const tree = await render(jest.fn(), 'usevoltz.app')
    expect(tree.root.findByType(TextInput).props.autoFocus).toBeFalsy()
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(Modal).props.onShow()
    })
    expect(tree.root.findByType(TextInput).props.autoFocus).toBe(true)
  })

  it('keeps what was typed when it takes focus', async () => {
    const tree = await render(jest.fn(), 'usevoltz.app')
    await type(tree, 'bobby')
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(Modal).props.onShow()
    })
    expect(tree.root.findByType(TextInput).props.value).toBe('bobby')
  })
})


// The address reads name@domain in every language. Under a right-to-left layout the field's row
// mirrors and would draw the suffix before the name, so the name field holds its box left to right
// with the name at the left edge, while every other field keeps following the layout.
describe('under a right-to-left layout', () => {
  const { View } = jest.requireActual('react-native') as typeof import('react-native')
  const { Field } = jest.requireActual('../src/components/Field') as typeof import('../src/components/Field')

  beforeEach(() => {
    jest.replaceProperty(I18nManager, 'isRTL', true)
  })

  function boxOf(input: ReactTestRenderer.ReactTestInstance): ReactTestRenderer.ReactTestInstance {
    let at = input.parent
    while (at && at.type !== View) {
      at = at.parent
    }
    if (!at) {
      throw new Error('no box around the input')
    }
    return at
  }

  test('the name field reads name then domain, left to right', async () => {
    const tree = await render(jest.fn(), 'usevoltz.app')
    const input = tree.root.findByType(Field).findByType(TextInput)
    const box = boxOf(input)
    expect(StyleSheet.flatten(box.props.style).direction).toBe('ltr')
    expect(StyleSheet.flatten(input.props.style).textAlign).toBe('left')
    // The suffix is in the same box, so it follows the name rather than leading it.
    expect(box.findAllByType(Text).map(n => [n.props.children].flat().join(''))).toContain('@usevoltz.app')
  })

  test('a field without it still follows the layout', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<Field value="" onChangeText={() => undefined} trailing={<Text>sats</Text>} />)
    })
    const input = tree.root.findByType(TextInput)
    expect(StyleSheet.flatten(boxOf(input).props.style).direction).toBeUndefined()
    expect(StyleSheet.flatten(input.props.style).textAlign).toBe('right')
  })
})

// A name taken for free names no charge, and the slot is shared with the recovery sweep, which files
// a paid proof there whenever the gateway lists a charge. Taking the free name leaves that proof for
// the reader that names its reference, whatever its last answer, and drops only a record of the
// sheet's own standing for no payment.
describe('a free name taken while the slot holds a proof', () => {
  const SWEPT = { kind: 'name' as const, subject: 'carol', reference: 'ref-swept', amountSats: 900 }

  async function takeFree(fileMeanwhile?: () => Promise<unknown>): Promise<void> {
    quote.mockImplementation(async () => {
      await fileMeanwhile?.()
      throw new Error('free_on_this_domain')
    })
    jest.mocked(sparkRegisterLnAddress).mockResolvedValue({
      username: 'bakery',
      address: 'bakery@pay.example.com',
      lnurl: 'lnurl1abc',
    })
    const onRegistered = jest.fn()
    const tree = await render(onRegistered)
    await type(tree, 'bakery')
    await settle()
    await press(tree, 'See the price')
    await settle()
    expect(onRegistered).toHaveBeenCalled()
  }

  const read = (RNFS as unknown as { readFile(p: string, e: string): Promise<string> }).readFile
  const stored = async (): Promise<Record<string, Record<string, unknown>>> =>
    (await RNFS.exists(STORE)) ? JSON.parse(await read(STORE, 'utf8')) : {}

  test('a paid proof the sweep filed meanwhile stays', async () => {
    await takeFree(() => purchase.savePending(SWEPT))
    expect(await purchase.loadPending('name')).toEqual(SWEPT)
  })

  test('a paid proof whose last answer owes nothing stays too', async () => {
    await takeFree(async () => {
      await purchase.savePending(SWEPT)
      await purchase.recordRefusal('name', 'ref-swept', true, 'boughtBefore')
    })
    expect((await stored()).primary?.name).toEqual({ ...SWEPT, refusedForGood: true, finalAnswer: 'boughtBefore' })
  })

  test('a record of its own standing for no payment goes', async () => {
    await purchase.savePending({ ...SWEPT, unpaid: true })
    await takeFree()
    expect(await RNFS.exists(STORE)).toBe(false)
  })

  // The mark that disowns the unkeyed record stands for no payment too, and dropping it would offer
  // that record to this wallet again.
  test('the mark disowning the unkeyed record stays', async () => {
    await RNFS.writeFile(UNKEYED, JSON.stringify({ ...SWEPT, reference: 'ref-old' }), 'utf8')
    expect(await purchase.disownPending('name', 'ref-old')).toBe(true)
    await takeFree()
    expect((await stored()).primary?.name).toEqual({ ...SWEPT, reference: 'ref-old', unpaid: true })
    expect(await purchase.loadPending('name')).toBeNull()
  })
})

// A question whose start could not read which wallet was active (activeScope answers no wallet) knows
// no wallet its answer belongs to, so the answer writes nothing to any slot, even once the registry
// reads again before it lands, when a write left to read the active wallet would land on it.
describe('a question that could not read its wallet', () => {
  const PROOF = { kind: 'name' as const, subject: 'alice', reference: 'ref-1', amountSats: 19800 }
  const OLD = { kind: 'name' as const, subject: 'alice', reference: 'ref-old', amountSats: 19800 }

  // The next question's scope meets a registry that cannot be read, and every read after it works.
  function nextScopeUnread(): jest.SpyInstance {
    const realScope = lines.activeScope
    return jest.spyOn(lines, 'activeScope').mockImplementationOnce(() => {
      const unreadable = jest.spyOn(registry, 'getActiveWalletId').mockRejectedValueOnce(new Error('registry unreadable'))
      return realScope().finally(() => unreadable.mockRestore())
    })
  }

  async function openOn(unread: boolean): Promise<ReactTestRenderer.ReactTestRenderer> {
    const scope = unread ? nextScopeUnread() : null
    try {
      const tree = await render()
      await settle()
      return tree
    } finally {
      scope?.mockRestore()
    }
  }

  test.each([true, false])('an answer for good marks the proof only on a wallet read (unread %s)', async unread => {
    await purchase.savePending(PROOF)
    confirm.mockRejectedValue(Object.assign(new Error('paid_but_not_granted'), { final: true, repaid: false }))
    await openOn(unread)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(await purchase.loadPending('name')).toEqual(unread ? PROOF : { ...PROOF, refusedForGood: true })
  })

  test.each([true, false])('a key refused disowns the unkeyed record only on a wallet read (unread %s)', async unread => {
    await RNFS.writeFile(UNKEYED, JSON.stringify(OLD), 'utf8')
    confirm.mockRejectedValue(new Error('reference does not belong to this purchase'))
    const tree = await openOn(unread)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(texts(tree).join(' ')).toContain('does not match this wallet')
    expect(await purchase.loadPending('name')).toEqual(unread ? OLD : null)
  })
})

// A paid name goes only on the wallet whose question heard its grant, by the sweep's rule (recover.ts,
// takeName). A switch that reconnects the session while the question is out leaves the live connection
// on another wallet, whose key would take the name and whose address the sheet would read; the sheet
// then registers nothing, clears nothing, and the proof stays in the slot of the wallet that paid.
describe('a grant heard after the session moved to another wallet', () => {
  const spark = jest.requireMock('../src/wallet/spark') as Record<string, jest.Mock>
  const PROOF = { kind: 'name' as const, subject: 'alice', reference: 'ref-1', amountSats: 19800 }
  const B_PROOF = { kind: 'name' as const, subject: 'bob', reference: 'ref-b', amountSats: 19800 }
  const ADDRESS = { username: 'alice', address: 'alice@lnurl.usevoltz.app', lnurl: 'lnurl1abc' }

  beforeEach(async () => {
    jest.mocked(sparkRegisterLnAddress).mockResolvedValue(ADDRESS)
    await purchase.savePending(B_PROOF, 'w_b')
  })
  afterEach(() => {
    spark.sparkConnectedWalletId!.mockImplementation(() => 'primary')
  })

  // The registry and the session both move to the other wallet, as a switch and the reconnect after it.
  function moveTo(walletId: string | null): () => void {
    spark.sparkConnectedWalletId!.mockImplementation(() => walletId)
    const active = jest.spyOn(registry, 'getActiveWalletId').mockResolvedValue(walletId ?? 'w_b')
    return () => active.mockRestore()
  }

  // The confirmation the next question sends, answered when the case says.
  function holdConfirm(): (grant: () => Promise<boolean>) => Promise<void> {
    let answer!: (grant: () => Promise<boolean>) => void
    confirm.mockImplementationOnce(() => new Promise<() => Promise<boolean>>(resolve => (answer = resolve)).then(grant => grant()))
    return grant =>
      ReactTestRenderer.act(async () => {
        answer(grant)
      })
  }

  async function expectLeftForPayer(tree: ReactTestRenderer.ReactTestRenderer, onRegistered: jest.Mock): Promise<void> {
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    expect(onRegistered).not.toHaveBeenCalled()
    expect(await purchase.loadPending('name', 'primary')).toMatchObject({ reference: 'ref-1' })
    expect(await purchase.loadPending('name', 'w_b')).toEqual(B_PROOF)
    expect(texts(tree).join(' ')).toContain('Payment made')
  }

  test.each([true, false])('an opening registers the name only on the wallet that asked (moved %s)', async moved => {
    await purchase.savePending(PROOF)
    const answer = holdConfirm()
    const onRegistered = jest.fn()
    const tree = await render(onRegistered)
    await settle()
    const back = moved ? moveTo('w_b') : null
    try {
      await answer(async () => true)
      await settle()
    } finally {
      back?.()
    }
    if (moved) {
      await expectLeftForPayer(tree, onRegistered)
      return
    }
    expect(sparkRegisterLnAddress).toHaveBeenCalledWith('alice', undefined, 'primary')
    expect(onRegistered).toHaveBeenCalledWith(ADDRESS)
    expect(await purchase.loadPending('name', 'primary')).toBeNull()
  })

  test('a Pay registers the name only on the wallet that asked', async () => {
    const answer = holdConfirm()
    const onRegistered = jest.fn()
    const tree = await render(onRegistered)
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await press(tree, 'Pay and take the name')
    const back = moveTo('w_b')
    try {
      await answer(async () => true)
      await settle()
    } finally {
      back()
    }
    await expectLeftForPayer(tree, onRegistered)
  })

  // A question that could not read its wallet has none to put the name on, whether a session is live
  // or not.
  test.each(['primary', null])('a grant to a question with no wallet registers nothing (session on %s)', async connected => {
    await purchase.savePending(PROOF)
    const realScope = lines.activeScope
    const scope = jest.spyOn(lines, 'activeScope').mockImplementationOnce(async () => ({ ...(await realScope()), walletId: null }))
    spark.sparkConnectedWalletId!.mockImplementation(() => connected)
    const onRegistered = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    try {
      tree = await render(onRegistered)
      await settle()
    } finally {
      scope.mockRestore()
    }
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    expect(onRegistered).not.toHaveBeenCalled()
    expect(await purchase.loadPending('name', 'primary')).toMatchObject({ reference: 'ref-1' })
    expect(texts(tree).join(' ')).toContain('Payment made')
  })

  // The session can move while the register waits for its turn behind another address change, which
  // the register reads right before it goes out and answers by registering nothing (spark.ts).
  test('a register that finds the session moved before its turn clears nothing', async () => {
    await purchase.savePending(PROOF)
    jest.mocked(sparkRegisterLnAddress).mockResolvedValueOnce(null)
    const onRegistered = jest.fn()
    const tree = await render(onRegistered)
    await settle()
    expect(sparkRegisterLnAddress).toHaveBeenCalledWith('alice', undefined, 'primary')
    expect(onRegistered).not.toHaveBeenCalled()
    expect(await purchase.loadPending('name', 'primary')).toMatchObject({ reference: 'ref-1' })
    expect(texts(tree).join(' ')).toContain('Payment made')
  })

  // A holder's answer puts the name on the wallet that asked only, through the take that refuses
  // another wallet's connection; the slot it gives up is that wallet's.
  test('a holder\'s answer takes the name only for the wallet that asked', async () => {
    await purchase.savePending(PROOF)
    const answer = holdConfirm()
    await render()
    await settle()
    const back = moveTo('w_b')
    try {
      await answer(async () => {
        throw Object.assign(new Error('paid_again'), { paidAgain: true, final: true })
      })
      await settle()
    } finally {
      back()
    }
    expect(spark.sparkTakeLnAddress).toHaveBeenCalledWith('alice', 'primary')
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    expect(await purchase.loadPending('name', 'primary')).toBeNull()
    expect(await purchase.loadPending('name', 'w_b')).toEqual(B_PROOF)
  })
})

// A Pay files its quote's proof, promotes it before the send and drops it after a send that failed, all
// in the slot of the wallet its press started on. A switch right after the press moves the registry to
// a wallet holding a proof of its own, which none of those writes touch.
describe('a Pay after a switch right after its press', () => {
  const spark = jest.requireMock('../src/wallet/spark') as Record<string, jest.Mock>
  const B_PROOF = { kind: 'name' as const, subject: 'bob', reference: 'ref-b', amountSats: 19800 }
  const RECORD_UNREAD = (JSON.parse(fs.readFileSync(join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as {
    recover: Record<string, string>
  }).recover.recordUnread!

  beforeEach(async () => {
    await purchase.savePending(B_PROOF, 'w_b')
  })

  // The proof as it stands on disk, a record standing for no payment included.
  async function filed(walletId: string): Promise<unknown> {
    if (!(await RNFS.exists(STORE))) {
      return undefined
    }
    const read = (RNFS as unknown as { readFile(p: string, e: string): Promise<string> }).readFile
    return (JSON.parse(await read(STORE, 'utf8')) as Record<string, { name?: unknown }>)[walletId]?.name
  }

  async function priced(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    return tree
  }

  // The press reads the wallet it starts on, and every read after it answers the wallet switched to.
  async function payThenSwitch(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    const switched = jest.spyOn(registry, 'getActiveWalletId').mockResolvedValueOnce('primary').mockResolvedValue('w_b')
    try {
      await press(tree, 'Pay and take the name')
      await settle()
    } finally {
      switched.mockRestore()
    }
  }

  test('a send that failed drops its proof in the slot of the wallet that pressed', async () => {
    spark.sparkConfirmSend!.mockResolvedValue('failed')
    const tree = await priced()
    await payThenSwitch(tree)
    expect(spark.sparkConfirmSend).toHaveBeenCalledTimes(1)
    expect(await filed('primary')).toBeUndefined()
    expect(await purchase.loadPending('name', 'w_b')).toEqual(B_PROOF)
  })

  // The clear on close stands behind a send's own clear that did not land.
  test('closing after a send that failed drops the proof left in the slot of the wallet that pressed', async () => {
    const pay = jest.spyOn(purchase, 'payAndSettle').mockImplementationOnce(async (bought, _invoice, _confirm, walletId) => {
      await purchase.savePending({ ...bought, unpaid: true }, walletId)
      return { outcome: 'failed' }
    })
    const tree = await priced()
    try {
      await payThenSwitch(tree)
    } finally {
      pay.mockRestore()
    }
    expect(await filed('primary')).toMatchObject({ reference: 'ref-1', unpaid: true })
    const switched = jest.spyOn(registry, 'getActiveWalletId').mockResolvedValue('w_b')
    try {
      const back = tree.root.findAll(n => n.props.accessibilityLabel === 'Back')[0]
      await ReactTestRenderer.act(async () => {
        back!.props.onPress()
      })
      await settle()
    } finally {
      switched.mockRestore()
    }
    expect(await filed('primary')).toBeUndefined()
    expect(await purchase.loadPending('name', 'w_b')).toEqual(B_PROOF)
  })

  // A send that threw is read against the proof of the wallet that pressed, never the one a switch made
  // active, whose proof of another payment would take the sheet. The case runs with no switch as its
  // control.
  test.each([true, false])('a send that threw waits on the proof of the wallet that pressed (switch %s)', async switches => {
    spark.sparkConfirmSend!.mockRejectedValueOnce(new Error('Network request failed'))
    const tree = await priced()
    if (switches) {
      await payThenSwitch(tree)
    } else {
      await press(tree, 'Pay and take the name')
      await settle()
    }
    expect(spark.sparkConfirmSend).toHaveBeenCalledTimes(1)
    expect(await purchase.loadPending('name', 'primary')).toMatchObject({ reference: 'ref-1' })
    expect(await purchase.loadPending('name', 'w_b')).toEqual(B_PROOF)
    expect(tree.root.findByType(TextInput).props.value).toBe('alice')
    expect(texts(tree).join(' ')).not.toContain('bob')
    expect(texts(tree).join(' ')).toContain('Payment made')
  })

  // A press that could read neither its wallet nor the identity has no slot of its own to read, so the
  // sheet reads as a proof it cannot read rather than as the active wallet's.
  test('a press that could read neither its wallet nor the identity reads as unread', async () => {
    const tree = await priced()
    const unreadable = jest.spyOn(registry, 'getActiveWalletId').mockRejectedValueOnce(new Error('registry unreadable'))
    spark.sparkGetIdentityPubkey!.mockRejectedValueOnce(new Error('SdkError.NetworkError'))
    try {
      await press(tree, 'Pay and take the name')
      await settle()
    } finally {
      unreadable.mockRestore()
    }
    expect(spark.sparkConfirmSend).not.toHaveBeenCalled()
    expect(await filed('primary')).toBeUndefined()
    expect(texts(tree).join(' ')).toContain(RECORD_UNREAD)
  })

  // A press that could not read which wallet it starts on has no slot to file the proof in, so nothing
  // is filed and nothing is sent, whatever the registry answers after it.
  test('a press that could not read its wallet files and sends nothing', async () => {
    const tree = await priced()
    const unreadable = jest.spyOn(registry, 'getActiveWalletId').mockRejectedValueOnce(new Error('registry unreadable'))
    try {
      await press(tree, 'Pay and take the name')
      await settle()
    } finally {
      unreadable.mockRestore()
    }
    expect(spark.sparkPrepareSend).not.toHaveBeenCalled()
    expect(spark.sparkConfirmSend).not.toHaveBeenCalled()
    expect(await filed('primary')).toBeUndefined()
    expect(texts(tree).join(' ')).toContain(RECORD_UNREAD)
  })
})

// A name taken for free goes only on the wallet active as its press started, while the live connection
// is still that wallet, and its clear drops only that wallet's record standing for no payment. A switch
// that reconnects the session during the quote leaves the live connection on another wallet, whose key
// would take the name; the sheet then registers and clears nothing. Each other wallet's record of its
// own stays whatever happens.
describe('a free name after the session moved to another wallet', () => {
  const spark = jest.requireMock('../src/wallet/spark') as Record<string, jest.Mock>
  const A_UNPAID = { kind: 'name' as const, subject: 'carol', reference: 'ref-a', amountSats: 900, unpaid: true }
  const B_UNPAID = { kind: 'name' as const, subject: 'dave', reference: 'ref-b', amountSats: 900, unpaid: true }
  const ADDRESS = { username: 'bakery', address: 'bakery@lnurl.usevoltz.app', lnurl: 'lnurl1abc' }

  const read = (RNFS as unknown as { readFile(p: string, e: string): Promise<string> }).readFile
  async function filed(walletId: string): Promise<unknown> {
    return (await RNFS.exists(STORE))
      ? (JSON.parse(await read(STORE, 'utf8')) as Record<string, { name?: unknown }>)[walletId]?.name
      : undefined
  }

  let restore: (() => void) | null = null

  beforeEach(async () => {
    jest.mocked(sparkRegisterLnAddress).mockResolvedValue(ADDRESS)
    await purchase.savePending(A_UNPAID, 'primary')
    await purchase.savePending(B_UNPAID, 'w_b')
  })
  afterEach(() => {
    restore?.()
    restore = null
    spark.sparkConnectedWalletId!.mockImplementation(() => 'primary')
  })

  // The registry moves to the other wallet, and the session with it when the switch reconnects.
  function switchTo(walletId: string, reconnects: boolean): void {
    if (reconnects) {
      spark.sparkConnectedWalletId!.mockImplementation(() => walletId)
    }
    const active = jest.spyOn(registry, 'getActiveWalletId').mockResolvedValue(walletId)
    restore = () => active.mockRestore()
  }

  // Asks the price of a name the gateway answers is free, with whatever happens right before the press
  // and while the quote is out.
  async function takeFree(
    meanwhile?: () => void,
    beforePress?: () => void,
  ): Promise<{ tree: ReactTestRenderer.ReactTestRenderer; onRegistered: jest.Mock }> {
    quote.mockImplementation(async () => {
      meanwhile?.()
      throw new Error('free_on_this_domain')
    })
    const onRegistered = jest.fn()
    const tree = await render(onRegistered)
    await type(tree, 'bakery')
    await settle()
    beforePress?.()
    await press(tree, 'See the price')
    await settle()
    return { tree, onRegistered }
  }

  async function expectNothingTaken(onRegistered: jest.Mock): Promise<void> {
    expect(onRegistered).not.toHaveBeenCalled()
    expect(await filed('primary')).toEqual(A_UNPAID)
    expect(await filed('w_b')).toEqual(B_UNPAID)
  }

  test('with no switch the name goes on the wallet that pressed, which drops its own unpaid record', async () => {
    const { onRegistered } = await takeFree()
    expect(sparkRegisterLnAddress).toHaveBeenCalledWith('bakery', undefined, 'primary')
    expect(onRegistered).toHaveBeenCalledWith(ADDRESS)
    expect(await filed('primary')).toBeUndefined()
    expect(await filed('w_b')).toEqual(B_UNPAID)
  })

  test('a switch that reconnected during the quote registers and clears nothing', async () => {
    const { onRegistered } = await takeFree(() => switchTo('w_b', true))
    expect(spark.sparkGetLnAddress).not.toHaveBeenCalled()
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    await expectNothingTaken(onRegistered)
  })

  // The session is still the pressing wallet's, so the name goes there, and the clear goes there too
  // rather than to the wallet the registry now names.
  test('a switch that has not reconnected yet puts the name and the clear on the wallet that pressed', async () => {
    const { onRegistered } = await takeFree(() => switchTo('w_b', false))
    expect(sparkRegisterLnAddress).toHaveBeenCalledWith('bakery', undefined, 'primary')
    expect(onRegistered).toHaveBeenCalledWith(ADDRESS)
    expect(await filed('primary')).toBeUndefined()
    expect(await filed('w_b')).toEqual(B_UNPAID)
  })

  test('a session already on another wallet as the press starts registers nothing', async () => {
    spark.sparkConnectedWalletId!.mockImplementation(() => 'w_b')
    const { onRegistered } = await takeFree()
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    await expectNothingTaken(onRegistered)
  })

  // The register reads the connection again inside its turn (spark.ts) and answers null when it moved.
  test('a register that finds the session moved before its turn clears nothing', async () => {
    jest.mocked(sparkRegisterLnAddress).mockResolvedValueOnce(null)
    const { onRegistered } = await takeFree()
    expect(sparkRegisterLnAddress).toHaveBeenCalledWith('bakery', undefined, 'primary')
    await expectNothingTaken(onRegistered)
  })

  test('a press that could not read its wallet registers nothing', async () => {
    const realScope = lines.activeScope
    const { onRegistered } = await takeFree(undefined, () => {
      const scope = jest.spyOn(lines, 'activeScope').mockImplementationOnce(async () => ({ ...(await realScope()), walletId: null }))
      restore = () => scope.mockRestore()
    })
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    await expectNothingTaken(onRegistered)
  })
})

describe('the warning before a change', () => {
  const OLD = 'old@usevoltz.app'

  async function sheet(props: { currentAddress?: string; addressUnread?: boolean }) {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <LnAddressSheet visible onClose={jest.fn()} onRegistered={jest.fn()} {...props} />,
      )
    })
    await type(tree, 'alice')
    await settle()
    return tree
  }

  const reply = async (tree: ReactTestRenderer.ReactTestRenderer, text: string) => {
    await answerQuestion(tree, text)
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
  }

  test('nothing happens before the answer, and cancelling prices and registers nothing', async () => {
    const tree = await sheet({ currentAddress: OLD })
    await press(tree, 'See the price')

    expect(question(tree)).not.toBeNull()
    expect(quote).not.toHaveBeenCalled()

    await reply(tree, 'Cancel')
    expect(quote).not.toHaveBeenCalled()
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
  })

  test('going ahead asks the price', async () => {
    const tree = await sheet({ currentAddress: OLD })
    await press(tree, 'See the price')
    await reply(tree, 'Continue')

    expect(quote).toHaveBeenCalledTimes(1)
  })

  test('with no address there is no warning, and the first name costs no extra press', async () => {
    const tree = await sheet({})
    await press(tree, 'See the price')

    expect(question(tree)).toBeNull()
    expect(quote).toHaveBeenCalledTimes(1)
  })

  test('names the address that stops, says one change a day, and names no price', async () => {
    const tree = await sheet({ currentAddress: OLD })
    await press(tree, 'See the price')

    const body = question(tree)!.body
    expect(body).toContain(OLD)
    expect(body).toContain('once a day')
    expect(body).toContain('reserved')
    expect(body).not.toMatch(/free|sats|price|pay/i)
  })

  test('an address that could not be read counts as one, with no address named', async () => {
    const tree = await sheet({ addressUnread: true })
    await press(tree, 'See the price')

    expect(question(tree)?.body).toContain('current address')
    expect(quote).not.toHaveBeenCalled()
  })

  test('two taps raise one warning', async () => {
    const tree = await sheet({ currentAddress: OLD })
    const btn = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(t => t.props.children === 'See the price'))
    await ReactTestRenderer.act(async () => {
      btn?.props.onPress()
      btn?.props.onPress()
    })

    expect(tree.root.findAllByType(ConfirmBody)).toHaveLength(1)
    await reply(tree, 'Continue')
    expect(quote).toHaveBeenCalledTimes(1)
  })

  test('a second question can come once the first was answered', async () => {
    const tree = await sheet({ currentAddress: OLD })
    await press(tree, 'See the price')
    await reply(tree, 'Cancel')
    await press(tree, 'See the price')

    expect(question(tree)).not.toBeNull()
  })

  test('the backdrop ends the question and leaves the sheet, and the name typed', async () => {
    const onClose = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <LnAddressSheet visible currentAddress={OLD} onClose={onClose} onRegistered={jest.fn()} />,
      )
    })
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')

    await ReactTestRenderer.act(async () => tree.root.findByType(Sheet).props.onClose())

    expect(question(tree)).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(quote).not.toHaveBeenCalled()
    expect(tree.root.findByType(TextInput).props.value).toBe('alice')
  })

  test('a sheet that left takes its question with it', async () => {
    const element = (visible: boolean) => (
      <LnAddressSheet visible={visible} currentAddress={OLD} onClose={jest.fn()} onRegistered={jest.fn()} />
    )
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(element(true))
    })
    await type(tree, 'alice')
    await settle()
    await press(tree, 'See the price')
    await ReactTestRenderer.act(async () => tree.update(element(false)))
    await ReactTestRenderer.act(async () => tree.update(element(true)))
    await settle()

    expect(question(tree)).toBeNull()
  })

  test('a purchase already paid resumes with no warning', async () => {
    jest.mocked(sparkRegisterLnAddress).mockResolvedValue({
      username: 'alice',
      address: 'alice@usevoltz.app',
      lnurl: 'lnurl1',
    })
    await purchase.savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 19800 })
    const tree = await sheet({ currentAddress: OLD })

    expect(question(tree)).toBeNull()
    expect(sparkRegisterLnAddress).toHaveBeenCalled()
  })
})
