import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import fs from 'fs'
import path from 'path'
import '../src/i18n'
import { UseMyDomainScreen } from '../src/screens/UseMyDomainScreen'
import { claimDomain, confirmDomain, quoteDomain } from '../src/wallet/domainOnboard'
import { sparkConfirmSend, sparkPrepareSend } from '../src/wallet/spark'
import { formatDate } from '../src/wallet/history'
import { deviceDateTimePrefs } from '../src/wallet/deviceLocale'
import { formatSats } from '../src/wallet/amount'

const HOST = 'pay.bakery.com.br'
// The day the renewed year ends. Far from anything else on screen, so a card printing the wrong
// stamp prints a visibly different date.
const NEW_EXPIRY = 1_800_000_000

jest.mock('../src/wallet/spark', () => ({
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkPrepareSend: jest.fn(async () => ({ handle: 'h-1', amount: 199800, fee: 0 })),
  sparkSyncedBalanceSat: jest.fn(async () => 1_000_000),
  sparkConfirmSend: jest.fn(async () => 'complete'),
}))

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'lnurl.usevoltz.app', getDistribution: () => 'direct' }))

let mockParams: { renew?: string } | undefined
jest.mock('@react-navigation/native', () => ({ useRoute: () => ({ params: mockParams }) }))

jest.mock('../src/wallet/domainOnboard', () => {
  const real = jest.requireActual('../src/wallet/domainOnboard')
  return {
    ...real,
    claimDomain: jest.fn(),
    quoteDomain: jest.fn(),
    confirmDomain: jest.fn(),
  }
})

const claim = claimDomain as jest.MockedFunction<typeof claimDomain>
const quote = quoteDomain as jest.MockedFunction<typeof quoteDomain>
const confirm = confirmDomain as jest.MockedFunction<typeof confirmDomain>

// The mock is an ES default export, so the CommonJS require hands back the module wrapper.
const RNFS = (
  require('react-native-fs') as {
    default: { DocumentDirectoryPath: string; exists(p: string): Promise<boolean>; unlink(p: string): Promise<void> }
  }
).default
const PENDING = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`
// The list of lines no view has shown, which also remembers what was shown, so no case inherits it.
const LINES = `${RNFS.DocumentDirectoryPath}/released-lines.json`

// The module under test is mocked at the network calls, so the file the screen reads and writes is
// reached through the unmocked one.
function realOnboard(): typeof import('../src/wallet/domainOnboard') {
  return jest.requireActual('../src/wallet/domainOnboard')
}

// The rendered words are compared against the locale file itself, never against t() again, so a
// line borrowed from the neighbouring case cannot agree with the assertion.
const en = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8'),
) as { useDomain: Record<string, string>; receive: Record<string, string> }

function renewCopy(key: string, date = ''): string {
  return en.useDomain[key]!.replace(/\{\{domain\}\}/g, HOST).replace(/\{\{date\}\}/g, date)
}

function live(state: 'awaiting_dns' | 'awaiting_certificate' | 'active' = 'awaiting_dns') {
  return {
    host: HOST,
    provider: 'cloudflare' as const,
    supportsRoot: true,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state,
  }
}

function priced() {
  return {
    host: HOST,
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'ref-1',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
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
  await settle(tree)
  return tree
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

async function pay(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    press(tree, 'Pay')
  })
  await settle(tree)
}

beforeEach(async () => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  mockParams = { renew: HOST }
  for (const file of [PENDING, LINES]) {
    if (await RNFS.exists(file)) {
      await RNFS.unlink(file)
    }
  }
})
afterEach(() => {
  jest.useRealTimers()
})

it('opens at the payment for the domain it was given, and never asks for it again', async () => {
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  const tree = await render()

  // The domain is already known, so the field that asks for it is a press bought for nothing.
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0)
  expect(quote).toHaveBeenCalledWith(expect.anything(), HOST)
  const shown = texts(tree)
  expect(shown).toContain(HOST)
  expect(shown).toContain(`${formatSats(199_800)} sats`)
})

// A claim that succeeds means the year is still running. In a first purchase that is the shortcut
// to the DNS steps; here it would answer a renewal with instructions for a record set up a year ago
// and never sell the year the owner came for.
it('quotes the renewal even though the domain claims, and says the days left are not lost', async () => {
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  const tree = await render()

  expect(quote).toHaveBeenCalledWith(expect.anything(), HOST)
  const shown = texts(tree)
  expect(shown).toContain(renewCopy('renewEarly'))
  expect(shown).not.toContain(renewCopy('renewLate'))
  expect(shown.join(' ')).not.toContain('Type: CNAME')
})

it('says the new year starts today once the old one has run out', async () => {
  // The gateway gates the claim on `expires_at > now()`, so a lapsed year is refused before it can
  // touch a hostname. That refusal is the only thing separating the two lines.
  claim.mockRejectedValue(new Error('domain_tier_not_paid'))
  quote.mockResolvedValue(priced())
  const tree = await render()

  const shown = texts(tree)
  expect(shown).toContain(renewCopy('renewLate'))
  expect(shown).not.toContain(renewCopy('renewEarly'))
  // The refusal must not reach the screen as a failure: the price is on offer either way.
  expect(shown).toContain(`${formatSats(199_800)} sats`)
  expect(shown.join(' ')).not.toContain('has not been paid for')
})

it('says neither line when the claim failed for a reason that answers nothing', async () => {
  // A network that dropped says nothing about the expiry. Guessing here tells an owner whose year
  // has lapsed that their remaining days are safe.
  claim.mockRejectedValue(new Error('Network request failed'))
  quote.mockResolvedValue(priced())
  const tree = await render()

  const shown = texts(tree)
  expect(shown).not.toContain(renewCopy('renewEarly'))
  expect(shown).not.toContain(renewCopy('renewLate'))
  expect(shown).toContain(`${formatSats(199_800)} sats`)
})

it('names the day the renewed year ends', async () => {
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  confirm.mockResolvedValue({ expiresAt: NEW_EXPIRY, frozen: false })
  const tree = await render()
  await pay(tree)

  const shown = texts(tree)
  expect(shown).toContain(renewCopy('renewDone', formatDate(NEW_EXPIRY, deviceDateTimePrefs())))
  expect(shown).not.toContain(renewCopy('renewWaking'))
  // The record was made a year ago and still points where it should.
  expect(shown.join(' ')).not.toContain('Type: CNAME')
})

// `frozen` is read before the gateway puts the hostname back, so it says the domain was off the
// edge. Claiming it works would be false for exactly the few minutes that matter.
it('says the addresses are coming back when the domain had stopped', async () => {
  claim.mockRejectedValueOnce(new Error('domain_tier_not_paid'))
  claim.mockResolvedValue(live('awaiting_certificate'))
  quote.mockResolvedValue(priced())
  confirm.mockResolvedValue({ expiresAt: NEW_EXPIRY, frozen: true })
  const tree = await render()
  await pay(tree)

  const shown = texts(tree)
  expect(shown).toContain(renewCopy('renewWaking'))
  expect(shown).not.toContain(renewCopy('renewDone', formatDate(NEW_EXPIRY, deviceDateTimePrefs())))
})

it('keeps claiming after the payment, which is what puts the hostname back', async () => {
  claim.mockRejectedValueOnce(new Error('domain_tier_not_paid'))
  claim.mockResolvedValue(live('awaiting_certificate'))
  quote.mockResolvedValue(priced())
  confirm.mockResolvedValue({ expiresAt: NEW_EXPIRY, frozen: true })
  const tree = await render()
  await pay(tree)

  const afterPaying = claim.mock.calls.length
  expect(claim).toHaveBeenLastCalledWith(expect.anything(), HOST)
  expect(texts(tree).join(' ')).toContain('getting your address ready')

  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(10_000)
  })
  await settle(tree)
  expect(claim.mock.calls.length).toBeGreaterThan(afterPaying)
})

// An outage is not a refused renewal. Somebody paying to bring a dead domain back deserves to know
// the failure is on the service side, or they go looking for what they did wrong.
it('says the shop is shut when the treasury cannot mint the renewal', async () => {
  claim.mockResolvedValue(live())
  quote.mockRejectedValue(new Error('treasury_unavailable'))
  const tree = await render()

  const shown = texts(tree).join(' ')
  expect(shown).toContain(en.receive.lnShopClosed)
  expect(shown).not.toContain(en.useDomain.payFailed)
  // With no price there is nothing to pay, so the button offers to ask for one again.
  expect(texts(tree)).toContain(en.useDomain.requote)
})

it('offers a fresh price after a failed mint, without going back to the domain question', async () => {
  claim.mockResolvedValue(live())
  quote.mockRejectedValueOnce(new Error('treasury_unavailable'))
  quote.mockResolvedValue(priced())
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    press(tree, en.useDomain.requote)
  })
  await settle(tree)
  expect(quote).toHaveBeenCalledTimes(2)
  expect(texts(tree)).toContain(`${formatSats(199_800)} sats`)
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0)
})

it('does not report a renewal when the payment itself failed', async () => {
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  ;(sparkConfirmSend as jest.Mock).mockResolvedValue('failed')
  const tree = await render()
  await pay(tree)

  const shown = texts(tree)
  expect(shown.join(' ')).toContain('did not go through')
  expect(confirm).not.toHaveBeenCalled()
  expect(shown).not.toContain(renewCopy('renewDone', formatDate(NEW_EXPIRY, deviceDateTimePrefs())))
  expect(shown).not.toContain(renewCopy('renewWaking'))
  // The proof of a payment that never happened must not be left behind for the next run to settle.
  expect(await RNFS.exists(PENDING)).toBe(false)
})

// A renewal killed between paying and confirming is picked up here too, or the owner is quoted a
// second invoice for a year they already bought.
it('finishes a renewal already paid for instead of minting a second invoice', async () => {
  await realOnboard().savePendingPurchase({ host: HOST, reference: 'ref-1', amountSats: 199800 })
  claim.mockResolvedValue(live('awaiting_certificate'))
  confirm.mockResolvedValue({ expiresAt: NEW_EXPIRY, frozen: true })
  const tree = await render()

  expect(confirm).toHaveBeenCalledWith(expect.anything(), HOST, 'ref-1')
  expect(quote).not.toHaveBeenCalled()
  expect(texts(tree)).toContain(renewCopy('renewWaking'))
  expect(await RNFS.exists(PENDING)).toBe(false)
})

// A renewal opened while an older purchase is still owed settles that one first, and the sentence
// that follows has to name the domain the year actually landed on. Naming the one on screen would
// tell an owner their renewal is done when the money went to a different host entirely.
it('names the domain the year landed on, not the one it was opened for', async () => {
  const other = 'pay.other.com.br'
  await realOnboard().savePendingPurchase({ host: other, reference: 'ref-9', amountSats: 199800 })
  claim.mockResolvedValue(live('active'))
  confirm.mockResolvedValue({ expiresAt: NEW_EXPIRY, frozen: false })
  const tree = await render()

  expect(confirm).toHaveBeenCalledWith(expect.anything(), other, 'ref-9')
  const done = en.useDomain.renewDone!
  const shown = texts(tree)
  expect(shown).toContain(
    done.replace(/\{\{domain\}\}/g, other).replace(/\{\{date\}\}/g, formatDate(NEW_EXPIRY, deviceDateTimePrefs())),
  )
  expect(shown).not.toContain(renewCopy('renewDone', formatDate(NEW_EXPIRY, deviceDateTimePrefs())))
})

// The gateway answering 402 means the payment is still landing, not that it was lost. The hold
// lapses while the owner waits, and a button offering a new price then takes a second payment:
// paying it writes its reference over the first one's, which is the only proof on the
// device that the first payment happened at all.
it('offers to check the payment instead of a new price once the hold lapses', async () => {
  // Set here rather than left to the file, because clearAllMocks forgets the calls and not the
  // implementation a neighbouring case installed, and a send that fails never reaches the
  // confirmation at all.
  ;(sparkConfirmSend as jest.Mock).mockResolvedValue('complete')
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  confirm.mockResolvedValue(null)
  const tree = await render()
  await pay(tree)

  // Past the ten minute hold, where a button offering a new price would otherwise appear.
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(601_000)
  })
  await settle(tree)

  const shown = texts(tree)
  expect(shown).toContain(en.receive.lnCheckAgain)
  expect(shown).not.toContain(en.useDomain.requote)
  // Nothing on screen offers to charge again, the price included.
  expect(shown).not.toContain(`${formatSats(199_800)} sats`)
  expect(shown.join(' ')).toContain('Waiting for it to be seen')

  await ReactTestRenderer.act(async () => {
    press(tree, en.receive.lnCheckAgain)
  })
  await settle(tree)

  // One invoice was ever minted, and the payment made against it still has its proof.
  expect(quote).toHaveBeenCalledTimes(1)
  expect(confirm).toHaveBeenLastCalledWith(expect.anything(), HOST, 'ref-1')
  expect(await realOnboard().loadPendingPurchase()).toMatchObject({ host: HOST, reference: 'ref-1' })

  // And the year still lands the moment the gateway sees the payment.
  confirm.mockResolvedValue({ expiresAt: NEW_EXPIRY, frozen: false })
  await ReactTestRenderer.act(async () => {
    press(tree, en.receive.lnCheckAgain)
  })
  await settle(tree)
  expect(texts(tree)).toContain(renewCopy('renewDone', formatDate(NEW_EXPIRY, deviceDateTimePrefs())))
  expect(quote).toHaveBeenCalledTimes(1)
  expect(await RNFS.exists(PENDING)).toBe(false)
})

// A renewal opened while a payment on another domain is still owed. Quoting this one would take a
// second payment and bury the first one's reference, so the older purchase is what the screen shows
// and the domain it was opened for is never priced.
it('holds the payment owed on another domain instead of pricing the one on screen', async () => {
  const other = 'pay.other.com.br'
  await realOnboard().savePendingPurchase({ host: other, reference: 'ref-9', amountSats: 199800 })
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  confirm.mockResolvedValue(null)
  const tree = await render()

  const shown = texts(tree)
  expect(shown).toContain(other)
  expect(shown).not.toContain(HOST)
  expect(shown).toContain(en.receive.lnCheckAgain)
  expect(quote).not.toHaveBeenCalled()

  await ReactTestRenderer.act(async () => {
    press(tree, en.receive.lnCheckAgain)
  })
  await settle(tree)
  // The press asks after the payment that was made, never the domain on screen.
  expect(confirm).toHaveBeenLastCalledWith(expect.anything(), other, 'ref-9')
  expect(quote).not.toHaveBeenCalled()
  expect(await realOnboard().loadPendingPurchase()).toMatchObject({ host: other, reference: 'ref-9' })
})

// The renewal shares pay(), so it shares the trap. Preparing a send moves no money and throws for
// the commonest reason there is, too little balance; a proof left behind by that throw hides every
// price behind a wait on a charge the gateway never took, and the owner can never renew again.
it('offers the renewal price again after a send that never left', async () => {
  ;(sparkPrepareSend as jest.Mock).mockRejectedValueOnce(new Error('insufficient balance'))
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  const tree = await render()
  await pay(tree)

  expect(sparkConfirmSend).not.toHaveBeenCalled()
  expect(confirm).not.toHaveBeenCalled()
  expect(await RNFS.exists(PENDING)).toBe(false)
  const shown = texts(tree)
  expect(shown).not.toContain(en.receive.lnCheckAgain)
  expect(shown).toContain(`${formatSats(199_800)} sats`)

  // And the next open prices the year again rather than waiting on a payment nobody made.
  const reopened = await render()
  expect(texts(reopened)).toContain(`${formatSats(199_800)} sats`)
  expect(texts(reopened)).not.toContain(en.receive.lnCheckAgain)
  expect(quote).toHaveBeenCalledTimes(2)
  expect(confirm).not.toHaveBeenCalled()
})

// The renewal shares pay(), so it shares the trap on the far side of the dispatch. The record is
// promoted before the send, and a balance too small is not discovered by preparing the send, it is
// discovered by the send throwing. Kept, that proof waits forever on a charge the gateway never
// took, and it tells the owner their money is on its way while it is still theirs.
it('offers the renewal price again when the send refused for too little balance', async () => {
  ;(sparkConfirmSend as jest.Mock).mockRejectedValueOnce(
    new Error('PaymentError.InsufficientFunds: not enough funds'),
  )
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  const tree = await render()
  await pay(tree)

  expect(confirm).not.toHaveBeenCalled()
  expect(await RNFS.exists(PENDING)).toBe(false)
  const shown = texts(tree)
  expect(shown.join(' ')).toContain(en.useDomain.payFailed)
  expect(shown).not.toContain(en.receive.lnCheckAgain)
  expect(shown).toContain(`${formatSats(199_800)} sats`)

  // And the next open prices the year again rather than waiting on a payment nobody made.
  const reopened = await render()
  expect(texts(reopened)).toContain(`${formatSats(199_800)} sats`)
  expect(texts(reopened)).not.toContain(en.receive.lnCheckAgain)
})

// A throw once the send was dispatched says nothing about whether the money left, so the proof stays
// and the renewal stays on the payment. A price still on offer there is the second charge for one
// year.
it('stays on the renewal payment when the send threw after it was dispatched', async () => {
  ;(sparkConfirmSend as jest.Mock).mockRejectedValueOnce(new Error('Network request failed'))
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  const tree = await render()
  await pay(tree)

  expect(await RNFS.exists(PENDING)).toBe(true)
  expect(await realOnboard().loadPendingPurchase()).toMatchObject({ host: HOST, reference: 'ref-1' })
  const shown = texts(tree)
  expect(shown).toContain(en.receive.lnCheckAgain)
  expect(shown).not.toContain(`${formatSats(199_800)} sats`)

  confirm.mockResolvedValue(null)
  await ReactTestRenderer.act(async () => {
    press(tree, en.receive.lnCheckAgain)
  })
  await settle(tree)
  expect(confirm).toHaveBeenCalledWith(expect.anything(), HOST, 'ref-1')
  expect(quote).toHaveBeenCalledTimes(1)
})

// A payment can reach the slot while the renewal price sits on screen, since the recovery on the
// Home screen files a proof for every charge the gateway says this wallet is owed. The new price
// offered once the hold lapses is then the second charge for one year.
it('finishes the renewal already owed instead of minting the new price it offers', async () => {
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  confirm.mockResolvedValue(null)
  const tree = await render()
  await realOnboard().savePendingPurchase({ host: HOST, reference: 'ref-1', amountSats: 199800 })

  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(601_000)
  })
  await settle(tree)
  await ReactTestRenderer.act(async () => {
    press(tree, en.useDomain.requote)
  })
  await settle(tree)

  expect(quote).toHaveBeenCalledTimes(1)
  expect(confirm).toHaveBeenCalledWith(expect.anything(), HOST, 'ref-1')
  expect(await realOnboard().loadPendingPurchase()).toMatchObject({ host: HOST, reference: 'ref-1' })
  expect(texts(tree)).toContain(en.receive.lnCheckAgain)
})

// A confirmation that cannot be reached says nothing about where the money went. The screen has to
// read as a payment waiting on the gateway, never as a price waiting to be asked for.
it('still shows the payment as owed when the confirmation cannot be reached', async () => {
  await realOnboard().savePendingPurchase({ host: HOST, reference: 'ref-1', amountSats: 199800 })
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  confirm.mockRejectedValue(new Error('Network request failed'))
  const tree = await render()

  const shown = texts(tree)
  expect(shown).toContain(en.receive.lnCheckAgain)
  expect(shown).not.toContain(en.useDomain.requote)
  expect(quote).not.toHaveBeenCalled()
  expect(await RNFS.exists(PENDING)).toBe(true)
})

it('falls back to the ordinary purchase when the param is not a domain', async () => {
  // A destination is not a promise that its payload is well formed. Opening a payment for a host
  // nobody can name would leave a button that pays for nothing.
  mockParams = { renew: 'not a domain' }
  const tree = await render()

  expect(tree.root.findAllByType(TextInput).length).toBeGreaterThan(0)
  expect(quote).not.toHaveBeenCalled()
  expect(claim).not.toHaveBeenCalled()
})

// A year the charge bought before owes nothing, so once its answer is heard the next opening sells the
// renewal in sats instead of standing on that charge for ever. A refusal still owed keeps the
// renewal behind the payment, as before.
describe('a renewal after a paid year answered for good', () => {
  const refusals = {
    boughtBefore: () => Object.assign(new Error('bought_before'), { final: true }),
    kept: () => new Error('paid_but_not_granted'),
  }

  for (const which of ['boughtBefore', 'kept'] as const) {
    it(`${which === 'kept' ? 'control: a refusal still owed' : 'a year bought before'} ${which === 'kept' ? 'keeps' : 'stops'} blocking the renewal at the next opening`, async () => {
      await realOnboard().savePendingPurchase({ host: HOST, reference: 'ref-0', amountSats: 199800 })
      claim.mockResolvedValue(live())
      quote.mockResolvedValue(priced())
      confirm.mockRejectedValue(refusals[which]())
      const first = await render()
      expect(quote).not.toHaveBeenCalled()
      expect(confirm).toHaveBeenCalledTimes(1)
      await ReactTestRenderer.act(async () => {
        first.unmount()
      })

      const tree = await render()
      expect(confirm).toHaveBeenCalledTimes(which === 'kept' ? 2 : 1)
      expect(quote).toHaveBeenCalledTimes(which === 'kept' ? 0 : 1)
      expect(texts(tree).includes(`${formatSats(199_800)} sats`)).toBe(which !== 'kept')
    })
  }
})

// A line kept while no view could show it is said on mount, and the mount still resumes what it
// resumes with no proof held, the renewal's claim and price here. The next mount sells
// the renewal.
it('a kept year line is said on mount, and the renewal still resumes', async () => {
  const recover = (en as unknown as { recover: Record<string, string> }).recover
  const said = recover.boughtBeforeBody!.replace('{{subject}}', HOST)
  const lines = jest.requireActual('../src/wallet/releasedLines') as typeof import('../src/wallet/releasedLines')
  await lines.noteLine({ kind: 'tier', reference: 'ref-0', answer: 'boughtBefore', subject: HOST }, await lines.activeScope())
  claim.mockResolvedValue(live())
  quote.mockResolvedValue(priced())
  const first = await render()
  expect(texts(first).join(' ')).toContain(said)
  expect(confirm).not.toHaveBeenCalled()
  expect(claim).toHaveBeenCalledWith(expect.anything(), HOST)
  expect(await lines.listLines()).toEqual([])
  await ReactTestRenderer.act(async () => {
    first.unmount()
  })

  const tree = await render()
  expect(texts(tree).join(' ')).not.toContain(said)
  expect(texts(tree).includes(`${formatSats(199_800)} sats`)).toBe(true)
})

// The recovery sweep shares the record a renewal waits on. A failed press leaves a line that the year
// completes later, false once the sats came back, so it goes with the wait; a year the sweep
// delivered shows as renewed, from the year its grant answered, never as a fresh price.
describe('a renewal wait another reader settles', () => {
  const LATER = 'the app completes it the next time you open it'
  const repaid = () => Object.assign(new Error('paid_but_not_granted'), { repaid: true })

  // A due sweep beside the screen, its confirmation answered by `answer` and its writes inside act.
  async function sweep(answer: () => Promise<unknown>): Promise<unknown> {
    confirm.mockImplementationOnce(answer as never)
    const asked = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`
    if (await RNFS.exists(asked)) {
      await RNFS.unlink(asked)
    }
    const { recoverPurchases } = jest.requireActual('../src/wallet/recover') as typeof import('../src/wallet/recover')
    const charges = [{ reference: 'ref-1', kind: 'tier', domain: 'lnurl.usevoltz.app', subject: HOST, amountSats: 199800 }]
    let card: unknown
    await ReactTestRenderer.act(async () => {
      card = await recoverPurchases({
        walletId: 'primary',
        lines: (jest.requireActual('../src/wallet/releasedLines') as typeof import('../src/wallet/releasedLines')).scopeOn('primary'),
        pubkey: `02${'a'.repeat(64)}`,
        sign: async () => 'sig',
        onScreen: () => true,
        request: (async () => ({ ok: true, status: 200, json: async () => ({ charges }) })) as unknown as typeof fetch,
      })
    })
    expect(await realOnboard().loadPendingPurchase()).toBeNull()
    return card
  }

  // A renewal paid and waiting, whose Check again lost to the network.
  async function failedCheck(): Promise<ReactTestRenderer.ReactTestRenderer> {
    await realOnboard().savePendingPurchase({ host: HOST, reference: 'ref-1', amountSats: 199800 })
    claim.mockResolvedValue(live('active'))
    quote.mockResolvedValue(priced())
    confirm.mockRejectedValueOnce(new Error('Network request failed'))
    const tree = await render()
    expect(texts(tree).join(' ')).toContain('Waiting for it to be seen')
    confirm.mockRejectedValueOnce(new Error('Network request failed'))
    await ReactTestRenderer.act(async () => {
      press(tree, en.receive.lnCheckAgain!)
    })
    await settle(tree)
    expect(texts(tree).join(' ')).toContain(LATER)
    return tree
  }

  it('a failed Check again says nothing of completing once the sweep gives the proof up', async () => {
    const tree = await failedCheck()
    expect(await sweep(async () => Promise.reject(repaid()))).toMatchObject({ status: 'repaid', reference: 'ref-1' })
    await settle(tree)
    const shown = texts(tree)
    expect(shown.join(' ')).not.toContain(LATER)
    expect(shown.join(' ')).not.toContain('Waiting for it to be seen')
    expect(shown).toContain(en.useDomain.requote)
    expect(quote).not.toHaveBeenCalled()
  })

  it('a renewal the sweep delivers shows the renewed year and offers no new price', async () => {
    const tree = await failedCheck()
    expect(await sweep(async () => ({ expiresAt: NEW_EXPIRY, frozen: false }))).toMatchObject({
      status: 'ready',
      reference: 'ref-1',
    })
    await settle(tree)
    const shown = texts(tree)
    expect(shown).toContain(renewCopy('renewDone', formatDate(NEW_EXPIRY, deviceDateTimePrefs())))
    expect(shown).not.toContain(en.useDomain.requote)
    expect(shown).not.toContain(en.receive.lnCheckAgain)
    expect(shown.join(' ')).not.toContain(LATER)
    expect(shown).not.toContain(`${formatSats(199_800)} sats`)
    expect(quote).not.toHaveBeenCalled()
    expect(confirm).toHaveBeenCalledTimes(3)
  })
})
