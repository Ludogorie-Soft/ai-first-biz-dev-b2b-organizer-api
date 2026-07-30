import { randomUUID } from 'crypto'
import { supabaseAdmin } from '../config/supabase'

export const ATTACHMENT_BUCKET = 'sequence-attachments'
export const MAX_ATTACHMENTS_PER_STEP = 3
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024

const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'text/plain',
])

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
}

function sanitizeFileName(name: string): string {
  const base = name.replace(/[/\\]/g, '_').replace(/[^\w.\- ()[\]]+/g, '_').trim()
  return base.slice(0, 180) || 'attachment'
}

function resolveContentType(fileName: string, reported?: string | null): string | null {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  const fromExt = EXT_TO_CONTENT_TYPE[ext]
  if (reported && ALLOWED_CONTENT_TYPES.has(reported)) return reported
  if (fromExt) return fromExt
  return null
}

function isAllowedAttachment(fileName: string, contentType: string | null | undefined, size: number): string | null {
  if (size <= 0) return 'File is empty'
  if (size > MAX_ATTACHMENT_BYTES) return 'File exceeds 4 MB limit'
  const resolved = resolveContentType(fileName, contentType)
  if (!resolved || !ALLOWED_CONTENT_TYPES.has(resolved)) {
    return 'File type not allowed. Use PDF, DOC, DOCX, XLS, XLSX, PNG, JPG, or TXT'
  }
  return null
}

function buildStoragePath(
  companyId: string,
  sequenceId: string,
  stepId: string,
  fileName: string
): string {
  const safe = sanitizeFileName(fileName)
  return `${companyId}/${sequenceId}/${stepId}/${randomUUID()}-${safe}`
}

async function deleteStoragePaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const { error } = await supabaseAdmin.storage.from(ATTACHMENT_BUCKET).remove(paths)
  if (error) {
    console.warn('[attachments] Failed to delete storage objects:', error.message)
  }
}

export {
  ALLOWED_CONTENT_TYPES,
  sanitizeFileName,
  resolveContentType,
  isAllowedAttachment,
  buildStoragePath,
  deleteStoragePaths,
}
