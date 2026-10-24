# @mmmike/drizzle-kit-matview

This project generates its drizzle migrations with `@mmmike/drizzle-kit-matview`, so that materialized views keep
their indexes and the views that depend on a changed view are recreated in order.

## Rules

- **Generate migrations with `drizzle-kit-matview generate`, never `drizzle-kit generate`.** Pass the same
  arguments you would pass to drizzle-kit. Plain `drizzle-kit generate` succeeds, but writes a migration that
  Postgres refuses with `2BP01` when a view that others read changes, and that loses the indexes of every
  materialized view it recreates.
- **Declare materialized views with this package's `pgMaterializedView`**, imported from
  `@mmmike/drizzle-kit-matview`, not drizzle's from `drizzle-orm/pg-core`. Use `materializedViewIn(schema)` for a
  view outside `public`. It takes drizzle's arguments, plus the indexes.
- **Declare indexes on a materialized view with drizzle's `index()` and `uniqueIndex()` in that argument.** Never
  write `CREATE INDEX` for one in a custom migration, a hook, or the view's `.as()`.
- **Don't edit a generated `migration.sql` by hand to reorder views or add indexes.** Change the schema and
  generate again.
- **Commit each migration folder's `matview-indexes.json` with its `migration.sql` and `snapshot.json`.** Don't
  delete it: the next generate reads it to know which indexes already exist.
- **Run `drizzle-kit-matview baseline` only when the database already has the declared indexes** and the
  migrations folder doesn't record them yet, for example when adopting the package.
- **Answer drizzle-kit's rename questions as usual**, interactively or with `--hints`. The package reads the
  answers from the snapshot drizzle-kit writes.

## Declaring indexes

```ts
import { pgMaterializedView } from "@mmmike/drizzle-kit-matview"

// Declared columns: the indexes are the third argument, as for pgTable.
export const userNames = pgMaterializedView("user_names", { id: integer("id"), name: text("name") }, (mv) => [
	uniqueIndex("user_names_id_idx").on(mv.id),
]).as(sql`select "id", "name" from ${activeUsers}`)

// Query builder: the indexes are the second argument of `.as()`.
export const names = pgMaterializedView("names").as(
	(qb) => qb.select({ id: users.id }).from(users),
	(mv) => [uniqueIndex().on(mv.id)],
)
```

With declared columns, the callback gets a table's index columns, so `.desc()`, `.nullsFirst()` and
`.op("gin_trgm_ops")` work. In the query-builder form they don't; declare the view's columns when you need them.

An index can be on the view's columns, or on a `sql` expression in a named index. A field selected as
`` sql`...`.as("alias") `` isn't a column, and generate refuses an index on it.
