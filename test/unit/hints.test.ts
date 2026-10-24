import { sql } from "drizzle-orm"
import { generateDrizzleJson } from "drizzle-kit/api-postgres"
import { integer, pgSchema, pgTable, uniqueIndex } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vite-plus/test"
import { needsRewrite, plan } from "../../src/assemble.ts"
import { hintsOf } from "../../src/hints.ts"
import { indexEntities } from "../../src/index-entities.ts"
import { materializedViewIn } from "../../src/index.ts"
import { clearDeclarations, declarations } from "../../src/registry.ts"
import { type Files, leafIds, originId, stateOf } from "../../src/state.ts"

const users = pgTable("users", { id: integer("id").primaryKey() })

const schemaWithView = async (schemaName: string) => {
	clearDeclarations()
	const schema = pgSchema(schemaName)
	const mv = materializedViewIn(schema)("mv", { id: integer("id") }, (view) => [uniqueIndex("mv_id_idx").on(view.id)]).as(
		sql`select "id" from ${users}`,
	)
	const state = await generateDrizzleJson({ users, schema, mv })
	return { state, indexes: await indexEntities(declarations()) }
}

const snapshot = (id: string, prevIds: string[], body: Record<string, unknown>) => ({
	version: "9",
	dialect: "postgres",
	id,
	prevIds,
	footprints: [],
	...body,
})

describe("hintsOf", () => {
	it("follows the views of a renamed schema, so their indexes stay in place", async () => {
		const before = await schemaWithView("app")
		const after = await schemaWithView("analytics")
		const files = {
			"0001_base": snapshot("a", [originId], { type: "base", ddl: before.state.ddl }),
			"0002_rename": snapshot("b", ["a"], {
				type: "diff",
				deltas: [{ op: "rename", key: `schemas\0${JSON.stringify(["app"])}`, set: { name: "analytics" } }],
			}),
		} as unknown as Files
		const cur = await stateOf(files, "b")
		const { hints, views } = await hintsOf(files, files["0002_rename"], cur)

		expect(hints).toContainEqual({ type: "rename", kind: "schema", from: ["app"], to: ["analytics"] })
		expect([...views]).toEqual([[JSON.stringify(["app", "mv"]), JSON.stringify(["analytics", "mv"])]])
		const p = plan({ prev: before.state, cur, hints, viewRenames: views, prevIndexes: before.indexes, curIndexes: after.indexes })
		expect(needsRewrite(p)).toBe(false)
	})
})

describe("leafIds", () => {
	it("lists every branch a new migration starts from", () => {
		const files = {
			"0001_base": snapshot("a", [originId], { type: "base", ddl: [] }),
			"0002_x": snapshot("x", ["a"], { type: "diff", deltas: [] }),
			"0003_y": snapshot("y", ["a"], { type: "diff", deltas: [] }),
		} as unknown as Files
		expect(leafIds(files).sort()).toEqual(["x", "y"])
	})
})
