import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packages = Object.entries(JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')).packages)
  .filter(([path]) => path.endsWith('/miniflare'))

for (const [path, metadata] of packages) test(`installed Miniflare ${metadata.version} pairs replies after a previous request's late notification`, { timeout: 20_000 }, async () => {
  const filename = resolve(root, path, 'dist/src/index.js')
  const source = readFileSync(filename, 'utf8')
  // Exercise the installed caller and the installed worker publication, not a
  // second implementation of the fixed algorithm. Only transport/scheduling
  // are controlled, to force the preemption described in upstream PR15552.
  const caller = source.match(/var SynchronousFetcher = class \{[\s\S]*?\n};/)?.[0]
  const publication = source.match(/Atomics\.store\(notifyHandle,[^;]+;/)?.[0]
  assert.ok(caller && publication, 'the reviewed dependency seam must remain recognizable')
  const control = new Int32Array(new SharedArrayBuffer(16))
  const channels = []
  let currentId = -1, waits = 0
  const boundedWait = (handle, index, value) => {
    const result = Atomics.wait(handle, index, value, 10_000)
    assert.notEqual(result, 'timed-out', 'controlled protocol handoff stalled')
    return result
  }
  const releaseReply = () => { Atomics.store(control, 2, 1); Atomics.notify(control, 2) }
  class ScheduledChannel {
    constructor() {
      const channel = new MessageChannel(), post = channel.port1.postMessage.bind(channel.port1)
      channels.push(channel)
      channel.port1.postMessage = message => {
        currentId = message.id; waits = 0; post(message)
        if (message.id === 0) {
          // Caller is preempted between post and wait: reply0 and its store
          // arrive first. The worker's notify0 is deliberately delayed.
          boundedWait(control, 0, 0)
        } else {
          Atomics.store(control, 1, 1); Atomics.notify(control, 1)
        }
      }
      return channel
    }
  }
  class ScheduledWorker extends Worker {
    constructor(_script, options) {
      super(`
        const {workerData}=require('node:worker_threads');
        const {port,notifyHandle,control}=workerData;
        port.on('message',({id})=>{
          port.postMessage({id,response:{status:204,headers:{'x-request-id':String(id)},body:null}});
          ${publication}
          if(id===0){
            Atomics.store(control,0,1);Atomics.notify(control,0);
            Atomics.wait(control,1,0,10000);
            // Confirm request1 actually armed its wait before delivering the
            // stale notify0. No scheduler probability is needed in this test.
            while(Atomics.notify(notifyHandle,0)!==1){}
            Atomics.add(control,3,1);
            Atomics.wait(control,2,0,10000);
          }else Atomics.notify(notifyHandle,0);
        });
        port.start();`, { ...options, eval: true, workerData: { ...options.workerData, control } })
    }
  }
  const threads = {
    MessageChannel: ScheduledChannel, Worker: ScheduledWorker,
    receiveMessageOnPort: port => {
      const reply = receiveMessageOnPort(port)
      // The old caller reads an empty queue after its first wake. A fixed
      // caller re-arms its wait; only then may the worker queue reply1.
      if (currentId === 1 && Atomics.load(control, 2) === 0) releaseReply()
      return reply
    },
  }
  const atomics = {
    load: Atomics.load, store: Atomics.store, notify: Atomics.notify,
    wait: (handle, index, seen) => {
      if (currentId === 1 && ++waits === 2) releaseReply()
      return boundedWait(handle, index, seen)
    },
  }
  const sandbox = { WORKER_SCRIPT: '', __filename: filename, Atomics: atomics, CoreHeaders: { ERROR_STACK: 'unused' } }
  for (const symbol of new Set(caller.match(/\bimport_[a-zA-Z0-9_]+(?=\.)/g))) {
    if (symbol.includes('worker_threads')) sandbox[symbol] = threads
    else if (symbol.includes('assert')) sandbox[symbol] = { default: assert }
    else if (symbol.includes('undici')) sandbox[symbol] = { Headers }
    else if (symbol.startsWith('import_web')) sandbox[symbol] = { ReadableStream }
    else assert.fail(`Unreviewed dependency in protocol seam: ${symbol}`)
  }
  const Fetcher = runInNewContext(`${caller}\nSynchronousFetcher`, sandbox, { filename })
  const fetcher = new Fetcher()
  try {
    assert.equal(fetcher.fetch('http://owned.invalid/', { method: 'GET' }).headers.get('x-request-id'), '0')
    assert.equal(fetcher.fetch('http://owned.invalid/', { method: 'GET' }).headers.get('x-request-id'), '1')
    assert.equal(Atomics.load(control, 3), 1, 'one confirmed stale wake was forced')
    assert.ok(waits >= 2, 'the caller rechecked its generation and re-armed its wait')
  } finally {
    releaseReply(); await fetcher.dispose()
    for (const channel of channels) { channel.port1.close(); channel.port2.close() }
  }
})
