import React, { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import Clipboard from '@react-native-clipboard/clipboard'
import { sparkGetTokenBalances, sparkResolveToken } from '../wallet/spark'
import {
  addToken,
  isListed,
  isTokenIdentifier,
  loadHomeTokens,
  mergeCatalog,
  type CatalogToken,
} from '../wallet/tokenPrefs'
import { KNOWN_TOKENS, lookalikeOf } from '../wallet/tokens'
import { AssetIcon } from '../components/AssetIcon'
import { GradientButton } from '../components/GradientButton'
import { Skeleton } from '../components/Skeleton'
import { TabIcon } from '../components/TabIcon'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { useAccent } from '../wallet/dollarMode'
import { colors, font, radius, rhythm, space } from '../theme'
import { ErrorBox } from '../components/ErrorBox'
import { Field } from '../components/Field'
import { Notice } from '../components/Notice'
import { FooterAction, Screen } from '../components/Screen'
import { Row } from '../components/Row'
import { SectionLabel } from '../components/SectionLabel'
import { Txt } from '../components/Txt'
import { Touch } from '../components/Touch'

type Nav = NativeStackNavigationProp<RootStackParamList, 'AddAsset'>

// Spark has no browsable registry, so the suggestions list is the tokens the app knows by identifier.
const CATALOG: CatalogToken[] = KNOWN_TOKENS.map(known => ({
  identifier: known.identifier,
  name: known.name,
  ticker: known.ticker,
  decimals: known.decimals,
}))

// notFound means the network knows no such token, where error means the lookup itself failed.
type Status = 'idle' | 'invalid' | 'resolving' | 'resolved' | 'notFound' | 'error'

// Lookup is by `btkn1...` id only, with no name search, because Spark has no registry to browse.
export function AddAssetScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { accent } = useAccent()
  const navigation = useNavigation<Nav>()
  const scanned = useRoute<RouteProp<RootStackParamList, 'AddAsset'>>().params?.scanned

  const [input, setInput] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [token, setToken] = useState<CatalogToken | null>(null)
  const [busy, setBusy] = useState(false)
  // The last add was refused, so the screen stays and says so rather than go back as if it held.
  const [addFailed, setAddFailed] = useState(false)
  // Seeded with the defaults, which need no read, so USDB never shows as addable while the file loads.
  const [home, setHome] = useState<{ catalog: CatalogToken[]; hidden: string[] }>(() => ({
    catalog: mergeCatalog([]),
    hidden: [],
  }))
  // Bumped per lookup so a stale resolve from a fast second paste drops its result.
  const runId = useRef(0)

  // The tokens the wallet holds, which Home shows whether or not they were added. Empty until the read
  // lands or when it fails, which leaves the lists alone to decide.
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    loadHomeTokens()
      .then(setHome)
      .catch(() => undefined)
    sparkGetTokenBalances()
      .then(tokens => setHeld(new Set(tokens.filter(tk => tk.balanceBaseUnits > 0).map(tk => tk.identifier))))
      .catch(() => undefined)
  }, [])

  const resolve = useCallback(async (raw: string) => {
    setAddFailed(false)
    const value = raw.trim()
    if (value.length === 0) {
      setStatus('idle')
      setToken(null)
      return
    }
    if (!isTokenIdentifier(value)) {
      setStatus('invalid')
      setToken(null)
      return
    }
    const id = ++runId.current
    setStatus('resolving')
    setToken(null)
    try {
      const meta = await sparkResolveToken(value)
      if (id !== runId.current) {
        return
      }
      if (meta) {
        setToken(meta)
        setStatus('resolved')
      } else {
        setStatus('notFound')
      }
    } catch {
      if (id === runId.current) {
        setStatus('error')
      }
    }
  }, [])

  useEffect(() => {
    if (scanned) {
      setInput(scanned)
      resolve(scanned)
    }
  }, [scanned, resolve])

  async function paste() {
    const text = (await Clipboard.getString()).trim()
    if (text.length > 0) {
      setInput(text)
      resolve(text)
    }
  }

  // addToken is idempotent, so re-adding a suggestion only unhides it.
  async function commit(entry: CatalogToken) {
    if (busy) {
      return
    }
    setBusy(true)
    setAddFailed(false)
    try {
      await addToken(entry)
      navigation.goBack()
    } catch {
      setAddFailed(true)
    } finally {
      setBusy(false)
    }
  }

  // Only failures are text. Loading is a skeleton, never a label, per the design system. A refused add
  // is the newest thing the person did, so it is the one said.
  const message = addFailed
    ? t('addAsset.addFailed')
    : status === 'invalid'
    ? t('addAsset.invalid')
    : status === 'notFound'
    ? t('addAsset.notFound')
    : status === 'error'
    ? t('addAsset.error')
    : null
  // The list shows a token by name and ticker only, so a fake under a known name would pass for it.
  const lookalike = status === 'resolved' && token ? lookalikeOf(token) : undefined

  return (
    <Screen
      scroll
      keyboard
      layout="padded"
      contentStyle={styles.container}
      footer={
        // Concealed exactly when GradientButton conceals it: disabled and not loading.
        <FooterAction concealed={status !== 'resolved' && !busy}>
          <View style={styles.footer}>
            <GradientButton
              label={t('addAsset.add')}
              onPress={() => token && commit(token)}
              loading={busy}
              disabled={status !== 'resolved'}
            />
          </View>
        </FooterAction>
      }>
      <Txt role="caption" tone="muted">
        {t('addAsset.intro')}
      </Txt>

      {CATALOG.length > 0 && (
        <View style={styles.suggestions}>
          <SectionLabel style={styles.suggestLabel}>
            {t('addAsset.suggested')}
          </SectionLabel>
          {CATALOG.map(item => {
            const present = isListed(item.identifier, home, held)
            if (present) {
              // Grouped as one static node so assistive tech reads a status, not a control.
              return (
                <View
                  key={item.identifier}
                  style={styles.suggestRow}
                  accessible
                  accessibilityRole="text">
                  <AssetIcon assetId={item.identifier} ticker={item.ticker} size={32} />
                  <View style={styles.suggestText}>
                    <Txt role="bodyBold" lines={1}>
                      {item.name}
                    </Txt>
                    <Txt role="label" tone="muted">
                      {item.ticker}
                    </Txt>
                  </View>
                  <Txt role="label" tone="muted">
                    {t('addAsset.added')}
                  </Txt>
                </View>
              )
            }
            return (
              <Touch
                key={item.identifier}
                onPress={() => commit(item)}
                feedback="link"
                style={styles.suggestRow}>
                <AssetIcon assetId={item.identifier} ticker={item.ticker} size={32} />
                <View style={styles.suggestText}>
                  <Txt role="bodyBold" lines={1}>
                    {item.name}
                  </Txt>
                  <Txt role="label" tone="muted">
                    {item.ticker}
                  </Txt>
                </View>
                <TabIcon name="plus" color={accent} size={18} strokeWidth={2.5} />
              </Touch>
            )
          })}
        </View>
      )}

      <Field
        value={input}
        onChangeText={text => {
          setInput(text)
          resolve(text)
        }}
        placeholder={t('addAsset.placeholder')}
        accessibilityLabel={t('addAsset.placeholder')}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />

      <View style={styles.chips}>
        <View style={styles.chip}>
          <GradientButton
            variant="secondary"
            singleLine
            label={t('addAsset.paste')}
            icon={<TabIcon name="paste" color={colors.text} size={18} />}
            onPress={paste}
          />
        </View>
        <View style={styles.chip}>
          <GradientButton
            variant="secondary"
            singleLine
            label={t('addAsset.scan')}
            icon={<TabIcon name="scan" color={colors.text} size={18} />}
            onPress={() => navigation.navigate('Scan', { mode: 'token' })}
          />
        </View>
      </View>

      {status === 'resolving' && (
        // Shaped like the resolved preview card below so the layout does not jump.
        <Row gap="md" style={styles.preview}>
          <Skeleton width={40} height={40} borderRadius={radius.full} />
          <View style={styles.previewText}>
            <Skeleton width={140} height={font.leading.base} />
            <Skeleton width={72} height={font.leading.sm} />
          </View>
        </Row>
      )}

      {status === 'resolved' && token && (
        <Row gap="md" style={styles.preview}>
          <AssetIcon assetId={token.identifier} ticker={token.ticker} size={40} />
          <View style={styles.previewText}>
            <Txt role="bodyBold" lines={1}>
              {token.name}
            </Txt>
            <Txt role="label" tone="muted">
              {token.ticker}
            </Txt>
          </View>
        </Row>
      )}

      {lookalike && (
        <Notice>
          <Txt role="caption">{t('addAsset.lookalike', { ticker: lookalike.ticker })}</Txt>
        </Notice>
      )}

      <ErrorBox message={message} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  container: {
    gap: space.lg,
  },
  // The screen's own gap is the intro's distance to it, as a hint's to the first block, and the field
  // under it starts a new section.
  suggestions: {
    marginBottom: rhythm.section - space.lg,
  },
  suggestLabel: {
    marginBottom: rhythm.sectionLabelToList,
  },
  suggestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
  },
  suggestText: {
    flex: 1,
    gap: space.xs,
  },
  chips: {
    flexDirection: 'row',
    gap: space.sm,
  },
  chip: {
    flex: 1,
  },
  preview: {
    padding: space.md,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    backgroundColor: colors.surfaceVariant,
  },
  // Takes the row's width beside the mark, so a long token name ends in an ellipsis inside the card
  // instead of pushing past it.
  previewText: {
    flex: 1,
    gap: space.xs,
  },
  footer: {
    padding: space.xl,
  },
})
