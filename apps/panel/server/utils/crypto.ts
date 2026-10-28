import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Symmetric encryption for secrets at rest (backup target credentials …).
 * AES-256-GCM with a key derived from NUXT_APP_KEY. Changing the app key
 * makes stored secrets unreadable, so it must stay stable.
 *
 * Format: "v1.<iv>.<tag>.<ciphertext>" (base64url). `purpose` is bound as
 * additional authenticated data so a value cannot be moved to another field.
 */
let cachedKey: Buffer | undefined
let warned = false

function appKey(): Buffer {
  if (cachedKey) return cachedKey
  const raw = useRuntimeConfig().appKey as string
  if (!raw) {
    if (!import.meta.dev) {
      throw createError({ statusCode: 500, statusMessage: 'NUXT_APP_KEY is not set; secrets cannot be stored' })
    }
    if (!warned) {
      warned = true
      console.warn('[crypto] NUXT_APP_KEY is not set, using an insecure development key')
    }
  } else if (raw.length < 32) {
    throw createError({ statusCode: 500, statusMessage: 'NUXT_APP_KEY must be at least 32 characters' })
  }
  cachedKey = createHash('sha256').update(raw || 'panel-insecure-development-key').digest()
  return cachedKey
}

export function encryptJson(value: unknown, purpose: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', appKey(), iv)
  cipher.setAAD(Buffer.from(purpose))
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

export function decryptJson<T = unknown>(payload: string, purpose: string): T {
  const [version, iv, tag, ct] = payload.split('.')
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('unsupported ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', appKey(), Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(purpose))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()])
  return JSON.parse(pt.toString('utf8')) as T
}
