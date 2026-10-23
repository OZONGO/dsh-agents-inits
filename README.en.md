# dsh-agents-init

Runs the whole "write AGENTS.md" job inside a subagent. The main conversation issues one command and receives one report — **the instruction body never enters it at all**.

English | [中文](README.md)

## How the zero-context path works

A skill normally has to be loaded into the model's context before the model can follow it — that loading is the cost. This plugin skips that step:

```
user types /agentinit
      ↓
the command handler calls ctx.subagents.startActivation() directly
      ↓
the child reads references/methodology.md in its own context and works
      ↓
the child finishes; its report returns as a subagent-settled notice that wakes the parent
```

The key point: **the command handler is host code, not the model.** It spawns a child directly, and the child reads the method itself. The main window never sees a single instruction.

| | A traditional skill | This plugin |
|---|---|---|
| Enters the main window on activation | the whole body (thousands of tokens) | **0** |
| Who reads the method | the main model | the subagent |
| What the main window pays | body + tool trace + report | **one receipt + the report** |

This is not "write the skill shorter" — it is keeping it out of the context entirely.

## Usage

```
/agentinit                          # start
/agentinit audit this repo          # your request, forwarded verbatim to the child
```

The command returns one line immediately:

> Started an AGENTS.md subagent (child-0123456). Its report will arrive when it finishes; this conversation stays out of the work until then.

The report arrives automatically when the child settles. **The main conversation is free to do other work meanwhile** — it is not blocked.

## Install

```bash
plugin_manager  action=install_bundle  target=<absolute path to this directory>
```

The bundle inserts one Host row (`skill-agents-init`). Its `index.js` imports **only Node builtins**, so it activates in any profile without peer resolution against `@deepseek-ai/*` packages.

## Config

All fields optional. Unknown fields and wrong types fail activation loudly.

| Field | Default | Meaning |
|---|---|---|
| `provider` | `spawn` | Subagent backend name. `spawn` is the in-process implementation `dsh-base` mounts. |
| `agentPreset` | `""` | Agent preset for the child; empty inherits the parent's. |
| `allowMethodEdit` | `true` | Whether the child may correct the method file when a run proves a rule wrong. |
| `activationNote` | `""` | Extra guidance appended to every run. |

```yaml
- id: skill-agents-init
  name: dsh-agents-init
  config:
    provider: spawn
```

An unknown `provider` fails the command immediately and lists the backends that are actually mounted, rather than failing silently.

## Files

| File | Role |
|---|---|
| `index.js` | Host plugin: the `/agentinit` command, which spawns a subagent directly. |
| `references/methodology.md` | The method. **Read only by the subagent**, never by the main window. |
| `cordis.patch.yml` | Bundle patch inserting the Host row. |
| `scripts/agents_md.py` | Read-only checker for commands and paths (`sections`, `check`, `stats`). |
| `locale/en.json`, `locale/zh.json` | Plugin Manager display metadata. |
| `test/smoke.mjs` | Offline contract checks against a fake context. |
| `test/runtime.mjs` | Mounts on the real Cordis runtime and drives the real commands service. |

Run the tests with plain Node — no dependencies:

```bash
node test/smoke.mjs
node test/runtime.mjs
```

`test/runtime.mjs` needs a DSH installation. It searches common locations and honours `DSH_INSTALL_ROOT`; when it finds none it prints SKIPPED and exits 0.

## Why there is no SKILL.md

An earlier version was a skill plus a `/agentinit` command. The skill path had a problem: `SKILL.md` must be injected into the main window to take effect, and those 686 tokens were paid on every run.

The plugin no longer registers a skill provider, and `SKILL.md` is gone. The method exists as one copy (`references/methodology.md`) with one reader (the subagent). The trade: the model can no longer *discover* this capability on its own — only your `/agentinit` triggers it. That is the intended trade.

## Known boundaries

**The production is isolated, not the product.** Once written into a repository, `AGENTS.md` is injected automatically by `dsh-agent-instructions`, which treats `AGENTS.md` / `CLAUDE.md` as candidates and loads the whole chain from the project root down to the session working directory. A subagent spares you the cost of reading a repository, but the file it produces still enters every request by design. That is the AGENTS.md trade: a small file, paid for on every request, to keep each request correct.

**Editing this plugin needs a host restart.** Node's ESM has no module-cache invalidation, so re-enabling the plugin reuses the module already loaded in the process. After changing `index.js`, restart DSH rather than toggling the plugin. `references/methodology.md` is unaffected — it is re-read on every run.
