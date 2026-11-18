---
name: scoring-rules
description: Scoring in this repo — the fit score, ranking pools, "waiting to know", trend and the compare page. Use before touching src/domain/scoring, src/server/compare, config/scoring/v0.json, or the fit-score/trend UI.
---

Rules live in [docs/scoring/rules-v0-experimental.md](../../../docs/scoring/rules-v0-experimental.md) (meaning, admission, trend, the "implementation notes" in §6) and [config/scoring/v0.json](../../../config/scoring/v0.json), which is the only place numbers live. Decisions: [ADR-0001](../../../docs/adr/0001-ai-suggests-level-program-computes-score.md), [ADR-0005](../../../docs/adr/0005-unknown-is-a-state-not-a-score.md). Read the section you are changing first.

## Where things live

| Concern | Path |
|---|---|
| Config schema (levels, evidence, total, ranking, trend) | `src/domain/analysis/rules.ts` |
| Fit score, "known" test, weighted score (pure) | `src/domain/scoring/score.ts` |
| Ranking pools, waiting-to-know, exclusions (pure) | `src/domain/scoring/ranking.ts` |
| Trend and baseline change (pure) | `src/domain/scoring/trend.ts` |
| User-facing wording for reasons and trend | `src/domain/scoring/labels.ts` |
| Gathering saved analyses, preferences, stages | `src/server/compare/service.ts` |
| UI | `src/app/(app)/compare/page.tsx`, `src/components/fit-score.tsx` |

## Hold these invariants

- Every function takes the rules as a parameter defaulting to the config; no number from `v0.json` is repeated in code.
- A score comes only from the saved analysis result, the importance saved in its snapshot, and the rules. Same inputs, same score.
- Unknown is a state: a dimension that is not "known" (clue, insufficient, or "known" without a valid level) is never scored as 0 and never dropped to inflate the rest. No aggregate number is shown unless all five are known.
- Ranking happens per stage, compares only on dimensions every ranked person has known, and renormalises weights inside them. Ties share a rank. "My feeling" and personal notes never enter any calculation.
- A report that needs re-analysis (corrected data, preference change, rules change) cannot enter a pool. "New data waiting" still can.
- Trend compares only same-rules, same-preference, scored snapshots; a difference across versions is shown as "口径变化", never as warming or cooling.
- Everything shows the "experimental rules" label until the config status is `active`.

## Change a rule

1. Change the number or switch in `config/scoring/v0.json`; if the meaning changes, bump `version` (every old report becomes "rules changed") and update the rules document.
2. Done when the unit tests in `tests/unit/scoring-*.test.ts` and `tests/integration/compare.test.ts` pass and a mutation that removes the protected behaviour turns one red. Rules stay `experimental` until the sample evaluation and the user's confirmation (rules document §9).
