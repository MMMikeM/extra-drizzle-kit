import { generateDrizzleJson, type Hint } from "drizzle-kit/api-postgres"
import { integer, pgTable, text, varchar } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vite-plus/test"
import { tablesWithBrokenColumns } from "../../src/columns.ts"
import { viewKey } from "../../src/graph.ts"

const state = (table: Parameters<typeof generateDrizzleJson>[0]) => generateDrizzleJson(table)
const customers = viewKey({ schema: "public", name: "customers" })

describe("tablesWithBrokenColumns", () => {
	it("finds a table whose column changes type or is dropped", async () => {
		const prev = await state({ t: pgTable("customers", { id: integer("id"), name: text("name") }) })
		const retyped = await state({ t: pgTable("customers", { id: integer("id"), name: varchar("name", { length: 9 }) }) })
		const dropped = await state({ t: pgTable("customers", { id: integer("id") }) })
		expect([...tablesWithBrokenColumns(prev, retyped, [])]).toEqual([customers])
		expect([...tablesWithBrokenColumns(prev, dropped, [])]).toEqual([customers])
	})

	it("follows table and column renames, which Postgres allows under a view", async () => {
		const prev = await state({ t: pgTable("customers", { id: integer("id"), name: text("name") }) })
		const cur = await state({ t: pgTable("clients", { id: integer("id"), label: text("label") }) })
		const hints = [
			{ type: "rename", kind: "table", from: ["public", "customers"], to: ["public", "clients"] },
			{ type: "rename", kind: "column", from: ["public", "clients", "name"], to: ["public", "clients", "label"] },
		] as Hint[]
		expect([...tablesWithBrokenColumns(prev, cur, hints)]).toEqual([])
	})

	it("ignores a new column", async () => {
		const prev = await state({ t: pgTable("customers", { id: integer("id") }) })
		const cur = await state({ t: pgTable("customers", { id: integer("id"), name: text("name") }) })
		expect([...tablesWithBrokenColumns(prev, cur, [])]).toEqual([])
	})
})
