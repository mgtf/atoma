# Repository rulesets

`protect-main.json` is the ruleset applied to `main`, kept here so the
protection is reviewable and reproducible. It is not applied automatically:
import it from **Settings → Rules → Rulesets → New ruleset → Import a
ruleset**, or with the API:

```bash
gh api -X POST repos/mgtf/atoma/rulesets --input .github/rulesets/protect-main.json
```

What it enforces on `main`:

- no deletion, no force-push;
- changes arrive through a pull request with every review thread resolved;
- the CI checks `Hermetic checks (Node 22)`, `Hermetic checks (Node 24)`,
  `Mender credential isolation`, `Fresh worker image` and the `cla` check
  must pass, reported by GitHub Actions only.

Bypass is granted to the repository admin role only. GitHub refuses the GitHub
Actions app as a bypass actor on a user-owned repository, so the `i18n` job,
which commits translations straight to `main`, pushes with the admin's
fine-grained token (`ATOMA_I18N_PUSH_TOKEN`, Contents: read and write on this
repository) and bypasses as the admin. A bypassed push is recorded as such in
the branch's rule insights.

When editing the ruleset in the UI, export it again into this file so the two
never drift.
