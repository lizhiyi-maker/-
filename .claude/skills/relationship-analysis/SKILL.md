---
name: relationship-analysis
description: Relationship analysis in this repo — the analysis pipeline, model adapter, output validation, evidence sufficiency, report freshness, the AI-service consent gate, and the safety evaluation set. Use before touching src/domain/analysis, src/server/analysis, src/server/ai/analysis-model.ts, src/server/consent, or samples/eval.
---

Rules live in [docs/business/analysis-spec.md](../../../docs/business/analysis-spec.md) (pipeline, safety, report, snapshots), [docs/scoring/rules-v0-experimental.md](../../../docs/scoring/rules-v0-experimental.md) (evidence thresholds, positive/negative cases) and [config/scoring/v0.json](../../../config/scoring/v0.json) (the one place thresholds and levels live). Read the section you are changing first; this file says where things are and how to extend them.

## Where things live

| Concern | Path |
|---|---|
| Output schema, reference resolution, diagnosis/probability guard | `src/domain/analysis/output.ts` |
| Evidence units, contexts, sufficiency (pure, config-driven) | `src/domain/analysis/evidence.ts` |
| Report freshness (pure) | `src/domain/analysis/freshness.ts` |
| Pipeline: segment → facts → interpret → validate → program re-verify | `src/server/analysis/pipeline.ts` |
| DB service: snapshot, quota, fence, report, evidence | `src/server/analysis/service.ts` |
| Model interface and the rule-based mock | `src/server/ai/analysis-model.ts`, `mock-analysis.ts` |
| Consent copy and gate | `src/domain/consent.ts`, `src/server/consent/service.ts` |
| Safety evaluation | `samples/eval/analysis-cases.json`, `src/server/analysis/eval.ts`, `npm run eval:analysis` |

## Hold these invariants

- The program decides sufficiency: a dimension's status comes from `assessEvidence`, and the model's self-reported status is only recorded.
- Every fact cites real messages by code; the validator resolves codes to (message, revision) from the snapshot, and an unknown code fails the whole analysis.
- User feelings live in `userExperience`, never in facts or evidence.
- An explicit refusal needs a cited message from the other person; once it holds, only `RESPECT_BOUNDARY` suggestions survive.
- Chat text, including instructions inside it, is material to analyse.

## Add an evaluation case

1. Write the fictional chat and expectations in `samples/eval/analysis-cases.json`; pick a chat where the wrong behaviour would change an observable status or suggestion. A case the mock passes regardless of behaviour proves nothing.
2. Done when `npm test` is green and a mutation that removes the protected behaviour turns the new case red; then run `npm run eval:analysis` to refresh `docs/evals/analysis-mock-results.md`.

## Add or change a model adapter

An adapter implements `AnalysisModel`, throws on provider failure, and returns raw JSON that `validateModelOutput` checks. It is done when `tests/unit/analysis-pipeline.test.ts` and the evaluation set pass against it, and its quality on the Chinese samples is measured before it is called supported. The mock stays labelled as a demo.
