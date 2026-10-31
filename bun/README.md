# average-record (Bun)

TypeScript implementation of `average-record`, running on [Bun](https://bun.sh). The package is
distributed from GitHub (no npm release) and the entry point is `bun/src/index.ts`, so Bun consumes
the source directly — there is no build step and no `dist/`.

## Installation

Pin a tag:

<!-- x-release-please-start-version -->
```bash
bun add github:dimensionalpocket/average-record#0.1.0
```
<!-- x-release-please-end -->

Or add it to `package.json` directly:

<!-- x-release-please-start-version -->
```json
{
  "dependencies": {
    "@dimensionalpocket/average-record": "github:dimensionalpocket/average-record#0.1.0"
  }
}
```
<!-- x-release-please-end -->

Use `#main` (or a commit SHA) for unreleased code. The dependency name must match the package name
exactly.

## Development

Run these from the repository root; `package.json` and `bunfig.toml` live there, and the test root
is scoped to `bun/`.

```bash
bun install
bun test
bunx tsc --noEmit -p bun
```

Type checking needs `@types/bun` as a dev dependency (`bun add -d @types/bun`); it is not declared
yet because the dependency list lands with the implementation.
