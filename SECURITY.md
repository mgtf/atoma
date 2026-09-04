# Security policy

atoma runs model-authored code. The sandbox, the container isolation, the
egress proxy and the organisation gate are the product, so a hole in any of
them is a vulnerability, not a bug.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting on this
repository ("Security" tab, then "Report a vulnerability"). Do not open a
public issue, and do not include a live credential or a real victim's data in
the report.

Include what you can of:

- the affected surface (sandbox, worker container, egress, viz HTTP surface,
  auth gate, MCP server, preview) and the commit or release you tested;
- a reproduction, ideally as a failing test under `tests/`;
- the impact you believe it has.

You will get an acknowledgement within a few days. Fixes ship as a normal
release with a `### Security` entry in `CHANGELOG.md`; the report is credited
there unless you ask otherwise.

## Supported versions

Only the latest release and `main` receive fixes.

## Scope

In scope: anything that lets a run escape its workspace or container, reach a
network it was not granted, read another organisation's data, bypass the OAuth
gate or the platform-admin flag, or forge audit-ledger entries.

Out of scope: the cost or behaviour of third-party models, and findings that
require an operator to have already granted the attacker platform-admin.

## What is enforced today

The enforced model, and its known gaps, is documented in
[`docs/how-it-works.md`](docs/how-it-works.md) under "The safety model". The
README's Status section states plainly what is not built, including the
absence of full tenant isolation. A report that restates a documented gap is
welcome as a discussion, not as a vulnerability.
