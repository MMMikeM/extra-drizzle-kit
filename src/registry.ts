import { getMaterializedViewConfig, type IndexBuilder, type PgMaterializedView } from "drizzle-orm/pg-core"

export type Declaration = { view: PgMaterializedView; indexes: (view: never) => IndexBuilder[] }

// Kit's jiti loads the user's schema, and with it a second instance of this module. A `Symbol.for` key on
// globalThis is the one place both instances share.
const storeKey = Symbol.for("drizzle-matview-kit.declarations")

const store = (): Map<string, Declaration> => {
	const global = globalThis as { [storeKey]?: Map<string, Declaration> }
	return (global[storeKey] ??= new Map())
}

export const declare = (view: PgMaterializedView, indexes: Declaration["indexes"]): void => {
	const { schema, name } = getMaterializedViewConfig(view)
	store().set(JSON.stringify([schema ?? "public", name]), { view, indexes })
}

export const declarations = (): Declaration[] => [...store().values()]

export const clearDeclarations = (): void => store().clear()
