---
name: chat-import
description: Chat import in this repo — adding or changing a chat text parser, the screenshot vision adapter, overlap detection, import batch states, the confirm/correct flow, or original-image cleanup. Use before touching src/domain/chat, src/server/imports, src/server/recognition, or src/server/storage.
---

Rules live in [docs/business/import-spec.md](../../../docs/business/import-spec.md) (formats, overlap, parsers, original-image lifecycle) and [docs/business/state-machines.md](../../../docs/business/state-machines.md) (batch, recognition, deletion fence). Terms are in [GLOSSARY.md](../../../GLOSSARY.md). Read the section you are changing before editing; this file only says where things are and how to add a parser.

## Where things live

| Concern | Path |
|---|---|
| Parsers (pure) and message types | `src/domain/chat/` — `parser.ts`, `overlap.ts`, `reply-interval.ts`, `types.ts` |
| Simulated chats (the only test data) | `samples/` — every claimed format has a file here |
| Batch flow, staging, confirm, delete | `src/server/imports/` — `staging.ts` holds the shared lock order and staging |
| Screenshots, rounds, quota, signed links | `src/server/recognition/service.ts` |
| Vision interface and the mock | `src/server/ai/` |
| Private storage | `src/server/storage/` |

## Add a parser

1. Write the sample into `samples/chat-text/` first. A format is "supported" only when a sample and a test exist; everything else stays on the generic paste path.
2. Write the failing test in `tests/unit/chat-parser.test.ts` against the sample, then implement. Expected values come from the sample, not from running the parser.
3. Done when: the test covers a message without time (`occurredAt` null, precision `UNKNOWN`), an unattributable line (`uncertain: true`), and a repeated identical message (kept).

## Change the vision adapter

The adapter returns messages shaped like `ParsedMessage` and throws on provider failure (no charge). It returns left/right or name labels; "我/对方" stays a user decision. A real provider adapter is done only when the mock-based tests in `tests/integration/screenshots.test.ts` pass unchanged against it, and its quality is measured on the Chinese samples before it is called supported.

## Change batch or recognition behaviour

Done when `npm test` passes, including the ownership, deletion-fence and quota cases in `tests/integration/imports.test.ts` and `screenshots.test.ts`, and `docs/verification-matrix.md` reflects what is now verified versus mocked.
