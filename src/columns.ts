import type { Hint } from "drizzle-kit/api-postgres"
import { type ViewKey, viewKey } from "./graph.ts"
import type { State } from "./state.ts"

type Column = Extract<State["ddl"][number], { entityType: "columns" }>

const columnsOf = (state: State) => state.ddl.filter((entity): entity is Column => entity.entityType === "columns")

const renamesOf = (hints: Hint[], kind: "table" | "column") =>
	new Map(
		hints.flatMap((hint) =>
			hint.type === "rename" && hint.kind === kind ? [[JSON.stringify(hint.from), JSON.stringify(hint.to)] as const] : [],
		),
	)

// Postgres refuses ALTER COLUMN ... TYPE and DROP COLUMN on a column that a view reads, with 0A000 and 2BP01. A
// generated column whose expression changes is dropped and added again, which counts as a drop.
const breaks = (before: Column, after: Column | undefined) =>
	!after ||
	after.type !== before.type ||
	after.typeSchema !== before.typeSchema ||
	after.dimensions !== before.dimensions ||
	JSON.stringify(after.generated) !== JSON.stringify(before.generated)

/**
 * The tables in `prev` that lose a column or change a column's type on the way to `cur`, keyed as in `prev`.
 * Renames come from the hints, in the order kit applies them: a column's hint names its table's new name.
 */
export const tablesWithBrokenColumns = (prev: State, cur: State, hints: Hint[]): Set<ViewKey> => {
	const tableRenames = renamesOf(hints, "table")
	const columnRenames = renamesOf(hints, "column")
	const current = new Map(columnsOf(cur).map((column) => [JSON.stringify([column.schema, column.table, column.name]), column]))

	const broken = new Set<ViewKey>()
	for (const column of columnsOf(prev)) {
		const tableId = tableRenames.get(JSON.stringify([column.schema, column.table]))
		const [schema, table] = tableId ? (JSON.parse(tableId) as [string, string]) : [column.schema, column.table]
		const columnId = JSON.stringify([schema, table, column.name])
		const after = current.get(columnRenames.get(columnId) ?? columnId)
		if (breaks(column, after)) broken.add(viewKey({ schema: column.schema, name: column.table }))
	}
	return broken
}
