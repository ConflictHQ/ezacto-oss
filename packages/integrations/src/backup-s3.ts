import { AwsClient } from 'aws4fetch'
import { backupSha256, OffsiteBackupError as BackupS3Error } from '@ezacto/core'
export { OffsiteBackupError as BackupS3Error } from '@ezacto/core'
export interface BackupS3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}
const advice = (status: number) => {
  if (status === 403)
    return 'Check the backup access key and bucket policy: scoped ListBucket, GetObject and PutObject permissions are required.'
  if (status === 404)
    return 'The backup bucket or object is missing. Check the bucket name and endpoint.'
  if ((status >= 300 && status < 400) || status === 400)
    return 'Check the backup S3 endpoint and region; redirects are refused.'
  if (status === 412)
    return 'An object already exists with different bytes. Preserve it and use a new backup destination prefix.'
  return status >= 500
    ? 'The backup service is unavailable; the checkpoint will retry.'
    : 'Check the backup bucket policy, endpoint and region.'
}
const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
const maxBytes = 16 * 1024 * 1024 + 8192
export const createBackupS3Target = (
  config: BackupS3Config,
  options: { fetch?: typeof fetch; allowLoopbackHttp?: boolean } = {},
) => {
  const endpoint = new URL(config.endpoint)
  if (
    (endpoint.protocol !== 'https:' &&
      !(
        options.allowLoopbackHttp &&
        endpoint.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      )) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new BackupS3Error(
      'Set a HTTPS backup endpoint without credentials, query parameters or fragments.',
    )
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(config.bucket) ||
    !/^[a-z0-9-]{1,64}$/u.test(config.region) ||
    !config.accessKeyId ||
    !config.secretAccessKey
  )
    throw new BackupS3Error('Set a valid backup bucket, region and dedicated access-key pair.')
  const aws = new AwsClient({ ...config, service: 's3', retries: 0 }),
    doFetch = options.fetch ?? fetch
  const url = (name: string) => {
    if (!name || name.startsWith('/') || name.split('/').some((p) => !p || p === '.' || p === '..'))
      throw new BackupS3Error('The backup destination object path is invalid.')
    return `${endpoint.origin}${endpoint.pathname.replace(/\/$/u, '')}/${encode(config.bucket)}/${name.split('/').map(encode).join('/')}`
  }
  const send = async (
    method: string,
    name: string,
    headers: Record<string, string> = {},
    bytes?: Uint8Array,
  ) => {
    try {
      const request = await aws.sign(url(name), {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        ...(bytes === undefined ? {} : { body: new Uint8Array(bytes).buffer }),
      })
      return await doFetch(request)
    } catch (error) {
      if (error instanceof BackupS3Error) throw error
      throw new BackupS3Error(
        'Cannot reach the backup S3 endpoint. Check DNS, TLS, network access and endpoint/region settings; the checkpoint will retry.',
      )
    }
  }
  const fail = (response: Response) =>
    new BackupS3Error(
      `Off-site backup returned HTTP ${response.status}. ${advice(response.status)}`,
    )
  const matches = async (name: string, size: number, sha256: string) => {
    const response = await send('HEAD', name, { 'x-amz-checksum-mode': 'ENABLED' })
    if (response.status === 404) return false
    if (!response.ok) throw fail(response)
    if (Number(response.headers.get('content-length')) !== size)
      throw new BackupS3Error(
        'The destination already contains a different object size. Preserve it and configure a new backup prefix.',
      )
    const reported = response.headers.get('x-amz-checksum-sha256')
    if (reported) {
      if (!/^[A-Za-z0-9+/]{43}=$/u.test(reported))
        throw new BackupS3Error(
          'The destination returned an unsupported checksum header. Check S3 checksum support before retrying.',
        )
      const hex = [...Uint8Array.from(atob(reported), (c) => c.charCodeAt(0))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      if (hex !== sha256)
        throw new BackupS3Error(
          'The destination checksum differs. Preserve the object and configure a new backup prefix.',
        )
      return true
    }
    // S3-compatible servers do not all return stored checksum headers. Verify
    // their bytes instead of trusting user metadata or multipart ETags.
    const downloaded = await send('GET', name)
    if (!downloaded.ok) throw fail(downloaded)
    const reader = downloaded.body?.getReader(),
      parts: Uint8Array[] = []
    let length = 0
    if (reader)
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.length
        if (length > maxBytes || length > size) {
          await reader.cancel()
          throw new BackupS3Error('The destination object exceeds its recorded size.')
        }
        parts.push(next.value)
      }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    if (length !== size || (await backupSha256(bytes)) !== sha256)
      throw new BackupS3Error(
        'The destination bytes do not match the backup checksum. Preserve the object and configure a new backup prefix.',
      )
    return true
  }
  return {
    async ensureObject(name: string, bytes: Uint8Array) {
      if (bytes.length > maxBytes)
        throw new BackupS3Error(
          'This backup object exceeds the 16 MiB scheduled-sync limit. Use an operator export for larger tables.',
        )
      const sha256 = await backupSha256(bytes)
      if (await matches(name, bytes.length, sha256))
        return { outcome: 'reused' as const, sha256, size: bytes.length }
      const checksum = btoa(
        String.fromCharCode(
          ...Uint8Array.from(sha256.match(/../gu)!, (value) => parseInt(value, 16)),
        ),
      )
      const response = await send(
        'PUT',
        name,
        {
          'content-type': 'application/octet-stream',
          'x-amz-checksum-sha256': checksum,
          'x-amz-sdk-checksum-algorithm': 'SHA256',
          'if-none-match': '*',
        },
        bytes,
      )
      if (!response.ok && response.status !== 412 && response.status !== 409) throw fail(response)
      if (!(await matches(name, bytes.length, sha256)))
        throw new BackupS3Error(
          'The uploaded backup object could not be verified; the checkpoint will retry.',
        )
      return { outcome: 'uploaded' as const, sha256, size: bytes.length }
    },
  }
}
