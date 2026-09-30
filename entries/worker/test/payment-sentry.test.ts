import { build } from "esbuild";
import {
  Miniflare,
  Request as MiniflareRequest,
  Response as MiniflareResponse,
} from "miniflare";
import { expect, it, vi } from "vitest";

it("delivers a handled payment 502 as a Sentry envelope with the request ID", async () => {
  // Exercise the real Worker application's error reporter and SDK transport in
  // workerd. The fake DSN and outbound sink keep this entirely local.
  const bundled = await build({
    stdin: {
      contents: `
        import * as Sentry from '@sentry/cloudflare';
        import { ApiError } from '@ezacto/api';
        import { createApp } from './src/app.ts';
        const app = createApp();
        app.post('/test-payment-failure', () => {
          throw new ApiError({status:502, code:'provider_error', message:'Wise 403 during lookup. Trace: fixture'});
        });
        export default Sentry.withSentry(env => ({
          dsn:env.SENTRY_DSN, enabled:Boolean(env.SENTRY_DSN),
          environment:env.ENVIRONMENT, release:env.RELEASE,
          sendDefaultPii:false, tracesSampleRate:0,
        }), { fetch: (request, env, ctx) => app.fetch(request, env, ctx) });
      `,
      resolveDir: new URL("..", import.meta.url).pathname,
    },
    bundle: true,
    conditions: ["development"],
    format: "esm",
    platform: "browser",
    external: ["node:async_hooks"],
    target: "es2022",
    write: false,
  });
  const envelopes: string[] = [];
  const worker = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_als"],
    bindings: {
      SENTRY_DSN: "https://fixture@sentry.example.com/123",
      ENVIRONMENT: "test",
      RELEASE: "payment-sentry-test",
    },
    outboundService: async (request: MiniflareRequest) => {
      expect(new URL(request.url).pathname).toBe("/api/123/envelope/");
      envelopes.push(await request.text());
      return new MiniflareResponse("{}", { status: 200 });
    },
  });
  try {
    const response = await worker.dispatchFetch(
      "https://app.example.com/test-payment-failure",
      { method: "POST" },
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as { request_id: string };
    await vi.waitFor(() => expect(envelopes.length).toBeGreaterThan(0));
    const event = envelopes
      .flatMap((envelope) =>
        envelope.split("\n").map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return {};
          }
        }),
      )
      .find((entry) => entry.exception !== undefined)!;
    expect(event).toMatchObject({
      tags: { request_id: body.request_id },
      environment: "test",
      release: "payment-sentry-test",
      exception: {
        values: [
          expect.objectContaining({
            value: "Wise 403 during lookup. Trace: fixture",
          }),
        ],
      },
    });
  } finally {
    await worker.dispose();
  }
}, 30000);
