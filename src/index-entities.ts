import { Column, is, SQL } from "drizzle-orm"
import { generateDrizzleJson } from "drizzle-kit/api-postgres"
import {
	type AnyPgColumnBuilder,
	getMaterializedViewConfig,
	getTableConfig,
	IndexedColumn,
	pgSchema,
	pgTable,
	type PgMaterializedView,
	text,
} from "drizzle-orm/pg-core"
import type { Declaration } from "./registry.ts"
import type { Entity } from "./state.ts"

type IndexConfig = { name?: string; columns: unknown[] }

// generateDrizzleJson calls process.exit(1) on these, so they are caught here first with a message that names
// the view.
const assertConvertible = (view: string, configs: IndexConfig[]) => {
	for (const { name, columns } of configs) {
		for (const column of columns) {
			if (is(column, SQL)) {
				if (!name) throw new Error(`An expression index on ${view} needs a name: index("name").on(sql\`...\`).`)
			} else if (!is(column, IndexedColumn) || typeof column.name !== "string") {
				throw new Error(
					`An index on ${view} uses a field that isn't one of the view's columns. Index a field the view ` +
						"selects, or index the expression with a named index.",
				)
			}
		}
	}
}

// A query-builder view selects columns and `sql\`...\`.as()` aliases, and Postgres names each output column after
// the column or the alias. A text column of that name stands in for each field; an index only reads the name.
const outputColumns = (view: PgMaterializedView): Record<string, AnyPgColumnBuilder> =>
	Object.fromEntries(
		Object.entries(getMaterializedViewConfig(view).selectedFields).flatMap(([key, field]) => {
			if (is(field, Column)) return [[key, text(field.name)]]
			if (is(field, SQL.Aliased)) return [[key, text(field.fieldAlias)]]
			return []
		}),
	)

// Kit's serializer reads indexes only from tables. A table named after the view, with the view's columns and never
// exported, carries the index builders, so kit's own serializer produces the index entities. The callback gets the
// columns a table's indexes get, which is why `.desc()`, `.nullsFirst()` and `.op()` work on a view's fields.
const indexesOf = async ({ view, indexes, columns }: Declaration): Promise<Entity[]> => {
	const { name, schema } = getMaterializedViewConfig(view)
	const table = (schema && schema !== "public" ? pgSchema(schema).table : pgTable) as typeof pgTable
	const carrier = table(name, columns ?? outputColumns(view), (extraColumns) => indexes(extraColumns as never))
	assertConvertible(name, getTableConfig(carrier).indexes.map((index) => index.config))
	const { ddl } = await generateDrizzleJson({ carrier })
	return ddl.filter((entity) => entity.entityType === "indexes")
}

export const indexEntities = async (declared: Declaration[]): Promise<Entity[]> => {
	const entities = (await Promise.all(declared.map(indexesOf))).flat()
	const seen = new Set<string>()
	for (const { schema, name } of entities as Entity[] & { schema: string; name: string }[]) {
		const key = `${schema}.${name}`
		if (seen.has(key)) throw new Error(`Two indexes are named ${key}. Postgres needs index names unique in a schema.`)
		seen.add(key)
	}
	return entities
}
