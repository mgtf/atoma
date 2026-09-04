# Keeping the README true — generated facts and a generated diagram

**2026-09-04.** Two mechanisms landed together because they answer the same
question — *what in our outward-facing documentation goes stale silently?* —
and because only one of them needed a third-party tool.

The README carries two kinds of claim. **Numbers** ("Thirteen tools", "Node
22.13+ or 24+", "Twelve controlled rounds") and, until now, **no picture at
all**: every diagram lived in `docs/how-it-works.md` as hand-written Mermaid.
Both kinds drift the same way — nothing fails when the code moves — but they do
not have the same fix, and conflating them is how a documentation pipeline ends
up rewriting prose it does not understand.

## The rule that came out of it: generate what is tabular, assert what is prose

`scripts/repo-facts.mjs` derives every fact from a tracked artefact.
`scripts/readme-facts.mjs` then does two different things with them:

- It **generates** the block between `<!-- atoma:facts:begin -->` and its end
  marker. That region belongs to the machine. `npm run docs:facts -- --apply`
  rewrites it; a stale block fails `npm run docs:check`.
- It **asserts** the sentences. "**Thirteen tools.**" stays hand-written and is
  only checked against `src/mcp/server.ts`. When it disagrees, the gate names
  the sentence and the file that outranks it, and a human rewrites it.

A generator that edited prose would either flatten the README's voice or, worse,
silently "correct" a number whose surrounding argument no longer holds — and the
argument is the part a machine cannot see. `--apply` therefore still fails on
prose drift: a CI auto-fix must never be able to make a wrong sentence look
reviewed.

What is checked today: the MCP tool count, the controlled-round count, every
Node version claim against `.nvmrc`, the curated pool sizes in `AGENTS.md`
(which is loaded into every agent session, so a stale count there is a wrong
instruction), and every `npm run <script>` the README tells a reader to type.

What is deliberately **not** generated is listed in `KNOWN_NARRATIVE` in
`scripts/repo-facts.mjs`: the 156-run corpus totals, whose measurement CSVs were
archived out of the tree on 2026-08-18, and the benchmark badges, whose
cross-round ratios are not comparable — one generated number there would
misstate them. A freshness pipeline that invented those would be worse than no
pipeline.

## The diagram: Archify

[Archify](https://github.com/tt-a1i/archify) (pinned at
`06dd052602dd9a369e4d034e24faef0917b5a60c`, package version `2.17.0-dev.1`) is
a Node CLI that compiles a typed JSON IR into a self-contained HTML diagram —
architecture, workflow, sequence, dataflow, lifecycle. It renders; it derives
nothing. An IR written by hand drifts exactly like the prose above, so the
component list is **read from the AGENTS.md subsystem map**, the table
`docs:check` already proves complete.

`scripts/architecture-ir.mjs` splits ownership the same way the facts script
does:

- The generator owns **membership**. A subsystem in the map that is not in the
  diagram fails. A subsystem in the diagram that the map dropped fails. An edge
  naming an id the map never produced fails.
- A human owns **arrangement** — the `LAYOUT` table and the edge list. Adding a
  subsystem forces a deliberate decision about where it sits and what it talks
  to, which is the review this generator exists to provoke.

### Four things worth knowing before adopting it

**1. Its validator is real, and it is the reason the first draft was wrong.**
The first IR took column order from the subsystem map, on the theory that
documentation order was good enough. `archify validate --quality showcase`
returned 17 errors: arrows crossing four unrelated components, endpoint sides
the router could not honour, and three sublabels too long to be legible in the
cell they were given — with the pixel arithmetic in the message. Documentation
order is a reading order, not a diagram order. That is the finding that split
membership from arrangement.

**2. Repository evidence is excellent and cannot live in the committed IR.**
Each component may declare `sources: [{path, line}]`, and with `--repo-root`
Archify verifies every path *at a pinned 40-character commit SHA*, then deep-links
it. The catch is that a pinned SHA in a committed file changes on every commit,
so the drift check could never be green. Evidence is therefore **injected at
render time** against the current HEAD: the committed IR stays structural, and
the rendered artifact still carries provenance verified against a real commit.

Two constraints travel with it. The evidence check requires
`meta.repository.url` to be a public `https://github.com/...` URL whose slug
matches the local `origin` — atoma is private, so the links resolve for
authorised readers and 404 for everyone else. And it reads the pinned commit out
of the local checkout, so any CI job that rendered would need `fetch-depth: 0`,
not the default shallow clone.

**3. Export is a button in the browser — but the SVG can be lifted headlessly.**
Archify's PNG and share-card exports run client-side inside the rendered page.
There is no headless export command, and GitHub will not render an HTML artifact
inside a README, which looked like the end of the road for an embeddable image.
It is not: the artifact's diagram is one inline `<svg>` and every rule painting
it lives in the page's single `<style>`. `standaloneSvg()` lifts both and
inlines the stylesheet into the SVG root — CDATA-wrapped, or an XML parser trips
over the first `<` in the CSS and renders nothing but a parse error. The result
was verified in a real browser, is byte-identical across renders, and is what
`docs/architecture.svg` holds. Because it is deterministic it reviews as a
normal diff.

The committable SVG is rendered from the **plain** IR, without evidence: links
inside an `<img>`-embedded SVG are dead weight a browser will not follow, and a
pinned revision would rewrite the file on every render.

**4. `archify` on npm is not this tool.** It is an unrelated, abandoned 2016
package by a different author. Install only from the pinned GitHub source.

### Why rendering is not in `docs:check`

`docs:check` regenerates and compares the IR — that is the drift gate, and it is
dependency-free. It never renders. Rendering needs a third-party checkout
(`ARCHIFY_HOME`, or `--archify <path>`), which CI must not clone on every push,
and the same reasoning that removed the browser smoke from `release:check` on
2026-08-24 applies to putting a diagram renderer in the hot path: it would
measure the tool, not the change.

```bash
npm run docs:architecture                  # check: does the IR still match src/?
npm run docs:architecture -- --apply       # rewrite the IR
ARCHIFY_HOME=~/src/archify \
  npm run docs:architecture -- --apply --render --svg   # artifact + committable SVG
```

`docs/architecture.html` (~700 KB, and re-pinned on every render) is gitignored;
`docs/architecture.svg` is committed and embedded in the README.

## What this does not solve

The diagram's *edges* remain an assertion by a human. Nothing checks that
`atoms → tools` is still how the code behaves; the generator only guarantees the
picture names the right components. Deriving edges from real imports is possible
and was not attempted here — it would need a dependency graph the generator does
not currently build, and an import edge is not the same claim as an
architectural one.
