# average-record

A lightweight, Active-Record-style ORM for **SQLite**, with a fluent query builder, lifecycle
hooks, validation, column redaction, change tracking, and a migration runner.

This repository holds two independent implementations of the same contract:

| Implementation | Location | Execution model | Documentation |
| --- | --- | --- | --- |
| Rust | `rust/` | async, over caller-supplied `sqlx` connections | [rust/README.md](rust/README.md) |
| TypeScript (Bun) | `bun/` | synchronous, matching `bun:sqlite` | [bun/README.md](bun/README.md) |

Both are libraries, not applications: the host application owns the database (its pool, PRAGMAs,
and data folder); each implementation provides the model, query, and migration layer on top of the
connection it is given.

## Requirements

- Rust 1.99+ (see `.tool-versions`)
- Bun 1.4+ (see `.tool-versions`)

## Repository layout

```
Cargo.toml        Rust workspace root (kept at the root so `git = "..."` dependencies resolve)
package.json      Bun package root, entry point → bun/index.ts
rust/             Rust crates
bun/              TypeScript sources and tests
dev/              Design notes and plans
```

Build and test commands live in each implementation's README; there are no wrapper scripts.
