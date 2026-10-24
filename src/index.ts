import type { ColumnsSelection, SQL } from "drizzle-orm"
import {
	pgMaterializedView as drizzlePgMaterializedView,
	type AnyPgColumnBuilder,
	type IndexBuilder,
	type PgBuildColumns,
	type PgBuildExtraConfigColumns,
	type PgMaterializedView,
	type PgMaterializedViewWithConfig,
	type PgMaterializedViewWithSelection,
	type PgSchema,
	type QueryBuilder,
} from "drizzle-orm/pg-core"
import type { TypedQueryBuilder } from "drizzle-orm/query-builders/query-builder"
import type { AddAliasToSelection } from "drizzle-orm/query-builders/select.types"
import { declare, type Declaration, declareExtension, type Extension } from "./registry.ts"

/**
 * The indexes of a materialized view, built with drizzle's `index()` and `uniqueIndex()` on its columns. A view
 * with declared columns gets the columns a table's indexes get, so `.desc()`, `.nullsFirst()` and `.op()` work.
 */
export type MaterializedViewIndexes<TColumns> = (columns: TColumns) => IndexBuilder[]

type QueryView<TName extends string, TSchema extends string | undefined, TSelectedFields extends ColumnsSelection> =
	PgMaterializedViewWithSelection<{
		name: TName
		schema: TSchema
		existing: false
		isAlias: false
		selectedFields: AddAliasToSelection<TSelectedFields, TName, "pg">
	}>

type ColumnsView<
	TName extends string,
	TColumns extends Record<string, AnyPgColumnBuilder>,
	TSchema extends string | undefined,
> = PgMaterializedViewWithSelection<{
	name: TName
	schema: TSchema
	existing: false
	isAlias: false
	selectedFields: PgBuildColumns<TName, TColumns>
}>

interface MaterializedViewOptions {
	using(using: string): this
	with(config: PgMaterializedViewWithConfig): this
	tablespace(tablespace: string): this
	withNoData(): this
}

/** Drizzle's `MaterializedViewBuilder`, whose `.as()` also takes the view's indexes. */
export interface QueryMaterializedViewBuilder<TName extends string, TSchema extends string | undefined>
	extends MaterializedViewOptions {
	as<TSelectedFields extends ColumnsSelection>(
		qb: TypedQueryBuilder<TSelectedFields> | ((qb: QueryBuilder) => TypedQueryBuilder<TSelectedFields>),
		indexes?: MaterializedViewIndexes<QueryView<TName, TSchema, TSelectedFields>>,
	): QueryView<TName, TSchema, TSelectedFields>
}

/** Drizzle's `ManualMaterializedViewBuilder`, for a view with declared columns. */
export interface ColumnsMaterializedViewBuilder<
	TName extends string,
	TColumns extends Record<string, AnyPgColumnBuilder>,
	TSchema extends string | undefined,
> extends MaterializedViewOptions {
	as(query: SQL): ColumnsView<TName, TColumns, TSchema>
	/** A view that already exists and that drizzle-kit leaves alone, so any indexes on it are left alone too. */
	existing(): PgMaterializedViewWithSelection<{
		name: TName
		schema: TSchema
		existing: true
		isAlias: false
		selectedFields: PgBuildColumns<TName, TColumns>
	}>
}

/** Drizzle's `pgMaterializedView`, plus the indexes that drizzle-kit can't declare on a materialized view. */
export interface PgMaterializedViewWithIndexesFn<TSchema extends string | undefined = undefined> {
	<TName extends string>(name: TName): QueryMaterializedViewBuilder<TName, TSchema>
	<TName extends string, TColumns extends Record<string, AnyPgColumnBuilder>>(
		name: TName,
		columns: TColumns,
		indexes?: MaterializedViewIndexes<PgBuildExtraConfigColumns<TColumns>>,
	): ColumnsMaterializedViewBuilder<TName, TColumns, TSchema>
}

type Builder = { as: (query: unknown) => PgMaterializedView }

// Every option method returns the builder itself, so the proxy hands itself back in its place: otherwise a
// chain such as `.with({...}).as(...)` would reach drizzle's own `as` and lose the indexes.
const recordingIndexes = <T extends Builder>(
	builder: T,
	columns?: Record<string, AnyPgColumnBuilder>,
	columnsIndexes?: Declaration["indexes"],
): T => {
	const proxy: T = new Proxy(builder, {
		get(target, prop) {
			const value: unknown = Reflect.get(target, prop)
			if (typeof value !== "function") return value
			if (prop === "as") {
				return (query: unknown, queryIndexes?: Declaration["indexes"]) => {
					const view = target.as(query)
					if (columnsIndexes && columns) declare({ view, indexes: columnsIndexes, columns })
					else if (queryIndexes) declare({ view, indexes: queryIndexes })
					return view
				}
			}
			return (...args: unknown[]) => {
				const result: unknown = value.apply(target, args)
				return result === target ? proxy : result
			}
		},
	})
	return proxy
}

const withIndexes = (
	create: (name: string, columns?: Record<string, AnyPgColumnBuilder>) => unknown,
): PgMaterializedViewWithIndexesFn<never> =>
	((name: string, columns?: Record<string, AnyPgColumnBuilder>, indexes?: Declaration["indexes"]) =>
		recordingIndexes(create(name, columns) as Builder, columns, indexes)) as PgMaterializedViewWithIndexesFn<never>

/**
 * Declares a materialized view, like drizzle's `pgMaterializedView`, and optionally its indexes.
 *
 * Pass the indexes as the third argument for a view with declared columns, as for `pgTable`, or as the second
 * argument of `.as()` for a view built with the query builder, which gets the view. `extra-drizzle-kit generate` writes them into the
 * migration after the view, and recreates them whenever the view is recreated.
 *
 * @example
 * export const searchIndex = pgMaterializedView(
 * 	"search_index",
 * 	{ id: integer("id"), tsv: tsvector("tsv") },
 * 	(mv) => [uniqueIndex().on(mv.id), index().using("gin", mv.tsv)],
 * ).as(sql`select ...`)
 */
export const pgMaterializedView: PgMaterializedViewWithIndexesFn = withIndexes((name, columns) =>
	columns ? drizzlePgMaterializedView(name, columns) : drizzlePgMaterializedView(name),
) as PgMaterializedViewWithIndexesFn

/** {@link pgMaterializedView} for a view in a Postgres schema other than `public`. */
export const materializedViewIn = <TSchema extends string>(
	schema: PgSchema<TSchema>,
): PgMaterializedViewWithIndexesFn<TSchema> =>
	withIndexes((name, columns) =>
		columns ? schema.materializedView(name, columns) : schema.materializedView(name),
	) as PgMaterializedViewWithIndexesFn<TSchema>

/**
 * Declares a Postgres extension the schema needs, such as `pg_trgm`, `vector` or `postgis`. The next migration
 * that `extra-drizzle-kit generate` writes creates it, before anything that uses it.
 *
 * Removing the declaration doesn't drop the extension, because `DROP EXTENSION` can take columns and data with it.
 *
 * @example
 * export const trigrams = pgExtension("pg_trgm")
 * export const vectors = pgExtension("vector", { schema: "extensions" })
 */
export const pgExtension = (name: string, options: { schema?: string } = {}): Extension => {
	const extension = { name, schema: options.schema ?? null }
	declareExtension(extension)
	return extension
}

export type { Extension }

