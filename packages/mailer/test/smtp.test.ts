import { createServer, type Server, type Socket } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import fs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SmtpMailer } from '../src/smtp.js'

type Capture = {
  server: Server
  url: string
  messages: string[]
}

const captures: Capture[] = []
const temporaryDirectories: string[] = []

const smtpCapture = async (rejectRecipient = false): Promise<Capture> => {
  const messages: string[] = []
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8')
    socket.write('220 capture.test ESMTP ready\r\n')
    let buffer = ''
    let data = false
    let message = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      while (buffer.includes('\r\n')) {
        const ending = buffer.indexOf('\r\n')
        const line = buffer.slice(0, ending)
        buffer = buffer.slice(ending + 2)
        if (data) {
          if (line === '.') {
            messages.push(message)
            message = ''
            data = false
            socket.write('250 queued as capture-1\r\n')
          } else {
            message += `${line}\r\n`
          }
          continue
        }
        if (/^(?:EHLO|HELO) /iu.test(line)) {
          socket.write('250-capture.test\r\n250 PIPELINING\r\n')
        } else if (/^MAIL FROM:/iu.test(line)) {
          socket.write('250 sender accepted\r\n')
        } else if (/^RCPT TO:/iu.test(line)) {
          socket.write(
            rejectRecipient
              ? '550 recipient rejected\r\n'
              : '250 recipient accepted\r\n',
          )
        } else if (line === 'DATA') {
          data = true
          socket.write('354 end with dot\r\n')
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n')
        } else {
          socket.write('250 ok\r\n')
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('SMTP capture did not bind a TCP port')
  }
  const capture = {
    server,
    url: `smtp://127.0.0.1:${address.port}`,
    messages,
  }
  captures.push(capture)
  return capture
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    captures.splice(0).map(
      ({ server }) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  )
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('SMTP mailer', () => {
  it.each(['file', 'url'] as const)('[security #451] preserves the content sandbox through the legacy plugin API (%s)', async (kind) => {
    const capture = await smtpCapture()
    const directory = await mkdtemp(join(tmpdir(), 'ezacto-smtp-sandbox-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'synthetic-canary.txt')
    await writeFile(path, 'SYNTHETIC SMTP CANARY — NOT A REAL SECRET')
    let requests = 0
    const http = createHttpServer((_request, response) => {
      requests += 1
      response.end('SYNTHETIC LOOPBACK CANARY')
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (address === null || typeof address === 'string') throw new Error('HTTP canary did not bind')
    const url = `http://127.0.0.1:${address.port}/canary`
    captures.push({ server: http, url, messages: [] })
    const read = vi.spyOn(fs, 'createReadStream')
    let legacyError: Error | null | undefined
    // Production does not currently install compile plugins. Exercise the
    // documented extension API so adding one cannot defeat our transport flags.
    const createTransport = ((options: SMTPTransport.Options) => {
      const transport = nodemailer.createTransport(options)
      transport.use('compile', (mail, done) => {
        expect(mail.data.disableFileAccess).toBe(true)
        expect(mail.data.disableUrlAccess).toBe(true)
        mail.data.html = { path: kind === 'file' ? path : url }
        void mail.resolveContent(mail.data, 'html', (error) => {
          legacyError = error
          done(error ?? undefined)
        })
      })
      return transport
    }) as typeof nodemailer.createTransport
    const mailer = new SmtpMailer({ url: capture.url, from: 'billing@example.test' }, { createTransport })
    const failure: unknown = await mailer.send({
      from: { email: 'billing@example.test' }, to: [{ email: 'recipient@example.test' }],
      template: 'verify_email', subject: 'Sandbox regression', text: 'Safe inline content',
    }, { signal: new AbortController().signal, idempotencyKey: `sandbox-${kind}` }).catch((error: unknown) => error)
    expect(read).not.toHaveBeenCalled()
    expect(requests).toBe(0)
    expect(legacyError).toMatchObject({ code: kind === 'file' ? 'EFILEACCESS' : 'EURLACCESS' })
    expect(failure).toBe(legacyError)
    expect(capture.messages).toEqual([])
  })

  it('[unit] verifies and sends through a real operator-supplied SMTP endpoint', async () => {
    const capture = await smtpCapture()
    let monotonic = 10
    const mailer = new SmtpMailer(
      { url: capture.url, from: 'Ezacto <billing@example.test>' },
      { monotonicNow: () => (monotonic += 7) },
    )

    await mailer.verify()
    const receipt = await mailer.send(
      {
        from: { email: 'billing@example.test', name: 'Ezacto Billing' },
        to: [{ email: 'owner@example.test', name: 'Owner' }],
        template: 'verify_email',
        subject: 'Verify account',
        text: 'Use the real SMTP path.',
      },
      {
        signal: new AbortController().signal,
        idempotencyKey: 'ezacto-email-1',
      },
    )

    expect(receipt).toEqual({
      messageId: '<ezacto-email-1@ezacto.invalid>',
      latencyMs: 7,
    })
    expect(capture.messages).toHaveLength(1)
    expect(capture.messages[0]).toContain(
      'From: Ezacto Billing <billing@example.test>',
    )
    expect(capture.messages[0]).toContain('To: Owner <owner@example.test>')
    expect(capture.messages[0]).toContain(
      'Message-ID: <ezacto-email-1@ezacto.invalid>',
    )
    expect(capture.messages[0]).toContain(
      'X-Ezacto-Idempotency-Key: ezacto-email-1',
    )
  })

  it('[unit] reports permanent SMTP rejection instead of silent success', async () => {
    const capture = await smtpCapture(true)
    const mailer = new SmtpMailer({
      url: capture.url,
      from: 'billing@example.test',
    })

    await expect(
      mailer.send(
        {
          from: { email: 'billing@example.test' },
          to: [{ email: 'owner@example.test' }],
          template: 'verify_email',
          subject: 'Verify account',
          text: 'Delivery must fail.',
        },
        {
          signal: new AbortController().signal,
          idempotencyKey: 'ezacto-email-2',
        },
      ),
    ).rejects.toMatchObject({
      name: 'EmailProviderTerminalError',
      reason: 'smtp_rejected:SMTP_550',
    })
    expect(capture.messages).toEqual([])
  })

  it.each([
    ['http://smtp.example.test', 'billing@example.test'],
    ['smtp://smtp.example.test/path', 'billing@example.test'],
    ['smtp://smtp.example.test', 'bad\r\nBcc: victim@example.test'],
  ])('[security] rejects unsafe SMTP configuration', (url, from) => {
    expect(() => new SmtpMailer({ url, from })).toThrow()
  })
})
