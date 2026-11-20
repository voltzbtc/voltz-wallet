import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native'
import { useTranslation } from 'react-i18next'
import { GradientButton } from '../components/GradientButton'
import { TabIcon } from '../components/TabIcon'
import {
  loadTxExplorers,
  addTxExplorer,
  removeTxExplorer,
  selectTxExplorer,
  allTxExplorers,
  validateExplorerUrl,
  TX_EXPLORER_PRESETS,
  type TxExplorer,
  type TxExplorerConfig,
} from '../wallet/settings'
import { alpha, colors, dividerBottom, font, motion, radius, rhythm, space } from '../theme'
import { useAccent } from '../wallet/dollarMode'
import { Touch } from '../components/Touch'
import { Screen } from '../components/Screen'
import { SectionLabel } from '../components/SectionLabel'
import { Skeleton } from '../components/Skeleton'
import { Txt } from '../components/Txt'
import { Sheet } from '../components/Sheet'
import { Field } from '../components/Field'
import { ErrorBox } from '../components/ErrorBox'
import { AddRow } from '../components/AddRow'
import { motionFor, useReduceMotion } from '../hooks/useReduceMotion'

// The delete button, and its slot with the gap after it, which is how far every row shifts right
// while editing.
const REMOVE_BUTTON = 22
const REMOVE_SLOT = REMOVE_BUTTON + space.md

const SKELETON_ROWS = TX_EXPLORER_PRESETS.length

function hostOf(url: string): string {
  return url.replace(/^\w+:\/\//, '').split('/')[0] || url
}

// Only the link target for "view on explorer". The SDK reads the chain through its own service,
// so nothing here affects balances or a payment.
export function ExplorersScreen(): React.JSX.Element {
  const { t } = useTranslation()

  // Null until the file answers, since a list drawn before that would check the default and then
  // move the check to the saved choice.
  const [config, setConfig] = useState<TxExplorerConfig | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  // A choice or a removal that could not be stored, said under the list, and an explorer that could
  // not be added, said in its sheet, which stays open with the address typed.
  const [error, setError] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      setConfig(await loadTxExplorers())
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function select(id: string) {
    if (busy || id === config?.selectedId) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      setConfig(await selectTxExplorer(id))
    } catch {
      setError(t('explorers.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    let next: TxExplorerConfig
    try {
      next = await removeTxExplorer(id)
    } catch {
      setError(t('explorers.saveFailed'))
      return
    } finally {
      setBusy(false)
    }
    setConfig(next)
    if (next.custom.length === 0) {
      setEditing(false)
    }
  }

  // addTxExplorer also selects the entry, since adding an explorer is the act of choosing it.
  async function add(url: string) {
    if (busy) {
      return
    }
    setBusy(true)
    setAddError(null)
    try {
      setConfig(await addTxExplorer(url))
      setAddOpen(false)
    } catch {
      setAddError(t('explorers.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  function openAdd() {
    setAddError(null)
    setAddOpen(true)
  }

  const presetIds = new Set(TX_EXPLORER_PRESETS.map(e => e.id))

  if (config === null) {
    return (
      <Screen scroll layout="padded" contentStyle={styles.container}>
        <Txt role="caption" tone="muted">
          {t('explorers.intro')}
        </Txt>
        {loadFailed ? (
          <View style={styles.failed}>
            <ErrorBox message={t('explorers.loadFailed')} />
            <GradientButton variant="secondary" label={t('common.retry')} onPress={load} />
          </View>
        ) : (
          <View>
            <Skeleton width={110} height={font.leading.sm} style={styles.sectionLabel} />
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <View key={index} style={styles.skeletonRow}>
                <Skeleton width={120} height={font.leading.base} />
                <Skeleton width={190} height={font.leading.sm} />
              </View>
            ))}
          </View>
        )}
      </Screen>
    )
  }

  return (
    <Screen scroll layout="padded" contentStyle={styles.container}>
      <Txt role="caption" tone="muted">
        {t('explorers.intro')}
      </Txt>
      <View style={[styles.sections, busy && styles.dimmed]} pointerEvents={busy ? 'none' : 'auto'}>
        {/* Edit opens what the long press on an added explorer opens, and turns into Done. Shipped
            explorers cannot be removed, so it shows only once one has been added. */}
        {(editing || config.custom.length > 0) && (
          <Touch
            onPress={() => setEditing(e => !e)}
            feedback="link"
            hitSlop={space.md}
            style={styles.doneRow}>
            <Txt role="bodyBold" tone="accent">
              {editing ? t('home.done') : t('explorers.edit')}
            </Txt>
          </Touch>
        )}

        <ExplorerSection
          title={t('explorers.section')}
          rows={allTxExplorers(config)}
          activeId={config.selectedId}
          editing={editing}
          isPreset={id => presetIds.has(id)}
          onSelect={select}
          onRemove={remove}
          onEnterEdit={() => setEditing(true)}
          onAdd={openAdd}
        />
        <ErrorBox message={error} />
      </View>
      <AddExplorerModal
        visible={addOpen}
        error={addError}
        onClose={() => setAddOpen(false)}
        onSave={add}
      />
    </Screen>
  )
}

function ExplorerSection({
  title,
  rows,
  activeId,
  editing,
  isPreset,
  onSelect,
  onRemove,
  onEnterEdit,
  onAdd,
}: {
  title: string
  rows: TxExplorer[]
  activeId: string
  editing: boolean
  isPreset: (id: string) => boolean
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onEnterEdit: () => void
  onAdd: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { accent } = useAccent()
  const reduced = useReduceMotion()
  // Width is a layout prop, so the delete slot cannot animate on the native driver. It slides the rows
  // over, so under reduced motion it jumps.
  const edit = useRef(new Animated.Value(0)).current
  useEffect(() => {
    const animation = Animated.timing(edit, {
      toValue: editing ? 1 : 0,
      duration: motionFor(motion.fast, reduced),
      useNativeDriver: false,
    })
    animation.start()
    // Stops the timer firing into a torn-down environment or a screen left mid-animation.
    return () => animation.stop()
  }, [editing, edit, reduced])
  const slotWidth = edit.interpolate({ inputRange: [0, 1], outputRange: [0, REMOVE_SLOT] })
  // Lifted from rowMain so the highlight can bleed to both edges.
  const [pressedId, setPressedId] = useState<string | null>(null)

  return (
    <View>
      <SectionLabel style={styles.sectionLabel}>
        {title}
      </SectionLabel>
      <View accessibilityRole="radiogroup">
        {rows.map(row => {
          const inUse = row.id === activeId
          const deletable = !isPreset(row.id)
          // An added explorer offers edit, as its long press does, to a screen reader. Removing stays
          // behind the remove button that edit mode shows.
          const canEdit = deletable && !editing
          return (
            <View key={row.id} style={[styles.row, pressedId === row.id && styles.rowPressed]}>
              {/* Kept present but empty for presets, so every row shifts by the same amount. */}
              <Animated.View style={[styles.removeSlot, { width: slotWidth, opacity: edit }]}>
                {editing && deletable && (
                  <Touch
                    onPress={() => onRemove(row.id)}
                    feedback="link"
                    size={REMOVE_BUTTON}
                    hitSlop={space.md}
                    label={t('common.remove')}
                    style={styles.remove}>
                    <TabIcon name="minus" color={colors.onPrimary} size={16} strokeWidth={3} />
                  </Touch>
                )}
              </Animated.View>
              <Pressable
                onPress={() => onSelect(row.id)}
                onLongPress={deletable ? onEnterEdit : undefined}
                accessibilityActions={canEdit ? [{ name: 'edit', label: t('explorers.edit') }] : undefined}
                onAccessibilityAction={
                  canEdit
                    ? (event: AccessibilityActionEvent) => {
                        if (event.nativeEvent.actionName === 'edit') {
                          onEnterEdit()
                        }
                      }
                    : undefined
                }
                onPressIn={() => setPressedId(row.id)}
                onPressOut={() => setPressedId(null)}
                accessibilityRole="radio"
                accessibilityState={{ checked: inUse }}
                style={styles.rowMain}>
                <View style={styles.rowText}>
                  <Txt role="bodyStrong">{hostOf(row.url)}</Txt>
                  <Txt role="caption" tone="muted" lines={1}>
                    {row.url}
                  </Txt>
                </View>
                {inUse && <TabIcon name="check" color={accent} size={20} />}
              </Pressable>
            </View>
          )
        })}
        <AddRow label={t('explorers.addExplorer')} onPress={onAdd} />
      </View>
    </View>
  )
}

function AddExplorerModal({
  visible,
  error,
  onClose,
  onSave,
}: {
  visible: boolean
  error: string | null
  onClose: () => void
  onSave: (url: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const valid = validateExplorerUrl(url)

  useEffect(() => {
    if (visible) {
      setUrl('')
    }
  }, [visible])

  return (
    <Sheet visible={visible} onClose={onClose} closeLabel={t('common.close')} keyboard>
      <Txt role="subheading">{t('explorers.addExplorer')}</Txt>
      {/* No reachability probe, since a self-hosted instance would not answer one. */}
      <Field
        value={url}
        onChangeText={setUrl}
        placeholder={t('explorers.placeholder')}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel={t('explorers.serverUrl')}
        hint={t('explorers.hint')}
        error={url.trim().length > 0 && !valid ? t('explorers.invalidUrl') : undefined}
      />
      <ErrorBox message={error} />
      <GradientButton label={t('explorers.save')} onPress={() => onSave(url)} disabled={!valid} />
    </Sheet>
  )
}

const styles = StyleSheet.create({
  // The screen holds the intro and one block under it, so its gap is the hint's; the sections keep
  // their own 32 between them.
  container: {
    gap: rhythm.hintToContent,
  },
  failed: {
    gap: space.md,
  },
  sections: {
    gap: rhythm.section,
  },
  dimmed: {
    opacity: alpha.inert,
  },
  doneRow: {
    alignItems: 'flex-end',
  },
  sectionLabel: {
    marginBottom: rhythm.sectionLabelToList,
  },
  skeletonRow: {
    gap: space.xs,
    paddingVertical: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // Stretching past the screen padding and re-insetting runs the highlight to the edges.
    marginHorizontal: -space.xl,
    paddingHorizontal: space.xl,
    ...dividerBottom,
  },
  // Width animates from 0, so overflow:hidden clips the button as it slides in.
  removeSlot: {
    justifyContent: 'center',
    alignItems: 'flex-start',
    overflow: 'hidden',
  },
  remove: {
    width: REMOVE_BUTTON,
    height: REMOVE_BUTTON,
    borderRadius: radius.full,
    borderCurve: 'continuous',
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
  },
  rowPressed: {
    backgroundColor: colors.surfaceVariant,
  },
  rowText: {
    flex: 1,
    gap: space.xs,
  },
})
