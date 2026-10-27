import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("uses native workerd fetch and rejects redirects without forwarding the bank token", async () => {
  const bundle = await build({
    stdin: {
      contents: `import {readJson,BankFeedError} from './packages/integrations/src/bank-feed/shared.ts';
        export default {async fetch(request) {
          try {return Response.json(await readJson(new URL('https://bank-fixture.example'+new URL(request.url).pathname),{token:'synthetic-bank-token'}));}
          catch(error) {if(error instanceof BankFeedError)return Response.json({code:error.code,status:error.status,message:error.message},{status:502});throw error;}
        }};`,
      resolveDir: new URL("../../../", import.meta.url).pathname,
      sourcefile: "bank-transport-native.ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const mf = new Miniflare({
    workers: [
      {
        name: "adapter",
        modules: true,
        compatibilityDate: "2026-08-06",
        script: bundle.outputFiles[0]!.text,
        outboundService: "provider",
      },
      {
        name: "provider",
        modules: true,
        compatibilityDate: "2026-08-06",
        script: `const requests=[];export default {fetch(request){
        const url=new URL(request.url);
        if(url.pathname==='/__requests')return Response.json(requests);
        requests.push({host:url.host,path:url.pathname,authorization:request.headers.get('authorization')});
        if(url.pathname==='/redirect')return new Response('private provider body',{status:302,headers:{location:'https://exfiltration.example/steal'}});
        return Response.json({received:true});
      }};`,
      },
    ],
  });
  try {
    const adapter = await mf.getWorker("adapter");
    const success = await adapter.fetch("https://adapter.example/success");
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ received: true });
    const rejected = await adapter.fetch("https://adapter.example/redirect");
    expect(rejected.status).toBe(502);
    expect(await rejected.json()).toEqual({
      code: "provider",
      status: 302,
      message: "Bank feed provider (302)",
    });
    const requests = await (
      await (
        await mf.getWorker("provider")
      ).fetch("https://provider.example/__requests")
    ).json();
    expect(requests).toEqual([
      {
        host: "bank-fixture.example",
        path: "/success",
        authorization: "Bearer synthetic-bank-token",
      },
      {
        host: "bank-fixture.example",
        path: "/redirect",
        authorization: "Bearer synthetic-bank-token",
      },
    ]);
  } finally {
    await mf.dispose();
  }
}, 30_000);
