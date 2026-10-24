import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Extension } from "./registry.ts"
import { type Entity, type Files, folderOf, originId } from "./state.ts"

// Kit reads only snapshot.json from a migration folder and the migrator only migration.sql, so what kit can't
// hold lives next to them. Keeping it out of kit's snapshots also keeps `drizzle-kit check` clean.
export const ledgerFile = "extra-drizzle-kit.json"

/** What the package added to the schema after a migration: indexes on materialized views, and extensions. */
export type Ledger = { indexes: Entity[]; extensions: Extension[] }

const emptyLedger: Ledger = { indexes: [], extensions: [] }

const read = (out: string, folder: string): Ledger | undefined => {
	const path = join(out, folder, ledgerFile)
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Ledger) : undefined
}

export const writeLedger = (out: string, folder: string, ledger: Ledger): void =>
	writeFileSync(join(out, folder, ledgerFile), `${JSON.stringify(ledger, null, 2)}\n`)

/**
 * The ledger after the migration with id `id`. A migration that plain drizzle-kit generated has no ledger, so the
 * nearest ancestor's ledger along first parents stands in for it.
 */
export const ledgerAt = (out: string, files: Files, id: string): Ledger => {
	let current: string | undefined = id
	while (current && current !== originId) {
		const folder = folderOf(files, current)
		if (!folder) return emptyLedger
		const found = read(out, folder)
		if (found) return found
		current = files[folder].prevIds[0]
	}
	return emptyLedger
}

const sortedKeys = (value: unknown): string =>
	JSON.stringify(value, (_, v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
	)

const canonical = ({ indexes, extensions }: Ledger) =>
	JSON.stringify([indexes.map(sortedKeys).sort(), extensions.map(sortedKeys).sort()])

export const sameEntity = (a: Entity, b: Entity): boolean => sortedKeys(a) === sortedKeys(b)

/** The ledger a migration with the parents `prevIds` starts from. A merge of parents that disagree is refused. */
export const startingLedger = (out: string, files: Files, prevIds: string[]): Ledger => {
	const [first, ...others] = prevIds.map((id) => ledgerAt(out, files, id))
	if (others.some((other) => canonical(other) !== canonical(first ?? emptyLedger))) {
		throw new Error(
			"The branches this migration merges declare different indexes on materialized views or extensions. Make " +
				`their ${ledgerFile} files agree, or merge with drizzle-kit and then run extra-drizzle-kit baseline.`,
		)
	}
	return first ?? emptyLedger
}
