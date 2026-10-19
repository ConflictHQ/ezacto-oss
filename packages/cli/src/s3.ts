import { createHash, createHmac } from 'node:crypto'

/**
 * A minimal S3-compatible client: SigV4 signing, HeadObject and PutObject.
 * Nothing else is needed to copy a bundle off-platform, and a smaller surface
 * is a smaller thing to get wrong against vendors that differ at the edges.
 * Only AWS S3 and MinIO are exercised.
 */

const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex')

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest()

/** RFC 3986 unreserved set; everything else is percent-encoded. */
const encodeRfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )

export interface SigV4Request {
  method: string
  url: URL
  /** Headers to sign in addition to host, x-amz-date and x-amz-content-sha256. */
  headers?: Record<string, string>
  /** Lowercase hex sha256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string
  region: string
  service?: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | undefined
  date: Date
}

const canonicalQuery = (url: URL): string =>
  [...url.searchParams.entries()]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? leftValue < rightValue
          ? -1
          : leftValue > rightValue
            ? 1
            : 0
        : leftName < rightName
          ? -1
          : 1,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join('&')

/**
 * Returns the full header set to send: the caller's headers plus host,
 * x-amz-date, x-amz-content-sha256 and Authorization. S3 does not normalise
 * the path a second time, so the URL's path is the canonical URI as given.
 */
export const signRequestV4 = (request: SigV4Request): Record<string, string> => {
  const service = request.service ?? 's3'
  const amzDate = request.date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ')
  }
  headers.host = request.url.host
  headers['x-amz-date'] = amzDate
  headers['x-amz-content-sha256'] = request.payloadHash
  if (request.sessionToken !== undefined) {
    headers['x-amz-security-token'] = request.sessionToken
  }
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    request.method,
    request.url.pathname,
    canonicalQuery(request.url),
    ...names.map((name) => `${name}:${headers[name]}`),
    '',
    signedHeaders,
    request.payloadHash,
  ].join('\n')
  const scope = `${day}/${request.region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n')
  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${request.secretAccessKey}`, day), request.region),
      service,
    ),
    'aws4_request',
  )
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return headers
}

export interface S3Config {
  /** Origin of an S3-compatible service. Omit for AWS (`s3.<region>.amazonaws.com`). */
  endpoint?: string | undefined
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | undefined
  /** `path` puts the bucket in the path, `virtual` in the host name. */
  addressing: 'path' | 'virtual'
}

export class S3Error extends Error {
  readonly status: number | null
  readonly code: string | null

  constructor(message: string, status: number | null, code: string | null) {
    super(message)
    this.name = 'S3Error'
    this.status = status
    this.code = code
  }
}

/** What an operator should do about an S3 error code, in one sentence. */
const advice = (code: string | null, status: number): string => {
  switch (code) {
    case 'NoSuchBucket':
      return 'the bucket does not exist, or the endpoint and region point at the wrong service; check the bucket name in --sync-to, EZACTO_S3_ENDPOINT and EZACTO_S3_REGION'
    case 'InvalidAccessKeyId':
      return 'the access key id is not known to this service; check AWS_ACCESS_KEY_ID and the endpoint'
    case 'SignatureDoesNotMatch':
      return 'the secret access key is wrong, or the region or endpoint differs from the one the key belongs to; check AWS_SECRET_ACCESS_KEY, EZACTO_S3_REGION and EZACTO_S3_ENDPOINT'
    case 'RequestTimeTooSkewed':
      return 'this machine clock differs from the service by more than the allowed skew; correct the system clock'
    case 'AccessDenied':
      return 'the credential may not write to this bucket and prefix; it needs s3:PutObject on the prefix (and s3:GetObject to skip objects already uploaded)'
    case 'AuthorizationHeaderMalformed':
    case 'AuthorizationQueryParametersError':
      return 'the region in the signature is not the bucket region; set EZACTO_S3_REGION to the bucket region'
    case 'PermanentRedirect':
    case 'AuthorizationHeaderMalformedRegion':
      return 'the bucket lives in another region or endpoint; set EZACTO_S3_REGION or EZACTO_S3_ENDPOINT to match it'
    case 'BadDigest':
    case 'XAmzContentSHA256Mismatch':
    case 'InvalidDigest':
      return 'the service received different bytes than were sent; retry, and if it persists suspect a proxy rewriting the request body'
    case 'EntityTooLarge':
      return 'a single PUT cannot exceed 5 GiB and multipart upload is not supported yet'
    default:
      return status >= 500
        ? 'the service reported a server error; rerun to resume'
        : 'see the service error code above'
  }
}

const errorCode = (body: string): string | null =>
  /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? null

export interface ObjectHead {
  size: number
  /** Lowercase hex sha256 the service recorded, or null if it recorded none. */
  sha256: string | null
}

export interface PutResult {
  /** True when the service echoed the checksum we sent. */
  verified: boolean
}

export interface S3Client {
  head(bucket: string, key: string): Promise<ObjectHead | null>
  put(bucket: string, key: string, body: Buffer, sha256: string): Promise<PutResult>
}

export const SINGLE_PUT_LIMIT = 5 * 1024 ** 3

export interface S3ClientOptions {
  fetch?: typeof fetch
  now?: () => Date
}

const fromBase64 = (value: string): string =>
  Buffer.from(value, 'base64').toString('hex')

export const createS3Client = (
  config: S3Config,
  options: S3ClientOptions = {},
): S3Client => {
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())

  const objectUrl = (bucket: string, key: string): URL => {
    const encodedKey = key.split('/').map(encodeRfc3986).join('/')
    const base =
      config.endpoint !== undefined
        ? new URL(config.endpoint)
        : new URL(`https://s3.${config.region}.amazonaws.com`)
    if (config.addressing === 'virtual') {
      return new URL(`${base.protocol}//${bucket}.${base.host}/${encodedKey}`)
    }
    return new URL(
      `${base.protocol}//${base.host}${base.pathname.replace(/\/$/, '')}/${encodeRfc3986(bucket)}/${encodedKey}`,
    )
  }

  const send = async (
    method: string,
    bucket: string,
    key: string,
    payloadHash: string,
    headers: Record<string, string>,
    body?: Buffer,
  ): Promise<Response> => {
    const url = objectUrl(bucket, key)
    const signed = signRequestV4({
      method,
      url,
      headers,
      payloadHash,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
      date: now(),
    })
    // fetch sets Host itself from the URL, which is the value that was signed.
    delete signed.host
    try {
      return await doFetch(url, {
        method,
        headers: signed,
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
      })
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error)
      throw new S3Error(
        `cannot reach ${url.host}: ${cause}; check EZACTO_S3_ENDPOINT, the network and TLS settings`,
        null,
        null,
      )
    }
  }

  const failure = async (
    action: string,
    response: Response,
    method: string,
  ): Promise<S3Error> => {
    // A HEAD response has no body to carry an error code.
    const text = method === 'HEAD' ? '' : await response.text()
    const code = errorCode(text)
    return new S3Error(
      `${action} failed with HTTP ${response.status}${code === null ? '' : ` ${code}`}: ${advice(code, response.status)}`,
      response.status,
      code,
    )
  }

  return {
    async head(bucket, key) {
      const response = await send(
        'HEAD',
        bucket,
        key,
        sha256Hex(''),
        { 'x-amz-checksum-mode': 'ENABLED' },
      )
      if (response.status === 404) return null
      // A credential that may write but not read (the put-only pattern) cannot
      // tell us what is there. Treat the object as absent and upload it: the
      // PUT then proves write access, and a bad credential fails there with
      // the service's own code.
      if (response.status === 403) return null
      if (!response.ok) throw await failure(`HEAD ${key}`, response, 'HEAD')
      const checksum = response.headers.get('x-amz-checksum-sha256')
      return {
        size: Number(response.headers.get('content-length') ?? '-1'),
        sha256: checksum === null ? null : fromBase64(checksum),
      }
    },

    async put(bucket, key, body, sha256) {
      if (body.length > SINGLE_PUT_LIMIT) {
        throw new S3Error(
          `${key} is ${body.length} bytes: ${advice('EntityTooLarge', 400)}`,
          null,
          'EntityTooLarge',
        )
      }
      const checksum = Buffer.from(sha256, 'hex').toString('base64')
      const response = await send(
        'PUT',
        bucket,
        key,
        sha256,
        {
          'content-type': 'application/octet-stream',
          'x-amz-checksum-sha256': checksum,
        },
        body,
      )
      if (!response.ok) throw await failure(`PUT ${key}`, response, 'PUT')
      const echoed = response.headers.get('x-amz-checksum-sha256')
      if (echoed !== null && echoed !== checksum) {
        throw new S3Error(
          `PUT ${key} stored a different checksum than was sent: ${advice('BadDigest', 200)}`,
          response.status,
          'BadDigest',
        )
      }
      return { verified: echoed !== null }
    },
  }
}

/** `s3://bucket/optional/prefix` -> bucket and a prefix with no leading or trailing slash. */
export const parseS3Destination = (
  value: string,
): { bucket: string; prefix: string } => {
  const match = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(value)
  if (match === null) {
    throw new Error(`destination must look like s3://bucket/prefix, got ${value}`)
  }
  return {
    bucket: match[1]!,
    prefix: (match[2] ?? '').replace(/^\/+|\/+$/g, ''),
  }
}

/**
 * Builds the client configuration from the environment. Credentials are read
 * from the environment only, never from a flag, so they cannot land in shell
 * history or a process listing.
 */
export const s3ConfigFromEnvironment = (
  environment: Record<string, string | undefined>,
): S3Config => {
  const accessKeyId = environment.AWS_ACCESS_KEY_ID
  const secretAccessKey = environment.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (a put-only credential is enough) to use --sync-to',
    )
  }
  const endpoint = environment.EZACTO_S3_ENDPOINT || undefined
  const addressing = environment.EZACTO_S3_ADDRESSING || (endpoint ? 'path' : 'virtual')
  if (addressing !== 'path' && addressing !== 'virtual') {
    throw new Error('EZACTO_S3_ADDRESSING must be path or virtual')
  }
  return {
    endpoint,
    region: environment.EZACTO_S3_REGION || environment.AWS_REGION || 'us-east-1',
    accessKeyId,
    secretAccessKey,
    sessionToken: environment.AWS_SESSION_TOKEN || undefined,
    addressing,
  }
}
