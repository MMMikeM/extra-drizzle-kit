import { describe, expect, it } from "vite-plus/test"
import { dependencies, nameChains, topologicalOrder, viewKey, viewsOf, withDependents } from "../../src/graph.ts"

const view = (name: string, definition: string, schema = "public") => ({
	entityType: "views",
	schema,
	name,
	definition,
	materialized: false,
})

describe("nameChains", () => {
	it("reads quoted, qualified and unquoted names, folding only the unquoted ones", () => {
		expect(nameChains(`select "id" from "app"."Mixed Case" join Other_View on x.y = 1`)).toEqual([
			["select"],
			["id"],
			["from"],
			["app", "Mixed Case"],
			["join"],
			["other_view"],
			["on"],
			["x", "y"],
		])
	})

	it("skips strings, comments and dollar quotes", () => {
		expect(nameChains(`select 'base_view' -- base_view\n/* base_view */ $$base_view$$, 1`)).toEqual([["select"]])
	})

	it("reads unquoted names with non-ASCII letters", () => {
		expect(nameChains(`select * from café_view`)).toEqual([["select"], ["from"], ["café_view"]])
	})

	it("reads on after a backslash-escaped quote and a dollar quote with digits in its tag", () => {
		expect(nameChains(String.raw`select E'it\'s' from base_view`)).toEqual([["select"], ["from"], ["base_view"]])
		expect(nameChains(`select $fn1$ it's $fn1$ from base_view`)).toEqual([["select"], ["from"], ["base_view"]])
	})
})

describe("dependencies", () => {
	const views = viewsOf([
		view("base_view", `select "id" from "users"`),
		view("joined", `select 1 from "users" left join "app"."Mixed Case" on true`),
		view("Mixed Case", `select "id" from "users"`, "app"),
		view("search_index", `select "id" from "base_view" union all select "id" from "joined"`),
	])
	const graph = dependencies(views)
	const key = (name: string, schema = "public") => viewKey({ schema, name })

	it("finds views read by name, by qualified name and through a join", () => {
		expect([...graph.get(key("search_index"))!]).toEqual([key("base_view"), key("joined")])
		expect([...graph.get(key("joined"))!]).toEqual([key("Mixed Case", "app")])
	})

	it("adds every view that reads a changed one, transitively", () => {
		expect([...withDependents(graph, [key("Mixed Case", "app")])].sort()).toEqual(
			[key("Mixed Case", "app"), key("joined"), key("search_index")].sort(),
		)
	})

	it("orders each view after the views it reads", () => {
		const order = topologicalOrder(graph, [key("search_index"), key("joined"), key("Mixed Case", "app")])
		expect(order).toEqual([key("Mixed Case", "app"), key("joined"), key("search_index")])
	})
})
