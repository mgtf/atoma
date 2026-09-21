# Transient HTTP 502 during VPS deployment

Status: open, deferred at the owner's request.

On 2026-09-21, the owner reported that https://atoma.run returned **502 Bad
Gateway for a few seconds during deployment to the VPS**. Service recovered
without an intervention in this task, and the owner then confirmed that account
switching worked.

This is a user-reported observation, not a measured outage. The exact duration,
deployed revision and root cause have not been verified; no server or proxy
logs were collected in this task.

Follow-up: investigate availability during deployment, correlate proxy and
application lifecycle logs, and correct the deployment handover so ordinary
deployments do not expose a transient 502. Verify the eventual fix by observing
HTTP availability throughout a deployment, while preserving the existing
run/preview preflight protections.

No fix or deployment change was attempted as part of recording this incident.
