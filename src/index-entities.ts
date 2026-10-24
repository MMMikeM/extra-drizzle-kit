import { is, SQL } from "drizzle-orm"
import { generateDrizzleJson } from "drizzle-kit/api-postgres"
import { getMaterializedViewConfig, getTableConfig, IndexedColumn, pgSchema, pgTable } from "drizzle-orm/pg-core"
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
					`An index on ${view} uses a field that isn't a column of the view, such as a sql\`...\`.as() alias. ` +
						"Declare the view's columns, or index the expression with a named index.",
				)
			}
		}
	}
}

// Kit's serializer reads indexes only from tables. A table named after the view, never exported, carries the
// index builders, so kit's own serializer produces the index entities. With declared columns the table has the
// view's columns, which gives the callback the same columns a table's indexes get.
const indexesOf = async ({ view, indexes, columns }: Declaration): Promise<Entity[]> => {
	const { name, schema } = getMaterializedViewConfig(view)
	const table = (schema && schema !== "public" ? pgSchema(schema).table : pgTable) as typeof pgTable
	const carrier = columns
		? table(name, columns, (extraColumns) => indexes(extraColumns as never))
		: table(name, {}, () => indexes(view as never))
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
