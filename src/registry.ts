import {
	type AnyPgColumnBuilder,
	getMaterializedViewConfig,
	type IndexBuilder,
	type PgMaterializedView,
} from "drizzle-orm/pg-core"
import { viewKey } from "./graph.ts"

/**
 * A view and its index callback. With `columns`, the view's declared columns, the callback takes the columns a
 * table's indexes get; without them it takes the view.
 */
export type Declaration = {
	view: PgMaterializedView
	indexes: (columns: never) => IndexBuilder[]
	columns?: Record<string, AnyPgColumnBuilder>
}

/** A Postgres extension the schema needs. `schema` is where its objects go, `null` for the default. */
export type Extension = { name: string; schema: string | null }

type Store = { views: Map<string, Declaration>; extensions: Map<string, Extension> }

// Kit's jiti loads the user's schema, and with it a second instance of this module. A `Symbol.for` key on
// globalThis is the one place both instances share.
const storeKey = Symbol.for("extra-drizzle-kit.declarations")

const store = (): Store => {
	const global = globalThis as { [storeKey]?: Store }
	return (global[storeKey] ??= { views: new Map(), extensions: new Map() })
}

export const declare = (declaration: Declaration): void => {
	const { schema, name } = getMaterializedViewConfig(declaration.view)
	store().views.set(viewKey({ schema: schema ?? "public", name }), declaration)
}

export const declareExtension = (extension: Extension): void => {
	const declared = store().extensions.get(extension.name)
	if (declared && declared.schema !== extension.schema) {
		throw new Error(`Extension ${extension.name} is declared twice, in schemas ${declared.schema} and ${extension.schema}.`)
	}
	store().extensions.set(extension.name, extension)
}

export const declarations = (): Declaration[] => [...store().views.values()]

export const declaredExtensions = (): Extension[] => [...store().extensions.values()]

export const clearDeclarations = (): void => {
	store().views.clear()
	store().extensions.clear()
}
