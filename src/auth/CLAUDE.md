@AGENTS.md

<!--
One active line, same indirection as the repository root: Codex reads AGENTS.md
natively, Claude Code reads CLAUDE.md, and Claude Code loads this file on its
own when it opens a file in this directory. Put subsystem rules in the sibling
AGENTS.md so both agents see them; nothing belongs below this import.
`npm run docs:check` enforces the pair, the root registration and the budget.
-->
