# Outpost Documentation Conventions

## Tooling

We use [TypeDoc](https://typedoc.org/) to extract documentation from TSDoc comments and generate static documentation sites.

## Installation

TypeDoc is installed as a dev dependency:

```bash
npm install -D typedoc typedoc-plugin-merge-modules
```

## Generating Documentation

```bash
npm run docs        # Generate HTML documentation
npm run docs:serve  # Serve docs locally for preview
```

## Style Guide

### Module Documentation

Every module (file) should begin with a module-level doc comment describing its purpose:

```typescript
/**
 * @module
 *
 * Brief description of what this module does.
 *
 * Optional longer description with context, design decisions,
 * or cross-references to related modules.
 */
```

### Exported Types and Interfaces

Document all exported types with `@description`, `@property` tags, and inline comments:

```typescript
/**
 * Description of what this type represents.
 *
 * @example
 * ```ts
 * const value: MyType = { ... };
 * ```
 */
export type MyType = {
  /** Description of this property. */
  name: string;
};
```

### Functions and Methods

Use complete JSDoc/TSDoc blocks for all exported functions:

```typescript
/**
 * Brief description of what the function does.
 *
 * @remarks
 * Optional additional context, caveats, or implementation notes.
 *
 * @param input - Description of the parameter.
 * @returns Description of the return value.
 * @throws {@link ErrorType} When and why this error is thrown.
 *
 * @example
 * ```ts
 * const result = myFunction({ name: "value" });
 * ```
 */
```

### Constants and Variables

Document exported constants that are part of the public API:

```typescript
/** Current protocol version string used in all wire messages. */
export const PROTOCOL_VERSION = "outpost.v1";
```

### Cross-References

Use `{@link}` to reference related symbols:

```typescript
/**
 * See {@link OtherType} for related configuration.
 * Uses {@link helperFunction} internally.
 */
```

### Tags We Use

| Tag | Purpose |
|-----|---------|
| `@module` | File-level documentation |
| `@description` | Detailed description (can be implicit first paragraph) |
| `@param` | Parameter documentation |
| `@returns` | Return value documentation |
| `@throws` | Documented error conditions |
| `@remarks` | Additional implementation notes |
| `@example` | Usage examples |
| `@see` | Related symbols or external resources |
| `@deprecated` | Mark deprecated APIs |
| `@defaultValue` | Document default values |

### What to Document

- ✅ All exported types, interfaces, enums, classes
- ✅ All exported functions and methods
- ✅ All exported constants that are part of the public API
- ✅ Module-level documentation for every source file
- ❌ Private helpers (prefixed with `_` or un-exported) — only if complex
- ❌ Self-evident local variables

## Documentation Quality

1. **Be specific**: "Deploys the project" is better than "Does deploy stuff"
2. **Document intent**, not just mechanics: explain *why* a function exists
3. **Include examples** for non-trivial functions
4. **Document error conditions** with `@throws`
5. **Keep descriptions current** when refactoring

## Review Checklist

Before merging code changes:

- [ ] New exports have JSDoc comments
- [ ] Changed functions have updated descriptions
- [ ] `npm run docs` succeeds without warnings
- [ ] Generated docs render correctly
