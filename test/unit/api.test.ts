import { sql } from "drizzle-orm"
import { index, integer, pgSchema, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"
import { beforeEach, describe, expect, expectTypeOf, it } from "vite-plus/test"
import { indexEntities } from "../../src/index-entities.ts"
import { materializedViewIn, pgMaterializedView } from "../../src/index.ts"
import { clearDeclarations, declarations } from "../../src/registry.ts"

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
