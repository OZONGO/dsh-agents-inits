#!/usr/bin/env python3
"""Deterministic helpers for AGENTS.md work.

Subcommands, all read-only:

  sections <file>             Parse a markdown file into its heading sections.
  check <file> [--root DIR]   Verify every command and path the file mentions.
  stats <file>                Size, per-section weight, and configuration smells.

What to write is a judgment call and belongs to the model. This script only
settles questions that have exact answers, so nothing gets guessed at twice.
"""

import argparse
import difflib
import json
import re
import shutil
import sys
from pathlib import Path

BT = chr(96)
HARD_CAP = 150      # above this, the report must justify every line
RECOMMENDED = (60, 100)
NL = chr(10)
CJK_LO = chr(0x4E00)
CJK_HI = chr(0x9FFF)

FENCE = re.compile("^ *(" + BT * 3 + "|~~~)")
HEADING = re.compile(r"^(#{1,6}) +(.*?) *#* *$")
INLINE = re.compile(BT + "([^" + BT + NL + "]+)" + BT)
ENV_ASSIGN = re.compile(r"^(?:[A-Za-z_][A-Za-z0-9_]*=[^ ]* +)+")
ENV_PREFIX = re.compile(r"^(?:sudo|time|nohup|env) +")
SPLITTER = re.compile(r"[&|;]{1,2}")

PKG_MANAGERS = {"npm", "pnpm", "yarn", "bun"}
RUN_WORDS = {"run", "run-script"}
NON_SCRIPT_WORDS = {
    "exec", "dlx", "x", "create", "install", "add", "remove", "rm", "i",
    "ci", "update", "up", "link", "unlink", "publish", "pack", "init", "why",
    "list", "ls", "outdated", "audit", "config", "store", "prune", "global",
    "login", "logout", "workspace", "workspaces", "env", "cache", "patch",
}
BINARIES = {
    "make", "just", "cargo", "go", "python", "python3", "uv", "poetry", "hatch",
    "tox", "nox", "pytest", "ruff", "black", "mypy", "flake8", "isort",
    "eslint", "prettier", "biome", "tsc", "jest", "vitest", "mocha",
    "playwright", "cypress", "gradle", "mvn", "dotnet", "bundle", "rake",
    "rspec", "rubocop", "mix", "php", "composer", "swift", "xcodebuild",
    "cmake", "ninja", "bazel", "docker", "docker-compose", "terraform", "helm",
    "kubectl", "deno", "node", "bunx", "npx", "turbo", "nx", "golangci-lint",
    "gofmt", "gofumpt", "staticcheck", "clippy", "rustfmt", "pre-commit",
    "husky", "act", "gh", "git", "task", "mage", "buf", "protoc", "air",
}

# Commands that change the repo just by running. Naming them without saying
# what they do is a half-fact, so the checker surfaces them for review.
RISKY = {
    "install": "may rewrite a committed lockfile",
    "ci": "may rewrite a committed lockfile",
    "migrate": "changes data and may be irreversible",
    "seed": "changes data",
    "reset": "destroys state",
    "publish": "publishes outside this machine",
    "deploy": "deploys outside this machine",
    "release": "publishes outside this machine",
}

LINT_LEAKAGE = [
    "single quote", "double quote", "semicolon", "trailing comma",
    "line length", "line width", "prefer const", "camelcase", "snake_case",
    "pascalcase", "alphabetize import", "sort import", "tabs vs spaces",
    "use 2 spaces", "use 4 spaces", "no unused", "eslint", "prettier",
    "ruff", "gofmt", "biome", "max-len",
]
GENERIC_ADVICE = [
    "write tests", "write unit tests", "meaningful name", "helpful error message",
    "clean code", "best practice", "good practice", "dry ", "solid principle",
    "keep it simple", "add comments", "proper error handling", "code quality",
    "ensure quality", "be careful", "think step by step", "don't repeat yourself",
]
# Signals that a line describes something MISSING rather than instructing a style.
# Deliberately excludes a bare "no X", because "no semicolons" is a style rule.
ABSENCE = re.compile(
    r"(not installed|isn't installed|are not installed|not declared|not configured|"
    r"is not configured|there is no|there are no|none of|is absent|are absent|"
    r"is missing|are missing|is broken|are broken|\bfails?\b|\bfailing\b|"
    r"not found|command not found|no longer exists)",
    re.I,
)
OVERVIEW_HEADINGS = re.compile(
    r"(overview|about|introduction|what is|purpose|project description|"
    r"architecture|project structure|directory structure|repository structure|"
    r"repo structure|tech stack|technology stack|getting started|introduction)",
    re.I,
)


def read(path):
    return Path(path).read_text(encoding="utf-8", errors="replace")


def parse_sections(text):
    lines = text.splitlines()
    sections = []
    cur = {"level": 0, "title": "(preamble)", "start": 1, "end": 1, "lines": []}
    in_fence = False
    for i, line in enumerate(lines, 1):
        if FENCE.match(line):
            in_fence = not in_fence
            cur["lines"].append(line)
            continue
        if not in_fence:
            m = HEADING.match(line)
            if m:
                cur["end"] = i - 1
                sections.append(cur)
                cur = {
                    "level": len(m.group(1)),
                    "title": m.group(2).strip(),
                    "start": i,
                    "end": i,
                    "lines": [],
                }
                continue
        cur["lines"].append(line)
    cur["end"] = len(lines)
    sections.append(cur)
    for s in sections:
        body = NL.join(s["lines"]).strip()
        s["body_lines"] = max(0, s["end"] - s["start"])
        s["chars"] = len(body)
        s["text"] = body
        del s["lines"]
    return [s for s in sections if s["title"] != "(preamble)" or s["chars"] > 0]


def cmd_sections(args):
    secs = parse_sections(read(args.file))
    if args.json:
        print(json.dumps([{k: v for k, v in s.items() if k != "text"} for s in secs], indent=2))
        return 0
    print(str(len(secs)) + " section(s) in " + args.file)
    for s in secs:
        pad = "  " * max(0, s["level"] - 1)
        print(
            pad + "#" * s["level"] + " " + s["title"]
            + "   [lines " + str(s["start"]) + "-" + str(s["end"])
            + ", " + str(s["chars"]) + " chars]"
        )
    return 0


def split_commands(span):
    out = []
    for part in SPLITTER.split(span):
        part = part.strip()
        part = ENV_ASSIGN.sub("", part)
        part = ENV_PREFIX.sub("", part)
        if part:
            out.append(part)
    return out


def find_up(start, names):
    here = Path(start).resolve()
    for d in [here] + list(here.parents):
        for n in names:
            f = d / n
            if f.exists():
                return f
    return None


def binary_note(name):
    if shutil.which(name):
        return ("ok", name + " on PATH")
    return ("warn", name + " not on PATH here (may exist in CI)")


def find_workspace_package(name, root):
    """Resolve a workspace package name to its package.json."""
    for child in sorted(Path(root).rglob("package.json")):
        if "node_modules" in child.parts:
            continue
        try:
            if json.loads(read(child)).get("name") == name:
                return child
        except Exception:
            continue
    return None


def verify_pkg_script(pm, rest, root):
    # pnpm --filter <pkg> <script> / npm -w <pkg> run <script>.
    # Scan the raw tokens first, because the scope flag starts with a dash.
    scope = None
    skip_next = False
    kept = []
    for i, t in enumerate(rest):
        if skip_next:
            skip_next = False
            continue
        if t in ("--filter", "-F", "-w", "--workspace") and i + 1 < len(rest):
            scope = rest[i + 1]
            skip_next = True
            continue
        if t.startswith("-"):
            continue
        kept.append(t)
    args = kept
    if scope:
        sub = find_workspace_package(scope, root)
        if sub is None:
            return ("missing", 'no workspace package named "' + scope + '"')
        pkg = sub
        if not args:
            return ("ok", "workspace package " + scope + " exists")
        if args[0] in RUN_WORDS:
            args = args[1:]
        script = args[0] if args else None
    else:
        if not args:
            return binary_note(pm)
        if args[0] in RUN_WORDS:
            args = args[1:]
        if not args or args[0] in NON_SCRIPT_WORDS:
            return binary_note(pm)
        script = args[0]
        pkg = find_up(root, ["package.json"])
    if pkg is None:
        return ("skip", "no package.json found")
    try:
        data = json.loads(read(pkg))
    except Exception:
        return ("skip", str(pkg) + " is not valid JSON")
    scripts = data.get("scripts") or {}
    if script in scripts:
        return ("ok", 'script "' + script + '" in ' + pkg.name)
    near = difflib.get_close_matches(script, list(scripts), n=1)
    hint = ' (closest: "' + near[0] + '")' if near else ""
    return ("missing", 'no script "' + script + '" in ' + pkg.name + hint)


def verify_make(rest, root):
    args = [t for t in rest if not t.startswith("-")]
    mk = find_up(root, ["Makefile", "makefile", "GNUmakefile"])
    if mk is None:
        return ("skip", "no Makefile found")
    if not args:
        return ("ok", "default target in " + mk.name)
    target = args[0]
    if re.search(r"^" + re.escape(target) + r" *:(?!=)", read(mk), re.M):
        return ("ok", 'target "' + target + '" in ' + mk.name)
    return ("missing", 'no target "' + target + '" in ' + mk.name)


def verify_command(cmd, root):
    toks = cmd.split()
    if not toks:
        return ("skip", "empty")
    head = toks[0]
    base = head.rsplit("/", 1)[-1]
    if head.startswith("./") or head.startswith("../"):
        p = (Path(root) / head).resolve()
        if p.exists():
            return ("ok", head + " exists")
        return ("missing", head + " does not exist")
    if base in PKG_MANAGERS:
        return verify_pkg_script(base, toks[1:], root)
    if base == "make":
        return verify_make(toks[1:], root)
    if base in BINARIES:
        return binary_note(base)
    return ("skip", "not a recognised command")


NEGATION = re.compile(
    r"(\bthere is no\b|\bthere are no\b|\bdoes not exist\b|\bdoesn't exist\b|"
    r"\bnot present\b|\bnot installed\b|\bnot found\b|\bcommand not found\b|"
    r"\babsent\b|\bmissing\b|\bnever created\b|\bdo not create\b|\bdon't create\b|"
    r"\bis not a\b|\bnot a git\b)", re.I)


def is_negated(text, lineno):
    """True when the line asserts the path does NOT exist."""
    lines = text.splitlines()
    if 1 <= lineno <= len(lines):
        return bool(NEGATION.search(lines[lineno - 1]))
    return False


def looks_like_path(span):
    s = span.strip()
    if not s or " " in s:
        return None
    if s.startswith(("http://", "https://", "-", "$", "<", "~")):
        return None
    if "*" in s or "?" in s or "{" in s:
        return None
    if s.startswith("@"):
        s = s[1:]
    if s.startswith("/") or "://" in s:
        return None
    has_slash = "/" in s
    has_ext = bool(re.search(r"[.][A-Za-z][A-Za-z0-9]{0,7}$", s))
    return s if (has_slash or has_ext) else None


def collect_spans(text):
    spans = []
    in_fence = False
    for i, line in enumerate(text.splitlines(), 1):
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            s = line.strip()
            if s and not s.startswith("#"):
                spans.append((i, s))
            continue
        for m in INLINE.finditer(line):
            spans.append((i, m.group(1)))
    return spans


def cmd_check(args):
    text = read(args.file)
    root = Path(args.root).resolve()
    rows = []
    skipped = []
    seen_cmd = set()
    seen_path = set()
    for lineno, span in collect_spans(text):
        # A bare path like scripts/build.sh is a path, not a command to resolve.
        p = looks_like_path(span)
        if p and p not in seen_path:
            seen_path.add(p)
            target = (root / p).resolve()
            exists = target.exists()
            if exists:
                status, note = "ok", "exists"
            elif is_negated(text, lineno):
                # "there is no turbo.json" is a correct claim, not a broken link.
                status, note = "ok", "absent, as the file states"
            else:
                status, note = "missing", "does not exist"
            rows.append({"line": lineno, "kind": "path", "ref": p,
                         "status": status, "note": note})
        for cmd in split_commands(span):
            if cmd in seen_cmd:
                continue
            seen_cmd.add(cmd)
            status, note = verify_command(cmd, root)
            if status == "skip":
                if p:
                    continue  # already reported as a path above
                skipped.append({"line": lineno, "ref": cmd, "note": note})
                continue
            rows.append({"line": lineno, "kind": "command", "ref": cmd,
                         "status": status, "note": note})
    if args.json:
        print(json.dumps({"checked": rows, "skipped": skipped}, indent=2))
        return 1 if any(r["status"] == "missing" for r in rows) else 0
    bad = [r for r in rows if r["status"] == "missing"]
    warn = [r for r in rows if r["status"] == "warn"]
    ok = [r for r in rows if r["status"] == "ok"]
    risky = [r for r in rows if r["kind"] == "command"
             and any(w in r["ref"].split() for w in RISKY)]
    print(str(len(rows)) + " verified: "
          + str(len(ok)) + " ok, " + str(len(warn)) + " warn, "
          + str(len(bad)) + " missing"
          + "   |   " + str(len(skipped)) + " not verifiable")
    for label, group in (("MISSING", bad), ("WARN", warn)):
        if not group:
            continue
        print(NL + label)
        for r in group:
            print("  line " + str(r["line"]).ljust(5) + r["kind"].ljust(9) + r["ref"])
            print("  " + " " * 10 + r["note"])
    if risky:
        print(NL + "SIDE EFFECTS - say what these do to the repo, not just that they run")
        for r in risky:
            words = [w for w in r["ref"].split() if w in RISKY]
            print("  line " + str(r["line"]).ljust(5) + r["ref"])
            print("  " + " " * 10 + RISKY[words[0]])
    if skipped and args.verbose:
        print(NL + "NOT VERIFIABLE")
        for s in skipped:
            print("  line " + str(s["line"]).ljust(5) + s["ref"])
            print("  " + " " * 10 + s["note"])
    elif skipped:
        print(NL + "Note: " + str(len(skipped))
              + " command(s) could not be verified automatically "
              + "(rerun with --verbose to list them).")
    return 1 if bad else 0


def estimate_tokens(text):
    cjk = sum(1 for ch in text if CJK_LO <= ch <= CJK_HI)
    return int(cjk / 1.5 + (len(text) - cjk) / 4)


def cmd_stats(args):
    text = read(args.file)
    lines = text.splitlines()
    tokens = estimate_tokens(text)
    secs = parse_sections(text)

    if args.json:
        print(json.dumps({
            "lines": len(lines),
            "words": len(text.split()),
            "tokens": tokens,
            "sections": [{k: v for k, v in s.items() if k != "text"} for s in secs],
        }, indent=2))
        return 0

    print("File     " + args.file)
    print("Lines    " + str(len(lines)))
    print("Words    " + str(len(text.split())))
    print("Tokens   ~" + str(tokens))
    print()
    print("Sections by weight")
    for s in sorted(secs, key=lambda x: -x["chars"])[:10]:
        print("  " + str(s["chars"]).rjust(6) + " chars  "
              + str(s["body_lines"]).rjust(4) + " lines   "
              + "#" * s["level"] + " " + s["title"])

    findings = []
    for i, line in enumerate(lines, 1):
        low = line.lower()
        # Naming a tool because it is missing or broken is a gotcha, not a rule.
        # Only flag a linter when the line reads like an instruction about style.
        if is_negated(text, i) or ABSENCE.search(low):
            continue
        if any(p in low for p in LINT_LEAKAGE):
            findings.append(("lint-leakage", i, line.strip()[:90]))
        elif any(p in low for p in GENERIC_ADVICE):
            findings.append(("generic-advice", i, line.strip()[:90]))
    for s in secs:
        if s["title"] != "(preamble)" and OVERVIEW_HEADINGS.search(s["title"]):
            findings.append(("repo-overview", s["start"], s["title"]))

    print()
    print("Smell candidates")
    if not findings:
        print("  none detected")
    for kind, line, snippet in findings:
        print("  " + kind.ljust(16) + "line " + str(line).ljust(5) + snippet)

    print()
    n = len(lines)
    if n > HARD_CAP:
        print("Size     OVER BUDGET - " + str(n) + " lines, hard cap is "
              + str(HARD_CAP) + " (" + str(n - HARD_CAP) + " over)")
        print("         Every over-budget line must be justified in the report, or")
        print("         this run has failed. Default is to move detail to agents-docs/.")
        return 2
    if RECOMMENDED[0] <= n <= RECOMMENDED[1]:
        print("Size     " + str(n) + " lines - inside the recommended "
              + str(RECOMMENDED[0]) + "-" + str(RECOMMENDED[1]) + " range")
    else:
        print("Size     " + str(n) + " lines - within the "
              + str(HARD_CAP) + "-line cap, outside the recommended "
              + str(RECOMMENDED[0]) + "-" + str(RECOMMENDED[1]) + " range")
    return 0


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sections", help="list heading sections")
    s.add_argument("file")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_sections)
    c = sub.add_parser("check", help="verify commands and paths")
    c.add_argument("file")
    c.add_argument("--root", default=".")
    c.add_argument("--json", action="store_true")
    c.add_argument("--verbose", action="store_true",
                   help="list commands that could not be verified")
    c.set_defaults(func=cmd_check)
    t = sub.add_parser("stats", help="size and smell report")
    t.add_argument("file")
    t.add_argument("--json", action="store_true")
    t.set_defaults(func=cmd_stats)
    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())