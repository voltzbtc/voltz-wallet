import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, Text } from 'react-native'
import RNFS from 'react-native-fs'
import Clipboard from '@react-native-clipboard/clipboard'
import i18n from '../src/i18n'
import {
  carriedTexts,
  expectMailFallback,
  expectNoMailFallback,
  pressCopy as copyFromCard,
} from './support/mailFallback'
import { MenuRow } from '../src/components/MenuRow'
import { SupportScreen } from '../src/screens/SupportScreen'
import { SupportMailCard } from '../src/components/SupportMail'
import { savePending } from '../src/wallet/purchase'
import { sparkGetIdentityPubkey } from '../src/wallet/spark'
import { paymentEvidence } from '../src/wallet/recover'
import { getActiveWalletId } from '../src/wallet/walletRegistry'

const PUBKEY = `02${'a'.repeat(64)}`

jest.mock('../src/wallet/spark', () => ({
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
}))

jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn(async () => 'w_a') }))
// The real evidence read, wrapped so a test can make it fail.
jest.mock('../src/wallet/recover', () => {
  const actual = jest.requireActual('../src/wallet/recover')
  return { ...actual, paymentEvidence: jest.fn(actual.paymentEvidence) }
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function press(label: string): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SupportScreen />)
  })
  const row = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === label))
  if (!row) {
    throw new Error(`row not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    row.props.onPress()
  })
  await settle()
  return tree
}

beforeEach(() => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(sparkGetIdentityPubkey).mockResolvedValue(PUBKEY)
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
})

// The customer whose payment the sweep found nothing for. Without this the page is a dead end for
// the one person on it who has actually lost money.
test('carries the wallet key, which is the row a person here can look the payment up by', async () => {
  await press('I paid and did not get it')
  const body = decodeURIComponent(jest.mocked(Linking.openURL).mock.calls[0][0])
  expect(body).toContain(`Wallet: ${PUBKEY}`)
  expect(body).toContain('leave the lines below as they are')
})

test('names any reference still on the device, so nothing has to be read out loud', async () => {
  await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-7', amountSats: 1 })
  await press('I paid and did not get it')
  expect(decodeURIComponent(jest.mocked(Linking.openURL).mock.calls[0][0])).toContain(
    'Payment: ref-7',
  )
})

// The device may hold several wallets, and the one that paid need not be the one open now.
test('names a payment filed under another wallet on the device', async () => {
  jest.mocked(getActiveWalletId).mockResolvedValueOnce('w_b')
  await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-other', amountSats: 1 })
  await press('I paid and did not get it')
  expect(decodeURIComponent(jest.mocked(Linking.openURL).mock.calls[0][0])).toContain('Payment: ref-other')
})

// A device that never held a proof is exactly the reinstall case, and an empty line there reads as
// a field somebody forgot to fill in.
test('says so in words when the device holds no reference at all', async () => {
  await press('I paid and did not get it')
  expect(decodeURIComponent(jest.mocked(Linking.openURL).mock.calls[0][0])).toContain(
    'Payment: none on this device',
  )
})

test('the FAQ opens the questions on the site, not the old wallet', async () => {
  await press('FAQ')
  expect(jest.mocked(Linking.openURL).mock.calls[0][0]).toBe('https://www.usevoltz.app/support/#faq')
})

// A mail app can open and still send nothing, as a Gmail signed in to no account does, so the
// address stays on screen after the mail opens.
test('contact writes to the support address on the site domain, and leaves it on screen', async () => {
  const tree = await press('Contact support')
  expect(jest.mocked(Linking.openURL).mock.calls[0][0]).toBe('mailto:support@usevoltz.app')
  expectMailFallback(tree, null, 'opened')
  expect(await copyFromCard(tree)).toBe('support@usevoltz.app')
})

test('no card shows before any mail is pressed', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SupportScreen />)
  })
  expectNoMailFallback(tree)
  tree.unmount()
})

// The contact mail carries no body, so the card names the address alone and says nothing of a
// payment.
test('contact with no app for mail leaves the address and Copy, which takes the address', async () => {
  jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no mail app'))
  const tree = await press('Contact support')
  expectMailFallback(tree, null)
  expect(await copyFromCard(tree)).toBe('support@usevoltz.app')
})

// The question mark is what a person looks for to find answers, so it marks the questions.
test('the questions carry the question mark and the contact row the mail mark', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SupportScreen />)
  })
  const iconOf = (label: string) =>
    tree.root.findAllByType(MenuRow).find(row => row.props.label === label)?.props.icon
  expect(iconOf(i18n.t('support.faq'))).toBe('help')
  expect(iconOf(i18n.t('support.contact'))).toBe('mail')
  tree.unmount()
})

// A device with no mail app, or one that refuses the link, would leave the row doing nothing. The
// screen shows the address and the text the mail would have carried, to copy, and does so as
// well when the mail opens, since an app that opens may still send nothing.
describe('the card a payment mail leaves, whether the mail opens or not', () => {
  const texts = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
    tree.root.findAllByType(Text).flatMap(n => [n.props.children].flat().filter((c): c is string => typeof c === 'string'))
  const mailText = (tree: ReactTestRenderer.ReactTestRenderer): string | undefined => carriedTexts(tree)[0]
  async function pressCopy(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    const button = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('support.copy')))!
    await ReactTestRenderer.act(async () => {
      button.props.onPress()
    })
  }

  test('shows the address and the text the mail would carry, references included', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-7', amountSats: 1 })
    jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no mail app'))

    const tree = await press('I paid and did not get it')

    const url = jest.mocked(Linking.openURL).mock.calls[0][0]
    const carried = decodeURIComponent(url.split('&body=')[1]!)
    expect(texts(tree)).toContain(i18n.t('support.mailFailed'))
    expect(texts(tree)).toContain('support@usevoltz.app')
    expect(mailText(tree)).toBe(carried)
    expect(mailText(tree)).toContain(`Wallet: ${PUBKEY}`)
    expect(mailText(tree)).toContain('Payment: ref-7')
  })

  test('Copy puts exactly the mail text on the clipboard, and says it was copied', async () => {
    jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no mail app'))
    const tree = await press('I paid and did not get it')

    await pressCopy(tree)

    expect(Clipboard.setString).toHaveBeenCalledTimes(1)
    expect(Clipboard.setString).toHaveBeenCalledWith(mailText(tree))
    expect(jest.mocked(Clipboard.setString).mock.calls[0][0]).toContain('Payment: none on this device')
    expect(texts(tree)).toContain(i18n.t('support.copied'))
  })

  test('evidence that cannot be read shows the address and says so, inventing no reference', async () => {
    jest.mocked(paymentEvidence).mockRejectedValueOnce(new Error('unreadable'))

    const tree = await press('I paid and did not get it')

    expect(Linking.openURL).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('support.referenceUnread'))
    expect(texts(tree)).toContain('support@usevoltz.app')
    // No mail was opened, so no line says one opened or failed.
    expectMailFallback(tree, null, 'none')
    expect(mailText(tree)).toBeUndefined()
    expect(texts(tree).join(' ')).not.toContain('Payment:')
    await pressCopy(tree)
    expect(Clipboard.setString).toHaveBeenCalledWith('support@usevoltz.app')
  })

  // The card and the mail say no payment is on this device only when every proof read answered.
  test.each([
    ['name record', 'purchases.json', '{"w_a": {"name": {"reference": "ref'],
    ['older name record', 'purchase-name.json', '{"reference'],
    ['domain record', 'domain-purchase.json', '{"w_a": '],
    ['store book', 'store-orders.json', '{"orders": '],
    ['store book set aside', 'store-orders.json.unreadable', '{"orders": '],
  ])('the %s that cannot be read opens no mail, and the card says it is unread, never none', async (_label, file, text) => {
    await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/${file}`, text, 'utf8')

    const tree = await press('I paid and did not get it')

    expect(Linking.openURL).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('support.referenceUnread'))
    expect(texts(tree)).toContain('support@usevoltz.app')
    expectMailFallback(tree, null, 'none')
    expect(texts(tree).join(' ')).not.toContain(i18n.t('recover.mailNoReference'))
    await pressCopy(tree)
    expect(Clipboard.setString).toHaveBeenCalledWith('support@usevoltz.app')
  })

  test('a payment found beside nothing unreadable is carried as before', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-7', amountSats: 1 })
    jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no mail app'))
    const tree = await press('I paid and did not get it')
    expect(mailText(tree)).toContain('Payment: ref-7')
    expect(texts(tree)).not.toContain(i18n.t('support.referenceUnread'))
  })

  // A torn record beside a good proof: the mail still names the payment that was read, and the card
  // says some details could not be read, never that there is none.
  test('a payment that reads beside a record that does not still reaches the mail', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-7', amountSats: 1 })
    await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/domain-purchase.json`, '{"w_a": ', 'utf8')

    const tree = await press('I paid and did not get it')

    expect(Linking.openURL).toHaveBeenCalledTimes(1)
    const sent = decodeURIComponent(jest.mocked(Linking.openURL).mock.calls[0][0])
    expect(sent).toContain('Payment: ref-7')
    expect(sent).not.toContain(i18n.t('recover.mailNoReference'))
    expect(texts(tree)).toContain(i18n.t('support.referenceUnread'))
    expect(texts(tree)).not.toContain(i18n.t('support.mailFailed'))
    expect(texts(tree)).toContain(i18n.t('support.mailOpened'))
    expect(mailText(tree)).toContain('Payment: ref-7')
  })

  test('the same case with no mail app shows both lines and the text with the payment', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-7', amountSats: 1 })
    await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/domain-purchase.json`, '{"w_a": ', 'utf8')
    jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no mail app'))

    const tree = await press('I paid and did not get it')

    expect(texts(tree)).toContain(i18n.t('support.referenceUnread'))
    expect(texts(tree)).toContain(i18n.t('support.mailFailed'))
    expect(mailText(tree)).toContain('Payment: ref-7')
    await pressCopy(tree)
    expect(Clipboard.setString).toHaveBeenCalledWith(mailText(tree))
  })

  // One card, the payment's, which holds the address the contact row would leave, so the text naming
  // the payment is still on screen to copy after that row is pressed, whether its mail opens or not.
  test.each([
    ['is refused too', false],
    ['opens', true],
  ])('the payment card survives a contact mail that %s', async (_case, contactOpens) => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-7', amountSats: 1 })
    jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no mail app'))
    const tree = await press('I paid and did not get it')
    const carried = mailText(tree)
    expect(carried).toContain('Payment: ref-7')

    if (!contactOpens) {
      jest.mocked(Linking.openURL).mockRejectedValueOnce(new Error('no mail app'))
    }
    const contact = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === 'Contact support'))!
    await ReactTestRenderer.act(async () => {
      contact.props.onPress()
    })
    await settle()

    expect(Linking.openURL).toHaveBeenLastCalledWith('mailto:support@usevoltz.app')
    expect(mailText(tree)).toBe(carried)
    expect(texts(tree)).toContain(i18n.t('support.mailFailed'))
    expect(tree.root.findAllByType(SupportMailCard)).toHaveLength(1)
  })

  // A mail app can open and still send nothing, as a Gmail signed in to no account does. The card
  // then says what to do if the mail was not sent, and claims nothing about whether it was.
  test('a mail that opens leaves the address and the text it carried, to copy', async () => {
    await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-7', amountSats: 1 })
    const tree = await press('I paid and did not get it')
    expect(Linking.openURL).toHaveBeenCalledTimes(1)
    const carried = decodeURIComponent(jest.mocked(Linking.openURL).mock.calls[0][0].split('&body=')[1]!)
    expect(texts(tree)).toContain(i18n.t('support.mailOpened'))
    expect(texts(tree)).not.toContain(i18n.t('support.mailFailed'))
    expect(texts(tree)).not.toContain(i18n.t('support.referenceUnread'))
    expect(texts(tree)).toContain('support@usevoltz.app')
    expect(mailText(tree)).toBe(carried)
    expect(mailText(tree)).toContain('Payment: ref-7')
    await pressCopy(tree)
    expect(Clipboard.setString).toHaveBeenCalledWith(carried)
  })
})
