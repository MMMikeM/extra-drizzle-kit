import { generateMigration, type Hint } from "drizzle-kit/api-postgres"
import { tablesWithBrokenColumns } from "./columns.ts"
import {
	dependencies,
	type Graph,
	hasEdgeWithin,
	references,
	topologicalOrder,
	type View,
	type ViewKey,
	viewKey,
	viewsOf,
	withDependents,
} from "./graph.ts"
import { sameEntity } from "./ledger.ts"
import type { Extension } from "./registry.ts"
import type { Entity, State } from "./state.ts"

export type Input = {
	prev: State
	cur: State
	hints: Hint[]
	/** Each renamed view's key in `prev` mapped to its key in `cur`. */
	viewRenames: Map<ViewKey, ViewKey>
	prevIndexes: Entity[]
	curIndexes: Entity[]
	prevExtensions?: Extension[]
	curExtensions?: Extension[]
}

type IndexRow = Entity & { schema: string; table: string }

const tableKey = (index: IndexRow): ViewKey => viewKey({ schema: index.schema, name: index.table })

const withDdl = (state: State, ddl: Entity[]): State => ({ ...state, ddl } as State)

const without = (state: State, keys: Set<ViewKey>): State =>
	withDdl(state, state.ddl.filter((entity) => entity.entityType !== "views" || !keys.has(viewKey(entity as View))))

/** Views whose drop kit would emit: dropped from the schema, or recreated because the definition or kind changed. */
const droppedOrRecreated = (prev: Map<ViewKey, View>, cur: Map<ViewKey, View>, renames: Map<ViewKey, ViewKey>) =>
	[...prev].flatMap(([key, view]) => {
		const next = cur.get(renames.get(key) ?? key)
		return !next || next.definition !== view.definition || next.materialized !== view.materialized ? [key] : []
	})

export type Plan = {
	/** Views to drop first, dependents before what they read. */
	drops: ViewKey[]
	/** Views to create after everything else, each after what it reads. */
	creates: ViewKey[]
	/** Indexes to drop from views that stay, under their names before the migration. */
	dropIndexes: IndexRow[]
	keptIndexes: IndexRow[]
	createIndexes: IndexRow[]
	createExtensions: Extension[]
	/** Extensions no longer declared. The package never drops one, because the drop can take data with it. */
	removedExtensions: Extension[]
	prevGraph: Graph
	curGraph: Graph
	/** Whether a view is recreated around a column change that kit would run under it. */
	underBrokenTables: boolean
}

/** Views that read a table losing a column or changing a column's type, which Postgres refuses under a view. */
const readingBrokenTables = (prev: State, cur: State, hints: Hint[], prevViews: Map<ViewKey, View>) => {
	const broken = tablesWithBrokenColumns(prev, cur, hints)
	if (broken.size === 0) return []
	const tables = prev.ddl.filter((entity) => entity.entityType === "tables") as (Entity & { schema: string; name: string })[]
	const reads = references(prevViews, tables)
	return [...reads].flatMap(([view, read]) => ([...read].some((table) => broken.has(table)) ? [view] : []))
}

export const plan = ({
	prev,
	cur,
	hints,
	viewRenames,
	prevIndexes,
	curIndexes,
	prevExtensions = [],
	curExtensions = [],
}: Input): Plan => {
	const prevViews = viewsOf(prev.ddl)
	const curViews = viewsOf(cur.ddl)
	const prevGraph = dependencies(prevViews)
	const curGraph = dependencies(curViews)
	const toPrev = new Map([...viewRenames].map(([from, to]) => [to, from]))

	const underBroken = readingBrokenTables(prev, cur, hints, prevViews)
	const recreated = withDependents(prevGraph, [...droppedOrRecreated(prevViews, curViews, viewRenames), ...underBroken])
	const creates = new Set(
		[...curViews.keys()].filter((key) => {
			const before = toPrev.get(key) ?? key
			return recreated.has(before) || !prevViews.has(before)
		}),
	)

	for (const index of curIndexes as IndexRow[]) {
		const view = curViews.get(tableKey(index))
		if (!view?.materialized) {
			throw new Error(`Index ${index.name} is declared on ${index.schema}.${index.table}, which isn't a materialized view in the schema.`)
		}
	}
	const untouched = (key: ViewKey) => curViews.get(key)?.materialized === true && !creates.has(key)
	const renamedIndex = (index: IndexRow): IndexRow => {
		const key = viewRenames.get(tableKey(index))
		if (!key) return index
		const [schema, table] = JSON.parse(key) as [string, string]
		return { ...index, schema, table }
	}
	const standing = (prevIndexes as IndexRow[])
		.map((before) => ({ before, after: renamedIndex(before) }))
		.filter(({ after }) => untouched(tableKey(after)))
	const isKept = (index: IndexRow) => curIndexes.some((other) => sameEntity(index, other))
	const keptIndexes = standing.filter(({ after }) => isKept(after)).map(({ after }) => after)
	const dropIndexes = standing.filter(({ after }) => !isKept(after)).map(({ before }) => before)
	const createIndexes = (curIndexes as IndexRow[]).filter((index) => !keptIndexes.some((kept) => sameEntity(index, kept)))

	return {
		drops: topologicalOrder(prevGraph, recreated).reverse(),
		creates: topologicalOrder(curGraph, creates),
		dropIndexes,
		keptIndexes,
		createIndexes,
		createExtensions: curExtensions.filter((e) => !prevExtensions.some((other) => other.name === e.name)),
		removedExtensions: prevExtensions.filter((e) => !curExtensions.some((other) => other.name === e.name)),
		prevGraph,
		curGraph,
		underBrokenTables: underBroken.length > 0,
	}
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`

// The one statement the package writes itself: kit has no entity for extensions, and `IF NOT EXISTS` makes it
// safe on a database that already has the extension.
const createExtension = ({ name, schema }: Extension) =>
	`CREATE EXTENSION IF NOT EXISTS ${quoted(name)}${schema ? ` WITH SCHEMA ${quoted(schema)}` : ""};`

/**
 * Kit's own migration is right when no view depends on another that it drops, no column change runs under a
 * view, no index needs SQL and no extension is new.
 */
export const needsRewrite = (p: Plan): boolean =>
	p.underBrokenTables ||
	hasEdgeWithin(p.prevGraph, new Set(p.drops)) ||
	hasEdgeWithin(p.curGraph, new Set(p.creates)) ||
	p.dropIndexes.length > 0 ||
	p.createIndexes.length > 0 ||
	p.createExtensions.length > 0

/**
 * The migration from `prev` to `cur`, every statement written by kit's `generateMigration`. It drops the views
 * to recreate one at a time and the indexes that go, then diffs everything else, then creates the views one at a
 * time, then creates the indexes. Within one diff kit drops views unsorted, ignores the views that read a
 * recreated one, and creates indexes before views.
 */
export const assemble = async (input: Input, p: Plan = plan(input)): Promise<string[]> => {
	const { prev, cur, hints } = input
	const statements: string[] = []
	const step = async (from: State, to: State, withHints = false) => {
		statements.push(...(await generateMigration(from, to, withHints ? { hints } : undefined)))
		return to
	}

	let state = prev
	if (p.createExtensions.length > 0) {
		// An extension's schema must exist before the extension, so a schema that is new in this migration is
		// created first, by kit.
		const wanted = new Set(p.createExtensions.flatMap((e) => (e.schema ? [e.schema] : [])))
		const schemasOf = (of: State) =>
			of.ddl.filter((entity): entity is Extract<State["ddl"][number], { entityType: "schemas" }> =>
				entity.entityType === "schemas" && wanted.has(entity.name),
			)
		const existing = new Set(schemasOf(prev).map((schema) => schema.name))
		const created = schemasOf(cur).filter((schema) => !existing.has(schema.name))
		if (created.length > 0) state = await step(state, withDdl(state, [...state.ddl, ...created]))
		statements.push(...p.createExtensions.map(createExtension))
	}
	for (const key of p.drops) state = await step(state, without(state, new Set([key])))
	// Before everything else, so that a table index created in the next diff can take a name freed here.
	if (p.dropIndexes.length > 0) await step(withDdl(state, [...state.ddl, ...p.dropIndexes]), state)

	state = await step(state, without(cur, new Set(p.creates)), true)

	const curViews = viewsOf(cur.ddl)
	for (const key of p.creates) state = await step(state, withDdl(state, [...state.ddl, curViews.get(key)!]))

	// The drops ran in a diff of their own, because a drop and a create of indexes on one view in the same diff make
	// kit ask whether it is a rename, and no prompt ever asked the user about these indexes.
	const kept = withDdl(cur, [...cur.ddl, ...p.keptIndexes])
	if (p.createIndexes.length > 0) await step(kept, withDdl(kept, [...kept.ddl, ...p.createIndexes]))
	return statements
}
