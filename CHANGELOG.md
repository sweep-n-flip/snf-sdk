# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning policy

Both `@sweepnflip/sdk` and `@sweepnflip/sdk-react` stay on `0.x` until the founder's UAT
of Phase 54 (a real, small-value purchase against the Base ETH/DEMON pool). `1.0.0` — and
the first `npm publish` — happen together at Phase 55, when the repo also goes public
(D-08). From `1.0.0` onward, breaking changes only ship in a major version, with a
documented overlap of at least 6 months for any deprecated surface (REQ-SDK-52).

## [Unreleased]

### Added

- Phase 54 — SDK-0 foundation + SDK-1 swap (in progress)
- 2026-09-20 — Toolchain installed after founder approval (T-54-SC gate): `typescript@5.9.3`, `prettier@3.9.8`, `eslint@9.39.4`, `typescript-eslint@8.70.0`, `tsup@8.5.1`, `vitest@5.0.1`, `@vitest/coverage-v8@5.0.1`, `size-limit@14.0.0`, `@size-limit/preset-small-lib@14.0.0`, `fast-check@4.10.2`, `@changesets/cli@3.0.3` (root); `viem@2.47.0` (`@sweepnflip/sdk`); `viem@2.47.0`, `wagmi@2.19.5`, `@tanstack/react-query@5.90.21`, `react@19.2.5`, `react-dom@19.2.5`, `@types/react@19.3.0`, `@testing-library/react@16.3.3`, `@testing-library/dom@10.4.2`, `jsdom@30.1.0` (`@sweepnflip/sdk-react`). `tsx` skipped (founder decision). Bare `changesets` package never installed — only the scoped `@changesets/cli`.
