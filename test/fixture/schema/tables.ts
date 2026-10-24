import { integer, pgTable, text } from "drizzle-orm/pg-core"

const variants = new Set((process.env.SCHEMA_VARIANT ?? "").split(","))

export const customers = pgTable(variants.has("renamedTable") ? "clients" : "customers", {
	id: integer("id").primaryKey(),
	name: text("name").notNull(),
	...(variants.has("newColumn") ? { title: text("title") } : {}),
})

export const products = pgTable("products", { id: integer("id").primaryKey(), label: text("label").notNull() })
