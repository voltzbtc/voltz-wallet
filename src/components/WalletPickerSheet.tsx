import React, { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { loadRegistry } from '../wallet/walletRegistry'
import { loadWalletMeta } from '../wallet/walletMeta'
import { resolveWalletDisplay } from '../wallet/walletIdentity'
import type { PhotoCrop } from '../wallet/photoCrop'
import { WalletAvatar } from './WalletAvatar'
import { Skeleton } from './Skeleton'
import { font, radius, space } from '../theme'
import { ConfirmBody, type ConfirmRequest } from './ConfirmSheet'
import { Sheet } from './Sheet'
import { Txt } from './Txt'
import { Touch } from './Touch'
import { EmptyState } from './EmptyState'
import { ErrorBox } from './ErrorBox'
import { GradientButton } from './GradientButton'

// The Wallets list's avatar size, so a wallet looks the same in the list and in this picker.
const AVATAR_SIZE = 44

type Choice = {
  id: string
  name: string
  color: string
  imagePath: string | null
  imageCrop: PhotoCrop | null
  monogram: string
}

type Props = {
  visible: boolean
  title: string
  /** Left out of the list, since it is the wallet being moved away from. */
  excludeWalletId?: string
  // A question about the wallet picked, drawn in the sheet in place of the list. `onClose` ends it.
  asking?: ConfirmRequest | null
  onClose: () => void
  onPick: (walletId: string) => void
}

// A read-only picker, unlike WalletList, which reorders and deletes. Choosing here has a consequence
// somewhere else, so it must not also be a place where wallets get edited by accident.
export function WalletPickerSheet({
  visible,
  title,
  excludeWalletId,
  asking = null,
  onClose,
  onPick,
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  // A list that could not be read is kept apart from an empty one, whose line says there is no other
  // wallet, which a failed read does not know.
  const [choices, setChoices] = useState<Choice[] | 'failed' | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!visible) {
      setChoices(null)
      return
    }
    let alive = true
    ;(async () => {
      const reg = await loadRegistry()
      const rows = await Promise.all(
        reg.wallets
          .filter(w => w.id !== excludeWalletId)
          .map(async w => {
            const d = resolveWalletDisplay(
              w.fingerprint,
              await loadWalletMeta(w.fingerprint),
              t('drawer.walletName'),
            )
            return {
              id: w.id,
              name: d.name,
              color: d.color,
              imagePath: d.imagePath,
              imageCrop: d.imageCrop,
              monogram: d.monogram,
            }
          }),
      )
      if (alive) {
        setChoices(rows)
      }
    })().catch(() => alive && setChoices('failed'))
    return () => {
      alive = false
    }
  }, [visible, excludeWalletId, t, attempt])

  return (
    <Sheet visible={visible} onClose={onClose} closeLabel={t('common.close')}>
      {asking ? (
        <ConfirmBody request={asking} onClose={onClose} />
      ) : (
        <>
          <Txt role="subheading">{title}</Txt>
          {choices === null ? (
            <RowsSkeleton />
          ) : choices === 'failed' ? (
            <View>
              <ErrorBox message={t('wallets.loadFailed')} style={styles.error} />
              <GradientButton
                label={t('common.retry')}
                variant="secondary"
                onPress={() => {
                  setChoices(null)
                  setAttempt(n => n + 1)
                }}
              />
            </View>
          ) : choices.length === 0 ? (
            // Reachable with a single wallet, so it explains instead of showing an empty box.
            <EmptyState message={t('receive.lnTransferNoWallets')} />
          ) : (
            <ScrollView>
              {choices.map(c => (
                <Touch key={c.id} onPress={() => onPick(c.id)} feedback="row" label={c.name} style={styles.row}>
                  <WalletAvatar
                    color={c.color}
                    imagePath={c.imagePath}
                    crop={c.imageCrop}
                    monogram={c.monogram}
                    size={AVATAR_SIZE}
                  />
                  <Txt role="body" lines={1} style={styles.name}>
                    {c.name}
                  </Txt>
                </Touch>
              ))}
            </ScrollView>
          )}
        </>
      )}
    </Sheet>
  )
}

// Shaped like the rows below rather than like the Wallets screen's cards, whose skeleton fills its
// screen with the background colour and would paint a black box inside the sheet.
function RowsSkeleton(): React.JSX.Element {
  return (
    <View>
      {[0, 1].map(i => (
        <View key={i} style={styles.row}>
          <Skeleton width={AVATAR_SIZE} height={AVATAR_SIZE} borderRadius={radius.full} />
          <Skeleton width="55%" height={font.leading.base} />
        </View>
      ))}
    </View>
  )
}

// The title carries no margin: Sheet's gap is the space under it, as in every other sheet.
const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
  },
  name: {
    flex: 1,
  },
  // The same distance the Wallets screen keeps between its load failure and its retry.
  error: {
    marginBottom: space.md,
  },
})
