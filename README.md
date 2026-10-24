# @mmmike/extra-drizzle-kit

**An extra step closer to your whole schema in TypeScript, migrated by `drizzle-kit generate`.**

drizzle-kit leaves a few things out, which means writing SQL migrations by hand next to the generated ones.
For Postgres, this package covers them:

- **Indexes on materialized views.** Declare them with drizzle's own `index()` and `uniqueIndex()`. They're
  created after the view and again whenever it's recreated, so `REFRESH MATERIALIZED VIEW CONCURRENTLY` keeps
  its unique index ([drizzle-orm#2976](https://github.com/drizzle-team/drizzle-orm/issues/2976)).
- **Views that depend on a changed view or column.** drizzle-kit drops the view you changed and leaves the views
  that read it, so Postgres refuses the migration with `2BP01`, or with `0A000` for a column type change
  ([drizzle-orm#6194](https://github.com/drizzle-team/drizzle-orm/issues/6194)). This package drops the
  dependents first and recreates them afterwards, in dependency order.
- **Extensions.** Declare `pg_trgm`, `vector` or `postgis` in your schema, and the next migration creates each
  one before anything that uses it ([drizzle-orm#2124](https://github.com/drizzle-team/drizzle-orm/issues/2124)).

Run `extra-drizzle-kit generate` wherever you ran `drizzle-kit generate`. drizzle-kit still writes the
migration. This package reorders it and adds what drizzle-kit can't express, using drizzle-kit's own SQL
generator for everything except `CREATE EXTENSION`.

```sh
pnpm add -D @mmmike/extra-drizzle-kit drizzle-kit@1.0.0-rc.5
pnpm add drizzle-orm@1.0.0-rc.5
```

> [!WARNING]
> **`drizzle-kit push` is not supported.** Use `extra-drizzle-kit generate` and `drizzle-kit migrate` for any
> database with materialized views, view chains or extensions. `push` never reads migration files, so with it:
>
> - indexes on materialized views and extensions are never created
> - an edited view is never updated. `push` reports "No changes detected" and the database keeps the old view.
>   That's drizzle-kit's own behaviour in 1.0.0-rc.5, with or without this package.
>
> Don't push changes to tables your migrations manage. The next `generate` writes them again, and `migrate` fails.
> If you push other tables, keep them in a Postgres schema of their own and give push a config with
> `schemaFilter` set to that schema.

## Before and after

`user_names` is a materialized view that reads the view `active_users`, with a unique index on `id`. Change
`active_users` to add `where "id" > 0`. Plain drizzle-kit writes:

```sql
DROP VIEW "active_users";  -- 2BP01: user_names depends on it
CREATE VIEW "active_users" AS (select "id", "name" from "users" where "id" > 0);
```

`extra-drizzle-kit generate` writes:

```sql
DROP MATERIALIZED VIEW "user_names";
DROP VIEW "active_users";
CREATE VIEW "active_users" AS (select "id", "name" from "users" where "id" > 0);
CREATE MATERIALIZED VIEW "user_names" AS (select "id", "name" from "active_users");
CREATE UNIQUE INDEX "user_names_id_idx" ON "user_names" ("id");
```

## Quickstart

**1. Import `pgMaterializedView` from this package, and declare the indexes.** It takes drizzle's arguments plus
the indexes, and returns drizzle's own view, so the rest of your code doesn't change.

```ts
import { sql } from "drizzle-orm"
import { integer, pgTable, pgView, text, uniqueIndex } from "drizzle-orm/pg-core"
import { pgMaterializedView } from "@mmmike/extra-drizzle-kit"

export const users = pgTable("users", { id: integer("id").primaryKey(), name: text("name") })

export const activeUsers = pgView("active_users", { id: integer("id"), name: text("name") }).as(
	sql`select "id", "name" from ${users}`,
)

export const userNames = pgMaterializedView("user_names", { id: integer("id"), name: text("name") }, (mv) => [
	uniqueIndex("user_names_id_idx").on(mv.id),
]).as(sql`select "id", "name" from ${activeUsers}`)
```

**2. Run `extra-drizzle-kit generate` wherever you ran `drizzle-kit generate`.** It passes every argument to
drizzle-kit unchanged, so `--name`, `--config`, `--hints`, `--custom`, `--output json` and the interactive rename
prompts work as before.

```sh
pnpm extra-drizzle-kit generate
```

Replace `drizzle-kit generate` in your scripts too. Running it directly still works, but it writes exactly the
migrations this package exists to fix, and nothing warns you.

**3. On a database that already has these indexes or extensions, run `baseline` once first.** It records what
you declare as already applied, and writes no SQL. Without it, the first generate creates them again and Postgres
refuses with `42P07`.

```sh
pnpm extra-drizzle-kit baseline
```

## Declaring indexes

For a view with declared columns, the indexes are the third argument, as in the quickstart. The callback gets
the same columns a `pgTable`'s indexes get, so ordering and operator classes work:

```ts
export const people = pgMaterializedView("people", { score: integer("score"), name: text("name") }, (t) => [
	index("people_score_idx").on(t.score.desc().nullsLast()),
	index("people_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
]).as(sql`select ...`)
```

For a view built with the query builder, the indexes are the second argument of `.as()`. That callback gets the
view, whose fields are plain columns, so `.desc()`, `.nullsFirst()` and `.op()` aren't available there. Declare
the view's columns when you need them.

```ts
export const userNames = pgMaterializedView("user_names").as(
	(qb) => qb.select({ id: users.id, name: users.name }).from(users),
	(mv) => [uniqueIndex().on(mv.id)],
)
```

For a view in another Postgres schema, use `materializedViewIn`:

```ts
import { materializedViewIn } from "@mmmike/extra-drizzle-kit"

const reporting = pgSchema("reporting")
export const totals = materializedViewIn(reporting)("totals", { day: date("day") }, (mv) => [uniqueIndex().on(mv.day)])
	.as(sql`select ...`)
```

An index can be on the view's columns, or on a `sql` expression in a named index:
``index("by_lower_name").on(sql`lower(name)`)``. A field selected as `` sql`...`.as("alias") `` isn't a column,
and generate refuses an index on it.

## Declaring extensions

```ts
import { pgExtension } from "@mmmike/extra-drizzle-kit"

export const trigrams = pgExtension("pg_trgm")
export const vectors = pgExtension("vector", { schema: "extensions" })
```

The next migration starts with `CREATE EXTENSION IF NOT EXISTS`, ahead of the tables and indexes that use the
extension. If the extension's Postgres schema is new in the same migration, drizzle-kit creates the schema first.

Removing a declaration never drops the extension, because `DROP EXTENSION` can take columns and data with it,
PostGIS's geometry columns for example. Generate says the extension is no longer declared, and leaves the drop to
you.

## What a run writes

- **drizzle-kit's own migration, byte for byte, when no view, index or extension changes.**
- **A reordered `migration.sql`, when a view changes that other views read, a column a view reads is dropped or
  changes type, or an index changes.** It drops the affected views, then runs everything else, then recreates
  the views, each after the views it reads, then creates the indexes. Postgres refuses a column type change
  under a view with `0A000`, which plain drizzle-kit runs into
  ([drizzle-orm#6194](https://github.com/drizzle-team/drizzle-orm/issues/6194)).
- **A migration of its own, when only indexes or extensions change.** drizzle-kit sees no change then, so the
  package has it write an empty custom migration and fills that in.
- **An `extra-drizzle-kit.json` in every migration folder.** It records the indexes on materialized views and
  the extensions after that migration, because drizzle-kit's snapshots can't hold them. drizzle-kit and
  drizzle-orm's migrator ignore it. Commit it with the migration.

## How it's tested

- **drizzle-kit writes every statement but `CREATE EXTENSION`.** The package chooses which schema states to diff
  with drizzle-kit's `generateMigration()`, and in what order. It adds index entities in drizzle-kit's own
  format, made by drizzle-kit's own serialiser from your `index()` calls. drizzle-kit has no notion of
  extensions, so that one statement is the package's.
- **The suite applies real migrations to Postgres.** It generates a migration chain into a test project, applies
  it with drizzle-orm's migrator on a testcontainers Postgres, and checks the indexes exist and `REFRESH ...
  CONCURRENTLY` succeeds. It covers a changed view, column type changes, an enum losing a value, table renames
  answered both ways, index-only changes, extensions and an unchanged schema, which must match drizzle-kit byte
  for byte.
- **Canaries watch drizzle-kit.** Two tests apply plain drizzle-kit's migrations and expect Postgres to refuse them, with `2BP01` for a changed view and `0A000` for a column type change. The day one fails, drizzle-kit handles
  that case itself.
- **One release per drizzle-kit version.** The package's version is the drizzle-kit version it was tested
  against, pinned exactly, because drizzle-kit's output changes between releases.

## Coming from a workaround?

If you create the indexes or extensions in a custom migration, a post-migration hook or SQL appended to `.as()`,
move them into `pgMaterializedView` and `pgExtension`, and remove the workaround. Then run `baseline` once, so
the next generate knows the database already has them.

## How dependencies are found

The package reads each view's SQL, as drizzle-kit stored it in the migration snapshots, and looks for the names
of other views and of tables. A view is recreated when a view it reads is recreated, or when a table it reads
loses a column or changes a column's type. Renames of tables and columns don't count, because Postgres allows them under a view. There is nothing to declare. A removed or renamed view still has its old dependencies known when
it has to be dropped.

The scan errs towards extra matches, so a name that only looks like a view triggers one unnecessary recreation. It
misses a view the SQL never names, such as one read inside a function the view calls, or a name built at
runtime. Postgres then refuses the migration with `2BP01`, as it would without this package.

## Limits

- **Postgres only, for now.** Other databases get added if there's demand, so
  [open an issue](https://github.com/MMMikeM/extra-drizzle-kit/issues) for the one you need.
- **`generate` only.** `push` isn't supported; see the warning at the top.
- **`drizzle-kit check` can't see conflicts on the statements this package adds.** drizzle-kit records what each
  statement touches, to catch conflicting migrations on parallel branches, and that record isn't public.
- **Merging branches that declare different indexes or extensions is refused.** Make their
  `extra-drizzle-kit.json` files agree, or merge with `drizzle-kit generate` and run `baseline` afterwards.
- **`drizzle.config.ts` is loaded with Node's own `import()`** to find the migrations folder, so its relative
  imports need file extensions. Your schema files are loaded by drizzle-kit, as before.
- **`--explain` previews drizzle-kit's own plan.** It is passed to drizzle-kit unchanged, so the
  preview lacks the reordered view statements and the index statements that `generate` then writes.
- **Node 23.6 or later.**

## For coding agents

The installed package has an `AGENTS.md` with the rules for working in a project that uses it. Its first rule is to generate migrations with `extra-drizzle-kit generate`, never `drizzle-kit generate`.

## License

MIT
