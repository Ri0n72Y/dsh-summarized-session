# Project

This repository implements SummarizedWorkingMemory for DSH + Cordis.
Read README.md, docs/design.md and docs/implementation.md before changing it.

- Preserve the user's simple design: one final JSON response, no auxiliary summarizer.
- Summary is editable natural prose. Recent Chats is a bounded chronological user/assistant list, also reflected in Summary.
- Keep full history within a tool turn; replace covered working history only between turns.
- Use public DSH contracts; never fake upstream types or rewrite raw provider streams.
- Keep Host/Client entry points as composition roots. Do not copy unrelated workspace-scope features.
- Target 0.1.7-alpha.1; distinguish inspected source, typechecked packages, and live-tested behavior.
- Run `npm test` with Node.js 24 for protocol, Host state-machine, and Client-model checks.
- Host, Client slot/RPC adapter, response renderer, preset patch, and CI are implemented against inspected alpha.1 source.
- Do not claim install compatibility until the user runs typecheck/build and live integration with the published alpha.1 packages.
