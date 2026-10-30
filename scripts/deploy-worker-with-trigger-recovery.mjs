import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const partialMessage = 'Successful trigger changes were not rolled back.'

/** Match only Wrangler's observed queue-consumer partial update, not generic 10013s. */
export function recoverableQueueTriggerFailure(output) {
  const text = output.replace(/\u001b\[[0-9;]*m/gu, '').replaceAll('\r', '')
  const blocks = [...text.matchAll(
    /Trigger configuration for "[^"\n]+" was only partially updated:\s*\n([\s\S]*?)\n\s*Successful trigger changes were not rolled back\./gu,
  )]
  if (blocks.length !== 1) return false
  const endpoint = '/accounts/[a-f0-9]{32}/queues/[a-f0-9]{32}/consumers/[a-f0-9]{32}'
  const failure = `- A request to the Cloudflare API \\(${endpoint}\\) failed\\.\\s*` +
    '- An unknown error has occurred\\.[^\\n]*\\[code: 10013\\]'
  return new RegExp(`^\\s*Queue consumers:\\s*(?:${failure}\\s*)+$`, 'u').test(blocks[0][1])
}

// This wrapper belongs to the fixed dev/prod workflow and its rendered default
// config. Refuse target overrides that a trigger-only recovery would not retain.
function deploymentEnvironment(args) {
  if (args[0] !== '--env' || !['dev', 'prod'].includes(args[1]))
    throw new Error('Expected the fixed dev or prod deployment environment.')
  for (let index = 2; index < args.length; index += 2) {
    if (!['--var', '--outdir'].includes(args[index]) || !args[index + 1])
      throw new Error('Unsupported deployment argument; no deployment attempted.')
  }
  return args[1]
}

const runWrangler = (args) => new Promise((resolve, reject) => {
  const child = spawn('npx', ['--no-install', 'wrangler', ...args], {
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  let output = ''
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      destination.write(chunk)
      // Fail closed if a diagnostic grows beyond this bounded tail.
      output = (output + chunk).slice(-256 * 1024)
    })
  }
  child.on('error', reject)
  child.on('close', (status, signal) => resolve({ status, signal, output }))
})

export async function deployWorker(args, {
  run = runWrangler,
  pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  report = message => process.stderr.write(`${message}\n`),
} = {}) {
  const environment = deploymentEnvironment(args)
  const deployed = await run(['deploy', ...args])
  if (deployed.status === 0) return 0
  if (deployed.signal || !recoverableQueueTriggerFailure(deployed.output)) {
    if (deployed.output.includes(partialMessage))
      report('::error::Worker code may already be live and triggers are partially updated. Successful changes were not rolled back. No automatic recovery matched; reconcile the reported trigger failures before accepting this release.')
    return deployed.status || 1
  }
  report('::warning::Worker code was uploaded, but a queue consumer returned Cloudflare 10013 and left triggers partially updated. Retrying only the same environment\'s trigger configuration once in 5 seconds; code and secrets will not be uploaded again.')
  await pause(5_000)
  const recovered = await run(['triggers', 'deploy', '--env', environment])
  if (recovered.status !== 0) {
    report('::error::Trigger-only recovery failed. Worker code may already be live and triggers may remain partially updated; successful changes were not rolled back. No further retry will run. Reconcile the reported state before accepting this release.')
    return recovered.status || 1
  }
  report('::notice::Trigger-only recovery succeeded. Exact deployed-binding and release smoke checks must still pass before this release is accepted.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  deployWorker(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(() => {
    console.error('::error::Deployment wrapper failed. Worker code and triggers may have changed; inspect the preceding deployment output before accepting this release. No further retry will run.')
    process.exitCode = 1
  })
}
