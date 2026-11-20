import React, { useCallback, useRef, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { Skeleton } from '../components/Skeleton'
import {
  onSparkConnected,
  sparkClassify,
  sparkListContacts,
  sparkAddContact,
  sparkSubscribeToPayments,
  sparkSyncState,
  sparkUpdateContact,
  sparkDeleteContact,
  type BalanceSync,
  type SparkContact,
} from '../wallet/spark'
import { contactKey } from '../wallet/history'
import { couldBeWholeAddress, isLightningAddress, verifyLightningAddress } from '../wallet/lnaddress'
import { useSyncRefresh } from '../hooks/useSyncRefresh'
import { AddRow } from '../components/AddRow'
import { Card } from '../components/Card'
import { ConfirmBody, type ConfirmRequest } from '../components/ConfirmSheet'
import { GradientButton } from '../components/GradientButton'
import { TabIcon } from '../components/TabIcon'
import { WalletAvatar } from '../components/WalletAvatar'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { colors, dividerBottom, font, radius, space } from '../theme'
import { Screen } from '../components/Screen'
import { Txt } from '../components/Txt'
import { Touch } from '../components/Touch'
import { Sheet } from '../components/Sheet'
import { EmptyState } from '../components/EmptyState'
import { Field } from '../components/Field'
import { ErrorBox } from '../components/ErrorBox'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Contacts'>

// A read that failed is its own state, never an empty list, so "No contacts yet" is only ever drawn
// from a read that answered with nothing, on a connection that has heard from the network. Contacts
// arrive by sync, so before that an empty list says nothing about the wallet.
type ListState =
  | { status: 'loading' }
  | { status: 'ready'; contacts: SparkContact[]; sync: BalanceSync }
  | { status: 'failed' }

// Doubles as a picker for Send, where `pick` fills the destination instead of opening the editor.
export function ContactsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<Nav>()
  const picking = useRoute<RouteProp<RootStackParamList, 'Contacts'>>().params?.pick === true

  const insets = useSafeAreaInsets()
  const [list, setList] = useState<ListState>({ status: 'loading' })
  // Null closes the sheet, a contact edits it, and 'new' adds one.
  const [editing, setEditing] = useState<SparkContact | 'new' | null>(null)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [addressFocused, setAddressFocused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<ConfirmRequest | null>(null)
  // The number of the last save started, which closing the sheet moves on, so a check that answers
  // after the close says nothing to a sheet that has gone.
  const saveTurn = useRef(0)

  // The number of the last read started, the only one whose answer lands. Focus, a save, a removal
  // and Try again each start one, and an older read answering late would draw over a newer list.
  const latest = useRef(0)

  // `background` is a read nobody asked for, which a failure must not take the list away for.
  const reload = useCallback((background = false) => {
    const mine = ++latest.current
    // Taken before the read it qualifies, as a balance read does.
    const sync = sparkSyncState()
    sparkListContacts().then(
      contacts => {
        if (mine === latest.current) {
          setList({ status: 'ready', contacts, sync })
        }
      },
      () => {
        // A list already on screen gives way too, since after a save or a removal it no longer
        // holds what was just changed.
        if (mine === latest.current) {
          setList(held => (background && held.status === 'ready' ? held : { status: 'failed' }))
        }
      },
    )
  }, [])

  useSyncRefresh(() => reload(true))

  const retry = (): void => {
    setList({ status: 'loading' })
    reload()
  }

  // Any SDK event reads the list again, since a contact saved on another device lands on a sync that
  // nothing else announces. Subscribing at focus can run before the SDK connects, and a new connection
  // drops the old listener, so it attaches on connect.
  useFocusEffect(
    useCallback(() => {
      reload()
      let alive = true
      let off: (() => void) | null = null
      let attaches = 0
      const offConnected = onSparkConnected(() => {
        const mine = ++attaches
        off?.()
        off = null
        sparkSubscribeToPayments(() => reload(true))
          .then(next => {
            if (alive && mine === attaches) {
              off = next
            } else {
              next()
            }
          })
          .catch(() => undefined)
      })
      return () => {
        alive = false
        offConnected()
        off?.()
      }
    }, [reload]),
  )

  function openAdd() {
    setError(null)
    setEditing('new')
    setName('')
    setAddress('')
    setAddressFocused(false)
  }

  function openEdit(c: SparkContact) {
    setError(null)
    setEditing(c)
    setName(c.name)
    setAddress(c.address)
    setAddressFocused(false)
  }

  function tapContact(c: SparkContact) {
    if (picking) {
      // Send is underneath, so going back to it keeps what is under it as the place a send ends up.
      navigation.popTo('Send', { destination: c.address, contactName: c.name, picked: Date.now() })
      return
    }
    openEdit(c)
  }

  const contacts = list.status === 'ready' ? list.contacts : []
  // The line and the way out are one block in the middle of the screen, rather than a line and a row
  // that keeps the list's left edge.
  const noContacts = list.status === 'ready' && list.contacts.length === 0 && list.sync !== 'waiting'
  const addRow = <AddRow label={t('contacts.add')} onPress={openAdd} style={styles.add} />
  const trimmedName = name.trim()
  const trimmedAddr = address.trim()
  const addressValid = isLightningAddress(trimmedAddr)
  const valid = trimmedName.length > 0 && addressValid
  // An address under the keyboard is unfinished rather than wrong, so it is judged once the field is
  // left or once the text is as long as a whole address gets.
  const addressWrong =
    trimmedAddr.length > 0 &&
    !addressValid &&
    (!addressFocused || couldBeWholeAddress(trimmedAddr))

  function closeSheet() {
    saveTurn.current += 1
    setBusy(false)
    setEditing(null)
  }

  async function save() {
    if (!valid || busy || !editing) {
      return
    }
    const mine = ++saveTurn.current
    setBusy(true)
    setError(null)
    try {
      // A new name on the same address has nothing to check, and that address needs no network.
      if (editing === 'new' || contactKey(editing.address) !== contactKey(trimmedAddr)) {
        const check = await verifyLightningAddress(trimmedAddr, sparkClassify)
        if (mine !== saveTurn.current) {
          return
        }
        if (check !== 'ok') {
          setError(t(check === 'wrong' ? 'contacts.addressNotFound' : 'contacts.addressUnreachable'))
          return
        }
      }
      if (editing === 'new') {
        await sparkAddContact(trimmedName, trimmedAddr)
      } else {
        await sparkUpdateContact(editing.id, trimmedName, trimmedAddr)
      }
      if (mine === saveTurn.current) {
        setEditing(null)
      }
      reload()
    } catch {
      // The sheet stays open with what was typed, so the same tap can try again.
      if (mine === saveTurn.current) {
        setError(t('contacts.saveFailed'))
      }
    } finally {
      if (mine === saveTurn.current) {
        setBusy(false)
      }
    }
  }

  // Asked first, naming the contact, since the button sits under Save and a removal cannot be undone.
  function confirmRemove() {
    if (editing === 'new' || !editing || busy) {
      return
    }
    setAsking({
      title: t('contacts.removeTitle', { name: editing.name }),
      confirm: t('contacts.removeConfirm'),
      cancel: t('common.cancel'),
      danger: true,
      onConfirm: () => remove(),
    })
  }

  async function remove() {
    if (editing === 'new' || !editing || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await sparkDeleteContact(editing.id)
      setEditing(null)
      reload()
    } catch {
      setError(t('contacts.removeFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen contentStyle={styles.listHost}>
      <FlatList
        data={contacts}
        keyExtractor={c => c.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: space.xl + insets.bottom },
          noContacts && styles.listEmpty,
        ]}
        ListFooterComponent={noContacts ? null : addRow}
        ListEmptyComponent={
          list.status === 'failed' ? (
            <View>
              <ErrorBox message={t('contacts.loadFailed')} style={styles.error} />
              <GradientButton label={t('common.retry')} variant="secondary" onPress={retry} />
            </View>
          ) : list.status === 'ready' && list.sync === 'synced' ? (
            // Only a read that answered with nothing reaches here, so the line is a fact about the wallet.
            <EmptyState message={t('contacts.empty')} action={addRow} />
          ) : list.status === 'ready' && list.sync === 'stale' ? (
            // The wait for a sync ran out, and contacts from another device may still be on their way.
            <EmptyState message={t('home.notUpdated')} action={addRow} />
          ) : (
            <Card padding="none" style={styles.card}>
              {[0, 1, 2].map(i => (
                // The ready row and its lines, the name on the body line and the address on the
                // caption line, so the list does not jump when the contacts arrive.
                <View key={i} style={[styles.row, i < 2 && styles.rowDivided]}>
                  <Skeleton width={AVATAR} height={AVATAR} borderRadius={radius.full} />
                  <View style={styles.rowText}>
                    <Skeleton width={130} height={font.leading.base} />
                    <Skeleton width={190} height={font.leading.sm} />
                  </View>
                </View>
              ))}
            </Card>
          )
        }
        renderItem={({ item, index }) => (
          // The rows are list items, so the one card is drawn by the first and last row's corners, as
          // in History.
          <Touch
            onPress={() => tapContact(item)}
            feedback="row"
            style={[
              styles.row,
              styles.cardRow,
              index === 0 && styles.cardFirst,
              index === contacts.length - 1 ? styles.cardLast : styles.rowDivided,
            ]}>
            <WalletAvatar color={colors.surfaceRaised} monogram={item.name.trim().charAt(0).toUpperCase()} size={AVATAR} />
            <View style={styles.rowText}>
              <Txt role="bodyStrong">{item.name}</Txt>
              <Txt role="caption" tone="muted" lines={1}>
                {item.address}
              </Txt>
            </View>
            <TabIcon name={picking ? 'chevron' : 'edit'} color={colors.textSecondary} size={18} />
          </Touch>
        )}
      />

      <Sheet
        visible={editing !== null}
        onClose={asking ? () => setAsking(null) : closeSheet}
        closeLabel={asking ? asking.cancel : t('contacts.close')}
        keyboard>
        {asking ? (
          <ConfirmBody request={asking} onClose={() => setAsking(null)} />
        ) : (
          <>
            <Txt role="subheading">
              {editing === 'new' ? t('contacts.newTitle') : t('contacts.editTitle')}
            </Txt>
            <Field
              // The only free-text field in the app with no ceiling. A 300-character name is a list
              // row ten lines tall, because the row lets its text wrap rather than push.
              maxLength={40}
              value={name}
              onChangeText={setName}
              editable={!busy}
              placeholder={t('contacts.namePlaceholder')}
              accessibilityLabel={t('contacts.namePlaceholder')}
            />
            <Field
              value={address}
              onChangeText={setAddress}
              onFocus={() => setAddressFocused(true)}
              onBlur={() => setAddressFocused(false)}
              editable={!busy}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t('contacts.addressPlaceholder')}
              accessibilityLabel={t('contacts.addressPlaceholder')}
              // Save stays hidden until the address parses, and the placeholder that names the format
              // is gone once typing starts, so this line is what says why. The hint holds the line
              // that an error takes over, so the sheet stays one height while Save comes and goes.
              hint={t('contacts.addressHint')}
              error={addressWrong ? t('contacts.invalidAddress') : undefined}
            />
            <ErrorBox message={error} />
            <GradientButton
              label={t('contacts.save')}
              onPress={save}
              disabled={!valid}
              loading={busy}
            />
            {editing !== 'new' && (
              <View style={styles.removeRow}>
                <GradientButton label={t('contacts.remove')} variant="danger" onPress={confirmRemove} />
              </View>
            )}
          </>
        )}
      </Sheet>
    </Screen>
  )
}

const AVATAR = 40

const styles = StyleSheet.create({
  // The list scrolls itself, so it owns the bottom of the screen.
  listHost: { flex: 1, paddingBottom: 0 },
  list: { padding: space.xl },
  // The empty state centred in the screen, as the screen's own center layout puts one.
  listEmpty: { flexGrow: 1, justifyContent: 'center' },
  card: { overflow: 'hidden' },
  // Laid across by the style, since a Touch is a column and would stack avatar, name and chevron.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  rowDivided: dividerBottom,
  cardRow: {
    backgroundColor: colors.surface,
  },
  cardFirst: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderCurve: 'continuous',
  },
  cardLast: {
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    borderCurve: 'continuous',
  },
  rowText: { flex: 1, gap: space.xs },
  add: { marginTop: space.xs },
  // Pushed away from the save button on purpose. The sheet spaces everything at space.lg, and a
  // destructive action one gap from the primary one is a distance nobody chose. This is the only
  // place in the sheet that adds to it, which is what makes it read as separation rather than as
  // rhythm.
  removeRow: { marginTop: space.md },
  error: {
    marginBottom: space.md,
  },
})
