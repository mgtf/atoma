# Northstar subscriptions

This synthetic project manages subscriptions for a design studio.
The current billing policy is in docs/billing.md.
Accepted decisions supersede drafts and archived decisions.
Amounts are integer euro cents. Provider identifiers are configuration keys.

To preview the configured offers, run `node preview.mjs`.
The preview reads pricing.json; only that configuration needs changing to
enable an offer whose terms are already documented.
