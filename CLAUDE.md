@AGENTS.md

<!--
This file is deliberately a one-line import, and it must stay that way.

AGENTS.md is the ROOT contract: cross-cutting rules plus the subsystem map.
Codex reads AGENTS.md natively; Claude Code reads THIS file and not AGENTS.md,
so the import is what makes one file serve both. The `@path` syntax expands the
target into context at session start (max 4 hops of recursive imports).

Subsystem rules live in src/<subsystem>/AGENTS.md with a sibling CLAUDE.md
holding the same one-line import. Claude Code loads those on demand when it
opens a file in that directory; Codex merges root-down-to-cwd, which is why the
root subsystem map tells the reader to open the file explicitly. Keeping them
OUT of this always-loaded file is the point of the split, so do not import them
here.

Do NOT add project rules here — they would be invisible to Codex, which is the
whole failure this indirection exists to prevent. Put them in AGENTS.md, or in
the subsystem AGENTS.md they belong to. The only thing that belongs below the
import is genuinely Claude-Code-specific configuration that no other agent could
act on.

Two things worth knowing before editing any AGENTS.md:
  - Import parsing skips code spans and fenced blocks but nothing else, so an
    at-sign token in plain prose becomes a phantom import. Every package name
    of that shape is backticked today; keep it that way.
  - HTML comments like this one are stripped before the content reaches the
    model, so notes for human maintainers cost zero context tokens.
  - Historical evidence belongs under docs/incidents as an ordinary Markdown
    link, never as an @ import; recursive imports would restore the old context
    cost on every session.
-->
