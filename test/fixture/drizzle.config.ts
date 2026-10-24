import { defineConfig } from "drizzle-kit"

export default defineConfig({
	dialect: "postgresql",
	schema: "./schema",
	out: process.env.MIGRATIONS_OUT ?? "./drizzle",
})
