# Outpost AI Agent Instructions

Welcome to the Outpost project. This repository contains the source code for an AI-first deployment harness for applications running on user-owned infrastructure.

As an AI coding agent working on this codebase, you must adhere to the following guidelines and rules to ensure consistency, quality, and correctness.

## 1. Project Overview

Outpost consists of three main components:

- **Mothership**: The AI operator, dashboard, tool runner, and approval gate. It runs on the user's machine.
- **Beacon**: A blind WebSocket relay server that forwards opaque messages between Mothership and Outpost Daemons. It does not decrypt or store secrets.
- **Outpost Daemon**: The target-side agent that accepts only signed, typed commands from Mothership (e.g., Deploy, Rollback, Health Checks).

Understand these components and their roles when modifying the architecture or adding features. **Never add arbitrary shell execution commands to Beacon or Outpost Daemon**; they operate strictly via typed commands for security.

## 2. Linter & Formatting

We maintain strict code style and formatting standards. Before finalizing your work or submitting any changes, you must ensure the codebase passes all formatting and linting checks:

- **Linting**: Run `npm run lint` to check for ESLint warnings or errors. To automatically fix lint issues, run `npm run lint:fix`.
- **Formatting**: Run `npm run format:check` to verify Prettier formatting. To format files automatically, use `npm run format`.

**Important**: Your changes must not introduce any new linter warnings or formatting errors.

## 3. Code Documentation

This project uses [TypeDoc](https://typedoc.org/) and TSDoc to generate static documentation sites.
**Whenever you work on or modify a function, class, type, or module, you must enhance its code documentation.**

Please follow the conventions detailed in `docs/DOCUMENTATION.md`. Specifically:

- Add a `@module` doc comment at the top of new files.
- Document exported types, interfaces, and variables using standard tags (`@description`, `@property`, `@example`, etc.).
- Add full JSDoc/TSDoc blocks to exported functions, including `@param`, `@returns`, and `@throws` tags.
- Explain _why_ a function exists, not just _what_ it does. Include examples where helpful.

After updating documentation, verify it builds successfully by running:

```bash
npm run docs
```

## 4. Build & Verification

Before submitting any code changes, verify your work using the built-in package scripts. Do not leave the codebase in a broken state.

Run the following commands to ensure everything builds correctly and types are sound:

- **Type Checking**: `npm run typecheck`
- **Build**: `npm run build`
- **Comprehensive Check**: Run `npm run check` (this sequentially runs `npm run format:check`, `npm run lint`, and `npm run typecheck`).

Your changes are only considered complete if `npm run check` and `npm run build` pass without errors.
