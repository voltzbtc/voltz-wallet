import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { onSparkConnected, sparkListContacts, type SparkContact } from '../wallet/spark'
import { onActiveWalletChanged } from '../wallet/wallet'

// `answered` says the newest read came back. A list with it off is what the last answer held, or
// nothing, and never proof that an address is not a contact.
export type ContactsRead = { contacts: readonly SparkContact[]; answered: boolean }

const NOTHING: ContactsRead = { contacts: [], answered: false }

// The contacts, read on each focus since they are edited on another screen, and on each new
// connection, which is when the SDK can answer for the wallet in use. A wallet switch clears the list
// at once and reads nothing, since the SDK still answers for the previous wallet until it reconnects.
export function useContacts(): ContactsRead {
  const [read, setRead] = useState<ContactsRead>(NOTHING)
  // Only the last read lands, so an answer for the previous wallet never fills the new one's list.
  const latest = useRef(0)
  // From a switch to the connection that follows it, the SDK answers for the wallet left behind.
  const switching = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    if (switching.current) {
      return
    }
    const mine = ++latest.current
    try {
      const contacts = await sparkListContacts()
      if (mine === latest.current) {
        setRead({ contacts, answered: true })
      }
    } catch {
      if (mine === latest.current) {
        setRead(held => ({ ...held, answered: false }))
      }
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  useEffect(
    () =>
      onSparkConnected(() => {
        switching.current = false
        load()
      }),
    [load],
  )

  useEffect(
    () =>
      onActiveWalletChanged(() => {
        latest.current += 1
        switching.current = true
        setRead(NOTHING)
      }),
    [],
  )

  return read
}
