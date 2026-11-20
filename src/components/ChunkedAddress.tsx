import React from 'react'
import { StyleSheet } from 'react-native'
import { Text } from './Text'
import { colors, font, tracking } from '../theme'
import { leadingText } from '../i18n/direction'

// This is a display form only, and the QR and the copy action still use the full payment URI.
export function rawAddress(value: string): string {
  return value.replace(/^[a-z]+:/i, '').split('?')[0]
}

// Per BIP173 the data part, after the separator, draws from 32 characters (no 1, b, i or o) and ends
// in a six-character checksum.
const BECH32_DATA = /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}$/

// The prefix up to bech32's separator, which is the last `1`, or nothing for a value that is not
// bech32 in shape. A base58 address can hold letters and a `1` near its start too, and grouping it
// from a `1` it does not have as a separator would split it where nobody reading it expects.
function bech32Prefix(value: string): string {
  const separator = value.lastIndexOf('1')
  const hrp = value.slice(0, separator)
  // Bech32 is one case throughout, so a value in mixed case, as base58 is, never qualifies.
  const lower = value.toLowerCase()
  if (separator < 1 || !/^[a-z]+$/i.test(hrp) || (value !== lower && value !== value.toUpperCase())) {
    return ''
  }
  return BECH32_DATA.test(lower.slice(separator + 1)) ? value.slice(0, separator + 1) : ''
}

// The prefix stays one group, so `spark1` is never split into `spar k1pg`.
export function groupsOf4(value: string): string[] {
  const groups: string[] = []
  const prefix = bech32Prefix(value)
  if (prefix) {
    groups.push(prefix)
  }
  for (let i = prefix.length; i < value.length; i += 4) {
    groups.push(value.slice(i, i + 4))
  }
  return groups
}

// Past this a value is an invoice rather than an address: a wall of lines nobody compares by eye, and
// the buttons under it fall off the screen.
const CHUNKED_MAX = 120

// Grouping bech32 in fours with alternating contrast lets it be verified at a glance. Invoices
// are too long to group and render middle-truncated instead.
export function ChunkedAddress({
  value,
  chunked,
}: {
  value: string
  chunked: boolean
}): React.JSX.Element {
  if (!chunked || rawAddress(value).length > CHUNKED_MAX) {
    return (
      <Text numberOfLines={1} ellipsizeMode="middle" style={[leadingText(), styles.mono]}>
        {value}
      </Text>
    )
  }
  const groups = groupsOf4(rawAddress(value))
  return (
    <Text style={[leadingText(), styles.mono]}>
      {groups.map((group, i) => (
        <Text key={i} style={i % 2 === 0 ? styles.groupA : styles.groupB}>
          {group}
          {i < groups.length - 1 ? ' ' : ''}
        </Text>
      ))}
    </Text>
  )
}

const styles = StyleSheet.create({
  mono: {
    fontFamily: font.mono,
    fontSize: font.size.sm,
    color: colors.text,
    textAlign: 'center',
    lineHeight: font.leading.sm,
    letterSpacing: tracking.address,
  },
  groupA: { color: colors.text },
  groupB: { color: colors.textSecondary },
})
