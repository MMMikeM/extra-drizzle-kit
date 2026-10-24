import {
	type AnyPgColumnBuilder,
	getMaterializedViewConfig,
	type IndexBuilder,
	type PgMaterializedView,
} from "drizzle-orm/pg-core"

/**
 * A view and its index callback. With `columns`, the view's declared columns, the callback takes the columns a
 * table's indexes get; without them it takes the view.
 */
export type Declaration = {
	view: PgMaterializedView
	indexes: (columns: never) => IndexBuilder[]
	columns?: Record<string, AnyPgColumnBuilder>
}

// Kit's jiti loads the user's schema, and with it a second instance of this module. A `Symbol.for` key on
// globalThis is the one place both instances share.
const storeKey = Symbol.for("drizzle-kit-matview.declarations")

const store = (): Map<string, Declaration> => {
	const global = globalThis as { [storeKey]?: Map<string, Declaration> }
	return (global[storeKey] ??= new Map())
}

export const declare = (declaration: Declaration): void => {
	const { schema, name } = getMaterializedViewConfig(declaration.view)
	store().set(JSON.stringify([schema ?? "public", name]), declaration)
}

export const declarations = (): Declaration[] => [...store().values()]

export const clearDeclarations = (): void => store().clear()
