import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useTranslation } from 'react-i18next'
import { loadRegistry, reorderWallets } from '../wallet/walletRegistry'
import { passkeyRemovalNote } from '../wallet/passkey'
import { loadWalletMeta } from '../wallet/walletMeta'
import { isUnconfirmed } from '../wallet/backupMark'
import {
  isWalletSeedAbsent,
  removeWalletById,
  switchWalletWithoutReconnecting,
} from '../wallet/wallet'
import { isWalletHasLiveExit } from '../wallet/exitPlan'
import { resolveWalletDisplay } from '../wallet/walletIdentity'
import { WalletList, type WalletRow } from '../components/WalletList'
import { WalletRowsSkeleton } from '../components/WalletRowsSkeleton'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { space } from '../theme'
import { Screen } from '../components/Screen'
import { Txt } from '../components/Txt'
import { Touch } from '../components/Touch'
import { ConfirmSheet, type ConfirmRequest } from '../components/ConfirmSheet'
import { ErrorBox } from '../components/ErrorBox'
import { AddRow } from '../components/AddRow'
import { GradientButton } from '../components/GradientButton'

export function WalletsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const [rows, setRows] = useState<WalletRow[]>([])
  // The rows come only from a read that answered. Until the first one does, the screen is the
  // skeleton, and a first read that fails shows the error with Try again rather than a list that
  // reads as a device with no wallets.
  const [first, setFirst] = useState<'loading' | 'ready' | 'failed'>('loading')
  // The number of the last first read started, the only one whose answer lands, so a slow read from
  // an earlier focus never draws over a Try again.
  const latest = useRef(0)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<ConfirmRequest | null>(null)

  const buildRows = useCallback(async (): Promise<WalletRow[]> => {
    const reg = await loadRegistry()
    return Promise.all(
      reg.wallets.map(async w => {
        const d = resolveWalletDisplay(
          w.fingerprint,
          await loadWalletMeta(w.fingerprint),
          t('drawer.walletName'),
        )
        return {
          id: w.id,
          fingerprint: w.fingerprint,
          name: d.name,
          imagePath: d.imagePath,
          imageCrop: d.imageCrop,
          color: d.color,
          monogram: d.monogram,
          active: w.id === reg.active,
        }
      }),
    )
  }, [t])

  const readRows = useCallback(() => {
    const mine = ++latest.current
    buildRows().then(
      r => {
        if (mine === latest.current) {
          setRows(r)
          setFirst('ready')
        }
      },
      () => {
        // A list already on screen came from a read that answered and stays, as it did before.
        if (mine === latest.current) {
          setFirst(prev => (prev === 'ready' ? prev : 'failed'))
        }
      },
    )
  }, [buildRows])

  useFocusEffect(
    useCallback(() => {
      readRows()
      return () => {
        // Leaving the screen drops whatever read is still out.
        latest.current += 1
        setEditing(false)
      }
    }, [readRows]),
  )

  function retry() {
    setFirst('loading')
    readRows()
  }

  // Shows the registry as read again, so after a failure the list says which wallets are on the
  // device rather than what the failed call was meant to leave. A read that fails keeps the rows
  // last read.
  async function showRegistry(): Promise<WalletRow[] | null> {
    try {
      const next = await buildRows()
      setRows(next)
      if (next.length <= 1) {
        setEditing(false)
      }
      return next
    } catch {
      return null
    }
  }

  // A switch returns Home, whose boot is what connects the newly active wallet.
  async function onPressRow(row: WalletRow) {
    if (row.active) {
      navigation.navigate('EditWallet')
      return
    }
    setError(null)
    setBusy(true)
    try {
      await switchWalletWithoutReconnecting(row.id)
    } catch (err) {
      await showRegistry()
      setBusy(false)
      // A wallet listed without its recovery phrase on this device, as after a restore onto a new
      // iPhone, is refused for good, so it is told apart from a switch worth trying again.
      setError(t(isWalletSeedAbsent(err) ? 'wallets.seedAbsent' : 'wallets.switchFailed'))
      return
    }
    navigation.navigate('Main')
  }

  // The list moves at once and the write follows. Every move writes the whole order shown, so a later
  // move that saves also saves the one before it that failed. A failed write shows the order the
  // registry holds, read back, unless a newer move was asked for by the time the read answers.
  const moves = useRef(0)
  function reorderRows(ids: string[]) {
    setRows(prev => {
      const byId = new Map(prev.map(r => [r.id, r]))
      return ids.map(id => byId.get(id)).filter((r): r is WalletRow => r !== undefined)
    })
    const mine = ++moves.current
    reorderWallets(ids).catch(async () => {
      const held = await buildRows().catch(() => null)
      if (held && mine === moves.current) {
        setRows(held)
      }
    })
  }

  // Warned before confirming, since removing deletes the seed from the device.
  async function confirmRemove(row: WalletRow) {
    const warning = (await isUnconfirmed(row.id)) ? 'backup.removeUnconfirmed' : 'editWallet.removeWarning'
    const passkey = await passkeyRemovalNote(row.id)
    setAsking({
      title: t('editWallet.removeTitle'),
      body: passkey ? `${t(warning)}\n\n${t(passkey)}` : t(warning),
      confirm: t('editWallet.remove'),
      cancel: t('editWallet.cancel'),
      danger: true,
      onConfirm: () => doRemove(row),
    })
  }

  async function doRemove(row: WalletRow) {
    setError(null)
    setBusy(true)
    try {
      await removeWalletById(row.id, row.fingerprint)
    } catch (err) {
      if (isWalletHasLiveExit(err)) {
        setBusy(false)
        setError(t('emergencyExit.removeRefused'))
        return
      }
      // Removing the active wallet disconnects the engine before it moves the pointer, so a failure
      // past that step leaves no connection here, and Home is what reconnects whichever wallet the
      // registry now names. The refusal for a device with no other wallet that opens comes before
      // anything is touched, so it stays here with its error.
      if (row.active && !isWalletSeedAbsent(err)) {
        navigation.navigate('Main')
        return
      }
      // The removal runs in steps, so a failure can leave the wallet listed or already gone, and only
      // the registry knows which.
      await showRegistry()
      setBusy(false)
      setError(t('wallets.removeFailed'))
      return
    }
    // Removing the active wallet tears down the engine, so Home has to reconnect the next one.
    // Staying here leaves the SDK disconnected and the drawer showing the deleted wallet.
    if (row.active) {
      navigation.navigate('Main')
      return
    }
    if (!(await showRegistry())) {
      // The removal returned, so the row goes even though the list could not be read again.
      setRows(prev => prev.filter(r => r.id !== row.id))
    }
    setBusy(false)
  }

  // Edit opens what the long press on a card opens, for whoever does not know to hold a card, and
  // turns into Done while editing. A single wallet has nothing to reorder or remove. It sits in the
  // header so that a list with something to edit starts where a list of one does.
  const editable = first === 'ready' && !busy && (editing || rows.length > 1)
  useLayoutEffect(() => {
    navigation.setOptions({
      // eslint-disable-next-line react/no-unstable-nested-components
      headerRight: () =>
        editable ? (
          // The label repeats the text so a header item carries its name on the control. The padding
          // is the room inside the glass, which fits itself to this box.
          <Touch
            onPress={() => setEditing(e => !e)}
            feedback="link"
            hitSlop={space.md}
            label={editing ? t('home.done') : t('wallets.edit')}
            style={styles.headerAction}>
            <Txt role="bodyBold" tone="accent">
              {editing ? t('home.done') : t('wallets.edit')}
            </Txt>
          </Touch>
        ) : undefined,
    })
  }, [navigation, editable, editing, t])

  if (busy || first === 'loading') {
    return <WalletRowsSkeleton />
  }

  if (first === 'failed') {
    return (
      <Screen scroll layout="padded">
        <ErrorBox message={t('wallets.loadFailed')} style={styles.error} />
        <GradientButton label={t('common.retry')} variant="secondary" onPress={retry} />
      </Screen>
    )
  }

  return (
    <Screen scroll layout="padded">
      <ErrorBox message={error} style={styles.error} />

      <WalletList
        rows={rows}
        editing={editing}
        onEnterEdit={() => setEditing(true)}
        onPressRow={onPressRow}
        onReorder={reorderRows}
        onRemove={confirmRemove}
      />

      {!editing && (
        <AddRow
          label={t('wallets.add')}
          onPress={() => navigation.navigate('AddWallet')}
          style={styles.addRow}
        />
      )}

      <ConfirmSheet request={asking} onClose={() => setAsking(null)} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  headerAction: { paddingHorizontal: space.md },
  // The same distance under the list as Home's add row keeps under its card.
  addRow: {
    marginTop: space.xs,
  },
  error: {
    marginBottom: space.md,
  },
})
