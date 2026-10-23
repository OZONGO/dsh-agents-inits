/**
 * Runtime integration check: mount the plugin on the real Cordis runtime and
 * drive the real commands service, with the subagent service stubbed.
 *
 * This verifies the part a fake context cannot: that Cordis `inject` gating
 * resolves, that the real `CommandDefinition` validation accepts the command,
 * and that executing the line reaches a real subagent activation.
 *
 * The DSH installation is located automatically. Set `DSH_INSTALL_ROOT` to the
 * directory holding `node_modules/@deepseek-ai` when it cannot be found.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, inject, name, COMMAND_NAME } from '../index.js'

/** Directories that commonly hold a DSH installation on each platform. */
const CANDIDATES = [
  process.env.DSH_INSTALL_ROOT,
  'E:/AI/dsh/DSH Desktop/resources/app',
  'C:/Program Files/DSH Desktop/resources/app',
  '/Applications/DSH Desktop.app/Contents/Resources/app',
  '/opt/dsh/resources/app',
].filter((entry) => typeof entry === 'string' && entry.length > 0)

/** Locate `@deepseek-ai` inside a DSH installation. */
function findPackages() {
  for (const root of CANDIDATES) {
    const packages = join(root, 'node_modules', '@deepseek-ai')
    if (existsSync(join(packages, 'cordis', 'lib', 'index.js'))) return packages
  }
  return undefined
}

const packages = findPackages()
if (packages === undefined) {
  console.error(
    'SKIPPED: no DSH installation found. Set DSH_INSTALL_ROOT to the app directory\n'
    + 'that contains node_modules/@deepseek-ai, or run test/smoke.mjs instead.',
  )
  process.exit(0)
}

const { Context } = await import(pathToFileURL(join(packages, 'cordis', 'lib', 'index.js')).href)
const { default: CommandRuntime } = await import(pathToFileURL(join(packages, 'dsh-commands', 'lib', 'index.js')).href)

/** Stand-in for the subagent service: records activations, reports one provider. */
function subagentService() {
  const activations = []
  return {
    activations,
    getProvider: (providerName) => (providerName === 'spawn' ? { name: 'spawn' } : undefined),
    list: () => ['spawn'],
    async startActivation(spec) {
      activations.push(spec)
      return { childId: 'child-0123456789abcdef', messageId: 'msg-1' }
    },
  }
}

/** A context with the services this plugin needs, plus the real commands row. */
function runtime() {
  const ctx = new Context()
  const subagents = subagentService()
  ctx.provide('subagents', subagents)
  ctx.provide('workingDirectory', { ensure: async () => process.cwd() })
  // CommandRuntime provides `ctx.commands` itself, so it must not be provided twice.
  return { ctx, subagents, commands: new CommandRuntime(ctx) }
}

// --- the command registers through real inject gating -----------------------

const { ctx, subagents, commands } = runtime()
const fiber = ctx.plugin({ name, inject, apply })
await fiber

const agent = { id: 'session-live', steer() {} }
const descriptors = await commands.list(agent)
const found = descriptors.find((entry) => entry.name === COMMAND_NAME)
assert.ok(found !== undefined, '/agentinit is listed by the real command registry')
assert.ok(found.description.length > 0, 'the descriptor carries a description')
assert.ok(found.input?.hint.length > 0, 'the descriptor carries an input hint')
console.log('ok  real command registry lists /agentinit')

// --- executing the line starts a real activation ---------------------------

// `execute` logs a `command/run` / `command/done` pair to the agent's session,
// so the test agent needs the append surface that path uses.
const steered = []
const logged = []
const liveAgent = {
  id: 'session-live',
  steer: (message) => steered.push(message),
  session: { append: (type, data) => { logged.push({ type, data }); return { data } } },
}

const execution = await commands.execute(liveAgent, '/agentinit audit this repo', [], new AbortController().signal)
assert.ok(execution !== undefined, 'the line resolves to a command execution')
assert.equal(execution.result.kind, 'success', 'the handler settles as success')

assert.equal(steered.length, 0, 'the main conversation receives no injected instructions')
assert.equal(subagents.activations.length, 1, 'exactly one subagent activation starts')

const spec = subagents.activations[0]
assert.equal(spec.provider, 'spawn', 'the spawn provider is used')
assert.equal(spec.delivery, 'parent', 'the child reports back to this parent')
assert.equal(spec.request.parent.id, 'session-live', 'the calling agent is the parent')
const prompt = spec.request.prompt[0].text
assert.ok(prompt.includes('methodology.md'), 'the child is pointed at the method')
assert.ok(prompt.includes('audit this repo'), 'the input is forwarded')
assert.ok(!prompt.includes('# Writing an AGENTS.md'), 'the method body is not inlined')

assert.equal(logged.length, 2, 'the host logs one run/done pair')
assert.equal(logged[0].type, 'command/run', 'the run is logged before the handler')
assert.equal(logged[1].type, 'command/done', 'the outcome is logged after it')
console.log('ok  /agentinit starts a subagent and injects nothing into the conversation')

// --- a bare invocation still works ----------------------------------------

const bare = await commands.execute({
  id: 'session-bare',
  steer: () => {},
  session: { append: (type, data) => ({ data }) },
}, '/agentinit', [], new AbortController().signal)
assert.equal(bare.result.kind, 'success', 'a bare invocation succeeds')
assert.equal(subagents.activations.length, 2, 'a second activation starts')
console.log('ok  a bare /agentinit starts a subagent')

// --- a wrong config fails the mount ---------------------------------------

{
  const second = runtime()
  await assert.rejects(
    async () => { await second.ctx.plugin({ name, inject, apply }, { provider: 1 }) },
    /agents-init: /,
    'an invalid config fails activation',
  )
  console.log('ok  invalid config fails activation on the real runtime')
}

// --- disposal unregisters -------------------------------------------------

await fiber.dispose?.()
const afterDispose = await commands.list(agent)
assert.equal(afterDispose.some((entry) => entry.name === COMMAND_NAME), false, 'disposal unregisters the command')
console.log('ok  disposal unregisters the command')

console.log('\nall runtime checks passed')
