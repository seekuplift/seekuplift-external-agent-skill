/**
 * Filebase IPFS upload for Node.js (Next.js API routes).
 * Ported from launchpad-mobile-migration/src/services/uploadService.ts.
 */
import { FILEBASE_API_KEY, FILEBASE_RPC_URL, IPFS_GATEWAY_URL } from './config'

type FilebaseAddResponse = {
  Name: string
  Hash: string
  Size: string
}

async function ipfsAdd(formData: FormData): Promise<{ cid: string; url: string }> {
  const response = await fetch(`${FILEBASE_RPC_URL}/api/v0/add?cid-version=1&progress=false`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${FILEBASE_API_KEY}` },
    body: formData,
  })
  if (!response.ok) throw new Error(`Filebase upload failed: ${response.status} ${await response.text()}`)
  const text = await response.text()
  const lastBrace = text.lastIndexOf('{')
  const result: FilebaseAddResponse = JSON.parse(lastBrace >= 0 ? text.slice(lastBrace) : text)
  return { cid: result.Hash, url: `${IPFS_GATEWAY_URL}/${result.Hash}` }
}

/**
 * Upload an image from a public URL or pass through if already on IPFS.
 */
export async function uploadImageFromUrl(imageUrl: string): Promise<{ cid: string; url: string }> {
  // Already on IPFS — skip re-upload
  if (imageUrl.startsWith('ipfs://') || imageUrl.includes('/ipfs/')) {
    const cid = imageUrl.split('/ipfs/').pop() ?? ''
    const url = imageUrl.startsWith('ipfs://')
      ? `${IPFS_GATEWAY_URL}/${imageUrl.slice(7)}`
      : imageUrl
    return { cid, url }
  }

  const res = await fetch(imageUrl)
  if (!res.ok) throw new Error(`Failed to fetch image from ${imageUrl}: ${res.status}`)
  const arrayBuf = await res.arrayBuffer()
  const ext = (imageUrl.split('?')[0].split('.').pop() ?? 'jpg').toLowerCase()
  const mimeType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'

  const formData = new FormData()
  formData.append('file', new Blob([arrayBuf], { type: mimeType }), `token.${ext}`)
  return ipfsAdd(formData)
}

/**
 * Upload metadata JSON object to IPFS.
 */
export async function uploadMetadataJson(metadata: object): Promise<{ cid: string; url: string }> {
  const json = JSON.stringify(metadata)
  const formData = new FormData()
  formData.append('file', new Blob([json], { type: 'application/json' }), 'metadata.json')
  return ipfsAdd(formData)
}
