# Project

This repository implements SummarizedWorkingMemory for DSH + Cordis.
Read README.md, docs/design.md and docs/implementation.md before changing it.

- Preserve the user's simple design: one final JSON response, no auxiliary summarizer.
- Summary is editable natural prose. Recent Chats is a bounded chronological user/assistant list, also reflected in Summary.
- A validated final envelope may expose response immediately, but Summary + Recent Chats remain pending until explicit human save.
- A pending memory proposal or recovery state is a hard between-turn boundary: restore claimed input to its original inbox class instead of letting another turn consume raw history.
- Keep full history within a tool turn; replace covered working history only between turns.
- Use public DSH contracts; never fake upstream types or rewrite raw provider streams. Do not append plugin-owned Session event types on alpha.1: live `Session.append()` cannot mark them ignorable for persistence reload.
- Keep Host/Client entry points as composition roots. The memory plugin is a composable capability; do not copy a full Coding Agent preset into it or unrelated workspace-scope features.
- Target 0.1.7-alpha.1; distinguish inspected source, typechecked packages, and live-tested behavior.
- Run `npm test` with Node.js 24 for protocol, Host state-machine, and Client-model checks.
- Host, Client slot/RPC adapter, response renderer, preset patch, and CI are implemented against inspected alpha.1 source.
- CI typecheck/build against published alpha.1 is established; do not claim live runtime compatibility until the user completes real DSH integration testing.
