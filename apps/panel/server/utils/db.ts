import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '../db/schema'

export { schema }

let _db: ReturnType<typeof drizzle<typeof schema>> | undefined

export function useDb() {
  if (!_db) {
    const { databaseUrl } = useRuntimeConfig()
    _db = drizzle(postgres(databaseUrl, { max: 10, onnotice: () => {} }), { schema })
  }
  return _db
}
