import { useMemo } from 'react'
import { contactKey, type ContactNames } from '../wallet/history'
import { useContacts } from './useContacts'

// The contacts by address. A failed read leaves titles on what the last read gave, or on the address,
// which is true, and no error is worth a row's title.
export function useContactNames(): ContactNames {
  const { contacts } = useContacts()
  return useMemo(
    () => new Map(contacts.map(contact => [contactKey(contact.address), contact.name])),
    [contacts],
  )
}
