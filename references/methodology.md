# Writing an AGENTS.md

This is the method. It is loaded into the subagent doing the work, so the main conversation never pays for it.

`<checker>` below stands for the checker script's absolute path, which the prompt that sent you here provides. It is read-only and standard-library only.

## The filter

Every line has to answer one question:

> **Would a competent agent, dropped into this repo cold, get this wrong without being told?**

If not, cut the line. This removes the framework name already in `package.json`, the directory tree `ls` reveals, and advice like "write clean code".

The corollary matters as much: **if you cannot verify a claim, you cannot write it.** An agent executes commands it finds here, so an invented command is not harmless prose — it is a wrong action repeated on every task.

## Budget

**Hard cap: 150 lines. Recommended: 60-100.**

A ceiling, not a target. A file that lands at 40 lines because the repo has little non-obvious to say is correct; one that lands at 140 because sections were filled in is not.

Over 150 is allowed only when the evidence demands it, and then the report must enumerate, line by line, which content is indispensable and why it cannot move behind an `agents-docs/` pointer. **An undeclared overage is a failed run.** Every line is paid for on every request, forever.

## Two modes

- **Build** — no AGENTS.md, or the existing one is thin. Run the workflow below.
- **Audit** — one exists and the question is whether it is still true. Skip to *Auditing*.

Decide which before anything else; they have different endings.

## Workflow

### 1. Look first

- Does `AGENTS.md` exist at the root? Is there an older instruction file — `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/`, `.github/copilot-instructions.md` — left over from another tool?
- Single package, monorepo, or several independent projects?
- What language does the existing documentation use?

An older instruction file is a **source, not a competitor**. Real knowledge trapped in it belongs in `AGENTS.md` — migrate it, then leave the original in place.

### 2. Mine for traps

Read for traps, not for an inventory:

- `README.md` and `CONTRIBUTING.md`
- Manifests and lockfiles — the real package manager, not the guessed one
- Build, test, lint, typecheck, and codegen config
- CI workflows and pre-commit hooks — these encode what "done" means
- Git history for commit and PR conventions, when consistent enough to be a rule

**Prefer executable sources of truth over prose.** If the README says `npm test` but the lockfile and CI both say `pnpm`, the executable source wins.

### 3. Ground every command

```bash
python "<checker>" check AGENTS.md --root .
```

It resolves package-manager scripts against the real manifest, `make` targets against the real Makefile, binaries against `PATH`, and paths against the filesystem — and names the closest real script when one is misspelled (`pnpm testt` becomes "did you mean `test`?").

**Anything reported missing gets fixed or removed. Anything unverifiable becomes a TODO, never a confident claim.**

### 4. Write the file

The table is a **list of questions, not a template**. For each row ask "do I have verified, non-obvious evidence?" Write the section only when yes. An empty `## Project Structure` heading teaches nothing and costs tokens on every request.

| Section | Include when |
|---|---|
| Commands | You verified build / test / lint / run. Almost always worth it. |
| Testing notes | Tests need special invocation, ordering, fixtures, or isolation. |
| Architecture that bites | A real trap in how pieces fit — not a directory tree. |
| Conventions | Rules no tool enforces. Anything a linter handles belongs in the linter. |
| Gotchas | Known footguns: the flaky test, the generated file, the migration that must run first. |
| PR / commit rules | The team enforces something specific. |
| Security / never-touch | Hard constraints. Always include if they exist. |
| `agents-docs/` pointers | Detail is needed but too long for the root file. |

Deliberately absent: **project overview, tech stack, directory structure.** An agent can read `package.json` itself at no cost; a stale copy costs tokens forever.

Write in the language the repo documents in — existing instruction files, then `CONTRIBUTING.md`, then `README.md`, then commit messages. When the repo is public and its contribution docs are English, prefer English.

### Where a line belongs

**Assume detail does not belong in the root file.** Before adding any line:

> **Must this be loaded on every single request?**

If no, its home is `agents-docs/` or a module-level file. The root file is for facts that apply to every task; everything narrower is a pointer. "Move it out when it gets too long" gets the default wrong — by then the file is already bloated and cutting is harder than never adding.

So: filter first (would an agent get this wrong?), then place (does it apply to every task?). A line that survives the filter but applies only to `src/api/` belongs in a pointer.

```markdown
Testing conventions: @agents-docs/testing.md - read before changing anything under src/api/.
```

`@` expansion is not guaranteed, so the sentence after the pointer must stand alone — it carries the reason to read the file even if the import never resolves.

**The exception runs the other way.** A few narrow things must stay in the root file, because a pointer to an unread file fails silently and the cost of missing them is severe: safety constraints, never-touch paths, required processes. Those are the lines worth the budget.

If the repo has nothing non-obvious to say, **still write the minimal skeleton** — title, verified commands, TODO block. An empty-handed exit leaves nothing to react to; eighty lines of correct filler is worse.

### 5. Report

- What you wrote, and why each section earned its place
- **What you deliberately left out**, so it reads as a decision, not an oversight
- What you could not verify and turned into TODOs
- Line count and rough token cost

A handful of lines. The file is the deliverable; the summary is how the user checks your judgement without reading every line.

## Handling an existing AGENTS.md

Merge by default. Merging only adds and updates, so it is non-destructive.

```bash
python "<checker>" sections AGENTS.md
```

Match headings semantically, not by exact string — "Testing" and "How to run tests" are the same section. For each section decide: keep, extend, correct, or leave alone. **Only add and update. Never delete or reorder what the user wrote.**

Replace wholesale only when explicitly asked. Back up first (`AGENTS.md.bak-YYYY-MM-DD`) and say where the backup is — a rewrite is the one irreversible action here.

The exception is an explicit cleanup request ("this is bloated, cut it down"). Then removals are in scope, but list every removed line in the report. Deleting unasked is the failure; deleting on request and hiding it is the same failure wearing a hat.

If a new section cannot map onto an existing one, append it at the end as a clearly separate block rather than restructuring the document.

## Auditing

The checker works standalone on a file you did not write:

```bash
python "<checker>" check AGENTS.md --root .   # broken commands and paths
python "<checker>" stats AGENTS.md            # size, section weight, smells
```

`stats` flags lint leakage (rules a linter already enforces), generic advice, repo-overview sections, and files that have outgrown the comfort zone.

Corrections to content that is provably wrong are fair game to apply directly — a broken command left in place is worse than a fix. **Deletions need a reason**: the user asked for cleanup, or the section is provably false. Never delete a preference or a human's note because it scored badly on a heuristic.

## Side effects

Knowing a command exists is not knowing what it does. Some change the repo just by running:

- `install` / `ci` can rewrite a committed lockfile
- `migrate`, `seed`, `reset` can destroy data
- `publish`, `deploy`, `release` leave the machine
- `codegen`, `sync` can touch tracked files

When you document one, say what it does to the repo. "Runs `pnpm install`" is half a fact; "`pnpm install` rewrites the committed lockfile even with `--frozen-lockfile`" is the half that prevents a polluted diff. If you ran one during discovery, restore the repo before finishing and say so.

## TODOs

Mark what you could not verify so it can be found later:

```markdown
<!-- agents-init: TODO verify this command -->
```

Never use a TODO to hide a guess.

## Anti-patterns

- **Writing an unverified command.** The agent will run it. The most damaging mistake available here.
- **Generating a project overview or directory listing.** Popular, vendor-recommended, unhelpful.
- **Restating what a linter enforces.** It drifts, and the tool already fails the build.
- **Filling a template.** A heading with no evidence is a tax on every future request.
- **Overwriting human writing.** Merge, or back up.
- **Burying critical constraints in `agents-docs/`.** If it must be obeyed, it must be read.

## The checker

`scripts/agents_md.py` is read-only and standard-library only:

| Command | Answers |
|---|---|
| `sections <file>` | What sections exist, with line ranges and weights — for section-level merging |
| `check <file> --root DIR` | Does every command and path actually exist, and which have side effects |
| `stats <file>` | Size, token estimate, heaviest sections, smell candidates |
