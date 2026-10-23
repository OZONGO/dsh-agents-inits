/**
 * `dsh-agents-init` — the AGENTS.md authoring workflow, packaged as a DeepSeek
 * Harness plugin with a `/agentinit` command.
 *
 * The command **spawns a subagent directly** through `ctx.subagents`, so no
 * instruction body ever enters the main conversation. The main window pays for
 * the command's one-line result and the child's final report — nothing else.
 * The child reads `references/methodology.md` itself, in its own context.
 *
 * This is deliberately not a skill: a skill would have to be loaded into the
 * calling model's context first, which is exactly the cost this plugin exists
 * to avoid.
 *
 * The method file is re-read on every run, so editing it takes effect on the
 * next invocation without restarting the host. This module imports only Node
 * builtins, so it activates in any profile regardless of peer resolution.
 *
 * @module dsh-agents-init
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin identity used in diagnostics. */
export const name = 'agents-init'

/** Services this plugin cannot work without. */
export const inject = ['subagents']

/** Slash command that runs the workflow. */
const COMMAND_NAME = 'agentinit'

/** The method the child follows. */
const METHOD_FILE = fileURLToPath(new URL('./references/methodology.md', import.meta.url))
const METHOD_DIR = dirname(dirname(METHOD_FILE)).split(sep).join('/')
const CHECKER = join(dirname(METHOD_FILE), '..', 'scripts', 'agents_md.py').split(sep).join('/')

/** User-facing config with its types, which double as the validator. */
const DEFAULTS = {
  /** Subagent provider name; `spawn` is the in-process backend `dsh-base` mounts. */
  provider: 'spawn',
  /** Optional agent preset for the child; empty inherits the parent's. */
  agentPreset: '',
  /** Tell the child it may edit the method file, and where it is. */
  allowMethodEdit: true,
  /** Extra guidance appended to every run; empty means none. */
  activationNote: '',
}

/**
 * Validate the row's config without pulling in a schema library.
 * @param raw - the loader-supplied config, possibly absent.
 * @returns the resolved config.
 */
function resolveConfig(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('agents-init: config must be an object')
  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`agents-init: unknown config field "${key}"`)
    if (typeof value !== typeof DEFAULTS[key]) {
      throw new Error(`agents-init: config field "${key}" must be a ${typeof DEFAULTS[key]}`)
    }
    config[key] = value
  }
  return config
}

/**
 * Read the method file's first heading, so a broken file fails the command
 * loudly instead of handing the child a path to nothing.
 * @returns the method file's text.
 */
function readMethod() {
  const text = readFileSync(METHOD_FILE, 'utf8')
  if (text.trim().length === 0) throw new Error(`agents-init: ${METHOD_FILE} is empty`)
  return text
}

/**
 * Build the child's prompt. The method is referenced, never inlined: the child
 * reads it in its own context.
 * @param config - resolved config.
 * @param request - the user's own words, verbatim.
 * @returns the prompt text.
 */
function buildPrompt(config, request) {
  const lines = [
    `Write AGENTS.md for the repository at ${'[the working directory]'}.`,
    '',
    `Read ${METHOD_DIR}/references/methodology.md first and follow it exactly. It defines the filter every line must pass, the 150-line ceiling, how to verify commands with ${CHECKER}, how to merge into an existing AGENTS.md without deleting what a human wrote, and how to report.`,
    '',
  ]
  if (request.length > 0) {
    lines.push(`The user asked: ${request}`, '')
  }
  lines.push(
    'Rules:',
    '- Work only inside the working directory you were given.',
    '- You cannot ask the user anything. When a decision is genuinely ambiguous, take the conservative option - add rather than delete, mark unverifiable lines as TODOs - and say what you would have asked.',
    '- Never invent a command. Anything you cannot verify becomes a TODO comment.',
  )
  if (config.allowMethodEdit) {
    lines.push(
      `- You may edit ${METHOD_DIR}/references/methodology.md if this run proves a rule in it wrong; keep its structure intact and say what you changed.`,
    )
  } else {
    lines.push('- Do not modify the method file. Report the change you would make instead.')
  }
  if (config.activationNote.length > 0) lines.push('', config.activationNote)
  lines.push(
    '',
    'Report back: what you wrote or changed, what you deliberately left out and why, what you could not verify, the final line count, and the checker output.',
  )
  return lines.join('\n')
}

/**
 * Run the workflow in a subagent.
 * @param ctx - context carrying the subagent service and working directory.
 * @param config - resolved config.
 * @param invocation - the command invocation.
 * @returns the human-facing command result.
 */
async function run(ctx, config, invocation) {
  const { agent, rawInput, signal } = invocation

  // Fail here, not in the child, when the method file is missing or empty.
  try {
    readMethod()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `Cannot run: ${detail}` }
  }

  const workingDirectory = ctx.get('workingDirectory')
  const cwd = workingDirectory === undefined ? undefined : await workingDirectory.ensure(agent, signal)
  if (signal.aborted) return { kind: 'error', text: 'The /agentinit command was cancelled.' }

  const provider = config.provider
  if (ctx.subagents.getProvider(provider) === undefined) {
    const available = ctx.subagents.list()
    return {
      kind: 'error',
      text: `No subagent provider named "${provider}" is mounted. Available: ${available.length > 0 ? available.join(', ') : 'none'}. Set the provider field to one of those.`,
    }
  }

  const prompt = buildPrompt(config, rawInput.trim())

  let activation
  try {
    activation = await ctx.subagents.startActivation({
      provider,
      label: 'AGENTS.md',
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
        signal,
        ...cwd === undefined ? {} : { cwd },
        ...config.agentPreset.length === 0 ? {} : { agentPreset: config.agentPreset },
      },
      signal,
      delivery: 'parent',
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `Could not start the AGENTS.md subagent: ${detail}` }
  }

  // The child's report returns as a `subagent-settled` notice that wakes this
  // agent, so the command must not wait: waiting would block the turn that
  // could be reading it.
  return {
    kind: 'success',
    text: `Started an AGENTS.md subagent (${activation.childId.slice(0, 8)}). Its report will arrive when it finishes; this conversation stays out of the work until then.`,
  }
}

/**
 * Register the `/agentinit` command.
 * @param ctx - Cordis context.
 * @param rawConfig - the row's `config`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: COMMAND_NAME,
      description: 'Write or audit AGENTS.md in a subagent, keeping this conversation clean',
      input: { hint: '[audit | build | what to change]', attachments: false },
      handler: (invocation) => run(ctx, config, invocation),
    })
  })

  ctx.logger?.info?.(`agents-init: /${COMMAND_NAME} runs ${METHOD_DIR}/references/methodology.md in a "${config.provider}" subagent`)
}

// Exported for tests: the prompt is the contract, so it is asserted directly.
export { buildPrompt, resolveConfig, METHOD_DIR, METHOD_FILE, CHECKER, COMMAND_NAME }
