# Hosted recovery exercise — W8-b

First hosted snapshot: `2026-09-20T13:37:48.987Z`. The operator executed the
prepared maintenance script on production, which held the deployment/run gate,
stopped the active services for capture and restarted them. The web service was
confirmed active afterwards. The snapshot and wrapping-key context were copied
separately to an operator-approved, access-restricted directory on another machine.
Neither payload belongs in this repository.

The unchanged snapshot passed all five captured tiers' size/SHA-256 checks.
Under local Linux, the independent restore verifier reported SQLite integrity
OK, 15 project runs and no missing run files or other store issues. Extraction
and validation took 10.99 seconds. No restored service was started.

Eight existing GitHub access/refresh envelopes decrypted successfully using the
separately retrieved wrapping key and production crypto implementation; zero
failures. There were no organisation-provider-key rows. Plaintext remained in
memory, was never printed or persisted, and no recovered credential was used
against a provider. A separate synthetic key round trip also passed.

The local manifest copy was created at `2026-09-20T13:39:38.5797543Z`: snapshot
age at receipt was approximately 110 seconds. Validation completed by
`2026-09-20T13:42:45.8442686Z`. This is a measured offline drill, not a recovery
SLA or restored production availability. Initial Windows attempts encountered
long-path and SQLite URI limitations; Linux completed the unchanged verifier.

**First capture incomplete:** the original manifest expected a benchmark `archive`
tier, but the host has no such directory. The documented production shape
declares `ATOMA_BACKUP_OPTIONAL_TIERS=archive`; this capture had no declaration.
The original result remains `incomplete` and its manifest is untouched. A fresh
capture with only that tier declared optional was then executed by the operator.

## Final capture — W8-b passed

The fresh production snapshot at `2026-09-20T21:19:44.650Z` explicitly declares
only the absent benchmark archive optional. The original snapshot was not edited.
The unchanged restore verifier returned **verified**: complete inventory, no
missing expected tiers, SQLite integrity OK, 15 runs and no store/file issues.
All eight existing GitHub envelopes decrypted with the separately transferred key;
zero failures and zero organisation-provider-key rows. No secret values are
included in this receipt. The production service was confirmed active afterwards.

- Manifest SHA-256: `cd88941a4180b295d1561bc9ab57eb6fb5cc21208685b5fc86afb09f47cb7376`.
- Local receipt: `2026-09-20T21:20:27.0648919Z`; observed recovery-point age
  **42.4 seconds** at receipt.
- Verification started: `2026-09-20T21:20:56.4646620Z`; completed:
  `2026-09-20T21:21:07.9318719Z` (**11.47 seconds**, including key checks).
- The verifier's extraction/integrity duration was **10.99 seconds**.

These are observed offline recovery timings, not an automated-backup frequency,
a service SLA or a production failover RTO. No restored service or paid provider
call was started. W13 separately proved assembled-stack restore and restart.
Together these receipts close the agreed W8-b acceptance scope. Future backup
invocations on this host must retain the documented optional-archive declaration;
the exercise supplied it to the backup command, not a persistent host-config edit.
