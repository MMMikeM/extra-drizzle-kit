import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixture = join(root, "test/fixture")
const cli = join(root, "src/cli.ts")
const kitBin = join(dirname(createRequire(import.meta.url).resolve("drizzle-kit/cli")), "bin.cjs")

const scratch = join(root, "test/.tmp")
mkdirSync(scratch, { recursive: true })
const out = mkdtempSync(join(scratch, "migrations-"))

let container: StartedPostgreSqlContainer
let pool: pg.Pool

beforeAll(async () => {
	container = await new PostgreSqlContainer("postgres:17-alpine").start()
	pool = new pg.Pool({ connectionString: container.getConnectionUri() })
})

afterAll(async () => {
	await pool?.end()
	await container?.stop()
	rmSync(out, { recursive: true, force: true })
})

const spawn = (command: string[], variant: string, migrationsOut = out) =>
	spawnSync(process.execPath, command, {
		cwd: fixture,
		env: { ...process.env, SCHEMA_VARIANT: variant, MIGRATIONS_OUT: migrationsOut },
		encoding: "utf8",
	})

const run = (command: string[], variant: string, migrationsOut = out) => {
	const result = spawn(command, variant, migrationsOut)
	if (result.status !== 0) throw new Error(`${command.join(" ")} failed:\n${result.stdout}\n${result.stderr}`)
	return result
}

const wrapped = (variant: string, ...args: string[]) => run([cli, "generate", ...args], variant)

/** Runs the wrapper on a copy of the migrations folder, and returns the new migration's statements. */
const wrappedOnCopy = (variant: string, ...args: string[]) => {
	const copy = mkdtempSync(join(scratch, "copy-"))
	cpSync(out, copy, { recursive: true })
	const before = new Set(folders(copy))
	run([cli, "generate", ...args], variant, copy)
	const folder = folders(copy).find((name) => !before.has(name))!
	const sql = sqlOf(folder, copy)
	rmSync(copy, { recursive: true, force: true })
	return statementsOf(sql)
}

const folders = (dir = out) => readdirSync(dir).filter((name) => existsSync(join(dir, name, "snapshot.json"))).sort()
const sqlOf = (folder: string, dir = out) => readFileSync(join(dir, folder, "migration.sql"), "utf8")

/** What plain drizzle-kit would write for `variant`, generated into a copy of the migrations folder. */
const plainKit = (variant: string) => {
	const copy = mkdtempSync(join(scratch, "plain-"))
	cpSync(out, copy, { recursive: true })
	const before = new Set(folders(copy))
	run([kitBin, "generate", "--name", "plain"], variant, copy)
	const folder = folders(copy).find((name) => !before.has(name))!
	const sql = sqlOf(folder, copy)
	rmSync(copy, { recursive: true, force: true })
	return sql
}

const migrateAll = () => migrate(drizzle({ client: pool }), { migrationsFolder: out })

const statementsOf = (sql: string) => sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)

const applyRolledBack = async (statements: string[], check?: (client: pg.PoolClient) => Promise<void>) => {
	const client = await pool.connect()
	try {
		await client.query("BEGIN")
		for (const statement of statements) await client.query(statement)
		await check?.(client)
	} finally {
		await client.query("ROLLBACK")
		client.release()
	}
}

const errorCode = async (promise: Promise<unknown>) => {
	try {
		await promise
	} catch (error) {
		return (error as { code?: string }).code
	}
	return undefined
}

const indexesOnSearchIndex = async () =>
	(await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'search_index' ORDER BY 1")).rows.map(
		(row: { indexname: string }) => row.indexname,
	)

// One migrations folder and one database, so each test builds on the migrations the tests before it wrote.
describe("drizzle-matview-kit generate", () => {
	it("creates the matview's indexes after the matview in the first migration", async () => {
		wrapped("")
		expect(folders()).toHaveLength(1)
		await migrateAll()
		expect(await indexesOnSearchIndex()).toEqual(["search_index_content_tsv_idx", "search_index_source_table_id_idx"])
		await pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY search_index")
	})

	it("leaves a migration that changes no view to drizzle-kit, byte for byte", async () => {
		const expected = plainKit("newColumn")
		wrapped("newColumn")
		expect(sqlOf(folders().at(-1)!)).toBe(expected)
		await migrateAll()
	})

	// The canary: when this starts failing, drizzle-kit orders dependent views itself.
	it("is needed: drizzle-kit alone drops a view that search_index depends on", async () => {
		const sql = plainKit("newColumn,changedView")
		expect(await errorCode(applyRolledBack(statementsOf(sql)))).toBe("2BP01")
	})

	it("recreates search_index and its indexes around a changed view", async () => {
		wrapped("newColumn,changedView")
		await migrateAll()
		expect(await indexesOnSearchIndex()).toEqual(["search_index_content_tsv_idx", "search_index_source_table_id_idx"])
		await pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY search_index")
	})

	it("writes no migration when nothing changed", () => {
		const before = folders()
		wrapped("newColumn,changedView")
		expect(folders()).toEqual(before)
	})

	it("gives an index-only change a migration of its own", async () => {
		const before = folders().length
		wrapped("newColumn,changedView,extraIndex")
		expect(folders()).toHaveLength(before + 1)
		expect(statementsOf(sqlOf(folders().at(-1)!))).toEqual([
			'CREATE INDEX "search_index_id_idx" ON "search_index" ("id");',
		])
		await migrateAll()
		expect(await indexesOnSearchIndex()).toContain("search_index_id_idx")
	})

	it("drops a removed index", async () => {
		wrapped("newColumn,changedView")
		expect(statementsOf(sqlOf(folders().at(-1)!))).toEqual(['DROP INDEX "search_index_id_idx";'])
		await migrateAll()
		expect(await indexesOnSearchIndex()).not.toContain("search_index_id_idx")
	})

	it("prints one JSON envelope for an index-only change with --output json", async () => {
		const { stdout } = wrapped("newColumn,changedView,extraIndex", "--output", "json")
		expect(JSON.parse(stdout)).toMatchObject({ status: "ok", dialect: "postgresql" })
		await migrateAll()
		wrapped("newColumn,changedView")
		await migrateAll()
	})

	it("removes the migration kit wrote when the wrapper can't finish it", () => {
		const before = folders()
		const result = spawn([cli, "generate"], "newColumn,changedView,extraTable,strayIndex")
		expect(result.status).toBe(1)
		expect(result.stderr).toContain("isn't a materialized view in the schema")
		expect(result.stderr).toContain("so the next run writes it again")
		expect(folders()).toEqual(before)
	})

	describe("a table rename under a view that search_index reads", () => {
		const variant = "newColumn,changedView,renamedTable"
		const rename = [{ type: "rename", kind: "table", from: ["public", "customers"], to: ["public", "clients"] }]
		const create = [{ type: "create", kind: "table", entity: ["public", "clients"] }]

		const appliesWithIndexes = (statements: string[]) =>
			applyRolledBack(statements, async (client) => {
				const { rows } = await client.query("SELECT indexname FROM pg_indexes WHERE tablename = 'search_index' ORDER BY 1")
				expect(rows.map((row: { indexname: string }) => row.indexname)).toEqual([
					"search_index_content_tsv_idx",
					"search_index_source_table_id_idx",
				])
				await client.query("REFRESH MATERIALIZED VIEW CONCURRENTLY search_index")
			})

		it("keeps the rename that kit was told about", async () => {
			const statements = wrappedOnCopy(variant, "--hints", JSON.stringify(rename))
			expect(statements).toContain('ALTER TABLE "customers" RENAME TO "clients";')
			await appliesWithIndexes(statements)
		})

		it("keeps a drop and a create when kit was told the table is new", async () => {
			const statements = wrappedOnCopy(variant, "--hints", JSON.stringify(create))
			expect(statements.some((s) => s.startsWith('CREATE TABLE "clients"'))).toBe(true)
			expect(statements).toContain('DROP TABLE "customers";')
			await appliesWithIndexes(statements)
		})
	})
})
