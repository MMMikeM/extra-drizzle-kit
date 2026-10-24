import { sql } from "drizzle-orm"
import { generateDrizzleJson } from "drizzle-kit/api-postgres"
import { index, integer, pgSchema, pgTable, pgView, text, uniqueIndex } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vite-plus/test"
import { assemble, needsRewrite, plan } from "../../src/assemble.ts"
import { indexEntities } from "../../src/index-entities.ts"
import { pgMaterializedView } from "../../src/index.ts"
import { clearDeclarations, declarations } from "../../src/registry.ts"

const users = pgTable("users", { id: integer("id").primaryKey(), name: text("name") })

const schemaState = async (where?: string, indexes = (mv: { id: unknown; name: unknown }) => [uniqueIndex("search_index_id_idx").on(mv.id as never)]) => {
	clearDeclarations()
	const base = pgView("base_view", { id: integer("id"), name: text("name") }).as(
		where ? sql`select "id", "name" from ${users} where ${sql.raw(where)}` : sql`select "id", "name" from ${users}`,
	)
	const searchIndex = pgMaterializedView("search_index", { id: integer("id"), name: text("name") }, indexes).as(
		sql`select "id", "name" from ${base}`,
	)
	const state = await generateDrizzleJson({ users, base, searchIndex })
	return { state, indexes: await indexEntities(declarations()) }
}

const input = async (from: Awaited<ReturnType<typeof schemaState>>, to: Awaited<ReturnType<typeof schemaState>>) => ({
	prev: from.state,
	cur: to.state,
	hints: [],
	viewRenames: new Map(),
	prevIndexes: from.indexes,
	curIndexes: to.indexes,
})

describe("plan", () => {
	it("leaves kit's migration alone when no view and no index changes", async () => {
		const v1 = await schemaState()
		expect(needsRewrite(plan(await input(v1, v1)))).toBe(false)
	})
})

describe("assemble", () => {
	it("drops the dependent matview first and recreates it, with its index, after the changed view", async () => {
		const statements = await assemble(await input(await schemaState(), await schemaState(`"id" > 0`)))
		expect(statements).toEqual([
			'DROP MATERIALIZED VIEW "search_index";',
			'DROP VIEW "base_view";',
			'CREATE VIEW "base_view" AS (select "id", "name" from "users" where "id" > 0);',
			'CREATE MATERIALIZED VIEW "search_index" AS (select "id", "name" from "base_view");',
			'CREATE UNIQUE INDEX "search_index_id_idx" ON "search_index" ("id");',
		])
	})

	it("creates a new matview's indexes after the view", async () => {
		const v1 = await schemaState()
		const statements = await assemble(await input({ state: { ...v1.state, ddl: [] }, indexes: [] }, v1))
		expect(statements.at(-1)).toBe('CREATE UNIQUE INDEX "search_index_id_idx" ON "search_index" ("id");')
		expect(statements.findIndex((s) => s.startsWith("CREATE MATERIALIZED VIEW"))).toBeLessThan(statements.length - 1)
	})

	it("replaces an index under a new name without asking kit about a rename", async () => {
		const before = await schemaState()
		const after = await schemaState(undefined, (mv) => [index().on(mv.name as never)])
		expect(await assemble(await input(before, after))).toEqual([
			'DROP INDEX "search_index_id_idx";',
			'CREATE INDEX "search_index_name_index" ON "search_index" ("name");',
		])
	})

	it("drops a matview's index before a table takes its name in the same migration", async () => {
		const before = await schemaState()
		const after = await schemaState(undefined, () => [])
		const notes = pgTable("notes", { id: integer("id") }, (t) => [index("search_index_id_idx").on(t.id)])
		const cur = { ...after.state, ddl: [...after.state.ddl, ...(await generateDrizzleJson({ notes })).ddl] }
		const statements = await assemble({ ...(await input(before, after)), cur })
		expect(statements.indexOf('DROP INDEX "search_index_id_idx";')).toBeGreaterThanOrEqual(0)
		expect(statements.indexOf('DROP INDEX "search_index_id_idx";')).toBeLessThan(
			statements.findIndex((s) => s.startsWith('CREATE INDEX "search_index_id_idx" ON "notes"')),
		)
	})

	it("creates a new extension first, after creating its schema when that is new too", async () => {
		const v1 = await schemaState()
		const extensions = pgSchema("extensions")
		const cur = { ...v1.state, ddl: [...v1.state.ddl, ...(await generateDrizzleJson({ extensions })).ddl] }
		const statements = await assemble({
			...(await input(v1, v1)),
			cur,
			curExtensions: [
				{ name: "pg_trgm", schema: null },
				{ name: "vector", schema: "extensions" },
			],
		})
		expect(statements.slice(0, 3)).toEqual([
			'CREATE SCHEMA "extensions";\n',
			'CREATE EXTENSION IF NOT EXISTS "pg_trgm";',
			'CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "extensions";',
		])
		expect(statements.filter((s) => s.startsWith("CREATE SCHEMA"))).toHaveLength(1)
	})

	it("never drops an extension that is no longer declared", async () => {
		const v1 = await schemaState()
		const p = plan({ ...(await input(v1, v1)), prevExtensions: [{ name: "pg_trgm", schema: null }] })
		expect(p.removedExtensions).toEqual([{ name: "pg_trgm", schema: null }])
		expect(needsRewrite(p)).toBe(false)
	})
})
