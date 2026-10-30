import { describe, expect, it, vi } from 'vitest'
import { createQueuedPortalMagicLinkMailer } from '../src/portal-magic-link-email.js'

describe('queued contact sign-in email', () => {
  it('uses the instance page and fragment credential, escaped copy and the existing sign-in queue', async () => {
    const enqueue = vi
      .fn<(message: unknown) => Promise<{ id: string }>>()
      .mockResolvedValue({ id: 'email' })
    const mailer = createQueuedPortalMagicLinkMailer(
      { enqueue } as never,
      async () => 'Example <Studio>',
      'https://instance.example/ignored?other=value',
    )
    await mailer.enqueue({
      kind: 'magic_link',
      to: 'contact@example.com',
      token: 'a.b&c',
      expiresAt: '2026-10-21T12:15:00.000Z',
    })
    expect(enqueue).toHaveBeenCalledOnce()
    const mail = enqueue.mock.calls[0]![0] as {
      template: string
      text: string
      html: string
      to: { email: string }[]
    }
    expect(mail.template).toBe('portal_magic_link_signin:v1')
    expect(mail.to).toEqual([{ email: 'contact@example.com' }])
    const raw = mail.text.split('\n').find((line) => line.startsWith('https:'))!
    const link = new URL(raw)
    expect(link.origin + link.pathname).toBe('https://instance.example/portal/estimate-review')
    expect(link.search).toBe('')
    expect(new URLSearchParams(link.hash.slice(1)).get('token')).toBe('a.b&c')
    expect(mail.html).toContain('Example &lt;Studio&gt;')
    expect(mail.html).not.toContain('<Studio>')
    expect(mail.text).toContain('2026-10-21T12:15:00.000Z')
  })
  it('refuses a non-web or credential-bearing instance destination', () => {
    for (const origin of ['javascript:alert(1)', 'http://public.example', 'https://user:password@example.com'])
      expect(() =>
        createQueuedPortalMagicLinkMailer({} as never, async () => 'Example', origin),
      ).toThrow()
  })
})
