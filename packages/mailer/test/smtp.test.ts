import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SmtpMailer } from '../src/smtp.js'

type Capture = {
  server: Server
  url: string
  messages: string[]
}

const captures: Capture[] = []

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
  await Promise.all(
    captures.splice(0).map(
      ({ server }) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  )
})

describe('SMTP mailer', () => {
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
