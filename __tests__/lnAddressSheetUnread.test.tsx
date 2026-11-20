import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, ScrollView, Text, TextInput } from 'react-native'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { carriedTexts, expectMailFallback, expectNoMailFallback, mailBody, pressCopy } from './support/mailFallback'
import { LnAddressSheet } from '../src/components/LnAddressSheet'
import { Sheet } from '../src/components/Sheet'
import { Skeleton } from '../src/components/Skeleton'
import { StoreNameOffer } from '../src/components/StoreNameOffer'
import { sparkCheckLnAddress, sparkConfirmSend } from '../src/wallet/spark'
import { DISOWNED } from '../src/wallet/lnRefusal'
import { clearPending, loadPending, recordRefusal, savePending } from '../src/wallet/purchase'
import { touch } from '../src/theme'
import { SupportMailCard } from '../src/components/SupportMail'

// A proof file that cannot be read may stand for a name already paid for. The sheet then offers no
// price and no store offer, and sends the buyer to support with the wallet's key.

const PUBKEY = `02${'a'.repeat(64)}`

jest.mock('../src/wallet/spark', () => ({
  connectedLnurlDomain: jest.fn(() => undefined),
  sparkGetLnAddress: jest.fn(async () => null),
  sparkCheckLnAddress: jest.fn(async () => true),
  sparkRegisterLnAddress: jest.fn(),
  sparkDeleteLnAddress: jest.fn(async () => undefined),
  // The session's wallet, the one the registry answers here, which a paid name is registered on.
  sparkConnectedWalletId: jest.fn(() => 'primary'),
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkPrepareSend: jest.fn(async () => ({ handle: 'h-1', amount: 19800, fee: 0 })),
  sparkConfirmSend: jest.fn(async () => 'complete'),
}))

const mockDistribution = { value: 'direct' as 'direct' | 'store' }
jest.mock('../src/config', () => ({
  getBreezLnurlDomain: () => 'lnurl.usevoltz.app',
  getDistribution: () => mockDistribution.value,
}))

jest.mock('../src/wallet/namePurchase', () => {
  const real = jest.requireActual('../src/wallet/namePurchase')
  return { ...real, quoteName: jest.fn(), confirmName: jest.fn() }
})

// The store's offer is its own component with its own suites; here only whether the sheet shows it
// matters.
jest.mock('../src/components/StoreNameOffer', () => ({ StoreNameOffer: jest.fn(() => null) }))

// The real read, wrapped so one case can make it fail for another reason, and the real clear,
// wrapped so a case can tell a clear that did nothing from one never asked for.
jest.mock('../src/wallet/purchase', () => {
  const real = jest.requireActual('../src/wallet/purchase')
  return { ...real, loadPending: jest.fn(real.loadPending), clearPending: jest.fn(real.clearPending) }
})

const quote = jest.requireMock('../src/wallet/namePurchase').quoteName as jest.Mock
const confirm = jest.requireMock('../src/wallet/namePurchase').confirmName as jest.Mock

const STORE = `${RNFS.DocumentDirectoryPath}/purchases.json`
const TORN = '{"primary": {"name": {"reference": "ref'

const realWrite = RNFS.writeFile.bind(RNFS)
const put = (path: string, text: string): Promise<void> => realWrite(path, text, 'utf8')
const raw = async (path: string): Promise<string | null> =>
  (await RNFS.exists(path)) ? RNFS.readFile(path, 'utf8') : null

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function settle(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 450))
  })
}

const sheet = (visible: boolean, onClose: () => void = jest.fn()) => (
  <LnAddressSheet visible={visible} onClose={onClose} onRegistered={jest.fn()} />
)

async function render(onClose: () => void = jest.fn()): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(sheet(true, onClose))
  })
  await settle()
  return tree
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
  await settle()
}

const UNREAD = i18n.t('recover.recordUnread')
const SUPPORT = i18n.t('recover.sendToSupport')

function expectUnread(tree: ReactTestRenderer.ReactTestRenderer): void {
  const shown = texts(tree)
  expect(shown).toContain(UNREAD)
  expect(shown).toContain(SUPPORT)
  for (const key of ['receive.lnPay', 'receive.lnSeePrice', 'receive.lnUseName', 'receive.lnSettling', 'receive.lnCheckAgain']) {
    expect({ key, shown: shown.includes(i18n.t(key)) }).toEqual({ key, shown: false })
  }
  expect(tree.root.findAllByType(StoreNameOffer)).toHaveLength(0)
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.clearAllMocks()
  mockDistribution.value = 'direct'
  jest.mocked(sparkCheckLnAddress).mockResolvedValue(true)
  jest.mocked(sparkConfirmSend).mockResolvedValue('complete' as never)
  quote.mockResolvedValue({
    username: 'alice',
    priceUsdCents: 990,
    amountSats: 19800,
    invoice: 'lnbc1',
    reference: 'ref-1',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })
  confirm.mockResolvedValue(true)
})

describe('a proof file that cannot be read on open', () => {
  test.each(['direct', 'store'] as const)('takes the sheet on a %s build, with no price and no store offer', async build => {
    mockDistribution.value = build
    await put(STORE, TORN)
    const tree = await render()
    expectUnread(tree)
    // Typing a name offers nothing either.
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(TextInput).props.onChangeText('alice')
    })
    await settle()
    expectUnread(tree)
    expect(texts(tree)).not.toContain(i18n.t('receive.lnAvailable'))
    expect(quote).not.toHaveBeenCalled()
  })

  // The same sheet over a file that reads still offers the store or the price, which is what makes
  // the case above a refusal rather than a sheet that offers nothing anywhere.
  test.each(['direct', 'store'] as const)('a file that reads leaves the %s build its offer', async build => {
    mockDistribution.value = build
    const tree = await render()
    expect(texts(tree)).not.toContain(UNREAD)
    if (build === 'store') {
      expect(tree.root.findAllByType(StoreNameOffer)).toHaveLength(1)
    } else {
      expect(texts(tree)).toContain(i18n.t('receive.lnSeePrice'))
    }
  })

  test('the support press mails the wallet key and says the record could not be read', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    await put(STORE, TORN)
    const tree = await render()
    await press(tree, SUPPORT)
    const url = decodeURIComponent(String(open.mock.calls[0]?.[0]))
    expect(url).toContain('mailto:support@usevoltz.app')
    expect(url).toContain(`Wallet: ${PUBKEY}`)
    expect(url).toContain(`Payment: ${i18n.t('recover.mailRecordUnread')}`)
    open.mockRestore()
  })

  // A phone with no app for mailto rejects the link, and the press then leaves the address, the
  // mail's text and Copy rather than nothing.
  test('a mail that does not open leaves the address, the mail text and Copy', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no mail app'))
    await put(STORE, TORN)
    const tree = await render()
    expectNoMailFallback(tree)
    await press(tree, SUPPORT)
    const body = mailBody(open.mock.calls[0]?.[0])
    expect(body).toContain(`Wallet: ${PUBKEY}`)
    expectMailFallback(tree, body)
    expect(await pressCopy(tree)).toBe(body)
    open.mockRestore()
  })

  // A mail app can open and still send nothing, as a Gmail signed in to no account does.
  test('a mail that opens still leaves the address, the mail text and Copy', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    await put(STORE, TORN)
    const tree = await render()
    expectNoMailFallback(tree)
    await press(tree, SUPPORT)
    expect(open).toHaveBeenCalledTimes(1)
    const body = mailBody(open.mock.calls[0]?.[0])
    expect(body).toContain(`Wallet: ${PUBKEY}`)
    expectMailFallback(tree, body, 'opened')
    expect(await pressCopy(tree)).toBe(body)
    open.mockRestore()
  })

  // At the largest text sizes the title, the field and the unread line pass the sheet's cap, and a
  // button below it is off screen and out of the accessibility tree unless the content scrolls.
  test('every control of the sheet scrolls under its cap', async () => {
    await put(STORE, TORN)
    const tree = await render()
    const scroll = tree.root.findByType(Sheet).findByType(ScrollView)
    const inside = (node: ReactTestRenderer.ReactTestInstance) => {
      for (let at: ReactTestRenderer.ReactTestInstance | null = node; at; at = at.parent) {
        if (at === scroll) {
          return true
        }
      }
      return false
    }
    const controls = tree.root.findAll(n => typeof n.props.onPress === 'function' && typeof n.type !== 'string')
    const support = controls.filter(n => n.findAllByType(Text).some(x => x.props.children === SUPPORT))
    expect(support.length).toBeGreaterThan(0)
    expect(support.every(inside)).toBe(true)
    expect(inside(tree.root.findByType(TextInput))).toBe(true)
  })

  test('closing leaves the file as it was', async () => {
    await put(STORE, TORN)
    const onClose = jest.fn()
    const tree = await render(onClose)
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(Sheet).props.onClose()
    })
    await settle()
    expect(onClose).toHaveBeenCalled()
    expect(await raw(STORE)).toBe(TORN)
  })

  // A torn copy with no file is a first write that was cut, whose last finished state is no proof.
  test.each(['direct', 'store'] as const)(
    'a torn copy with no file leaves the %s build its offer, and the price is paid over it',
    async build => {
      mockDistribution.value = build
      await put(`${STORE}.tmp`, TORN)
      const tree = await render()
      expect(texts(tree)).not.toContain(UNREAD)
      if (build === 'store') {
        expect(tree.root.findAllByType(StoreNameOffer)).toHaveLength(1)
        return
      }
      await ReactTestRenderer.act(async () => {
        tree.root.findByType(TextInput).props.onChangeText('alice')
      })
      await settle()
      await press(tree, i18n.t('receive.lnSeePrice'))
      expect(texts(tree)).toContain(i18n.t('receive.lnPay'))
      await press(tree, i18n.t('receive.lnPay'))
      expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
      expect([await raw(`${STORE}.tmp`), await raw(`${STORE}.unreadable`)]).toEqual([null, null])
    },
  )

  test('the next open whose read answers gives the sheet back', async () => {
    await put(STORE, TORN)
    const tree = await render()
    expectUnread(tree)
    await RNFS.unlink(STORE)
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(false))
    })
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(true))
    })
    await settle()
    expect(texts(tree)).not.toContain(UNREAD)
    expect(texts(tree)).toContain(i18n.t('receive.lnSeePrice'))
  })
})

// A read the platform refuses reads nothing, as a torn proof does, so the sheet says the record could
// not be read and claims no payment, and no price or offer stands beside a proof that may be there.
test.each(['direct', 'store'] as const)(
  'a read that fails for another reason takes the sheet on a %s build, with no line about a payment',
  async build => {
    mockDistribution.value = build
    jest.mocked(loadPending).mockRejectedValueOnce(new Error('disk busy'))
    const tree = await render()
    expectUnread(tree)
  },
)

// The platform's refusal goes through the real reader into the sheet, so this holds the two together
// rather than either one alone.
test('end to end through the real reader, an intact proof whose read the platform refuses takes the sheet and keeps its bytes', async () => {
  await savePending({ kind: 'name', subject: 'alice', reference: 'ref-1', amountSats: 1 })
  const intact = await raw(STORE)
  const real = RNFS.readFile.bind(RNFS)
  jest.spyOn(RNFS, 'readFile').mockImplementation(((path: string, encoding?: string) =>
    path === STORE ? Promise.reject(new Error('EIO: i/o error')) : (real as (...a: unknown[]) => Promise<string>)(path, encoding)) as never)
  const tree = await render()
  expectUnread(tree)
  jest.mocked(RNFS.readFile).mockRestore()
  expect(await raw(STORE)).toBe(intact)
})

// The open reads the proof before a price is offered, so no price stands beside a payment the read has
// not answered for yet. Each opening waits on its own read. The store's offer never reads the sats
// proof, and stays mounted, since unmounting it on every opening would drop a purchase it waits on.
describe('while the open is reading the proof', () => {
  // Holds the next proof read until `answer` is called with what it finds.
  function holdRead(): (found: Awaited<ReturnType<typeof loadPending>>) => void {
    let answer!: (found: Awaited<ReturnType<typeof loadPending>>) => void
    jest.mocked(loadPending).mockImplementationOnce(
      () => new Promise(resolve => (answer = resolve)),
    )
    return found => answer(found)
  }

  test('a direct build offers no price until the read answers', async () => {
    const answer = holdRead()
    const tree = await render()
    expect(texts(tree)).not.toContain(i18n.t('receive.lnSeePrice'))
    expect(texts(tree)).not.toContain(i18n.t('receive.lnUseName'))
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    await ReactTestRenderer.act(async () => {
      answer(null)
    })
    await settle()
    expect(texts(tree)).toContain(i18n.t('receive.lnSeePrice'))
  })

  // On a domain whose year is paid the button says Use this name rather than See the price, and it
  // waits on the same read.
  test('a domain with free names offers Use this name only once the read answers', async () => {
    const answer = holdRead()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <LnAddressSheet visible domain="bakery.com.br" namesFree onClose={jest.fn()} onRegistered={jest.fn()} />,
      )
    })
    await settle()
    expect(texts(tree)).not.toContain(i18n.t('receive.lnUseName'))
    expect(texts(tree)).not.toContain(i18n.t('receive.lnSeePrice'))
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    await ReactTestRenderer.act(async () => {
      answer(null)
    })
    await settle()
    expect(texts(tree)).toContain(i18n.t('receive.lnUseName'))
    expect(texts(tree)).not.toContain(i18n.t('receive.lnSeePrice'))
  })

  test('a store build keeps its offer mounted while the read is in flight', async () => {
    mockDistribution.value = 'store'
    const answer = holdRead()
    const tree = await render()
    const offer = tree.root.findAllByType(StoreNameOffer)
    expect(offer).toHaveLength(1)
    await ReactTestRenderer.act(async () => {
      answer(null)
    })
    await settle()
    expect(tree.root.findAllByType(StoreNameOffer)[0]).toBe(offer[0])
  })

  test('a read from an earlier opening that answers late does not end the wait of the next one', async () => {
    const first = holdRead()
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(false))
    })
    const second = holdRead()
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(true))
    })
    await ReactTestRenderer.act(async () => {
      first(null)
    })
    await settle()
    expect(texts(tree)).not.toContain(i18n.t('receive.lnSeePrice'))
    await ReactTestRenderer.act(async () => {
      second(null)
    })
    await settle()
    expect(texts(tree)).toContain(i18n.t('receive.lnSeePrice'))
  })

  // The earlier read answers first in the proofs' queue, so the latest one says the same or newer, and
  // only the latest decides the sheet.
  test('a late refusal from an earlier opening does not take the next one as unread', async () => {
    let refuse!: (err: Error) => void
    jest.mocked(loadPending).mockImplementationOnce(() => new Promise((_resolve, reject) => (refuse = reject)))
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(false))
    })
    const second = holdRead()
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(true))
    })
    await ReactTestRenderer.act(async () => {
      refuse(new Error('EIO: i/o error'))
    })
    await settle()
    expect(texts(tree)).not.toContain(UNREAD)
    await ReactTestRenderer.act(async () => {
      second(null)
    })
    await settle()
    expect(texts(tree)).not.toContain(UNREAD)
    expect(texts(tree)).toContain(i18n.t('receive.lnSeePrice'))
  })

  test('a proof an earlier opening finds late is not resumed under the next one', async () => {
    const first = holdRead()
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(false))
    })
    const second = holdRead()
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(true))
    })
    await ReactTestRenderer.act(async () => {
      first({ kind: 'name', subject: 'alice', reference: 'ref-9', amountSats: 19800 })
    })
    await settle()
    expect(confirm).not.toHaveBeenCalled()
    expect(texts(tree)).not.toContain(i18n.t('receive.lnCheckAgain'))
    await ReactTestRenderer.act(async () => {
      second(null)
    })
    await settle()
    expect(confirm).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('receive.lnSeePrice'))
  })

  // No bounded wait ends the read: a price beside a payment the proof may hold invites paying twice,
  // and Pay could not write its own proof behind the stuck read anyway.
  test('a read that never answers keeps the button shape, with no price, however long the sheet stays open', async () => {
    jest.mocked(loadPending).mockImplementationOnce(() => new Promise(() => undefined))
    jest.useFakeTimers()
    try {
      let tree!: ReactTestRenderer.ReactTestRenderer
      await ReactTestRenderer.act(async () => {
        tree = ReactTestRenderer.create(sheet(true))
      })
      await ReactTestRenderer.act(async () => {
        tree.root.findByType(TextInput).props.onChangeText('alice')
      })
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(60 * 60_000)
      })
      await ReactTestRenderer.act(async () => {
        await Promise.resolve()
      })
      expect(jest.mocked(sparkCheckLnAddress)).toHaveBeenCalledWith('alice')
      for (const key of ['receive.lnSeePrice', 'receive.lnUseName', 'receive.lnPay', 'recover.recordUnread']) {
        expect({ key, shown: texts(tree).includes(i18n.t(key)) }).toEqual({ key, shown: false })
      }
      expect(tree.root.findAllByType(Skeleton).some(node => node.props.height === touch.action)).toBe(true)
      expect(quote).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})

// The send's failure says nothing about whether the money left, so the sheet reads the proof again;
// a proof that cannot be read then takes the sheet, and Close drops nothing.
test('a pay whose catch finds the proof unreadable shows the unread line, and Close leaves the bytes', async () => {
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText('alice')
  })
  await settle()
  await press(tree, i18n.t('receive.lnSeePrice'))
  jest.mocked(sparkConfirmSend).mockImplementationOnce(async () => {
    await put(STORE, TORN)
    throw new Error('network')
  })
  await press(tree, i18n.t('receive.lnPay'))
  expectUnread(tree)
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(Sheet).props.onClose()
  })
  await settle()
  expect(await raw(STORE)).toBe(TORN)
})

// The send's failure says nothing about whether the money left, and a read that does not answer says
// nothing about the proof, so the sheet takes the unread state: no price, and no line claiming a payment.
test('a pay whose catch read does not answer takes the sheet rather than the price, and keeps the proof', async () => {
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText('alice')
  })
  await settle()
  await press(tree, i18n.t('receive.lnSeePrice'))
  jest.mocked(sparkConfirmSend).mockRejectedValueOnce(new Error('network'))
  // The two writes of the proof read through the real reader; the catch's read is the one that fails.
  jest.mocked(loadPending).mockRejectedValueOnce(new Error('disk busy'))
  await press(tree, i18n.t('receive.lnPay'))
  expectUnread(tree)
  expect((await loadPending('name'))?.reference).toBe('ref-1')
})

// A price from an earlier open is still set when the sheet opens again over a proof that stopped
// reading, and Close then clears nothing, since what the file holds is not known. The clear over a
// torn file would leave the bytes alone anyway, so only whether it was asked shows the guard.
test('Close over a proof that stopped reading asks no clear, though an earlier price is still set', async () => {
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText('alice')
  })
  await settle()
  await press(tree, i18n.t('receive.lnSeePrice'))
  expect(texts(tree)).toContain(i18n.t('receive.lnPay'))
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(Sheet).props.onClose()
  })
  await settle()
  expect(clearPending).toHaveBeenCalledTimes(1)

  await put(STORE, TORN)
  await ReactTestRenderer.act(async () => {
    tree.update(sheet(false))
  })
  await ReactTestRenderer.act(async () => {
    tree.update(sheet(true))
  })
  await settle()
  expectUnread(tree)
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(Sheet).props.onClose()
  })
  await settle()
  expect(clearPending).toHaveBeenCalledTimes(1)
  expect(await raw(STORE)).toBe(TORN)
})

// The gateway disowning the reference leads to releasing the record, and a record that cannot be
// read by then is released by nothing and takes the sheet as at the open.
test('a disowned payment whose record stopped reading shows the unread line and keeps the bytes', async () => {
  await savePending({ kind: 'name', subject: 'alice', reference: 'ref-old', amountSats: 19800 })
  confirm.mockImplementationOnce(async () => {
    await put(STORE, TORN)
    throw new Error(DISOWNED)
  })
  const tree = await render()
  expect(confirm).toHaveBeenCalledTimes(1)
  expectUnread(tree)
  expect(await raw(STORE)).toBe(TORN)
})

// The card beside a payment the gateway will not grant stays after a mail that opens, since a mail
// app can open and still send nothing, as a Gmail signed in to no account does.
test('a mail that opens beside a kept payment leaves the address, the mail text and Copy', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  await savePending({ kind: 'name', subject: 'alice', reference: 'ref-kept', amountSats: 19800 })
  await recordRefusal('name', 'ref-kept', true)
  confirm.mockImplementationOnce(() => new Promise(() => undefined))
  const tree = await render()
  expect(texts(tree)).toContain(i18n.t('recover.blockedBody'))
  expectNoMailFallback(tree)
  await press(tree, SUPPORT)
  expect(open).toHaveBeenCalledTimes(1)
  const body = mailBody(open.mock.calls[0]?.[0])
  expect(body).toContain('ref-kept')
  expectMailFallback(tree, body, 'opened')
  expect(await pressCopy(tree)).toBe(body)
  open.mockRestore()
})

// A read the platform refuses there releases nothing either, and leaves the sheet in the same state
// as a torn record, never on the wait for a payment nothing read.
test('a disowned payment whose record read the platform refuses shows the unread line and keeps the bytes', async () => {
  await savePending({ kind: 'name', subject: 'alice', reference: 'ref-old', amountSats: 19800 })
  const intact = await raw(STORE)
  const real = RNFS.readFile.bind(RNFS)
  confirm.mockImplementationOnce(async () => {
    jest.spyOn(RNFS, 'readFile').mockImplementation(((path: string, encoding?: string) =>
      path === STORE
        ? Promise.reject(new Error('EIO: i/o error'))
        : (real as (...a: unknown[]) => Promise<string>)(path, encoding)) as never)
    throw new Error(DISOWNED)
  })
  try {
    const tree = await render()
    expect(confirm).toHaveBeenCalledTimes(1)
    expectUnread(tree)
    expect(texts(tree)).not.toContain(i18n.t('receive.lnSettling'))
  } finally {
    jest.mocked(RNFS.readFile).mockRestore()
  }
  expect(await raw(STORE)).toBe(intact)
})

// A card left by a refused mail names the payment it was about, and once the sheet moves on to a
// record that stopped reading, whose mail names no payment, that card goes with it.
test('a support card about a kept payment goes once the record stops reading', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no mail app'))
  await savePending({ kind: 'name', subject: 'alice', reference: 'ref-kept', amountSats: 19800 })
  await recordRefusal('name', 'ref-kept', true)
  let answer!: () => void
  confirm.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        answer = () => {
          put(STORE, TORN).then(() => reject(new Error(DISOWNED)))
        }
      }),
  )
  const tree = await render()
  expect(texts(tree)).toContain(i18n.t('recover.blockedBody'))
  await press(tree, SUPPORT)
  const carried = (): string[] =>
    carriedTexts(tree)
  expect(carried()).toEqual([expect.stringContaining('ref-kept')])
  expect(tree.root.findByType(SupportMailCard).props.raised).toBe(true)

  await ReactTestRenderer.act(async () => {
    answer()
  })
  await settle()
  expectUnread(tree)
  expect(carried().filter(text => text.includes('ref-kept'))).toEqual([])
  open.mockRestore()
})
