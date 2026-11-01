# Changelog

## [0.2.0](https://github.com/dimensionalpocket/average-record/compare/0.1.0...0.2.0) (2026-11-01)


### ⚠ BREAKING CHANGES

* primary keys are `i64`, not `Option<i64>`. Replace `None` with `0` and `Some(id)` with `id`.

### Features

* primary keys are non-optional (0 means new) ([6505c74](https://github.com/dimensionalpocket/average-record/commit/6505c741df86aa682c416ec93eb84aa89004ef8d))

## 0.1.0 (2026-11-01)


### Features

* initial release ([a9b9bae](https://github.com/dimensionalpocket/average-record/commit/a9b9bae44e8269923f7068e753416ccee95bbf08))


### Bug Fixes

* run Bun tests, type check and formatter check in CI ([2e713f4](https://github.com/dimensionalpocket/average-record/commit/2e713f449c0ab6ce906869274d8347cff41ab3b0))
