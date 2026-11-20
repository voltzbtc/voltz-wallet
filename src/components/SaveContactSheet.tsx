import React, { useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { sparkAddContact } from '../wallet/spark'
import { space } from '../theme'
import { ErrorBox } from './ErrorBox'
import { Field } from './Field'
import { GradientButton } from './GradientButton'
import { Sheet } from './Sheet'
import { Touch } from './Touch'
import { Txt } from './Txt'

// A contact's name stops here in the editor as well, since the row lets its text wrap.
const NAME_MAX = 40

// Offered once a payment to an address landed, so the address needs no check: paying just proved it.
// Leaving never waits on a save, which carries on and may still land.
export function SaveContactSheet({
  address,
  onDone,
}: {
  address: string
  onDone: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(address.slice(0, address.indexOf('@')).slice(0, NAME_MAX))
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  // A save answering after a close would leave a second time.
  const left = useRef(false)
  const leave = () => {
    if (!left.current) {
      left.current = true
      onDone()
    }
  }

  const trimmedName = name.trim()

  async function save() {
    if (busy || trimmedName.length === 0) {
      return
    }
    setBusy(true)
    setFailed(false)
    try {
      await sparkAddContact(trimmedName, address)
      leave()
    } catch {
      // The sheet stays open with what was typed, so the same tap can try again.
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet visible onClose={leave} closeLabel={t('contacts.close')} keyboard>
      <Txt role="subheading">{t('send.saveContactTitle')}</Txt>
      <Txt role="caption" tone="muted" lines={1}>
        {address}
      </Txt>
      <Field
        maxLength={NAME_MAX}
        value={name}
        onChangeText={setName}
        placeholder={t('contacts.namePlaceholder')}
      />
      <ErrorBox message={failed ? t('contacts.saveFailed') : null} />
      <GradientButton
        label={t('contacts.save')}
        onPress={save}
        disabled={trimmedName.length === 0}
        loading={busy}
      />
      <Touch onPress={leave} feedback="link" hitSlop={space.sm} style={styles.later}>
        <Txt role="bodyStrong" tone="muted">
          {t('send.saveContactLater')}
        </Txt>
      </Touch>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  later: { alignItems: 'center' },
})
