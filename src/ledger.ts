import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Entity, type Files, folderOf, originId } from "./state.ts"

// Kit reads only snapshot.json from a migration folder and the migrator only migration.sql, so the indexes kit
// can't hold live next to them. Keeping them out of kit's snapshots also keeps `drizzle-kit check` clean.
export const ledgerFile = "matview-indexes.json"

type Ledger = { indexes: Entity[] }

const read = (out: string, folder: string): Entity[] | undefined => {
	const path = join(out, folder, ledgerFile)
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Ledger).indexes : undefined
}

export const writeLedger = (out: string, folder: string, indexes: Entity[]): void =>
	writeFileSync(join(out, folder, ledgerFile), `${JSON.stringify({ indexes } satisfies Ledger, null, 2)}\n`)

/**
 * The indexes on materialized views after the migration with id `id`. A migration that plain drizzle-kit
 * generated has no ledger, so the nearest ancestor's ledger along first parents stands in for it.
 */
export const ledgerAt = (out: string, files: Files, id: string): Entity[] => {
	let current: string | undefined = id
	while (current && current !== originId) {
		const folder = folderOf(files, current)
		if (!folder) return []
		const found = read(out, folder)
		if (found) return found
		current = files[folder].prevIds[0]
	}
	return []
}

const canonical = (entities: Entity[]) => JSON.stringify(entities.map(sortedKeys).sort())

const sortedKeys = (value: unknown): string =>
	JSON.stringify(value, (_, v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
	)

export const sameEntity = (a: Entity, b: Entity): boolean => sortedKeys(a) === sortedKeys(b)

/** The ledger a migration with the parents `prevIds` starts from. A merge of parents that disagree is refused. */
export const startingLedger = (out: string, files: Files, prevIds: string[]): Entity[] => {
	const [first, ...others] = prevIds.map((id) => ledgerAt(out, files, id))
	if (others.some((other) => canonical(other) !== canonical(first ?? []))) {
		throw new Error(
			"The branches this migration merges declare different indexes on materialized views. Make their " +
				`${ledgerFile} files agree, or merge with drizzle-kit and then run drizzle-kit-matview baseline.`,
		)
	}
	return first ?? []
}
