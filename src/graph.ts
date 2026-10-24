import type { Entity } from "./state.ts"

export type View = Entity & { schema: string; name: string; definition: string | null; materialized: boolean }
export type ViewKey = string
export type Graph = Map<ViewKey, Set<ViewKey>>

export const viewKey = ({ schema, name }: { schema: string; name: string }): ViewKey => JSON.stringify([schema, name])

export const viewsOf = (ddl: Entity[]): Map<ViewKey, View> =>
	new Map(ddl.filter((entity): entity is View => entity.entityType === "views").map((view) => [viewKey(view), view]))

const skipQuoted = (sql: string, from: number, quote: string): number => {
	let i = from + 1
	while (i < sql.length) {
		if (sql[i] === quote) {
			if (sql[i + 1] !== quote) return i + 1
			i += 2
		} else i += 1
	}
	return i
}

/** The dotted name chains in a SQL text, outside strings and comments, with unquoted parts folded to lower case. */
export const nameChains = (sql: string): string[][] => {
	const chains: string[][] = []
	let chain: string[] = []
	let afterDot = false
	const end = () => {
		if (chain.length > 0) chains.push(chain)
		chain = []
		afterDot = false
	}
	let i = 0
	while (i < sql.length) {
		const c = sql[i]
		if (c === "'") {
			end()
			i = skipQuoted(sql, i, "'")
		} else if (c === "-" && sql[i + 1] === "-") {
			end()
			const eol = sql.indexOf("\n", i)
			i = eol === -1 ? sql.length : eol
		} else if (c === "/" && sql[i + 1] === "*") {
			end()
			const close = sql.indexOf("*/", i + 2)
			i = close === -1 ? sql.length : close + 2
		} else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
			end()
			const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/)![0]
			const close = sql.indexOf(tag, i + tag.length)
			i = close === -1 ? sql.length : close + tag.length
		} else if (c === '"') {
			const next = skipQuoted(sql, i, '"')
			const part = sql.slice(i + 1, next - 1).replaceAll('""', '"')
			if (!afterDot) end()
			chain.push(part)
			afterDot = false
			i = next
		} else if (/[A-Za-z_]/.test(c)) {
			const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/)![0]
			if (!afterDot) end()
			chain.push(word.toLowerCase())
			afterDot = false
			i += word.length
		} else if (c === ".") {
			afterDot = chain.length > 0
			i += 1
		} else if (/\s/.test(c)) {
			i += 1
		} else {
			end()
			i += 1
		}
	}
	end()
	return chains
}

/**
 * The views each view reads, found in its definition. It over-matches on purpose: a name that only looks like a
 * view costs an extra recreation, and a missed one brings back the drop that Postgres refuses with 2BP01.
 */
export const dependencies = (views: Map<ViewKey, View>): Graph => {
	const byName = new Map<string, ViewKey[]>()
	for (const [key, view] of views) byName.set(view.name, [...(byName.get(view.name) ?? []), key])

	const graph: Graph = new Map()
	for (const [key, view] of views) {
		const found = new Set<ViewKey>()
		for (const chain of nameChains(view.definition ?? "")) {
			for (const part of chain) for (const match of byName.get(part) ?? []) found.add(match)
			for (let i = 0; i + 1 < chain.length; i++) {
				const qualified = viewKey({ schema: chain[i], name: chain[i + 1] })
				if (views.has(qualified)) found.add(qualified)
			}
		}
		found.delete(key)
		graph.set(key, found)
	}
	return graph
}

/** `seeds` and every view that reads one of them, directly or through other views. */
export const withDependents = (graph: Graph, seeds: Iterable<ViewKey>): Set<ViewKey> => {
	const result = new Set(seeds)
	let grew = true
	while (grew) {
		grew = false
		for (const [key, deps] of graph) {
			if (!result.has(key) && [...deps].some((dep) => result.has(dep))) {
				result.add(key)
				grew = true
			}
		}
	}
	return result
}

/** `keys` with each view after the views it reads. A cycle, which Postgres can't create, keeps its input order. */
export const topologicalOrder = (graph: Graph, keys: Iterable<ViewKey>): ViewKey[] => {
	const wanted = new Set(keys)
	const visited = new Set<ViewKey>()
	const sorted: ViewKey[] = []
	const visit = (key: ViewKey) => {
		if (visited.has(key)) return
		visited.add(key)
		for (const dep of graph.get(key) ?? []) if (wanted.has(dep)) visit(dep)
		sorted.push(key)
	}
	for (const key of wanted) visit(key)
	return sorted
}

export const hasEdgeWithin = (graph: Graph, keys: Set<ViewKey>): boolean =>
	[...keys].some((key) => [...(graph.get(key) ?? [])].some((dep) => keys.has(dep)))
