# AGENTS.md

Hybrid repo: one product, two independent implementations of the same contract.

- `rust/` — Rust crates; `Cargo.toml` at the root is the workspace root (deliberately at the
  root so `git = "..."` dependencies resolve).
- `bun/` — TypeScript sources and tests; `package.json` at the root is the Bun package, with
  `main`/`types`/`exports` pointing at `bun/src/index.ts`.
- `dev/` — design notes and plans. Not code.

Run every command from the repository root. There are no wrapper scripts (`just`, `make`, etc.)
and none should be added.

## Development vs CI

During development, run the **autofixing** commands. CI runs only the **verify** commands, which
never write to the working tree. Autofixing commands must never appear in a workflow.

## Tests

```bash
cargo test --workspace --all-features
```

The Bun implementation is not present yet (`bun/src` is empty). Once it lands: `bun install` then
`bun test`, which `bunfig.toml` scopes to `bun/`.

## Formatting

Autofix:

```bash
cargo fmt --all
```

Verify (CI):

```bash
cargo fmt --all -- --check
```

No TypeScript formatter or linter is configured yet; do not add one without asking.

## Linting

Autofix:

```bash
cargo clippy --fix --workspace --all-targets --all-features --allow-dirty
```

Verify (CI):

```bash
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

`--fix` applies only machine-applicable suggestions, so always follow it with the verify command
(and with `cargo fmt --all`, since fixes can disturb layout). `--allow-dirty` is required while the
tree has uncommitted changes; drop it once the initial commit exists.

## Conventions

- `Cargo.lock` is generated and **not** committed. Do not add it, and never pass `--locked` or
  `--frozen` (there is no committed lockfile to honor, by design).
- Releases are git tags created by release-please, not registry publishes. Nothing goes to
  crates.io or npm.
- Versions live in `.release-please-manifest.json`, `package.json`, and `[workspace.package]` in
  `Cargo.toml`; they must agree. Tags carry no `v` prefix (`0.1.0`, not `v0.1.0`).
- Add dependencies with `cargo add` (workspace) / `bun add`; keep shared crate versions in
  `[workspace.dependencies]`.
- Do not scaffold the Bun side or invent its directory structure; it is moved in from elsewhere.
