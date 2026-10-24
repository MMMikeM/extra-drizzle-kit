import { sql } from "drizzle-orm"
import { index, integer, pgSchema, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"
import { beforeEach, describe, expect, expectTypeOf, it } from "vite-plus/test"
import { indexEntities } from "../../src/index-entities.ts"
import { materializedViewIn, pgExtension, pgMaterializedView } from "../../src/index.ts"
import { clearDeclarations, declarations, declaredExtensions } from "../../src/registry.ts"

const users = pgTable("users", { id: integer("id").primaryKey(), name: text("name") })

beforeEach(clearDeclarations)

describe("pgMaterializedView", () => {
	it("records the indexes of a view with declared columns, through option methods", async () => {
		const mv = pgMaterializedView("mv", { id: integer("id"), name: text("name") }, (view) => [
			uniqueIndex("mv_id_idx").on(view.id),
		])
			.withNoData()
			.as(sql`select "id", "name" from ${users}`)
		expectTypeOf(mv.name).not.toBeAny()
		const [entity] = await indexEntities(declarations())
		expect(entity).toMatchObject({ table: "mv", name: "mv_id_idx", isUnique: true, columns: [{ value: "id" }] })
	})

	it("gives declared columns a table's index options: order, nulls and operator class", async () => {
		pgMaterializedView("ranked", { score: integer("score"), name: text("name") }, (t) => [
			index("ranked_score_idx").on(t.score.desc().nullsLast()),
			index("ranked_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
		]).as(sql`select 1 as score, 'a' as name`)
		const entities = await indexEntities(declarations())
		expect(entities).toMatchObject([
			{ name: "ranked_score_idx", columns: [{ value: "score", asc: false, nullsFirst: false }] },
			{ name: "ranked_name_trgm_idx", method: "gin", columns: [{ value: "name", opclass: { name: "gin_trgm_ops" } }] },
		])
	})

	it("records the indexes of a query-builder view, given to as()", async () => {
		const mv = pgMaterializedView("names").as((qb) => qb.select({ id: users.id }).from(users), (view) => [
			index().on(view.id),
		])
		expectTypeOf(mv.id).not.toBeAny()
		expect((await indexEntities(declarations())).map((e) => e.name)).toEqual(["names_id_index"])
	})

	it("records nothing for a view without indexes", () => {
		pgMaterializedView("plain", { id: integer("id") }).as(sql`select 1 as id`)
		expect(declarations()).toEqual([])
	})

	it("keeps drizzle's existing(), and records nothing for an existing view", () => {
		const mv = pgMaterializedView("legacy", { id: integer("id") }).existing()
		expectTypeOf(mv.id).not.toBeAny()
		expect(declarations()).toEqual([])
	})

	it("puts the indexes of a view in another Postgres schema there", async () => {
		const mv = materializedViewIn(pgSchema("app"))("mv", { id: integer("id") }, (view) => [uniqueIndex().on(view.id)]).as(
			sql`select 1 as id`,
		)
		expectTypeOf(mv.id).not.toBeAny()
		expect(await indexEntities(declarations())).toMatchObject([{ schema: "app", table: "mv", name: "mv_id_index" }])
	})

	it("refuses an index on a sql alias, which has no column name", async () => {
		pgMaterializedView("aliased").as(
			(qb) => qb.select({ upper: sql<string>`upper(${users.name})`.as("upper") }).from(users),
			// @ts-expect-error -- drizzle's index().on() types reject a sql alias too
			(view) => [index().on(view.upper)],
		)
		await expect(indexEntities(declarations())).rejects.toThrow("isn't a column of the view")
	})
})

describe("pgExtension", () => {
	it("records each extension once, with its schema", () => {
		pgExtension("pg_trgm")
		pgExtension("pg_trgm")
		pgExtension("vector", { schema: "extensions" })
		expect(declaredExtensions()).toEqual([
			{ name: "pg_trgm", schema: null },
			{ name: "vector", schema: "extensions" },
		])
	})

	it("refuses one extension declared in two schemas", () => {
		pgExtension("vector")
		expect(() => pgExtension("vector", { schema: "extensions" })).toThrow("declared twice")
	})
})

