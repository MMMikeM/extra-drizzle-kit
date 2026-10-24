import type { Hint } from "drizzle-kit/api-postgres"
import { type Delta, type Entity, type Files, type Snapshot, startingState, type State } from "./state.ts"

type Kind = Extract<Hint, { type: "rename" }>["kind"]
type Row = Entity & { schema?: string; table?: string; name?: string }

const kinds: Record<string, Kind> = {
	schemas: "schema",
	roles: "role",
	tables: "table",
	enums: "enum",
	sequences: "sequence",
	views: "view",
	columns: "column",
	policies: "policy",
	checks: "check",
	indexes: "index",
	uniques: "unique",
	pks: "primary_key",
	fks: "foreign key",
}

// The identifier tuple of each kind, as kit's resolver builds it (drizzle-kit/src/cli/prompts.ts, `entityId`).
const idOf = (kind: Kind, row: Row): string[] => {
	if (kind === "schema" || kind === "role") return [row.name!]
	if (kind === "table" || kind === "enum" || kind === "sequence" || kind === "view") return [row.schema!, row.name!]
	return [row.schema!, row.table!, row.name!]
}

const rowOfKey = (state: State, key: string): Row | undefined => {
	const separator = key.indexOf("\0")
	const entityType = key.slice(0, separator)
	const identity = JSON.parse(key.slice(separator + 1)) as string[]
	const fields = identity.length === 1 ? ["name"] : identity.length === 2 ? ["schema", "name"] : ["schema", "table", "name"]
	return (state.ddl as Row[]).find(
		(row) => row.entityType === entityType && fields.every((field, i) => row[field] === identity[i]),
	)
}

export type Renames = { hints: Hint[]; views: Map<string, string> }

// Records that a view moved, keyed by its key in the starting state, so a view that kit moves twice (a schema
// rename, then a rename of the view) maps straight from its first key to its last.
const moveView = (views: Map<string, string>, from: Row, to: Row) => {
	const fromKey = JSON.stringify([from.schema, from.name])
	const toKey = JSON.stringify([to.schema, to.name])
	const original = [...views].find(([, current]) => current === fromKey)?.[0] ?? fromKey
	views.set(original, toKey)
}

/**
 * The hints that reproduce how kit resolved the new migration, whether the user answered a prompt or passed
 * `--hints`. A rename is stored as a `rename` delta. A "create" answer leaves only a drop and a create, so every
 * created entity that no rename targets gets a `create` hint.
 */
export const hintsOf = async (files: Files, snapshot: Snapshot, cur: State): Promise<Renames> => {
	const renameDeltas = (snapshot.deltas ?? []).filter((delta): delta is Extract<Delta, { op: "rename" }> => delta.op === "rename")
	const hints: Hint[] = []
	const views = new Map<string, string>()
	const targets = new Set<string>()

	// Kit applies renames in order, so a column's key already names its renamed table. Each delta is read in
	// the state that the deltas before it leave, which kit's own reconstruct builds.
	for (let i = 0; i < renameDeltas.length; i++) {
		const before = await startingState(files, snapshot.prevIds, renameDeltas.slice(0, i))
		const from = rowOfKey(before, renameDeltas[i].key)
		const kind = from && kinds[from.entityType]
		if (!from || !kind) continue
		const to = { ...from, ...renameDeltas[i].set } as Row
		hints.push({ type: "rename", kind, from: idOf(kind, from), to: idOf(kind, to) } as unknown as Hint)
		targets.add(JSON.stringify([kind, ...idOf(kind, to)]))
		if (kind === "view") moveView(views, from, to)
		// A schema rename moves its views with it, as kit's ALTER SCHEMA does in Postgres.
		if (kind === "schema") {
			for (const view of before.ddl as Row[]) {
				if (view.entityType === "views" && view.schema === from.name) moveView(views, view, { ...view, schema: to.name })
			}
		}
	}

	const renamed = await startingState(files, snapshot.prevIds, renameDeltas)
	const existing = new Set(
		(renamed.ddl as Row[]).flatMap((row) => (kinds[row.entityType] ? [JSON.stringify([kinds[row.entityType], ...idOf(kinds[row.entityType], row)])] : [])),
	)
	for (const row of cur.ddl as Row[]) {
		const kind = kinds[row.entityType]
		if (!kind) continue
		const id = idOf(kind, row)
		const key = JSON.stringify([kind, ...id])
		if (!existing.has(key) && !targets.has(key)) hints.push({ type: "create", kind, entity: id } as unknown as Hint)
	}
	return { hints, views }
}
