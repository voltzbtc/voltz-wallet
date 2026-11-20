import React, { useEffect, useRef, useState } from 'react'
import { I18nManager, Keyboard, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { Text, useFontScale } from './Text'
import { useTranslation } from 'react-i18next'
import { formatSats, formatBtcTrim, groupDigits, parseConvertAmount } from '../wallet/amount'
import { formatSmallFiat } from '../wallet/assets'
import { formatBaseUnitsExact, roundBaseUnits, toBaseUnitsExact } from '../wallet/sparkConvert'
import {
  satsToFiat,
  fiatToSats,
  formatFiat,
  fiatAffixes,
  fiatSymbol,
  fiatFractionSize,
  decimalMark,
  localizeAmount,
  type FiatCurrency,
} from '../wallet/fiat'
import { TabIcon } from './TabIcon'
import { GradientButton } from './GradientButton'
import { SegmentedControl } from './SegmentedControl'
import { colors, font, press, radius, space, textScale, touch } from '../theme'
import { Field } from './Field'
import { Sheet } from './Sheet'
import { holdDirection, leadingText } from '../i18n/direction'
import { Txt } from './Txt'
import { Figure } from './Amount'
import { Row } from './Row'
import { Touch } from './Touch'
import { useAnnounced } from '../hooks/useAnnounced'

export type Denom = 'sats' | 'btc' | 'fiat'

// On a swap rail the number means either what the payer pays or what the wallet nets after the fee.
export type AmountKind = 'charge' | 'receive'

// A token's bounds and what can be spent of it, in its base units, which a double cannot carry at 18
// places. Its places also cap the keypad unless `maxDecimals` says otherwise.
export type TokenBounds = { decimals: number; min?: bigint; max?: bigint; available?: bigint }

// Both ends as drawn, either one absent.
type Bounds = { min?: string; max?: string }

type Props = {
  visible: boolean
  unit: string
  allowDecimal: boolean
  // Places the asset can hold. Digits past them are not taken, rather than refused later.
  maxDecimals?: number
  // In the unit `parse` returns, for sats and dollars. A token's bounds go in `tokenBounds`.
  min?: number
  max?: number
  // What can be spent, in the unit of `min` and `max`. Unset draws no line and locks nothing, so a
  // caller passes it only for a figure it can stand behind.
  available?: number
  // What can be spent, as a sentence's figure that locks nothing, for a balance only the review can
  // weigh. Beside `available` it is ignored.
  availableNote?: string
  // Offers spending all of it, which the caller prepares itself so a token skips the sheet's unit.
  onUseAll?: (comment?: string) => void
  initial: string
  /** Parses the entry to the base unit, or null when invalid. */
  parse: (raw: string) => number | null
  /** Dollars typed as dollars, with no rate behind them: min, max and onConfirm are in dollars. */
  dollars?: boolean
  /** Bitcoin only. min/max/onConfirm stay in sats whichever unit is toggled. */
  satsBtcToggle?: boolean
  /** Bitcoin only. Paired with a currency, adds a fiat unit to the toggle. */
  fiatRate?: number
  fiatCurrency?: FiatCurrency
  /** The unit the sheet opens in, read on opening only. Fiat with no rate opens in sats. */
  initialDenom?: Denom
  chargeReceiveToggle?: boolean
  mode?: AmountKind
  /** Chars allowed in the optional LUD-12 note. Unset hides the field. */
  commentMax?: number
  /** Who the amount goes to, in place of the generic title, so it is never typed blind. */
  title?: string
  onClose: () => void
} & Confirm

// A token's figure reaches its caller in base units, exactly as typed. A double carries about 15
// significant digits and prints a small figure as "1e-7", so read back as text it would quote another
// amount than the one typed, at 18 places. Sats, BTC and money keep the double, which holds them.
type Confirm =
  | {
      tokenBounds?: undefined
      /** An undefined value clears the amount. */
      onConfirm: (
        value: number | undefined,
        denom?: Denom,
        mode?: AmountKind,
        comment?: string,
      ) => void | Promise<void>
    }
  | {
      // Compared with the typed figure and drawn on integers alone, so neither end crosses its bound.
      // The bounds and the balance in a double are refused, so no token figure is weighed as one.
      tokenBounds: TokenBounds
      min?: undefined
      max?: undefined
      available?: undefined
      /** The typed amount in the token's base units. An undefined value clears the amount. */
      onConfirm: (base: bigint | undefined) => void | Promise<void>
    }

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
const SATS_PER_BTC = 100_000_000
// A key row's height when there is room, shrinking towards the touch floor when there is not.
const KEY_HEIGHT = 56
// The close mark, drawn beside the subheading title.
const CLOSE_ICON = 22
// Four rows at the touch floor and the three gaps between them. Without it the keypad box shrinks
// below its rows on a short window, and the rows, held at the floor, run onto the error line below.
const KEYPAD_FLOOR = 4 * touch.min + 3 * space.sm
// The scroll's weight when the sheet is short, against the keypad's 1. Yoga takes a shortfall from
// each child in proportion to flexShrink times basis, and the scroll's basis is all of its content,
// so at an equal weight it gives up more than the keypad and cuts the note at its end while the key
// rows still have room. At this weight its share stays far under a pixel until the keypad reaches
// KEYPAD_FLOOR, where Yoga holds the keypad and hands the rest to the scroll. It is never 0, since past
// the floor only the scroll can give way, and without it Confirm leaves a short screen.
const SCROLL_SHRINK = 1e-4

// The entry keeps a dot as it is typed, and reads in the app language's separators, except sats, which
// keep their own grouping in every language.
function formatEntry(entry: string, sats: boolean): string {
  if (entry.length === 0) {
    return '0'
  }
  if (sats) {
    return formatSats(Number(entry))
  }
  return localizeAmount(entry.startsWith('.') ? `0${entry}` : entry)
}

function stripZeros(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

function cutToEightPlaces(value: number): string {
  const [whole, places] = value.toFixed(12).split('.')
  return stripZeros(`${whole}.${places.slice(0, 8)}`)
}

function parseBtc(raw: string): number | null {
  const trimmed = raw.trim().replace(',', '.')
  if (!/^\d*\.?\d+$/.test(trimmed)) {
    return null
  }
  const value = Number(trimmed)
  if (!(value > 0) || !Number.isFinite(value)) {
    return null
  }
  const sats = Math.round(value * SATS_PER_BTC)
  return sats > 0 ? sats : null
}

// A private keypad, so the OS keyboard never covers the value being typed.
//
// It is drawn on Sheet, which brings the safe-area bottom padding and, when the note field shows, the
// keyboard avoider. Everything above the keypad scrolls, and on a short window the key rows shrink to
// the touch floor before the scroll gives up any visible height, so Confirm stays on a 667pt screen under the
// sheet's cap even with the note and the unit toggle. An error stands beside Confirm, outside the
// scroll. While the OS keyboard is up for the note the keypad steps aside, since the keyboard covers
// its place and the note would otherwise have no room above it.
export function AmountSheet(props: Props): React.JSX.Element {
  const {
    visible,
    unit,
    allowDecimal,
    min,
    max,
    tokenBounds,
    available,
    availableNote,
    onUseAll,
    initial,
    parse,
    dollars,
    satsBtcToggle,
    fiatRate,
    fiatCurrency,
    initialDenom,
    chargeReceiveToggle,
    mode: initialMode,
    commentMax,
    title,
    onClose,
  } = props
  const maxDecimals = props.maxDecimals ?? tokenBounds?.decimals
  const { t } = useTranslation()
  const [entry, setEntry] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [denom, setDenom] = useState<Denom>('sats')
  const [mode, setMode] = useState<AmountKind>(initialMode ?? 'charge')
  const [comment, setComment] = useState('')
  const [typingNote, setTypingNote] = useState(false)
  const scroll = useRef<ScrollView>(null)
  // A caption's line at the system text size. The text's leading grows with that size, so a place
  // held at the unscaled 20 would grow the sheet when its line comes, by 2pt at 110%.
  const captionLine = font.leading.sm * useFontScale()

  // A ref, so a rate that lands with the sheet open changes neither the unit nor what was typed.
  const opening = useRef({ initialDenom, fiatRate, fiatCurrency, parse })
  opening.current = { initialDenom, fiatRate, fiatCurrency, parse }

  useEffect(() => {
    if (visible) {
      const start = opening.current
      const inFiat =
        start.initialDenom === 'fiat' && start.fiatRate !== undefined && start.fiatRate > 0 && start.fiatCurrency
      const inBtc = start.initialDenom === 'btc'
      const sats = (inFiat || inBtc) && initial.length > 0 ? start.parse(initial) : null
      setEntry(
        // What comes in is in sats, the unit a caller keeps, and it reads in the unit the sheet opens in.
        (inFiat || inBtc) && initial.length > 0
          ? sats === null
            ? ''
            : inBtc
            ? formatBtcTrim(sats)
            : stripZeros(satsToFiat(sats, start.fiatRate as number).toFixed(fiatFractionSize(start.fiatCurrency as string)))
          : initial,
      )
      setError(null)
      setDenom(inFiat ? 'fiat' : start.initialDenom === 'btc' ? 'btc' : 'sats')
      setMode(initialMode ?? 'charge')
      setComment('')
    }
  }, [visible, initial, initialMode])

  const showComment = commentMax !== undefined && commentMax > 0

  // iOS announces the keyboard before it moves, Android only once it is up.
  useEffect(() => {
    if (!visible || !showComment) {
      setTypingNote(false)
      return
    }
    const ios = Platform.OS === 'ios'
    const up = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setTypingNote(true))
    const down = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setTypingNote(false))
    return () => {
      up.remove()
      down.remove()
    }
  }, [visible, showComment])

  // The note sits at the end of the scroll, so with the keyboard up the scroll rests on it.
  const keepNoteInView = () => {
    if (typingNote) {
      scroll.current?.scrollToEnd({ animated: false })
    }
  }

  const hasFiat =
    Boolean(satsBtcToggle) && fiatRate !== undefined && fiatRate > 0 && fiatCurrency !== undefined
  const rate = fiatRate ?? 0

  const toBase = (raw: string): number | null => {
    if (!satsBtcToggle) {
      return parse(raw)
    }
    if (denom === 'btc') {
      return parseBtc(raw)
    }
    if (denom === 'fiat') {
      const value = parseConvertAmount(raw)
      return value === null ? null : fiatToSats(value, rate)
    }
    return parse(raw)
  }

  // Fiat fraction size is not universally 2, since JPY has 0 and the dinars have 3.
  const fiatDecimals = fiatCurrency ? fiatFractionSize(fiatCurrency) : 2

  const satsToEntry = (sats: number, target: Denom): string => {
    if (target === 'btc') {
      return formatBtcTrim(sats)
    }
    if (target === 'fiat') {
      return stripZeros(satsToFiat(sats, rate).toFixed(fiatDecimals))
    }
    return String(sats)
  }

  // Sats are whole, so an entry that takes a decimal point is dollars or a token, whatever word it
  // goes by, and grouping it as sats would draw a rounded figure beside the exact one the SDK gets.
  const wholeSats = unit === 'sats' && !allowDecimal
  // Sats keep their own grouping, decided by the unit itself rather than by the word drawn for it.
  const satsEntry = satsBtcToggle ? denom === 'sats' : wholeSats
  // Money takes its symbol on the side the language writes it, with that language's spacing, so
  // English reads $12.50 and German 12,50 $. Sats, BTC and tokens keep their unit after the figure.
  const money = dollars
    ? fiatAffixes('USD')
    : satsBtcToggle && denom === 'fiat'
    ? fiatAffixes(fiatCurrency as FiatCurrency)
    : null
  const effUnit = satsBtcToggle ? (denom === 'btc' ? 'BTC' : t('common.sats')) : unit
  // A zero-decimal currency must not accept a decimal point, and sats never do.
  const effDecimal = satsBtcToggle
    ? denom === 'btc' || (denom === 'fiat' && fiatDecimals > 0)
    : allowDecimal

  // A minimum is drawn at or above itself and a maximum at or below, so the figure drawn, typed back,
  // is always in range; whatever the sheet draws without a side is a ceiling, such as the balance.
  const showValue = (base: number, bound: 'min' | 'max' = 'max'): string => {
    const atLeast = bound === 'min'
    if (dollars) {
      return formatSmallFiat(base, 'USD', { atLeast })
    }
    if (denom === 'btc') {
      return `${localizeAmount(formatBtcTrim(base))} BTC`
    }
    if (denom === 'fiat') {
      const figure = formatSmallFiat(satsToFiat(base, rate), fiatCurrency as FiatCurrency, { atLeast })
      // Bound for a sentence, out of Figure's reach.
      return I18nManager.isRTL ? holdDirection(figure) : figure
    }
    // Counted, so a limit of one reads "1 sat" in the languages that inflect it, with the figure and
    // its word held together on a line.
    return t('receive.limitSats', { count: base, amount: formatSats(base) })
  }

  // Both ends of a range, each on its side. A range that sits inside one drawn step has no figure in
  // that unit that fits it, so both ends read the one figure under it rather than cross.
  const showRange = (low: number, high: number): { min: string; max: string } => {
    const floor = showValue(high)
    return showValue(low) === floor ? { min: floor, max: floor } : { min: showValue(low, 'min'), max: floor }
  }

  // A token reads in its own unit, grouped as sats are and with the language's decimal mark, at two
  // places, or as many more as a range inside one cent needs to hold a figure, so neither end is
  // ever drawn past its bound, at any number of places.
  const showTokenBounds = ({ decimals, min: low, max: high }: TokenBounds): Bounds => {
    const at = (places: number, base: bigint, direction: 'up' | 'down') =>
      roundBaseUnits(base, decimals, places, direction)
    const crosses = (places: number) =>
      low !== undefined && high !== undefined && at(places, low, 'up') > at(places, high, 'down')
    let places = 2
    while (places < decimals && crosses(places)) {
      places += 1
    }
    const figure = (base: bigint, direction: 'up' | 'down') => {
      const drawn = formatBaseUnitsExact(at(places, base, direction), decimals)
      const [whole, fraction] = drawn.split('.')
      return `${groupDigits(whole)}${fraction ? `${decimalMark()}${fraction}` : ''} ${unit}`
    }
    return {
      min: low === undefined ? undefined : figure(low, 'up'),
      max: high === undefined ? undefined : figure(high, 'down'),
    }
  }

  // What the hint and the error name as the ends, each drawn on its own side.
  const drawnBounds: Bounds = tokenBounds
    ? showTokenBounds(tokenBounds)
    : min !== undefined && max !== undefined
    ? showRange(min, max)
    : {
        min: min === undefined ? undefined : showValue(min, 'min'),
        max: max === undefined ? undefined : showValue(max),
      }

  // The ends as a sentence, which wraps between its words like any prose; its figures never part, since
  // they are grouped with a no-break space.
  const boundsHint =
    drawnBounds.min !== undefined && drawnBounds.max !== undefined
      ? t('receive.range', drawnBounds)
      : drawnBounds.min !== undefined
      ? t('receive.minHint', { min: drawnBounds.min })
      : drawnBounds.max !== undefined
      ? t('receive.maxHint', { max: drawnBounds.max })
      : null

  // The typed figure in the token's base units, exactly, or null for one the token cannot hold. The
  // keypad writes a first dot as "0.", so an entry never starts with one.
  const typedBaseUnits = (raw: string, decimals: number): bigint | null =>
    toBaseUnitsExact(raw.trim().replace(',', '.'), decimals)

  const typed = entry.trim().length > 0
  // A token is read in its base units alone, and never through `parse`.
  const entrySats = typed && !tokenBounds ? toBase(entry) : null
  const tokenEntry = typed && tokenBounds ? typedBaseUnits(entry, tokenBounds.decimals) : null
  const tokenAvailable = tokenBounds?.available
  // Compared in the base unit, whichever unit is typed.
  const overAvailable =
    tokenAvailable !== undefined
      ? tokenEntry !== null && tokenEntry > tokenAvailable
      : available !== undefined && entrySats !== null && entrySats > available
  const shownError = error ?? (overAvailable ? t('errors.insufficientFunds') : null)
  // The sheet stays mounted while closed, and a typed amount outlives the close, so a balance that
  // drops under it later would otherwise say an error nobody sees.
  useAnnounced(visible ? shownError : null)
  // showValue draws sats, BTC and money only, and would name a token's balance in sats, so a token
  // keeps its own unit here. Cut at eight places rather than rounded, so typing the figure drawn never
  // passes the balance.
  const availableText = (base: number): string =>
    !satsBtcToggle && !dollars && !wholeSats
      ? `${localizeAmount(cutToEightPlaces(base))} ${unit}`
      : showValue(base)
  // A token's balance, cut at eight places on integers for the same reason.
  const tokenAvailableText = (base: bigint, decimals: number): string =>
    `${localizeAmount(formatBaseUnitsExact(roundBaseUnits(base, decimals, 8, 'down'), decimals))} ${unit}`
  let conversion: string | null = null
  if (hasFiat && entrySats !== null && entrySats > 0) {
    conversion =
      denom === 'fiat'
        ? t('receive.approxSats', { amount: formatSats(entrySats) })
        : t('receive.approxFiat', {
            amount: formatFiat(satsToFiat(entrySats, rate), fiatCurrency as FiatCurrency),
          })
  }

  function append(key: string) {
    setError(null)
    setEntry(current => {
      if (key === '.') {
        // An asset with no places takes whole units only.
        if (maxDecimals === 0) {
          return current
        }
        return current.includes('.') ? current : current.length === 0 ? '0.' : `${current}.`
      }
      // Only digits after the point count against the places, so a whole figure always takes one.
      const places = current.includes('.') ? current.length - current.indexOf('.') - 1 : 0
      if (maxDecimals !== undefined && current.includes('.') && places >= maxDecimals) {
        return current
      }
      // Drop a lone leading zero so "0" + "5" reads "5", not "05".
      if (current === '0') {
        return key
      }
      return current + key
    })
  }

  function backspace() {
    setError(null)
    setEntry(current => current.slice(0, -1))
  }

  function switchDenom(next: Denom) {
    if (next === denom) {
      return
    }
    setError(null)
    if (entry.length > 0) {
      const sats = toBase(entry)
      setEntry(sats === null ? '' : satsToEntry(sats, next))
    }
    setDenom(next)
  }

  // A bound on one side only is named alone, or the message would name 0 as the other end.
  function refuseOutOfRange() {
    if (drawnBounds.min !== undefined && drawnBounds.max !== undefined) {
      setError(t('receive.outOfRange', drawnBounds))
    } else if (drawnBounds.min !== undefined) {
      setError(t('receive.belowMin', { min: drawnBounds.min }))
    } else if (drawnBounds.max !== undefined) {
      setError(t('receive.aboveMax', { max: drawnBounds.max }))
    }
  }

  function confirm() {
    if (!typed) {
      props.onConfirm(undefined)
      return
    }
    // A token compares in its base units and hands them on, since its bounds and its figure can hold
    // more places than a double does.
    if (props.tokenBounds) {
      const { min: low, max: high } = props.tokenBounds
      if (tokenEntry === null) {
        setError(t('receive.invalidAmount'))
        return
      }
      if (overAvailable) {
        return
      }
      if ((low !== undefined && tokenEntry < low) || (high !== undefined && tokenEntry > high)) {
        refuseOutOfRange()
        return
      }
      props.onConfirm(tokenEntry)
      return
    }
    const parsed = toBase(entry)
    if (parsed === null) {
      setError(t('receive.invalidAmount'))
      return
    }
    if (overAvailable) {
      return
    }
    if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
      refuseOutOfRange()
      return
    }
    const denomArg = satsBtcToggle ? denom : undefined
    const modeArg = chargeReceiveToggle ? mode : undefined
    if (showComment) {
      props.onConfirm(parsed, denomArg, modeArg, comment.trim() || undefined)
    } else {
      props.onConfirm(parsed, denomArg, modeArg)
    }
  }

  const denomOptions: { label: string; value: Denom }[] = [
    { label: t('common.sats'), value: 'sats' },
    { label: 'BTC', value: 'btc' },
  ]
  if (hasFiat) {
    denomOptions.push({ label: fiatSymbol(fiatCurrency as FiatCurrency), value: 'fiat' })
  }

  const rows = [
    KEYS.slice(0, 3),
    KEYS.slice(3, 6),
    KEYS.slice(6, 9),
    [effDecimal ? '.' : '', '0', 'back'],
  ]

  return (
    <Sheet visible={visible} onClose={onClose} closeLabel={t('common.close')} keyboard={showComment}>
      <ScrollView
        ref={scroll}
        style={styles.scroll}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={keepNoteInView}
        onLayout={keepNoteInView}>
        <View style={styles.header}>
          <Txt role="subheading" style={styles.title}>
            {title ?? t('receive.amountTitle')}
          </Txt>
          {/* Drawn at the icon's size so the header keeps the title's height, and reaching 44 by slop. */}
          <Touch onPress={onClose} feedback="link" label={t('common.close')} size={CLOSE_ICON} hitSlop={space.md}>
            <TabIcon name="close" color={colors.textSecondary} size={CLOSE_ICON} />
          </Touch>
        </View>

        {chargeReceiveToggle && (
          <View style={styles.modeToggle}>
            <SegmentedControl<AmountKind>
              options={[
                { label: t('receive.modeCharge'), value: 'charge' },
                { label: t('receive.modeReceive'), value: 'receive' },
              ]}
              value={mode}
              onChange={setMode}
            />
          </View>
        )}

        {/* The entry and its unit are one paragraph, as in Amount, so they shrink together and
            never part. A unit drawn beside the figure keeps its width and takes the figure's
            room. */}
        <View style={styles.display}>
          <Figure role="display" tone={entry.length === 0 ? 'muted' : 'default'}>
            {money?.before ? <Text style={styles.unit}>{money.before}</Text> : null}
            {formatEntry(entry, satsEntry)}
            {money ? (
              money.after ? <Text style={styles.unit}>{money.after}</Text> : null
            ) : (
              <Text style={styles.unit}>
                {'\u00A0'}
                {effUnit}
              </Text>
            )}
          </Figure>
        </View>

        {/* An absent line holds its own height and margin, so what is below stays put when it comes. */}
        {conversion ? (
          <Figure role="label" tone="muted" style={styles.conversion}>
            {conversion}
          </Figure>
        ) : (
          <View style={{ height: captionLine + space.sm }} />
        )}

        {satsBtcToggle && (
          <View style={styles.toggle}>
            <SegmentedControl<Denom> options={denomOptions} value={denom} onChange={switchDenom} />
          </View>
        )}

        {boundsHint !== null ? (
          <Txt role="caption" tone="muted" style={styles.hint}>
            {boundsHint}
          </Txt>
        ) : (
          <View style={{ height: captionLine + space.md }} />
        )}

        {(available !== undefined || tokenAvailable !== undefined || availableNote !== undefined) && (
          <Row gap="md" style={styles.available}>
            <Txt role="caption" tone="muted" style={styles.availableText}>
              {t('send.available', {
                amount:
                  tokenBounds && tokenAvailable !== undefined
                    ? tokenAvailableText(tokenAvailable, tokenBounds.decimals)
                    : available !== undefined
                    ? availableText(available)
                    : availableNote,
              })}
            </Txt>
            {onUseAll && (
              <Touch
                onPress={() => onUseAll(showComment ? comment.trim() || undefined : undefined)}
                feedback="link"
                hitSlop={space.sm}>
                <Txt role="label" tone="accent">
                  {t('send.useAll')}
                </Txt>
              </Touch>
            )}
          </Row>
        )}

        {showComment && (
          <Field
            value={comment}
            onChangeText={setComment}
            maxLength={commentMax}
            placeholder={t('send.commentPlaceholder')}
            returnKeyType="done"
            style={styles.comment}
          />
        )}
      </ScrollView>

      {!typingNote && (
        <View style={styles.keypad}>
          {rows.map((row, r) => (
            <View key={r} style={styles.row}>
              {row.map((key, c) => {
                if (key === '') {
                  return <View key={c} style={[styles.key, styles.keyEmpty]} />
                }
                if (key === 'back') {
                  return (
                    <Pressable
                      key={c}
                      onPress={backspace}
                      accessibilityRole="button"
                      accessibilityLabel={t('common.backspace')}
                      style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}>
                      <TabIcon name="backspace" color={colors.text} size={24} />
                    </Pressable>
                  )
                }
                return (
                  <Pressable
                    key={c}
                    onPress={() => append(key)}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}>
                    <Text maxFontSizeMultiplier={textScale.keypadMax} style={[leadingText(), styles.keyLabel]}>
                      {key === '.' ? decimalMark() : key}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          ))}
        </View>
      )}

      {/* Beside Confirm, which raises it, and outside the scroll, which a short screen shows only in
          part. The note ends the scroll, so an error there is the first thing cut off. */}
      {/* Kept empty at the line's height, so an error moves neither the keypad nor Confirm. */}
      <View style={{ minHeight: captionLine }}>
        {shownError && (
          <Txt role="caption" tone="danger" accessibilityRole="alert" style={styles.error}>
            {shownError}
          </Txt>
        )}
      </View>

      <GradientButton label={t('receive.confirmAmount')} onPress={confirm} disabled={overAvailable} />
    </Sheet>
  )
}

const styles = StyleSheet.create({
  scroll: {
    flexShrink: SCROLL_SHRINK,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  // Wraps rather than pushing the close mark out of the sheet at the larger text sizes.
  title: {
    flexShrink: 1,
  },
  modeToggle: {
    marginTop: space.lg,
  },
  display: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: space.lg,
  },
  // A run inside the entry's paragraph, on its baseline, so it takes no margin of its own.
  unit: {
    ...font.family.semibold,
    color: colors.textSecondary,
    fontSize: font.size.lg,
  },
  // A readout, not a CTA, so muted: orange is reserved for actions.
  conversion: {
    marginTop: space.sm,
    textAlign: 'center',
  },
  toggle: {
    marginTop: space.lg,
  },
  hint: {
    marginTop: space.md,
    textAlign: 'center',
  },
  available: {
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: space.sm,
  },
  availableText: {
    flexShrink: 1,
  },
  error: {
    textAlign: 'center',
  },
  comment: {
    marginTop: space.sm,
  },
  // Sheet's gap stands above the keypad and below it, and the margin brings the space above Confirm
  // back to space.xl. A phone keypad reads 1 2 3 from the left in every language, so it never mirrors
  // in RTL.
  keypad: {
    direction: 'ltr',
    flexShrink: 1,
    minHeight: KEYPAD_FLOOR,
    marginBottom: space.sm,
    gap: space.sm,
  },
  row: {
    flexDirection: 'row',
    gap: space.sm,
    flexBasis: KEY_HEIGHT,
    flexShrink: 1,
    minHeight: touch.min,
  },
  // A key is a button, so it takes the button radius rather than a card's.
  key: {
    flex: 1,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceVariant,
  },
  keyEmpty: {
    backgroundColor: 'transparent',
  },
  keyPressed: {
    opacity: press.dim,
  },
  keyLabel: {
    color: colors.text,
    fontSize: font.size.xxl,
    ...font.family.medium,
  },
})
