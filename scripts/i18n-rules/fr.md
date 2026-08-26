# Language rules — French (`fr`)

Rules for translating the atoma interface catalog (`src/viz/client/locales/en.json` → `fr.json`).
Read by `scripts/i18n.mjs` (translate/sync) and by any agent doing the translation.

## Register

- Tutoiement. The whole French catalog already speaks to the user as "tu" — stay consistent.
- Short UI labels stay short. Explanatory copy stays clear and plain; no marketing padding.
- French typography: use «  » where the catalog already does, keep the existing
  apostrophe style (’ typographic where the file uses it), and keep a thin space
  before ! ? : ; only where the existing copy does. Follow the file, not a rulebook.

## Product vocabulary — keep in English

- **atoma**, **run**, **skill**, **burn-in**, **fallback**, **tier**, **trust**,
  **MCP**, **GitHub**, **WebGPU**, **Opus / Sonnet / Haiku**, **PWA**.
- Lanes and ranks: **Molécule / Cellule / Tissu** are translated (see below) but
  the L1/L2/L3 prefixes stay as-is (`L1 · molécules`).
- `workspace` → **workspace** (the run workspace is a directory the run owns; "espace de travail" would suggest a UI surface).

## Product vocabulary — French translations established by the catalog

- registry → **registre**
- Molecule / Cell / Tissue → **Molécule / Cellule / Tissu**
- element (L1 tool) → **élément**
- ledger → **registre du catalogue** (admin screen) / **ledger** where it names the cost ledger rows
- sentinel → **sentinelle**
- announcement → **annonce**
- organisation → **organisation**
- delivered / failed / cancelled (run status) → **livré / échoué / annulé**

## Numbers and plurals

- `{{count}} run` → `{{count}} run` (run stays English, plural -s applies: `{{count}} runs`).
- Use `_one` / `_other` entries exactly: singular key gets singular French, plural key gets plural French.

## Do not touch

- `{{placeholder}}` tokens — same names, same count, same order-insensitive signature.
- Leading symbols and icon glyphs (✓ ✕ ⚠ ● ⟳ ⛔ ⊘ ⚡ 📖 ✏️ 🛡️ ⏱ ▶ ■).
- Backtick-quoted identifiers inside values (`npm run burnin`, `ATOMA_VIZ_AUTH=1`, `--db path/to/atoma.db`): the command itself stays byte-identical, translate only around it.
- Product dates and durations formats — keep the `{{…}}` variables carrying them.
