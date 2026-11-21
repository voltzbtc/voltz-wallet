import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import { type TextInputRef } from '../components/Text'
import { useTranslation } from 'react-i18next'
import Clipboard from '@react-native-clipboard/clipboard'
import { validateMnemonic, type MnemonicLength } from '../wallet/seed'
import { fingerprintFromMnemonicAsync } from '../wallet/fingerprint'
import { formatFingerprint } from '../wallet/walletIdentity'
import { splitPhrase, suggestWords, isWordlistWord } from '../wallet/mnemonicInput'
import { SegmentedControl } from '../components/SegmentedControl'
import { revealedKeyboard } from '../components/PassphraseField'
import { GradientButton } from '../components/GradientButton'
import { TabIcon } from '../components/TabIcon'
import { colors, radius, space } from '../theme'
import { Txt } from '../components/Txt'
import { Screen } from '../components/Screen'
import { Row } from '../components/Row'
import { Touch } from '../components/Touch'
import { CheckBox } from '../components/CheckBox'
import { Field } from '../components/Field'
import { ScreenTitle } from '../components/ScreenTitle'
import { ErrorBox } from '../components/ErrorBox'
import { CaptureNotice } from '../components/CaptureNotice'
import { useScreenCapture } from '../hooks/useScreenCapture'
import { indexFloor, useWindow } from '../components/SeedWordGrid'

type Props = {
  // A rejection is the write failing: the screen says so and Restore repeats it with the same words.
  onImported: (mnemonic: string, passphrase?: string) => void | Promise<void>
  // Absent once a restore has started writing, when going back could lead into a second seed.
  onBack?: () => void
  // What a refused restore had entered, shown again so a step back does not ask for it twice.
  initial?: { phrase: string; passphrase?: string }
  // Another way in, drawn above the words.
  above?: React.ReactNode
  // Inside a navigator whose header carries the title, so the step does not draw it again.
  headerTitled?: boolean
}

function emptyWords(length: number): string[] {
  return Array.from({ length }, () => '')
}

// The phrase already exists outside the app, so the BIP39 checksum is the only gate before persisting.
function initialWords(phrase: string | undefined): string[] {
  const words = phrase ? phrase.split(' ') : []
  return words.length === 12 || words.length === 24 ? words : emptyWords(12)
}

export function ImportScreen({ onImported, onBack, initial, above, headerTitled = false }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  // Green under the dollar wallet when Add wallet opens this step, orange in the first run.
  // The number column takes the word grid's floor, which grows with the type, so the inputs still
  // line up down both columns at one digit or two at a large text size.
  const { fontScale } = useWindow()
  // A locale with its own digits numbers the cells in them, as the word grid numbers its cells.
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language])
  const [words, setWords] = useState<string[]>(() => initialWords(initial?.phrase))
  const [length, setLength] = useState<MnemonicLength>(() => (words.length === 24 ? 24 : 12))
  const [focused, setFocused] = useState<number | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [usePassphrase, setUsePassphrase] = useState(initial?.passphrase !== undefined)
  const [passphrase, setPassphrase] = useState(initial?.passphrase ?? '')
  // The field opens at the end of the words, under the fixed footer, so one the toggle opens takes
  // the focus, which scrolls it into view. A field restored from an earlier visit waits to be tapped.
  const [passphraseAsked, setPassphraseAsked] = useState(false)
  // The passphrase cannot be checked against anything, so the eye shows the exact characters, as on
  // the passphrase step of a new wallet.
  const [reveal, setReveal] = useState(false)
  const inputs = useRef<(TextInputRef | null)[]>([])
  const capture = useScreenCapture(words.some(word => word.length > 0))
  const drawn = capture.phase === 'shown'
  // Gates the cleanup below so a typed import never wipes unrelated clipboard content.
  const pasted = useRef(false)

  // A pasted phrase otherwise lingers on the OS clipboard after this screen closes.
  useEffect(
    () => () => {
      if (pasted.current) {
        Clipboard.setString('')
      }
    },
    [],
  )

  const filled = words.every(word => word.trim().length > 0)
  const phrase = useMemo(() => words.map(word => word.trim().toLowerCase()).join(' '), [words])
  const valid = filled && validateMnemonic(phrase)
  const usedPassphrase = usePassphrase ? passphrase : undefined
  // Showing the resolved wallet id confirms the right seed was entered before restoring. The
  // derivation is the async one, since the synchronous PBKDF2 would hold the JS thread on every change
  // of a valid phrase. A result is kept with the input it came from and shown only while that input is
  // still on screen, so a late answer for an earlier phrase or passphrase is never shown. Nothing shows
  // while it runs or when it fails.
  const [derived, setDerived] = useState<{ phrase: string; passphrase?: string; fingerprint: string } | null>(null)
  useEffect(() => {
    if (!valid) {
      return
    }
    let current = true
    fingerprintFromMnemonicAsync(phrase, usedPassphrase).then(
      fingerprint => {
        if (current) {
          setDerived({ phrase, passphrase: usedPassphrase, fingerprint })
        }
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [valid, phrase, usedPassphrase])
  const fingerprint =
    valid && derived && derived.phrase === phrase && derived.passphrase === usedPassphrase ? derived.fingerprint : ''
  // The fields leave with a capture and no blur reports it, so the focus goes with them, and the
  // passphrase field comes back waiting to be tapped, as one restored from an earlier visit does.
  useEffect(() => {
    if (!drawn) {
      setFocused(null)
      setPassphraseAsked(false)
    }
  }, [drawn])
  const suggestions =
    drawn && focused !== null ? suggestWords(words[focused] ?? '').filter(w => w !== words[focused]) : []

  // Deferred until the field loses focus so it does not turn red mid-typing.
  function isInvalid(word: string, index: number): boolean {
    return word.trim().length > 0 && focused !== index && !isWordlistWord(word)
  }

  function changeLength(next: MnemonicLength) {
    setError(false)
    setLength(next)
    setWords(current => Array.from({ length: next }, (_, i) => current[i] ?? ''))
  }

  function focusNext(index: number) {
    inputs.current[index + 1]?.focus()
  }

  function distribute(index: number, parts: string[]) {
    pasted.current = true
    let target: MnemonicLength = length
    if (index === 0 && (parts.length === 12 || parts.length === 24)) {
      target = parts.length
    }
    const next = Array.from({ length: target }, (_, i) =>
      i < index ? words[i] ?? '' : parts[i - index] ?? '',
    )
    setError(false)
    setLength(target)
    setWords(next)
  }

  function setField(index: number, text: string) {
    const parts = splitPhrase(text)
    if (parts.length > 1) {
      distribute(index, parts)
      return
    }
    setError(false)
    setWords(current => {
      const next = [...current]
      next[index] = parts[0] ?? ''
      return next
    })
    // A trailing space is the "next word" gesture.
    if (/\s$/.test(text)) {
      focusNext(index)
    }
  }

  // A paste into a controlled TextInput does not fire onChangeText on RN 0.86 New Arch, leaving
  // `words` empty while the field shows text, so an explicit button routes it through setField.
  async function paste() {
    const text = (await Clipboard.getString()).trim()
    if (text.length === 0) {
      return
    }
    setField(0, text)
    // Any app that reads the clipboard could take the phrase while this screen stays open or sits in
    // the background, so it leaves as soon as it is in the fields.
    Clipboard.setString('')
  }

  function chooseSuggestion(word: string) {
    if (focused === null) {
      return
    }
    const index = focused
    setWords(current => {
      const next = [...current]
      next[index] = word
      return next
    })
    focusNext(index)
  }

  async function write() {
    setFailed(false)
    setBusy(true)
    try {
      await onImported(phrase, usePassphrase ? passphrase : undefined)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  function restore() {
    if (valid) {
      write()
      return
    }
    setError(true)
  }

  return (
    <Screen
      scroll
      keyboard
      layout="padded"
      contentStyle={styles.container}
      footer={
        <>
          {suggestions.length > 0 && (
            <Row gap="sm" style={styles.suggestions}>
              {suggestions.map(word => (
                <Touch
                  key={word}
                  testID="import-suggestion"
                  onPress={() => chooseSuggestion(word)}
                  feedback="surface"
                  hitSlop={space.xs}
                  style={styles.suggestion}>
                  <Txt role="bodyBold">{word}</Txt>
                </Touch>
              ))}
            </Row>
          )}
          {/* Not a concealed button, whose kept box would cut the grid off above an empty band: the
              words scroll to the bottom of the screen until the last one is in. */}
          {filled && (
            <View style={styles.footer}>
              {fingerprint !== '' && (
                <Row style={styles.walletIdRow}>
                  <Txt role="caption" tone="muted">
                    {t('import.walletId')}
                  </Txt>
                  <Txt role="labelStrong">{formatFingerprint(fingerprint)}</Txt>
                </Row>
              )}
              <ErrorBox message={failed ? t('backup.saveFailed') : null} />
              <GradientButton label={t('import.restore')} onPress={restore} loading={busy} />
            </View>
          )}
        </>
      }>
      <ScreenTitle
        title={headerTitled ? undefined : t('import.title')}
        subtitle={t('import.subtitle')}
        onBack={onBack}
      />

      {above}

      <View style={[styles.lengthRow, drawn && styles.lengthRowOverPaste]}>
        <SegmentedControl
          options={[
            { label: t('welcome.words', { count: 12 }), value: 12 },
            { label: t('welcome.words', { count: 24 }), value: 24 },
          ]}
          value={length}
          onChange={changeLength}
        />
      </View>

      <CaptureNotice capture={capture} style={styles.captureNotice} />

      {drawn && (
        <Touch onPress={paste} feedback="link" hitSlop={space.xs} style={styles.pasteAction}>
          <TabIcon name="paste" color={colors.textSecondary} size={18} />
          <Txt role="bodyStrong" tone="muted">
            {t('import.paste')}
          </Txt>
        </Touch>
      )}

      {drawn && (
        <View style={styles.grid}>
          {words.map((word, index) => (
            <Field
              key={index}
              style={styles.cell}
              ref={node => {
                inputs.current[index] = node
              }}
              accessibilityLabel={t('import.wordLabel', { number: number.format(index + 1) })}
              leading={
                <Txt
                  role="caption"
                  tone={isInvalid(word, index) ? 'danger' : 'muted'}
                  style={{ minWidth: indexFloor(fontScale) }}>
                  {number.format(index + 1)}
                </Txt>
              }
              invalid={isInvalid(word, index)}
              value={word}
              onChangeText={text => setField(index, text)}
              onFocus={() => setFocused(index)}
              // Without this the deferral above only ends when another cell takes focus, so a bad
              // word in the last cell would stay unmarked: "phrase is invalid" with nothing saying
              // which of the twelve to look at.
              onBlur={() => setFocused(current => (current === index ? null : current))}
              onSubmitEditing={() => focusNext(index)}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              textContentType="none"
              importantForAutofill="no"
              // The one flag Android IMEs honor to keep seed words out of the learned dictionary,
              // where autoCorrect=false alone does not.
              keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
              returnKeyType={index + 1 < length ? 'next' : 'done'}
            />
          ))}
        </View>
      )}

      <Touch
        onPress={() => {
          setUsePassphrase(v => !v)
          setPassphraseAsked(true)
        }}
        role="switch"
        state={{ checked: usePassphrase }}
        feedback="link"
        hitSlop={space.md}
        style={styles.passToggle}>
        <CheckBox on={usePassphrase} />
        <Txt role="bodyStrong">{t('import.passphraseToggle')}</Txt>
      </Touch>
      {/* It can be revealed, so it leaves a recorded screen with the words and keeps its value. */}
      {usePassphrase && drawn && (
        <Field
          autoFocus={passphraseAsked}
          value={passphrase}
          onChangeText={setPassphrase}
          placeholder={t('import.passphrasePlaceholder')}
          hint={t('import.passphraseHint')}
          secureTextEntry={!reveal}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          // iOS offers a secure field typed "none" to Passwords once it leaves the screen, which would
          // carry the passphrase to iCloud Keychain; iOS 26.5 does not offer a one-time code field.
          textContentType="oneTimeCode"
          importantForAutofill="no"
          keyboardType={revealedKeyboard(reveal)}
          style={styles.passField}
          trailing={
            <Touch
              onPress={() => setReveal(r => !r)}
              feedback="link"
              // 28 plus 8 of slop on each side is 44 of reach, and the eye keeps its drawn width.
              size={28}
              hitSlop={space.sm}
              label={reveal ? t('passphrase.hide') : t('passphrase.reveal')}
              style={styles.eyeButton}>
              <TabIcon name={reveal ? 'eye-off' : 'eye'} color={colors.textSecondary} size={20} />
            </Touch>
          }
        />
      )}

      <ErrorBox message={error ? t('import.invalid') : null} style={styles.error} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  captureNotice: {
    marginBottom: space.lg,
  },
  container: {
    paddingBottom: space.xl,
  },
  lengthRow: {
    marginBottom: space.xl,
  },
  // Paste's own 44pt box holds the rest of the distance, its text sitting 12 off the grid it fills.
  lengthRowOverPaste: {
    marginBottom: space.sm,
  },
  // Over the grid's end, as a list's action is, since a phrase fills the grid and not one word's cell.
  pasteAction: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: space.xs,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  // Two to a row that grow into what the gap leaves, so the grid reaches both gutters, as the
  // segmented control above it does. A percentage width plus the gap fell short of the right edge.
  cell: {
    flexGrow: 1,
    flexBasis: '40%',
  },
  error: {
    marginTop: space.lg,
  },
  // A full-width target with no flexible child. Touch centres what it holds, so without this the
  // checkbox and its label would leave the left edge and float into the middle of the row.
  passToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: space.sm,
    marginTop: space.xl,
  },
  passField: {
    marginTop: space.md,
  },
  eyeButton: {
    paddingLeft: space.sm,
  },
  suggestions: {
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
  },
  suggestion: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.full,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  footer: {
    padding: space.xl,
  },
  walletIdRow: {
    justifyContent: 'center',
    marginBottom: space.md,
  },
})
