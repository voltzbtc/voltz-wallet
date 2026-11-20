import { useCallback, useRef, useState } from 'react'
import type { HistoryItem } from '../wallet/payment'

// The payment an open detail shows, as a live row of `items` so that one settling under the sheet
// changes in it. A row that leaves `items`, past a page or out of a window, leaves its last copy on
// the sheet rather than closing it under the reader.
export function useSelectedItem(
  items: readonly HistoryItem[] | null,
): [HistoryItem | null, (item: HistoryItem | null) => void] {
  const [id, setId] = useState<string | null>(null)
  const last = useRef<HistoryItem | null>(null)

  const select = useCallback((item: HistoryItem | null) => {
    last.current = item
    setId(item?.id ?? null)
  }, [])

  if (id === null) {
    return [null, select]
  }
  last.current = items?.find(item => item.id === id) ?? last.current
  return [last.current, select]
}
