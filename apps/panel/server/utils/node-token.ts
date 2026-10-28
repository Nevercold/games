import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Node tokens have the form `<nodeId>.<secret>`. Only sha256(secret) is
 * stored, so a database leak does not let anyone impersonate a node.
 */

export function generateNodeSecret() {
  const secret = randomBytes(32).toString('base64url')
  return { secret, hash: hashNodeSecret(secret) }
}

export function hashNodeSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex')
}

export function formatNodeToken(nodeId: string, secret: string) {
  return `${nodeId}.${secret}`
}

export function parseNodeToken(token: string): { nodeId: string; secret: string } | null {
  const idx = token.indexOf('.')
  if (idx <= 0 || idx === token.length - 1) return null
  return { nodeId: token.slice(0, idx), secret: token.slice(idx + 1) }
}

export function verifyNodeSecret(secret: string, storedHash: string) {
  const a = Buffer.from(hashNodeSecret(secret), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
