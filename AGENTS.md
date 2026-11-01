# AGENTS.md

Hybrid repo: one product, two independent implementations of the same contract.

- `rust/` — Rust crates; `Cargo.toml` at the root is the workspace root (deliberately at the
  root so `git = "..."` dependencies resolve).
- `bun/` — TypeScript sources and tests; `package.json` at the root is the Bun package, with
  `main`/`types`/`exports` pointing at `bun/index.ts`.
- `dev/` — design notes and plans. Not code.

Run every command from the repository root. There are no wrapper scripts (`just`, `make`, etc.)
and none should be added.

## Development vs CI

During development, run the **autofixing** commands. CI runs only the **verify** commands, which
never write to the working tree. Autofixing commands must never appear in a workflow.

## Tests

```bash
cargo test --workspace --all-features
bun test
```

`bunfig.toml` scopes Bun's test root to `bun/`, so `bun test` from the root does not walk the Rust
tree.

## Type checking

```bash
bun check
```

Bun's native checker replaces `tsc --noEmit`; there is no `typescript` dependency. It uses the root
`tsconfig.json`, which scopes to `bun/`, and needs `@types/bun` installed.

## Formatting

Rust — autofix `cargo fmt --all`, verify:

```bash
cargo fmt --all -- --check
```

Bun — autofix `bun fmt bun`, verify:

```bash
bun fmt --check bun
```

Scope the Bun formatter to `bun/` explicitly: a bare `bun fmt` also formats Markdown, JSON, YAML,
and `Cargo.toml`, which would rewrite the Rust docs and root config. Options live in the `[fmt]`
section of `bunfig.toml`.

## Linting

Rust — autofix:

```bash
cargo clippy --fix --workspace --all-targets --all-features --allow-dirty
```

Rust — verify:

```bash
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

`--fix` applies only machine-applicable suggestions, so follow it with the verify command (and with
`cargo fmt --all`, since fixes can disturb layout). `--allow-dirty` is required while the tree has
uncommitted changes.

Bun: `bun lint` exists only in canary builds, not in the stable version pinned in `.tool-versions`,
so linting means the formatter check:

```bash
bun fmt --check bun
```

Once `bun lint` ships in a stable release, the Bun lint step becomes
`bun lint --no-script && bun fmt --no-script --check bun`.

## No npm scripts

`package.json` has no `scripts` on purpose. Bun prefers a `package.json` script over its own command
of the same name, so a script named `test` that calls `bun test` calls itself, hits Bun's
script-depth limit, and **exits 0** — a silent pass. Run Bun's commands directly. If a shadowing
script ever becomes necessary, pass `--no-script`.

## Conventions

- `Cargo.lock` is generated and **not** committed. Do not add it, and never pass `--locked` or
  `--frozen` (there is no committed lockfile to honor, by design).
- `bun.lock` **is** committed. It stores no package version, so release-please never edits it on a
  bump; it pins the Git dependency commit and integrity hashes. CI installs with
  `bun install --frozen-lockfile`.
- Releases are git tags created by release-please, not registry publishes. Nothing goes to
  crates.io or npm.
- Versions live in `.release-please-manifest.json`, `package.json`, and `[workspace.package]` in
  `Cargo.toml`; they must agree. Tags carry no `v` prefix (`0.1.0`, not `v0.1.0`).
- Add dependencies with `cargo add` (workspace) / `bun add`; keep shared crate versions in
  `[workspace.dependencies]`.
- Do not scaffold the Bun side or invent its directory structure; it is moved in from elsewhere.
