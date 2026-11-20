import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking } from 'react-native'
import { useSupportMail } from '../src/components/SupportMail'

type Mail = ReturnType<typeof useSupportMail>

function mount(): { mail: () => Mail } {
  let current!: Mail
  function Probe(): null {
    current = useSupportMail()
    return null
  }
  ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<Probe />)
  })
  return { mail: () => current }
}

// Two presses about two purchases can be in flight at once, since each first reads the wallet's key.
// What either leaves belongs beside its own purchase only.
describe('a support note', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('shows only beside the purchase its mail was about', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('no mail app'))
    const { mail } = mount()

    await ReactTestRenderer.act(async () => mail().open('mailto:a', 'about A', 'ref-a'))

    expect(mail().noteFor('ref-a')).toEqual({ mail: 'refused', text: 'about A', about: 'ref-a' })
    expect(mail().noteFor('ref-b')).toBeNull()
    expect(mail().note).toBeNull()
  })

  // Android hands a mailto link to any app that claims it, so the open resolves on a phone whose
  // Gmail is signed in to no account, and nothing is sent. The address and the text stay.
  it.each([
    ['about a purchase', 'about A', 'ref-a'],
    ['with no text, about nothing in particular', null, null],
  ])('stays when the mail opens, %s', async (_case, text, about) => {
    jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(true)
    const { mail } = mount()

    await ReactTestRenderer.act(async () => mail().open('mailto:a', text, about))

    const note = { mail: 'opened', text, about }
    expect(about === null ? mail().note : mail().noteFor(about)).toEqual(note)
  })

  it.each([
    ['a mail about another purchase opens late', 'opened', 'refused'],
    ['a mail about another purchase is refused late', 'refused', 'opened'],
  ])('keeps each card when %s', async (_case, late, early) => {
    let answerA!: () => void
    const answer = (mail: string, resolve: (v: true) => void, reject: (e: Error) => void): void =>
      mail === 'opened' ? resolve(true) : reject(new Error('no mail app'))
    jest
      .spyOn(Linking, 'openURL')
      .mockImplementationOnce(() => new Promise<true>((resolve, reject) => (answerA = () => answer(late, resolve, reject))))
      .mockImplementationOnce(() => new Promise<true>((resolve, reject) => answer(early, resolve, reject)))
    const { mail } = mount()

    let first!: Promise<void>
    ReactTestRenderer.act(() => {
      first = mail().open('mailto:a', 'about A', 'ref-a')
    })
    await ReactTestRenderer.act(async () => mail().open('mailto:b', 'about B', 'ref-b'))
    await ReactTestRenderer.act(async () => {
      answerA()
      await first
    })

    expect(mail().noteFor('ref-a')).toEqual({ mail: late, text: 'about A', about: 'ref-a' })
    expect(mail().noteFor('ref-b')).toEqual({ mail: early, text: 'about B', about: 'ref-b' })
  })

  it('says the mail opened when a later mail about the same purchase opens', async () => {
    jest
      .spyOn(Linking, 'openURL')
      .mockRejectedValueOnce(new Error('no mail app'))
      .mockResolvedValueOnce(true)
    const { mail } = mount()

    await ReactTestRenderer.act(async () => mail().open('mailto:a', 'about A', 'ref-a'))
    await ReactTestRenderer.act(async () => mail().open('mailto:a', 'about A', 'ref-a'))

    expect(mail().noteFor('ref-a')).toEqual({ mail: 'opened', text: 'about A', about: 'ref-a' })
    expect(mail().note).toBeNull()
  })

  // A sheet that closes takes every card it left, whatever each was about.
  it('setNote(null) takes every card away', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('no mail app'))
    const { mail } = mount()

    await ReactTestRenderer.act(async () => mail().open('mailto:a', 'about A', 'ref-a'))
    await ReactTestRenderer.act(async () => mail().open('mailto:x', null))
    ReactTestRenderer.act(() => mail().setNote(null))

    expect(mail().noteFor('ref-a')).toBeNull()
    expect(mail().note).toBeNull()
  })
})

// A sheet that closes while its mail is still opening clears its cards before the answer lands.
// The answer is dropped, or the card would show on the sheet's next opening with no press.
describe('a mail that answers after the cards were cleared', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    ['opens', 'about A', 'ref-a'],
    ['is refused', 'about A', 'ref-a'],
    ['opens, with no text', null, null],
  ])('leaves no note when it %s', async (outcome, text, about) => {
    let answer!: () => void
    jest.spyOn(Linking, 'openURL').mockImplementationOnce(
      () =>
        new Promise<true>((resolve, reject) => {
          answer = () => (outcome === 'is refused' ? reject(new Error('no mail app')) : resolve(true))
        }),
    )
    const { mail } = mount()

    let sent!: Promise<void>
    ReactTestRenderer.act(() => {
      sent = mail().open('mailto:a', text, about)
    })
    ReactTestRenderer.act(() => mail().setNote(null))
    await ReactTestRenderer.act(async () => {
      answer()
      await sent
    })

    expect(mail().noteFor('ref-a')).toBeNull()
    expect(mail().note).toBeNull()
  })

  it('keeps the note of a mail sent after the clear', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(true)
    const { mail } = mount()

    ReactTestRenderer.act(() => mail().setNote(null))
    await ReactTestRenderer.act(async () => mail().open('mailto:a', 'about A', 'ref-a'))

    expect(mail().noteFor('ref-a')).toEqual({ mail: 'opened', text: 'about A', about: 'ref-a' })
  })
})
