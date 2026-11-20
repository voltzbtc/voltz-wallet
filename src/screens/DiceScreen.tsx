import React, { useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import {
  DICE_MIN_ROLLS,
  diceRollsDistribution,
  diceRollsEntropyBits,
  diceRollsUniform,
  mnemonicFromDiceRolls,
  type MnemonicLength,
} from '../wallet/seed'
import { SegmentedControl } from '../components/SegmentedControl'
import { GradientButton } from '../components/GradientButton'
import { TabIcon } from '../components/TabIcon'
import { alpha, colors, radius, rhythm, space } from '../theme'
import { Txt } from '../components/Txt'
import { Screen } from '../components/Screen'
import { ErrorBox } from '../components/ErrorBox'
import { Row } from '../components/Row'
import { Touch } from '../components/Touch'
import { useAccent } from '../wallet/dollarMode'
import { ScreenTitle } from '../components/ScreenTitle'

type Props = {
  onGenerated: (mnemonic: string, length: MnemonicLength, rolls: string) => void
  // Only for the onboarding welcome, which has no native header of its own.
  onBack?: () => void
  // The rolls a step back from the phrase returns to, so Generate gives the same words again
  // instead of asking for every roll a second time.
  initial?: { rolls: string; length: MnemonicLength }
  // The navigator's header carries the title, so only the subtitle is left to draw here.
  headerTitled?: boolean
}

const FACES = ['1', '2', '3', '4', '5', '6']

// Standard d6 pip layout on a 3x3 grid, indices 0-8 row-major.
const PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}

// A face's layout is fixed by its value, so memoizing keeps 54 pip cells off the per-tap render path.
const DiceFace = React.memo(function ({ value }: { value: number }): React.JSX.Element {
  const on = new Set(PIPS[value] ?? [])
  return (
    <View style={styles.face}>
      {[0, 1, 2].map(r => (
        <View key={r} style={styles.faceRow}>
          {[0, 1, 2].map(c => (
            <View key={c} style={styles.cell}>
              {on.has(r * 3 + c) ? <View style={styles.pip} /> : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  )
})

// The rolls are the only randomness, so a compromised device RNG cannot weaken the seed. Generation
// stays hard-blocked until the count floor and the chi-square fairness test both pass.
export function DiceScreen({ onGenerated, onBack, initial, headerTitled = false }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  // Green under the dollar wallet when Add wallet opens this step, orange in the first run.
  const { accent } = useAccent()
  // A locale with its own digits writes the faces and counts in them.
  const number = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language])
  const [length, setLength] = useState<MnemonicLength>(initial?.length ?? 12)
  const [rolls, setRolls] = useState(initial?.rolls ?? '')
  const [error, setError] = useState(false)
  const [showStats, setShowStats] = useState(false)

  const min = DICE_MIN_ROLLS[length]
  const dist = diceRollsDistribution(rolls)
  const maxCount = Math.max(1, ...dist)
  const bits = diceRollsEntropyBits(rolls)
  const uniform = diceRollsUniform(rolls)
  const enough = rolls.length >= min && uniform
  const noRolls = rolls.length === 0
  const biased = rolls.length >= min && !uniform

  function tap(face: string) {
    setError(false)
    setRolls(current => current + face)
  }

  function backspace() {
    setError(false)
    setRolls(current => current.slice(0, -1))
  }

  function clearAll() {
    setError(false)
    setRolls('')
  }

  function generate() {
    if (!enough) {
      return
    }
    // A shield against a redbox rather than a reachable state, since every condition
    // mnemonicFromDiceRolls throws on is already checked by `enough`, which gates this button. Kept
    // so a change to the derivation surfaces as a message rather than a crash, and left untested
    // for the same reason, since no sequence of taps reaches it.
    let mnemonic: string
    try {
      mnemonic = mnemonicFromDiceRolls(rolls, length)
    } catch {
      setError(true)
      return
    }
    onGenerated(mnemonic, length, rolls)
  }

  return (
    <Screen
      scroll
      layout="padded"
      footer={
        <View style={styles.footer}>
          {error && <ErrorBox message={t('dice.identical')} style={styles.errorBox} />}
          <GradientButton label={t('dice.generate')} onPress={generate} disabled={!enough} />
        </View>
      }>
      {headerTitled ? (
        <Txt role="body" tone="muted" style={styles.hint}>
          {t('dice.subtitle')}
        </Txt>
      ) : (
        <ScreenTitle title={t('dice.title')} subtitle={t('dice.subtitle')} onBack={onBack} />
      )}

      <View style={styles.length}>
        <SegmentedControl
          options={[
            { label: t('welcome.words', { count: 12 }), value: 12 },
            { label: t('welcome.words', { count: 24 }), value: 24 },
          ]}
          value={length}
          onChange={setLength}
        />
      </View>

      {/* The bar tracks the count alone. Fairness is enforced by the generate gate. */}
      <Row spread style={styles.counterRow}>
        <View {...hiddenFromReaders(noRolls)}>
          <Touch
            onPress={clearAll}
            disabled={noRolls}
            feedback="link"
            hitSlop={space.md}
            style={[styles.editSide, noRolls && styles.editHidden]}>
            <Txt role="label" tone="muted">
              {t('backup.clear')}
            </Txt>
          </Touch>
        </View>
        <Txt role="subheading" tone={enough ? 'default' : 'muted'}>
          {t('dice.progress', { count: rolls.length, min })}
        </Txt>
        <View {...hiddenFromReaders(noRolls)}>
          <Touch
            onPress={backspace}
            disabled={noRolls}
            feedback="link"
            label={t('common.backspace')}
            hitSlop={space.md}
            style={[styles.editSide, styles.editEnd, noRolls && styles.editHidden]}>
            <TabIcon name="backspace" color={colors.textSecondary} size={22} />
          </Touch>
        </View>
      </Row>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { backgroundColor: accent },
            biased && styles.fillBiased,
            { width: `${Math.min(100, (rolls.length / min) * 100)}%` },
          ]}
        />
      </View>

      {/* Two rows of flex:1 keys share one gap token so vertical spacing matches horizontal. */}
      <View style={styles.pad}>
        {[FACES.slice(0, 3), FACES.slice(3)].map((row, r) => (
          <Row key={r} gap="md">
            {row.map(face => (
              <Touch
                key={face}
                onPress={() => tap(face)}
                feedback="surface"
                label={face}
                style={styles.key}>
                <DiceFace value={Number(face)} />
              </Touch>
            ))}
          </Row>
        ))}
      </View>

      {biased && <ErrorBox message={t('dice.lowEntropy')} style={styles.biasHint} />}

      {rolls.length > 0 && (
        <Touch
          onPress={() => setShowStats(s => !s)}
          feedback="link"
          state={{ expanded: showStats }}
          hitSlop={space.md}
          style={styles.statsToggle}>
          <Txt role="label" tone="muted">
            {t('dice.stats')}
          </Txt>
          <View style={[styles.statsChevron, showStats && styles.statsChevronOpen]}>
            <TabIcon name="chevron" color={colors.textSecondary} size={16} />
          </View>
        </Touch>
      )}

      {showStats && rolls.length > 0 && (
        <View style={styles.stats}>
          {dist.map((count, i) => (
            <Row key={i} gap="sm">
              <Txt role="label" tone="muted" style={styles.statFace}>
                {number.format(i + 1)}
              </Txt>
              <View style={styles.statBarTrack}>
                <View style={[styles.statBarFill, { width: `${(count / maxCount) * 100}%` }]} />
              </View>
              <Txt role="caption" tone="muted" style={styles.statCount} lines={1}>
                {number.format(count)}
              </Txt>
            </Row>
          ))}
          <Txt role="micro" tone="muted" style={styles.statBits}>
            {t('dice.bits', { bits: Math.round(bits) })}
          </Txt>
        </View>
      )}
    </Screen>
  )
}

// A concealed control leaves screen readers as well as sight, on both platforms.
function hiddenFromReaders(hidden: boolean) {
  return {
    accessibilityElementsHidden: hidden,
    importantForAccessibility: hidden ? ('no-hide-descendants' as const) : ('auto' as const),
  }
}

// Sizes of this screen alone, none of them a step on the theme's scales. The face number and the
// count beside each statistics bar are fixed widths, so the six bars start and end at the same x.
// Both edit controls take one width, so the counter between them stays centred whichever shows.
const STAT_FACE_WIDTH = 14
const STAT_COUNT_WIDTH = 36
const EDIT_SIDE_WIDTH = 64
// The diameter of a pip on a die face.
const PIP = 9

const styles = StyleSheet.create({
  hint: {
    marginBottom: rhythm.hintToContent,
  },
  counterRow: {
    marginBottom: space.sm,
  },
  biasHint: {
    marginTop: space.md,
  },
  // Fixed so the six bars start at the same x whatever face number sits beside them.
  statFace: {
    width: STAT_FACE_WIDTH,
    textAlign: 'center',
  },
  statCount: {
    width: STAT_COUNT_WIDTH,
    textAlign: 'right',
  },
  statBits: {
    marginTop: space.xs,
    textAlign: 'center',
  },
  length: {
    marginBottom: space.xl,
  },
  editSide: {
    minWidth: EDIT_SIDE_WIDTH,
    paddingVertical: space.xs,
  },
  editEnd: {
    alignItems: 'flex-end',
  },
  // Clear and backspace keep their boxes with nothing to edit, so the counter between them stays put.
  editHidden: {
    opacity: alpha.concealed,
  },
  track: {
    height: 6,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    backgroundColor: colors.surfaceVariant,
    overflow: 'hidden',
    marginBottom: space.xl,
  },
  fill: {
    height: 6,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  // A full bar in red means the count floor was reached with a skewed distribution.
  fillBiased: {
    backgroundColor: colors.danger,
  },
  pad: {
    gap: space.md,
  },
  key: {
    flex: 1,
    aspectRatio: 1,
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    padding: space.lg,
  },
  // Filling the button minus its uniform padding centers the 3x3 grid by construction.
  face: {
    flex: 1,
  },
  faceRow: {
    flex: 1,
    flexDirection: 'row',
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pip: {
    width: PIP,
    height: PIP,
    borderRadius: radius.full,
    backgroundColor: colors.text,
  },
  statsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'center',
    marginTop: space.md,
    paddingVertical: space.xs,
  },
  // The 'chevron' glyph points right, so a quarter turn either way gives down and up.
  statsChevron: {
    transform: [{ rotate: '90deg' }],
  },
  statsChevronOpen: {
    transform: [{ rotate: '-90deg' }],
  },
  stats: {
    marginTop: space.md,
    gap: space.sm,
  },
  statBarTrack: {
    flex: 1,
    height: 8,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    backgroundColor: colors.surfaceVariant,
    overflow: 'hidden',
  },
  statBarFill: {
    height: 8,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    backgroundColor: colors.textSecondary,
  },
  errorBox: {
    marginBottom: space.md,
  },
  footer: {
    padding: space.xl,
  },
})
