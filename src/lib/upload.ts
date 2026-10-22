/**
 * Backend upload proxy client — replaces the old direct-to-Filebase path
 * (`ipfs.ts`). The service holds NO storage credentials: image bytes and the
 * metadata JSON go through backend-rs-sql's `/api/upload/image` and
 * `/api/upload/metadata`, which pin to Filebase server-side and apply the
 * per-IP upload allowance + the launch geo gate. The caller's IP is
 * forwarded as `X-Forwarded-For` (the backend trusts XFF from loopback in
 * the colocated deployment) so the 10/hour allowance and geo verdict are
 * the calling agent's, not this host's.
 *
 * Partner lane: an upload made under a partner key (`AGENT_API_KEYS` id)
 * also carries `X-Upload-Partner: <id>` and the shared
 * `X-Upload-Partner-Token` (`UPLOAD_PARTNER_TOKEN`, the backend's same
 * env), so it counts against the partner's hourly bucket instead of the
 * shared egress IP's. Without the token configured nothing is sent.
 */
import { backendPostForm, backendPostJson } from './backend.ts'

/** Mirrors the backend's MAX_IMAGE_BYTES (10 MB). */
export const MAX_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024

export type UploadResult = { cid: string; url: string }

/** Mirrors the backend's `sniff_image_mime`: magic bytes only. */
export function sniffImageMime(
  data: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 && // P
    data[2] === 0x4e && // N
    data[3] === 0x47 && // G
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.length, 12)).toString('latin1')
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif'
  if (data.length >= 12 && head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

export const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export type DecodedLaunchImage = {
  bytes: Buffer
  contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  fileName: string
}

/**
 * Decode a request `image` field: base64 bytes, optionally wrapped in an
 * RFC-2397 `data:` URL. The declared `data:` mime, when present, must match
 * the sniffed type. Throws `Error` with a client-facing message on anything
 * that cannot become a valid upload.
 */
export function decodeBase64Image(raw: unknown): DecodedLaunchImage {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('image must be a non-empty base64 string')
  }
  let text = raw.trim()
  let declaredMime: string | null = null
  const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(text)
  if (dataUrl) {
    declaredMime = dataUrl[1]?.trim().toLowerCase() || null
    if (!dataUrl[2]) {
      throw new Error('image data URL must be base64-encoded (data:<mime>;base64,<data>)')
    }
    text = dataUrl[3]
  }
  const compact = text.replace(/\s+/g, '')
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('image is not valid base64')
  }
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.length === 0) {
    throw new Error('image decodes to zero bytes')
  }
  if (bytes.length > MAX_UPLOAD_IMAGE_BYTES) {
    throw new Error(`image exceeds the ${MAX_UPLOAD_IMAGE_BYTES / (1024 * 1024)}MB upload limit`)
  }
  const contentType = sniffImageMime(bytes)
  if (!contentType) {
    throw new Error('Unsupported image type. Allowed: PNG, JPEG, GIF, WEBP')
  }
  if (declaredMime && declaredMime !== contentType) {
    throw new Error(`image data URL declares ${declaredMime} but the bytes are ${contentType}`)
  }
  return { bytes, contentType, fileName: `image.${MIME_EXTENSION[contentType]}` }
}

/** The partner-lane headers for `partnerId`, or none. */
export function uploadPartnerHeaders(
  partnerId: string | null,
  token: string | undefined = process.env.UPLOAD_PARTNER_TOKEN,
): Record<string, string> {
  const secret = token?.trim()
  if (!partnerId || !secret) return {}
  return { 'x-upload-partner': partnerId, 'x-upload-partner-token': secret }
}

/**
 * Upload image bytes through `POST /api/upload/image` (multipart `file`
 * field), forwarding the caller IP. Throws `BackendHttpError` on a
 * non-2xx backend response (rate limit, type refusal).
 */
export async function uploadImageBytes(
  image: DecodedLaunchImage,
  clientIp: string | null,
  partnerId: string | null = null,
): Promise<UploadResult> {
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(image.bytes)], { type: image.contentType }),
    image.fileName,
  )
  return backendPostForm<UploadResult>('/api/upload/image', form, {
    clientIp,
    headers: uploadPartnerHeaders(partnerId),
  })
}

/**
 * Upload the launch metadata JSON through `POST /api/upload/metadata`,
 * forwarding the caller IP (the backend's launch geo gate applies to it).
 * Throws `BackendHttpError` on a non-2xx backend response — including the
 * backend's own `geo_restricted` refusal, which the service's pre-check
 * should already have caught.
 */
export async function uploadMetadataJson(
  metadata: Record<string, unknown>,
  clientIp: string | null,
  partnerId: string | null = null,
): Promise<UploadResult> {
  return backendPostJson<UploadResult>('/api/upload/metadata', metadata, {
    clientIp,
    headers: uploadPartnerHeaders(partnerId),
  })
}
