import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { reconstruct } from "drizzle-kit/api-postgres"

export type Entity = { entityType: string; [field: string]: unknown }
export type State = Awaited<ReturnType<typeof reconstruct>>
export type Delta =
	| { op: "create"; row: Entity }
	| { op: "drop"; key: string }
	| { op: "alter"; key: string; set: Record<string, unknown> }
	| { op: "rename"; key: string; set: Record<string, unknown> }
export type Snapshot = { id: string; prevIds: string[]; type?: "base" | "diff"; deltas?: Delta[]; ddl?: Entity[] }
export type Files = Record<string, Snapshot>

export const originId = "00000000-0000-0000-0000-000000000000"

// Sorts after every folder kit names, because a snapshot's folder must sort after its parents' folders.
const startFolder = "99999999999999_drizzle_matview_kit_start"
const startId = "drizzle-matview-kit-start"

export const migrationFolders = (out: string): string[] =>
	existsSync(out)
		? readdirSync(out, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && existsSync(join(out, entry.name, "snapshot.json")))
				.map((entry) => entry.name)
				.sort()
		: []

export const readSnapshots = (out: string): Files =>
	Object.fromEntries(
		migrationFolders(out).map((folder) => [folder, JSON.parse(readFileSync(join(out, folder, "snapshot.json"), "utf8"))]),
	)

/** The snapshots no other snapshot names as a parent: the branches a new migration starts from. */
export const leafIds = (files: Files): string[] => {
	const parents = new Set(Object.values(files).flatMap((snapshot) => snapshot.prevIds))
	return Object.values(files).map((snapshot) => snapshot.id).filter((id) => !parents.has(id))
}

export const folderOf = (files: Files, id: string): string | undefined =>
	Object.keys(files).find((folder) => files[folder].id === id)

/**
 * The state a migration with the parents `prevIds` starts from, after `deltas`. For a merge it is kit's combined
 * state of all parents, which kit computes only when it reconstructs a snapshot with several parents.
 */
export const startingState = async (files: Files, prevIds: string[], deltas: Delta[] = []): Promise<State> => {
	if (prevIds.every((id) => id === originId)) {
		return { version: "9", dialect: "postgres", id: startId, prevIds: [originId], ddl: [] }
	}
	const start = { type: "diff", version: "9", dialect: "postgres", id: startId, prevIds, footprints: [], deltas }
	return reconstruct({ ...files, [startFolder]: start }, startId)
}

export const stateOf = (files: Files, id: string): Promise<State> => reconstruct(files, id)
