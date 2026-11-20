import React, { useMemo, useRef, useState } from 'react'
import { Animated, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { isWordAt, optionsFor, pickPositions, wordsOf, type Question } from '../wallet/backup'
import { useAccent } from '../wallet/dollarMode'
import { colors, radius, rhythm, space, touch } from '../theme'
import { Screen } from '../components/Screen'
import { Txt } from '../components/Txt'
import { Touch } from '../components/Touch'
import { ScreenTitle } from '../components/ScreenTitle'
import { CaptureNotice } from '../components/CaptureNotice'
import { ErrorBox } from '../components/ErrorBox'
import { useAnnounced } from '../hooks/useAnnounced'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useScreenCapture } from '../hooks/useScreenCapture'

type Props = {
  mnemonic: string
  onVerified: () => void
  // Only for a flow drawn outside the navigator, which has no header of its own to go back with.
  onBack?: () => void
  // Back to the words, offered once a pick was wrong. The step back each caller already has.
  onShowWords?: () => void
  // Inside a navigator, whose header carries the screen's name and the way back.
  headerTitled?: boolean
}

function drawQuestions(mnemonic: string): Question[] {
  const words = wordsOf(mnemonic)
  return pickPositions(words.length).map(position => ({
    position,
    options: optionsFor(words, position),
  }))
}

// One question at a time: which word sits at a number, among words of the same phrase. Three right
// picks in a row prove the words were written down in order; a wrong one draws new positions and
// starts over, so retrying the options one by one never gets through. Nothing is stored: leaving
// halfway draws new questions on the next visit.
export function VerifyBackupScreen({
  mnemonic,
  onVerified,
  onBack,
  onShowWords,
  headerTitled = false,
}: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { accent } = useAccent()
  // A locale with its own digits numbers the question in them, as the word grid numbers its cells.
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language])
  const [questions, setQuestions] = useState<Question[]>(() => drawQuestions(mnemonic))
  const [step, setStep] = useState(0)
  // The number of the word the last wrong pick was for, which the error line names, and how many
  // there were, so the same number missed twice is said twice.
  const [missed, setMissed] = useState<{ number: number; count: number } | null>(null)
  // Set by the last right pick, so a second tap landing before the next render passes nothing twice.
  const passed = useRef(false)
  const shake = useRef(new Animated.Value(0)).current
  // The options are words of the phrase, so they leave the screen with the grid.
  const capture = useScreenCapture(true)
  const drawn = capture.phase === 'shown'
  // With reduced motion the options do not shake; the error line says it.
  const reduced = useReduceMotion()

  const question = questions[step]
  const prompt = question
    ? t('backup.quizQuestion', { number: number.format(question.position + 1) })
    : ''
  // Said on each new question, since the tap that brings it keeps the focus on an option.
  useAnnounced(drawn && step > 0 ? prompt : null)

  function pick(word: string) {
    if (!question || passed.current) {
      return
    }
    if (isWordAt(mnemonic, question.position, word)) {
      setMissed(null)
      if (step + 1 === questions.length) {
        passed.current = true
        onVerified()
        return
      }
      setStep(step + 1)
      return
    }
    setMissed(previous => ({ number: question.position + 1, count: (previous?.count ?? 0) + 1 }))
    setQuestions(drawQuestions(mnemonic))
    setStep(0)
    shake.setValue(0)
    if (reduced) {
      return
    }
    Animated.sequence(
      [12, -12, 8, -8, 0].map(toValue =>
        Animated.timing(shake, { toValue, duration: 55, useNativeDriver: true }),
      ),
    ).start()
  }

  return (
    <Screen scroll layout="padded">
      {/* The question names a number and no word, so it stays with its way back while a recording
          takes the options off the screen. */}
      {question && (
        <>
          <View
            testID="quiz-progress"
            accessible
            accessibilityLabel={t('backup.quizProgress', {
              current: number.format(step + 1),
              total: number.format(questions.length),
            })}
            style={styles.progress}>
            {questions.map((_, index) => (
              <View
                key={index}
                style={[
                  styles.bar,
                  { backgroundColor: index <= step ? accent : colors.surfaceVariant },
                ]}
              />
            ))}
          </View>

          <ScreenTitle
            title={prompt}
            subtitle={t('backup.quizHint')}
            onBack={headerTitled ? undefined : onBack}
          />
        </>
      )}

      <CaptureNotice capture={capture} style={styles.captureNotice} />

      {drawn && question && (
        <>
          <Animated.View
            testID="quiz-options"
            style={[styles.options, !reduced && { transform: [{ translateX: shake }] }]}>
            {question.options.map(word => (
              <Touch
                key={`${question.position}-${word}`}
                testID="quiz-option"
                onPress={() => pick(word)}
                feedback="surface"
                label={word}
                style={styles.option}>
                <Txt role="bodyBold">{word}</Txt>
              </Touch>
            ))}
          </Animated.View>

          {missed !== null && (
            <View style={styles.missed}>
              <ErrorBox
                key={missed.count}
                message={t('backup.quizWrong', { number: number.format(missed.number) })}
              />
              {onShowWords && (
                <Touch
                  onPress={onShowWords}
                  feedback="link"
                  hitSlop={space.md}
                  style={styles.showWords}>
                  <Txt role="bodyStrong" tone="muted">
                    {t('backup.showWords')}
                  </Txt>
                </Touch>
              )}
            </View>
          )}
        </>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  captureNotice: {
    marginBottom: space.lg,
  },
  progress: {
    flexDirection: 'row',
    gap: space.xs,
    marginBottom: rhythm.titleToContent,
  },
  bar: {
    flex: 1,
    height: space.xs,
    borderRadius: radius.full,
  },
  options: {
    gap: space.sm,
  },
  // Each word on the fill of the grid's cells, so the word reads as the one on the backup screen.
  option: {
    minHeight: touch.action,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.md,
    borderCurve: 'continuous',
  },
  missed: {
    marginTop: space.xl,
    gap: space.md,
  },
  showWords: {
    alignSelf: 'center',
  },
})
