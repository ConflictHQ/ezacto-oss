import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { signRequestV4 } from '../../src/s3.js'

/**
 * A MinIO-style S3 stand-in: path-style addressing, SigV4 verification (the
 * signature is recomputed from what arrived), x-amz-checksum-sha256 validation
 * on PUT and echo on HEAD. It keeps every request so a test can assert order.
 */
export const FAKE_S3_ACCESS_KEY = 'minio-test-key'
export const FAKE_S3_SECRET = 'minio-test-secret'
export const FAKE_S3_REGION = 'us-east-1'
export const FAKE_S3_BUCKET = 'ezacto-offsite'

export interface FakeS3Options {
  /** Destroy the connection on the Nth PUT (1-based), as a killed sync would. */
  dieOnPut?: number
  /** Answer HEAD with 403, as a credential that may only write does. */
  putOnly?: boolean
}

export interface FakeS3 {
  endpoint: string
  objects: Map<string, { body: Buffer; checksum: string }>
  requests: Array<{ method: string; key: string }>
  puts(): string[]
  close(): Promise<void>
}

const xmlError = (code: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`

export const startFakeS3 = async (options: FakeS3Options = {}): Promise<FakeS3> => {
  const objects = new Map<string, { body: Buffer; checksum: string }>()
  const requests: FakeS3['requests'] = []
  let putCount = 0

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const reply = (status: number, code?: string, headers: Record<string, string> = {}) => {
        const text = code === undefined || request.method === 'HEAD' ? '' : xmlError(code)
        response.writeHead(status, headers)
        response.end(text)
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      const [, bucket, ...rest] = url.pathname.split('/')
      const key = rest.map(decodeURIComponent).join('/')
      requests.push({ method: request.method ?? '', key })

      const authorization = request.headers.authorization ?? ''
      const credential = /Credential=([^/]+)\//.exec(authorization)?.[1]
      if (credential !== FAKE_S3_ACCESS_KEY) return reply(403, 'InvalidAccessKeyId')
      const signedNames = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(';') ?? []
      const amzDate = String(request.headers['x-amz-date'])
      const echoed: Record<string, string> = {}
      for (const name of signedNames) {
        if (['host', 'x-amz-date', 'x-amz-content-sha256'].includes(name)) continue
        echoed[name] = String(request.headers[name])
      }
      const expected = signRequestV4({
        method: request.method ?? '',
        url,
        headers: echoed,
        payloadHash: String(request.headers['x-amz-content-sha256']),
        region: FAKE_S3_REGION,
        accessKeyId: FAKE_S3_ACCESS_KEY,
        secretAccessKey: FAKE_S3_SECRET,
        date: new Date(
          `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
        ),
      }).authorization
      if (expected !== authorization) return reply(403, 'SignatureDoesNotMatch')
      if (bucket !== FAKE_S3_BUCKET) return reply(404, 'NoSuchBucket')

      if (request.method === 'HEAD') {
        if (options.putOnly) return reply(403)
        const found = objects.get(key)
        if (found === undefined) return reply(404)
        return reply(200, undefined, {
          'content-length': String(found.body.length),
          'x-amz-checksum-sha256': found.checksum,
        })
      }
      if (request.method === 'PUT') {
        putCount++
        if (options.dieOnPut === putCount) {
          request.socket.destroy()
          return
        }
        const hash = () => createHash('sha256').update(body)
        if (hash().digest('hex') !== request.headers['x-amz-content-sha256']) {
          return reply(400, 'XAmzContentSHA256Mismatch')
        }
        const sent = String(request.headers['x-amz-checksum-sha256'])
        if (sent !== hash().digest('base64')) return reply(400, 'BadDigest')
        objects.set(key, { body, checksum: sent })
        return reply(200, undefined, { 'x-amz-checksum-sha256': sent })
      }
      return reply(405)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    puts: () => requests.filter((entry) => entry.method === 'PUT').map((entry) => entry.key),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
