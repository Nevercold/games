import { h } from 'vue'
import type { TableColumn } from '@nuxt/ui'

/**
 * Column for row actions. An empty string header hydrates differently on
 * server and client, so the header is a visually hidden label instead
 * (also gives screen readers a column name).
 */
export function actionsColumn<T>(): TableColumn<T> {
  return { id: 'actions', header: () => h('span', { class: 'sr-only' }, 'Aktionen') }
}
