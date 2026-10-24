# Changelog

All notable changes to `@mmmike/extra-drizzle-kit` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each version is the drizzle-kit
version the release targets, so a release can change behavior without a major version bump; the entries say
when it does.

## [1.0.0-rc.5] - 2026-10-24

The first release, for drizzle-kit and drizzle-orm `1.0.0-rc.5`.

### Added

- `extra-drizzle-kit generate`, which runs `drizzle-kit generate` with the same arguments and rewrites the
  migration when drizzle-kit's would fail or lose something.
- `pgMaterializedView` and `materializedViewIn`, drop-ins for drizzle's, that also take the view's indexes
  ([drizzle-orm#2976](https://github.com/drizzle-team/drizzle-orm/issues/2976)). A view with declared columns
  gets a table's index columns, so `.desc()`, `.nullsFirst()` and `.op()` work.
- Recreation of the views that read a changed view, a dropped column, a column whose type changes, or an enum
  that loses a value, in dependency order
  ([drizzle-orm#6194](https://github.com/drizzle-team/drizzle-orm/issues/6194)).
- `pgExtension`, which creates an extension in the next migration and never drops one
  ([drizzle-orm#2124](https://github.com/drizzle-team/drizzle-orm/issues/2124)).
- `extra-drizzle-kit baseline`, which records indexes and extensions that a database already has.
- `AGENTS.md` in the package, with the rules for coding agents.
