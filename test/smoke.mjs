/**
 * Contract checks for the plugin, against a fake context: no host, no services.
 *
 * The whole point of this plugin is that no instruction body enters the main
 * conversation, so the tests assert exactly that: the command starts an
 * activation and steers nothing.
 */

import assert from 'node:assert/strict'
import { apply, buildPrompt, resolveConfig, METHOD_DIR, COMMAND_NAME } from '../index.js'

/** Fake context recording registrations and activations. */
function fakeContext({ providers = ['spawn'] } = {}) {
  const record = { commands: [], activations: [], steered: [], injected: [], logs: [] }
  const subagents = {
    getProvider: (providerName) => (providers.includes(providerName) ? { name: providerName } : undefined),
    list: () => [...providers],
    async startActivation(spec) {
      record.activations.push(spec)
      return { childId: 'child-0123456789abcdef', messageId: 'msg-1' }
    },
  }
  const ctx = {
    subagents,
    inject(names, callback) {
      record.injected.push(names)
      callback({ commands: { register(definition) { record.commands.push(definition); return () => {} } } })
    },
    get(service) {
      if (service === 'workingDirectory') return { ensure: async () => 'C:/repo' }
      if (service === 'subagents') return subagents
      return undefined
    },
    logger: { info: (line) => record.logs.push(line), warn: (line) => record.logs.push(line) },
  }
  return { ctx, record }
}

/** One command invocation whose agent records any steer. */
function invocation(rawInput = '') {
  const steered = []
  return {
    steered,
    invocation: {
      commandId: 'cmd-1',
      agent: { id: 'session-1', steer: (message) => steered.push(message) },
      rawInput,
      attachments: [],
      signal: new AbortController().signal,
    },
  }
}

// --- registration -----------------------------------------------------------

const { ctx, record } = fakeContext()
apply(ctx, undefined)

assert.deepEqual(record.injected, [['commands']], 'the command row is injected')
assert.equal(record.commands.length, 1, 'exactly one command is registered')
assert.equal(record.commands[0].name, COMMAND_NAME, 'the command is named agentinit')
assert.equal(record.commands[0].name, 'agentinit', 'the command name is stable')
assert.ok(record.commands[0].description.length > 0, 'the descriptor carries a description')
assert.ok(record.commands[0].input.hint.length > 0, 'the descriptor carries an input hint')
console.log('ok  activation registers exactly one command')

// --- the command spawns a child and steers nothing -------------------------

{
  const { ctx: c, record: r } = fakeContext()
  apply(c, undefined)
  const { steered, invocation: call } = invocation('audit this repo')
  const result = await r.commands[0].handler(call)

  assert.equal(result.kind, 'success', 'the handler reports success')
  assert.equal(r.activations.length, 1, 'exactly one subagent activation starts')
  assert.equal(steered.length, 0, 'NOTHING is steered into the main conversation')

  const spec = r.activations[0]
  assert.equal(spec.provider, 'spawn', 'the default provider is the in-process spawn backend')
  assert.equal(spec.delivery, 'parent', 'the result returns to this parent')
  assert.equal(spec.request.parent.id, 'session-1', 'the calling agent is the parent')
  assert.equal(spec.request.cwd, 'C:/repo', 'the child inherits the working directory')
  assert.equal(spec.label, 'AGENTS.md', 'the child is labelled')
  assert.equal(spec.request.prompt.length, 1, 'one prompt block')
  assert.equal(spec.request.prompt[0].type, 'text', 'the prompt is text')

  const prompt = spec.request.prompt[0].text
  assert.ok(prompt.includes('methodology.md'), 'the prompt points at the method file')
  assert.ok(prompt.includes('audit this repo'), 'the user request is forwarded')
  assert.ok(prompt.includes('Never invent a command'), 'the hard rule survives')
  console.log('ok  /agentinit spawns a subagent and steers nothing into the main window')
}

// --- the instruction body never enters the parent's context ----------------

{
  const { ctx: c, record: r } = fakeContext()
  apply(c, undefined)
  const { steered, invocation: call } = invocation()
  await r.commands[0].handler(call)

  assert.equal(steered.length, 0, 'the parent receives no message from the command')

  // The method body must be referenced, never inlined: inlining would defeat
  // the entire design, because the prompt is part of the parent's tool call.
  const prompt = r.activations[0].request.prompt[0].text
  assert.ok(prompt.length < 1500, `the prompt stays small (was ${prompt.length} chars)`)
  assert.ok(!prompt.includes('# Writing an AGENTS.md'), 'the method body is not inlined')
  assert.ok(!prompt.includes('## Anti-patterns'), 'no method section is inlined')
  console.log('ok  the method body is referenced, never inlined')
}

// --- prompt shape ----------------------------------------------------------

{
  const prompt = buildPrompt({ allowMethodEdit: true, activationNote: '' }, 'make it short')
  assert.ok(prompt.includes(`${METHOD_DIR}/references/methodology.md`), 'the absolute method path is given')
  assert.ok(prompt.includes('You may edit'), 'editing is permitted by default')
  assert.ok(prompt.includes('make it short'), 'the request is included')

  const readOnly = buildPrompt({ allowMethodEdit: false, activationNote: '' }, '')
  assert.ok(readOnly.includes('Do not modify'), 'read-only mode forbids edits')
  assert.ok(!readOnly.includes('The user asked:'), 'no empty request line')

  const noted = buildPrompt({ allowMethodEdit: true, activationNote: 'Use tabs.' }, '')
  assert.ok(noted.includes('Use tabs.'), 'the activation note is appended')
  console.log('ok  the prompt reflects config and request')
}

// --- a missing provider fails before anything starts -----------------------

{
  const { ctx: c, record: r } = fakeContext({ providers: [] })
  apply(c, undefined)
  const { steered, invocation: call } = invocation()
  const result = await r.commands[0].handler(call)
  assert.equal(result.kind, 'error', 'a missing provider is an error')
  assert.ok(result.text.includes('No subagent provider'), 'the error names the problem')
  assert.equal(r.activations.length, 0, 'nothing is started')
  assert.equal(steered.length, 0, 'nothing is steered')
  console.log('ok  a missing provider fails loudly before starting')
}

// --- a failing activation is reported, not thrown --------------------------

{
  const { ctx: c, record: r } = fakeContext()
  c.subagents.startActivation = async () => { throw new Error('persistence unavailable') }
  apply(c, undefined)
  const { invocation: call } = invocation()
  const result = await r.commands[0].handler(call)
  assert.equal(result.kind, 'error', 'a rejected activation becomes an error result')
  assert.ok(result.text.includes('persistence unavailable'), 'the cause is surfaced')
  console.log('ok  a rejected activation becomes an error result')
}

// --- config ----------------------------------------------------------------

{
  const resolved = resolveConfig({ provider: 'fork', allowMethodEdit: false })
  assert.equal(resolved.provider, 'fork', 'provider is honoured')
  assert.equal(resolved.allowMethodEdit, false, 'allowMethodEdit is honoured')
  assert.equal(resolved.agentPreset, '', 'agentPreset defaults to empty')
}
for (const bad of [{ provider: 1 }, { unknown: true }, []]) {
  assert.throws(() => resolveConfig(bad), /agents-init: /, `rejects ${JSON.stringify(bad)}`)
}
console.log('ok  config validates types and rejects unknown fields')

console.log('\nall contract checks passed')
