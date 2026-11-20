import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Linking, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import Clipboard from '@react-native-clipboard/clipboard'
import { useTranslation } from 'react-i18next'
import { Card } from './Card'
import { Text } from './Text'
import { Txt } from './Txt'
import { GradientButton } from './GradientButton'
import { SUPPORT_EMAIL } from '../wallet/recover'
import { colors, font, space } from '../theme'

// What a support mail leaves beside the press that sent it. `mail` is whether an app took the
// mailto link (`opened`) or the link was rejected because no app would take it (`refused`), and
// null when no mail was opened. `text` is the body it carried (null for a mail with none), `unread`
// payment details on the device that could not be read, and `about` what the press mailed about (a
// purchase reference), when the screen can move on to another one.
export type SupportNote = {
  mail: 'opened' | 'refused' | null
  text: string | null
  unread?: boolean
  about?: string | null
}

const NO_NOTES: ReadonlyMap<string | null, SupportNote> = new Map()

// Opens a support mail and keeps what the card below needs to put the address and the mail's text
// on screen, whether the mail opened or not, since a press that leaves nothing on screen leaves
// somebody already worried about a payment with no way to reach a person. iOS rejects a mailto link
// when no app takes it, as on a phone whose Mail was deleted. Android hands the link to any app that
// claims mailto, and the open succeeds even when that app cannot send, as with a Gmail signed in to
// no account, so an opened mail is no proof the address is no longer needed.
export function useSupportMail(): {
  note: SupportNote | null
  setNote: (note: SupportNote | null) => void
  open: (url: string, text: string | null, about?: string | null) => Promise<void>
  noteFor: (about: string) => SupportNote | null
} {
  // One note per thing mailed about. Two presses about two purchases can be in flight at once, and
  // whichever answers last leaves the other's card in place.
  const [notes, setNotes] = useState(NO_NOTES)
  // Counts the clears. A mail still opening when the cards are taken away answers into a screen
  // that no longer wants it, and a closed sheet would show its card on the next opening unpressed.
  const clears = useRef(0)
  const open = useCallback(async (url: string, text: string | null, about: string | null = null): Promise<void> => {
    const sentAfter = clears.current
    let mail: SupportNote['mail'] = 'opened'
    try {
      await Linking.openURL(url)
    } catch {
      mail = 'refused'
    }
    if (clears.current !== sentAfter) {
      return
    }
    setNotes(current => new Map(current).set(about, { mail, text, about }))
  }, [])
  // The one note a screen sets by hand, or null to take every card away, as when a sheet closes,
  // along with the answer of every mail sent before it.
  const setNote = useCallback((note: SupportNote | null): void => {
    if (note === null) {
      clears.current += 1
    }
    setNotes(note ? new Map([[note.about ?? null, note]]) : NO_NOTES)
  }, [])
  // The card beside a press shows only the note about what that press mails about. A mail can
  // answer after the screen has moved on to another purchase, so the note is matched to what is on
  // screen when it renders rather than cleared when the screen moves.
  const noteFor = useCallback((about: string): SupportNote | null => notes.get(about) ?? null, [notes])
  return { note: notes.get(null) ?? null, setNote, open, noteFor }
}

// The line above the address. A mail that opened may still not have gone out, so its line says what
// to do if it did not, and claims nothing about whether it was sent.
const CAPTION = {
  refused: { text: 'support.mailFailed', address: 'support.mailFailedAddress' },
  opened: { text: 'support.mailOpened', address: 'support.mailOpenedAddress' },
} as const

// The address, the mail's text when there is one, and Copy. A body that names a payment keeps the
// line that says so; a mail without one is told only where to write, so the card claims nothing
// about a payment that the mail itself would not carry.
export function SupportMailCard({
  note,
  raised = false,
  style,
}: {
  note: SupportNote
  // For a card on a sheet or inside another card, where a card's own fill barely stands off the ground.
  raised?: boolean
  style?: StyleProp<ViewStyle>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  // Each press sets a new note, and its card starts at Copy again.
  useEffect(() => setCopied(false), [note])

  // The mail's own text when there is one, so what is pasted is exactly what the mail would carry,
  // and the address alone otherwise.
  function copy(): void {
    Clipboard.setString(note.text ?? SUPPORT_EMAIL)
    AccessibilityInfo.announceForAccessibility(t('support.copied'))
    setCopied(true)
  }

  return (
    <Card gap="sm" style={[raised && styles.raised, style]}>
      {note.unread && (
        <Txt role="caption" tone="danger">
          {t('support.referenceUnread')}
        </Txt>
      )}
      {note.mail && (
        <Txt role="caption" tone="muted">
          {t(note.text !== null ? CAPTION[note.mail].text : CAPTION[note.mail].address)}
        </Txt>
      )}
      <Txt role="bodyBold" selectable>
        {SUPPORT_EMAIL}
      </Txt>
      {note.text !== null && <MailText text={note.text} />}
      <GradientButton
        label={copied ? t('support.copied') : t('support.copy')}
        variant="secondary"
        onPress={copy}
      />
    </Card>
  )
}

// A run of the characters a key or a reference is written in, with a digit somewhere in it, long
// enough that no word of a sentence in any locale is one.
const IDENTIFIERS = /((?=[\w.-]*\d)[\w.-]{24,})/g

// The mail's text, a line at a time. A key has nowhere to wrap, so the platform breaks it mid-run and
// it reads as two words; a line holding a key or a reference stays on one line and is cut in the
// middle instead, and only the key or reference in it takes the monospace face. Copy takes the whole
// text. That line is not selectable, since Android does not reliably ellipsize a selectable TextView.
function MailText({ text }: { text: string }): React.JSX.Element {
  return (
    <View testID="support-mail-text">
      {text.split('\n').map((line, i) => {
        if (line === '') {
          return <View key={i} style={styles.blank} />
        }
        // Split by a capturing group, so every odd part is a key and only those take the mono face.
        const parts = line.split(IDENTIFIERS)
        return parts.length === 1 ? (
          <Txt key={i} role="caption" selectable>
            {line}
          </Txt>
        ) : (
          <Txt key={i} role="caption" lines={1} ellipsizeMode="middle">
            {parts.map((part, j) =>
              j % 2 === 1 ? (
                <Text key={j} style={styles.mono}>
                  {part}
                </Text>
              ) : (
                part
              ),
            )}
          </Txt>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  // surfaceVariant stands 1.27:1 off a sheet and 1.15:1 off a card. surfaceRaised stands further, but
  // it is the Copy button's own fill and takes the red line under 4.5:1.
  raised: {
    backgroundColor: colors.surfaceVariant,
  },
  // A blank line of the mail, drawn as the gap between its paragraphs.
  blank: {
    height: space.sm,
  },
  mono: {
    fontFamily: font.mono,
  },
})
