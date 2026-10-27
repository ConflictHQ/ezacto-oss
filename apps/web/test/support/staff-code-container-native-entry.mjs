/** Disposable local browser proof, never installed as an application entry. */
import { serve } from '@hono/node-server'
import { createContainerRuntime } from '../../../../entries/container/src/runtime.js'
import { createContainerHandler } from '../../../../entries/container/src/handler.js'
import { createApp } from '../../../../entries/worker/src/app.js'
import { join } from 'node:path'
import { realpath, readFile } from 'node:fs/promises'
import process from 'node:process'
import { webcrypto as crypto } from 'node:crypto'
const root = await realpath(process.env.EZACTO_STAFF_CODE_FIXTURE_DIRECTORY)
const port = Number(process.env.EZACTO_STAFF_CODE_FIXTURE_PORT)
const password = process.env.EZACTO_STAFF_CODE_FIXTURE_PASSWORD
if (!password || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid owned fixture configuration')
const origin = `http://localhost:${port}`
const nativeFetch = globalThis.fetch
globalThis.fetch = (input, init) => new globalThis.URL(input instanceof globalThis.Request ? input.url : String(input)).origin === origin ? nativeFetch(input, init) : Promise.reject(new Error('Owned fixture blocks external requests'))
const mails = []
const config = {
  host:'127.0.0.1',port,trustedProxyHops:0,dataDirectory:root,databasePath:join(root,'db.sqlite'),attachmentDirectory:join(root,'attachments'),brandDirectory:join(root,'brand'),
  appBaseUrl:origin,cursorSigningKey:crypto.getRandomValues(new Uint8Array(32)),magicLinkSigningKey:crypto.getRandomValues(new Uint8Array(32)),
  smtp:{url:'smtp://127.0.0.1:2525',from:'owned@example.test'},appEnv:{ENVIRONMENT:'test-container',RELEASE:'owned-staff-code-proof',APP_BASE_URL:origin,MAGIC_LINK_SIGNING_KEY:'owned-fixture-configured'},
}
const runtime = await createContainerRuntime(config, { emailProvider:{name:'smtp',async send(message,options){mails.push(message);return{messageId:`<${options.idempotencyKey}@owned.test>`,latencyMs:0}}}, verifyEmailProvider:async()=>undefined })
const delivery = await runtime.services.passwordAuth.signup({organizationName:'Owned code proof',firstName:'Owned',lastName:'Owner',email:'code-owner@example.test',password,clientKey:'owned-code-proof'})
await runtime.services.passwordAuth.verifyEmail(delivery.token,'owned-code-proof')
const timestamp = new Date().toISOString()
runtime.database.prepare("INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Mobile','Owner','administrator','[]',?,?)").run(timestamp,timestamp)
runtime.database.prepare("INSERT INTO user_emails(user_id,address,verified_at,is_primary,created_at,updated_at) VALUES(2,'mobile-code-owner@example.test',?,1,?,?)").run(timestamp,timestamp,timestamp)
const app = createApp(runtime.services,runtime.brandAssets,runtime.instanceTheme)
const handle = createContainerHandler(runtime.services,app,config.appEnv)
const server = serve({hostname:'127.0.0.1',port,fetch:async request=>{
  const url = new globalThis.URL(request.url)
  if(url.pathname === '/__owned_mobile_client.js' && process.env.EZACTO_STAFF_CODE_MOBILE_SOURCE) return new globalThis.Response(await readFile(join(root,'runtime','mobile-client.js')), {headers:{'content-type':'text/javascript','cache-control':'no-store'}})
  if(url.pathname === '/__owned_code_mail' && request.headers.get('x-owned-proof') === process.env.EZACTO_STAFF_CODE_FIXTURE_NONCE){
    const wanted = url.searchParams.get('email') ?? 'code-owner@example.test'
    const mail = mails.filter(message=>message.template==='staff_magic_link_signin:v1' && message.to.some(recipient=>recipient.email===wanted)).at(-1)
    const code = mail ? /Or enter this code[^:]*: (\d{6})/.exec(mail.text)?.[1] : null
    return globalThis.Response.json({code},{headers:{'cache-control':'no-store'}})
  }
  return handle(request)
}})
let stopping = null
const shutdown = ()=>{stopping ??= (async()=>{await new Promise(resolve=>{server.close(()=>resolve());server.closeIdleConnections()});await runtime.close()})();void stopping.then(()=>process.exit(0),()=>process.exit(1))}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown)
