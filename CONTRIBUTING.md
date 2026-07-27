# Contributing

Switch is being built from the implementation plan in `docs/plan/`.

## Development

Requirements:

- Node.js 26 or newer.
- npm 11 or newer.

Commands:

```bash
npm install
npm run build
npm test
npm run check
```

Normal tests must not require network access, paid models, or user credentials.
Live connector tests are opt-in.

## Changes

- Preserve domain and adapter dependency boundaries.
- Add runtime validation at trust boundaries.
- Add tests for failure and cancellation paths.
- Reference an ADR for material architecture changes.
- Never add credential extraction or undocumented consumer authentication.
- Update plan requirements and compatibility fixtures when public contracts
  change.
