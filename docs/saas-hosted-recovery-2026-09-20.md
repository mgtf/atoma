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

**Still incomplete:** the original manifest expected a benchmark `archive`
tier, but the host has no such directory. The documented production shape
declares `ATOMA_BACKUP_OPTIONAL_TIERS=archive`; this capture had no declaration.
The original result remains `incomplete` and its manifest is untouched. A fresh
capture with only that tier declared optional is prepared for operator execution;
W8-b closes only after that new snapshot passes the same verifier.
