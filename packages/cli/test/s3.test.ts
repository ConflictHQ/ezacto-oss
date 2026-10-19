import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createS3Client,
  parseS3Destination,
  s3ConfigFromEnvironment,
  signRequestV4,
  type S3Config,
} from '../src/s3.js'
import {
  FAKE_S3_ACCESS_KEY,
  FAKE_S3_BUCKET,
  FAKE_S3_REGION,
  FAKE_S3_SECRET,
  startFakeS3,
  type FakeS3,
} from './helpers/fake-s3.js'

// The worked examples from "Signature Calculations for the Authorization
// Header" in the Amazon S3 API reference.
const awsExample = {
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  date: new Date('2013-05-24T00:00:00Z'),
}
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

describe('SigV4 signing against the published AWS S3 examples', () => {
  it('signs GET Object with a Range header', () => {
    const headers = signRequestV4({
      ...awsExample,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      payloadHash: emptyHash,
    })
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })

  it('signs PUT Object with an encoded key and extra signed headers', () => {
    const body = 'Welcome to Amazon S3.'
    const headers = signRequestV4({
      ...awsExample,
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'),
      headers: {
        Date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      payloadHash: createHash('sha256').update(body).digest('hex'),
    })
    expect(headers.authorization).toContain(
      'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class',
    )
    expect(headers.authorization).toContain(
      'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    )
  })

  it('signs GET Bucket Lifecycle (a bare query parameter)', () => {
    const headers = signRequestV4({
      ...awsExample,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
      payloadHash: emptyHash,
    })
    expect(headers.authorization).toContain(
      'Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    )
  })

  it('signs GET Bucket (List Objects) with sorted query parameters', () => {
    const headers = signRequestV4({
      ...awsExample,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2'),
      payloadHash: emptyHash,
    })
    expect(headers.authorization).toContain(
      'Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    )
  })

  it('signs the session token when one is present', () => {
    const headers = signRequestV4({
      ...awsExample,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      payloadHash: emptyHash,
      sessionToken: 'token',
    })
    expect(headers['x-amz-security-token']).toBe('token')
    expect(headers.authorization).toContain('x-amz-security-token')
  })
})

describe('addressing', () => {
  const capture = (config: Partial<S3Config>) => {
    const urls: string[] = []
    const client = createS3Client(
      {
        region: 'eu-west-1',
        accessKeyId: 'a',
        secretAccessKey: 'b',
        addressing: 'path',
        ...config,
      },
      {
        fetch: ((input: URL | string) => {
          urls.push(String(input))
          return Promise.resolve(new Response(null, { status: 404 }))
        }) as typeof fetch,
      },
    )
    return { client, urls }
  }

  it('uses virtual-host addressing on AWS by default', async () => {
    const { client, urls } = capture({ addressing: 'virtual' })
    await client.head('my-bucket', 'pre fix/db.sqlite')
    expect(urls).toEqual([
      'https://my-bucket.s3.eu-west-1.amazonaws.com/pre%20fix/db.sqlite',
    ])
  })

  it('uses path-style addressing against a custom endpoint', async () => {
    const { client, urls } = capture({ endpoint: 'http://minio.local:9000' })
    await client.head('my-bucket', 'a/b.csv')
    expect(urls).toEqual(['http://minio.local:9000/my-bucket/a/b.csv'])
  })

  it('puts the bucket in the host name for a virtual endpoint', async () => {
    const { client, urls } = capture({
      endpoint: 'https://s3.example.test',
      addressing: 'virtual',
    })
    await client.head('my-bucket', 'a.csv')
    expect(urls).toEqual(['https://my-bucket.s3.example.test/a.csv'])
  })
})

describe('configuration', () => {
  it('parses destinations', () => {
    expect(parseS3Destination('s3://bucket')).toEqual({ bucket: 'bucket', prefix: '' })
    expect(parseS3Destination('s3://bucket/a/b/')).toEqual({ bucket: 'bucket', prefix: 'a/b' })
    expect(() => parseS3Destination('https://bucket/a')).toThrow(/s3:\/\/bucket\/prefix/)
  })

  it('reads credentials from the environment only and defaults addressing from the endpoint', () => {
    expect(() => s3ConfigFromEnvironment({})).toThrow(/AWS_ACCESS_KEY_ID/)
    const minio = s3ConfigFromEnvironment({
      AWS_ACCESS_KEY_ID: 'a',
      AWS_SECRET_ACCESS_KEY: 'b',
      EZACTO_S3_ENDPOINT: 'http://localhost:9000',
    })
    expect(minio).toMatchObject({ addressing: 'path', region: 'us-east-1' })
    const aws = s3ConfigFromEnvironment({
      AWS_ACCESS_KEY_ID: 'a',
      AWS_SECRET_ACCESS_KEY: 'b',
      AWS_REGION: 'eu-west-1',
    })
    expect(aws).toMatchObject({ addressing: 'virtual', region: 'eu-west-1' })
    expect(() =>
      s3ConfigFromEnvironment({
        AWS_ACCESS_KEY_ID: 'a',
        AWS_SECRET_ACCESS_KEY: 'b',
        EZACTO_S3_ADDRESSING: 'dns',
      }),
    ).toThrow(/path or virtual/)
  })
})

describe('against a MinIO-style server', () => {
  let server: FakeS3 | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  const config = (overrides: Partial<S3Config> = {}): S3Config => ({
    endpoint: server!.endpoint,
    region: FAKE_S3_REGION,
    accessKeyId: FAKE_S3_ACCESS_KEY,
    secretAccessKey: FAKE_S3_SECRET,
    addressing: 'path',
    ...overrides,
  })
  const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex')

  it('puts with a verified checksum and reads it back with head', async () => {
    server = await startFakeS3()
    const client = createS3Client(config())
    const body = Buffer.from('hello offsite')
    expect(await client.head(FAKE_S3_BUCKET, 'x/hello.txt')).toBeNull()
    expect(await client.put(FAKE_S3_BUCKET, 'x/hello.txt', body, digest(body))).toEqual({
      verified: true,
    })
    expect(await client.head(FAKE_S3_BUCKET, 'x/hello.txt')).toEqual({
      size: body.length,
      sha256: digest(body),
    })
  })

  it('fails with an actionable message for each misconfiguration', async () => {
    server = await startFakeS3()
    const body = Buffer.from('x')
    const put = (overrides: Partial<S3Config>, bucket = FAKE_S3_BUCKET) =>
      createS3Client(config(overrides)).put(bucket, 'k', body, digest(body))

    await expect(put({}, 'wrong-bucket')).rejects.toThrow(/NoSuchBucket.*bucket does not exist/)
    await expect(put({ accessKeyId: 'nope' })).rejects.toThrow(
      /InvalidAccessKeyId.*AWS_ACCESS_KEY_ID/,
    )
    await expect(put({ secretAccessKey: 'wrong' })).rejects.toThrow(
      /SignatureDoesNotMatch.*AWS_SECRET_ACCESS_KEY/,
    )
    await expect(put({ region: 'eu-west-1' })).rejects.toThrow(/SignatureDoesNotMatch.*REGION/)
  })

  it('names the endpoint when the network is unreachable', async () => {
    server = await startFakeS3()
    const endpoint = server.endpoint
    await server.close()
    server = undefined
    const client = createS3Client({
      endpoint,
      region: FAKE_S3_REGION,
      accessKeyId: FAKE_S3_ACCESS_KEY,
      secretAccessKey: FAKE_S3_SECRET,
      addressing: 'path',
    })
    await expect(client.head(FAKE_S3_BUCKET, 'k')).rejects.toThrow(
      /cannot reach 127\.0\.0\.1:\d+.*EZACTO_S3_ENDPOINT/,
    )
  })

  it('refuses a body over the single-PUT limit before sending it', async () => {
    server = await startFakeS3()
    const client = createS3Client(config())
    const big = { length: 5 * 1024 ** 3 + 1 } as Buffer
    await expect(client.put(FAKE_S3_BUCKET, 'k', big, 'a'.repeat(64))).rejects.toThrow(
      /5 GiB/,
    )
    expect(server.requests).toEqual([])
  })
})
