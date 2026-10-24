import { is, SQL } from "drizzle-orm"
import { generateDrizzleJson } from "drizzle-kit/api-postgres"
import { getMaterializedViewConfig, IndexedColumn, type IndexBuilder, pgSchema, pgTable } from "drizzle-orm/pg-core"
import type { Declaration } from "./registry.ts"
import type { Entity } from "./state.ts"

type BuilderConfig = { name?: string; columns: unknown[] }

const configOf = (builder: IndexBuilder) => (builder as unknown as { config: BuilderConfig }).config

// generateDrizzleJson calls process.exit(1) on these, so they are caught here first with a message that names
// the view.
const assertConvertible = (view: string, builders: IndexBuilder[]) => {
	for (const builder of builders) {
		const { name, columns } = configOf(builder)
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

// Kit's serializer reads indexes only from tables. A table that only carries the view's index builders, and is
// never exported, makes kit's own serializer produce the index entities.
const indexesOf = async ({ view, indexes }: Declaration): Promise<Entity[]> => {
	const { name, schema } = getMaterializedViewConfig(view)
	const builders = indexes(view as never)
	assertConvertible(name, builders)
	const extraConfig = () => builders
	const carrier =
		schema && schema !== "public" ? pgSchema(schema).table(name, {}, extraConfig) : pgTable(name, {}, extraConfig)
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
