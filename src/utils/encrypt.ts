import crypto from 'crypto'
import { EncryptedPayload, ImapConfig } from '../types'

const ALGORITHM = 'aes-256-gcm'

function getKey(): Buffer {
  const hex = process.env.IMAP_ENCRYPTION_KEY
  if (!hex || hex.length !== 64) throw new Error('IMAP_ENCRYPTION_KEY must be 64 hex characters')
  return Buffer.from(hex, 'hex')
}

function encrypt(plainObj: ImapConfig): EncryptedPayload {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv) as crypto.CipherGCM
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(plainObj), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { iv: iv.toString('hex'), tag: tag.toString('hex'), data: encrypted.toString('hex') }
}

function decrypt(encryptedObj: EncryptedPayload): ImapConfig {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(encryptedObj.iv, 'hex')
  ) as crypto.DecipherGCM
  decipher.setAuthTag(Buffer.from(encryptedObj.tag, 'hex'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedObj.data, 'hex')),
    decipher.final(),
  ])
  return JSON.parse(decrypted.toString('utf8')) as ImapConfig
}

export { encrypt, decrypt }
