import { sql } from "drizzle-orm"
import { customType, index, integer, pgView, text, uniqueIndex } from "drizzle-orm/pg-core"
import { pgMaterializedView } from "../../../src/index"
import { customers, products } from "./tables"

const variants = new Set((process.env.SCHEMA_VARIANT ?? "").split(","))

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" })

export const customerSearchData = pgView("customer_search_data_view", { id: integer("id"), content: text("content") }).as(
	variants.has("changedView")
		? sql`select ${customers.id} as id, upper(${customers.name}) as content from ${customers}`
		: sql`select ${customers.id} as id, ${customers.name} as content from ${customers}`,
)

export const productSearchData = pgView("product_search_data_view", { id: integer("id"), content: text("content") }).as(
	sql`select ${products.id} as id, ${products.label} as content from ${products}`,
)

export const searchIndex = pgMaterializedView(
	"search_index",
	{ sourceTable: text("source_table"), id: integer("id"), contentTsv: tsvector("content_tsv") },
	(mv) => [
		uniqueIndex("search_index_source_table_id_idx").on(mv.sourceTable, mv.id),
		index("search_index_content_tsv_idx").using("gin", mv.contentTsv),
		...(variants.has("extraIndex") ? [index("search_index_id_idx").on(mv.id)] : []),
	],
).as(sql`
	select 'customers' as source_table, id, to_tsvector('simple', content) as content_tsv from ${customerSearchData}
	union all
	select 'products' as source_table, id, to_tsvector('simple', content) as content_tsv from ${productSearchData}
`)

// Declared but never exported, so kit's schema has no such view and the wrapper must refuse its index.
if (variants.has("strayIndex")) {
	pgMaterializedView("stray", { id: integer("id") }, (mv) => [uniqueIndex("stray_id_idx").on(mv.id)]).as(sql`select 1 as id`)
}
