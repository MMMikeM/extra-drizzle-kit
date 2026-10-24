import type { Hint } from "drizzle-kit/api-postgres"
import { type ViewKey, viewKey } from "./graph.ts"
import type { State } from "./state.ts"

type Column = Extract<State["ddl"][number], { entityType: "columns" }>
type Enum = Extract<State["ddl"][number], { entityType: "enums" }>

const ofType = <K extends State["ddl"][number]["entityType"]>(state: State, entityType: K) =>
	state.ddl.filter((entity): entity is Extract<State["ddl"][number], { entityType: K }> => entity.entityType === entityType)

const renamesOf = (hints: Hint[], kind: Hint["kind"]) =>
	new Map(
		hints.flatMap((hint) =>
			hint.type === "rename" && hint.kind === kind ? [[JSON.stringify(hint.from), JSON.stringify(hint.to)] as const] : [],
		),
	)

/**
 * Maps an id in `prev` to its id in `cur`, the way kit applies renames: schemas first, then the renames of the
 * entities inside them, whose hints name the schema's new name.
 */
const renaming = (hints: Hint[]) => {
	const schemas = renamesOf(hints, "schema")
	const byKind = { table: renamesOf(hints, "table"), enum: renamesOf(hints, "enum"), column: renamesOf(hints, "column") }
	const schemaOf = (schema: string) => {
		const renamed = schemas.get(JSON.stringify([schema]))
		return renamed ? (JSON.parse(renamed) as [string])[0] : schema
	}
	const rename = (kind: keyof typeof byKind, id: string[]): string[] => {
		const key = JSON.stringify(id)
		const renamed = byKind[kind].get(key)
		return renamed ? (JSON.parse(renamed) as string[]) : id
	}
	return {
		table: (schema: string, name: string) => rename("table", [schemaOf(schema), name]),
		enum: (schema: string, name: string) => rename("enum", [schemaOf(schema), name]),
		column: (schema: string, table: string, name: string) => {
			const [tableSchema, tableName] = rename("table", [schemaOf(schema), table])
			return rename("column", [tableSchema, tableName, name])
		},
	}
}

// Kit recreates an enum that loses a value: it turns every column of the enum into text, drops the type and
// creates it again. Postgres refuses those statements on a column that a view reads, as it refuses any other
// type change, while the column's `type` in the state doesn't change.
const recreatedEnums = (prev: State, cur: State, renamed: ReturnType<typeof renaming>) => {
	const current = new Map(ofType(cur, "enums").map((e) => [JSON.stringify([e.schema, e.name]), e]))
	return new Set(
		ofType(prev, "enums")
			.filter((before: Enum) => {
				const after = current.get(JSON.stringify(renamed.enum(before.schema, before.name)))
				return !after || before.values.some((value) => !after.values.includes(value))
			})
			.map((e) => JSON.stringify([e.schema, e.name])),
	)
}

// Postgres refuses ALTER COLUMN ... TYPE and DROP COLUMN on a column that a view reads, with 0A000 and 2BP01. A
// generated column whose expression changes is dropped and added again, which counts as a drop. A column of a
// renamed enum, or of an enum in a renamed schema, keeps its type: `expectedType` is the enum's new id.
const breaks = (before: Column, after: Column | undefined, expectedType: [string | null, string]) =>
	!after ||
	after.type !== expectedType[1] ||
	(after.typeSchema ?? "public") !== (expectedType[0] ?? "public") ||
	after.dimensions !== before.dimensions ||
	JSON.stringify(after.generated) !== JSON.stringify(before.generated)

/**
 * The tables in `prev` that lose a column or change a column's type on the way to `cur`, keyed as in `prev`.
 * Renames come from the hints, and don't count: Postgres allows them under a view.
 */
export const tablesWithBrokenColumns = (prev: State, cur: State, hints: Hint[]): Set<ViewKey> => {
	const renamed = renaming(hints)
	const enums = recreatedEnums(prev, cur, renamed)
	const current = new Map(ofType(cur, "columns").map((column) => [JSON.stringify([column.schema, column.table, column.name]), column]))

	const prevEnums = new Set(ofType(prev, "enums").map((e) => JSON.stringify([e.schema, e.name])))
	const broken = new Set<ViewKey>()
	for (const column of ofType(prev, "columns")) {
		const after = current.get(JSON.stringify(renamed.column(column.schema, column.table, column.name)))
		const enumId = JSON.stringify([column.typeSchema ?? "public", column.type])
		const expectedType = (
			prevEnums.has(enumId) ? renamed.enum(column.typeSchema ?? "public", column.type) : [column.typeSchema, column.type]
		) as [string | null, string]
		if (enums.has(enumId) || breaks(column, after, expectedType)) {
			broken.add(viewKey({ schema: column.schema, name: column.table }))
		}
	}
	return broken
}
