# @mmmike/drizzle-kit-matview

**`drizzle-kit generate` that gets materialized views right, including their indexes and the views that depend on a changed view or column.**

You change a view that a materialized view reads, run `drizzle-kit generate`, and get a migration Postgres
refuses: `2BP01: cannot drop view active_users because other objects depend on it`. drizzle-kit drops and
recreates the view you changed and leaves the materialized view on top of it in place. And when it does recreate
a materialized view, every index on it is gone, because drizzle-kit has no way to declare one
([drizzle-orm#2976](https://github.com/drizzle-team/drizzle-orm/issues/2976), open since 2024). Without its
unique index, `REFRESH MATERIALIZED VIEW CONCURRENTLY` stops working.

The usual fixes are hand-written, such as a custom migration, a post-migration hook, or `CREATE INDEX` slipped into the
view's `.as()`. This package lets you declare the indexes with drizzle's own `index()` and `uniqueIndex()`, and
orders the migration so Postgres accepts it. drizzle-kit writes every statement.

```sh
pnpm add -D @mmmike/drizzle-kit-matview drizzle-kit@1.0.0-rc.5
pnpm add drizzle-orm@1.0.0-rc.5
```

## Before and after

`user_names` is a materialized view that reads the view `active_users`, with a unique index on `id`. Change
`active_users` to add `where "id" > 0`. Plain drizzle-kit writes:

```sql
DROP VIEW "active_users";  -- 2BP01: user_names depends on it
CREATE VIEW "active_users" AS (select "id", "name" from "users" where "id" > 0);
```

`drizzle-kit-matview generate` writes:

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
import { pgMaterializedView } from "@mmmike/drizzle-kit-matview"

export const users = pgTable("users", { id: integer("id").primaryKey(), name: text("name") })

export const activeUsers = pgView("active_users", { id: integer("id"), name: text("name") }).as(
	sql`select "id", "name" from ${users}`,
)

export const userNames = pgMaterializedView("user_names", { id: integer("id"), name: text("name") }, (mv) => [
	uniqueIndex("user_names_id_idx").on(mv.id),
]).as(sql`select "id", "name" from ${activeUsers}`)
```

**2. Run `drizzle-kit-matview generate` wherever you ran `drizzle-kit generate`.** It passes every argument to
drizzle-kit unchanged, so `--name`, `--config`, `--hints`, `--custom`, `--output json` and the interactive rename
prompts work as before.

```sh
pnpm drizzle-kit-matview generate
```

Replace `drizzle-kit generate` in your scripts too. Running it directly still works, but it writes exactly the
migrations this package exists to fix, and nothing warns you.

**3. On a database that already has these indexes, run `baseline` once first.** It records the indexes you
declare as already applied, and writes no SQL. Without it, the first generate creates them again and Postgres
refuses with `42P07`.

```sh
pnpm drizzle-kit-matview baseline
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
import { materializedViewIn } from "@mmmike/drizzle-kit-matview"

const reporting = pgSchema("reporting")
export const totals = materializedViewIn(reporting)("totals", { day: date("day") }, (mv) => [uniqueIndex().on(mv.day)])
	.as(sql`select ...`)
```

An index can be on the view's columns, or on a `sql` expression in a named index:
``index("by_lower_name").on(sql`lower(name)`)``. A field selected as `` sql`...`.as("alias") `` isn't a column,
and generate refuses an index on it.

## What a run writes

- **drizzle-kit's own migration, byte for byte, when no view and no index changes.**
- **A reordered `migration.sql`, when a view changes that other views read, a column a view reads is dropped or
  changes type, or an index changes.** It drops the affected views, then runs everything else, then recreates
  the views, each after the views it reads, then creates the indexes. Postgres refuses a column type change
  under a view with `0A000`, which plain drizzle-kit runs into
  ([drizzle-orm#6194](https://github.com/drizzle-team/drizzle-orm/issues/6194)).
- **A migration of its own, when only indexes change.** drizzle-kit sees no change then, so the package has it
  write an empty custom migration and fills that in.
- **A `matview-indexes.json` in every migration folder.** It records the indexes on materialized views after that
  migration, because drizzle-kit's snapshots can't hold them. drizzle-kit and drizzle-orm's migrator ignore it.
  Commit it with the migration.

## How it's tested

- **drizzle-kit writes every statement.** The package chooses which schema states to diff with drizzle-kit's
  `generateMigration()`, and in what order. It adds index entities in drizzle-kit's own format, made by
  drizzle-kit's own serialiser from your `index()` calls.
- **The suite applies real migrations to Postgres.** It generates a migration chain into a test project, applies
  it with drizzle-orm's migrator on a testcontainers Postgres, and checks the indexes exist and
  `REFRESH ... CONCURRENTLY` succeeds. It covers a changed view, table renames answered both ways, index-only
  changes and an unchanged schema, which must match drizzle-kit byte for byte.
- **Canaries watch drizzle-kit.** Two tests apply plain drizzle-kit's migrations and expect Postgres to refuse them, with `2BP01` for a changed view and `0A000` for a column type change. The day one fails, drizzle-kit handles that
  case itself.
- **One release per drizzle-kit version.** The package's version is the drizzle-kit version it was tested
  against, pinned exactly, because drizzle-kit's output changes between releases.

## Coming from a workaround?

If you create the indexes in a custom migration, a post-migration hook or SQL appended to `.as()`, move them
into `pgMaterializedView` and remove the workaround. Then run `baseline` once, so the next generate knows the
database already has them.

## How dependencies are found

The package reads each view's SQL, as drizzle-kit stored it in the migration snapshots, and looks for the names
of other views and of tables. A view is recreated when a view it reads is recreated, or when a table it reads
loses a column or changes a column's type. Renames of tables and columns don't count, because Postgres allows them under a view. There is nothing to declare. A removed or renamed view still has its old dependencies known when
it has to be dropped.

The scan errs towards extra matches, so a name that only looks like a view triggers one unnecessary recreation. It
misses a view the SQL never names, such as one read inside a function the view calls, or a name built at
runtime. Postgres then refuses the migration with `2BP01`, as it would without this package.

## Limits

- **Postgres and `generate` only.** `drizzle-kit push` never reads indexes on materialized views from the
  database, so this package doesn't cover `push`.
- **`drizzle-kit check` can't see conflicts on the statements this package adds.** drizzle-kit records what each
  statement touches, to catch conflicting migrations on parallel branches, and that record isn't public.
- **Merging branches that declare different indexes is refused.** Make their `matview-indexes.json` files agree,
  or merge with `drizzle-kit generate` and run `baseline` afterwards.
- **`drizzle.config.ts` is loaded with Node's own `import()`** to find the migrations folder, so its relative
  imports need file extensions. Your schema files are loaded by drizzle-kit, as before.
- **Node 23.6 or later.**

## For coding agents

The installed package has an `AGENTS.md` with the rules for working in a project that uses it. Its first rule is to generate migrations with `drizzle-kit-matview generate`, never `drizzle-kit generate`.

## License

MIT
