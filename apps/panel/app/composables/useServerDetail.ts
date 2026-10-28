export interface ServerVariable {
  env: string
  name: string
  description?: string
  type: string
  value: string
  user_editable: boolean
}

export interface ServerDetail {
  id: string
  name: string
  description: string | null
  status: string
  statusMessage: string | null
  memoryMb: number
  diskMb: number
  cpuPercent: number
  image: string | null
  startup: string | null
  templateName: string | null
  node: { id: string; name: string; publicHost: string; online: boolean } | null
  owner: { id: string; username: string } | undefined
  address: string | null
  permissions: string[]
  isOwner: boolean
  variables: ServerVariable[]
}

/** Shared server detail; same key → parent and tab pages share one fetch. */
export function useServerDetail(id: string) {
  return useFetch<ServerDetail>(`/api/servers/${id}`, { key: `server-${id}` })
}
