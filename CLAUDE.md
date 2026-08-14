@AGENTS.md

<!--
This file is deliberately a one-line import, and it must stay that way.

AGENTS.md is the single source of truth for active repository guidance and the
index to the archived engineering record.
Codex reads AGENTS.md natively; Claude Code reads THIS file and not AGENTS.md,
so the import is what makes one file serve both. The `@path` syntax expands the
target into context at session start (max 4 hops of recursive imports).

Do NOT add project rules here — they would be invisible to Codex, which is the
whole failure this indirection exists to prevent. Put them in AGENTS.md. The
only thing that belongs below the import is genuinely Claude-Code-specific
configuration that no other agent could act on.

Two things worth knowing before editing AGENTS.md:
  - Import parsing skips code spans and fenced blocks but nothing else, so an
    at-sign token in plain prose becomes a phantom import. Every package name
    of that shape in AGENTS.md is backticked today; keep it that way.
  - HTML comments like this one are stripped before the content reaches the
    model, so notes for human maintainers cost zero context tokens.
  - Historical evidence belongs under docs/incidents as an ordinary Markdown
    link, never as an @ import; recursive imports would restore the old context
    cost on every session.
-->
