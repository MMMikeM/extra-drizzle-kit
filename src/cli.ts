#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { exportSql } from "drizzle-kit/cli"
import { assemble, needsRewrite, plan } from "./assemble.ts"
import { loadProject, parseFlags, type Project } from "./config.ts"
import { hintsOf } from "./hints.ts"
import { indexEntities } from "./index-entities.ts"
import { ledgerAt, startingLedger, writeLedger } from "./ledger.ts"
import { clearDeclarations, declarations } from "./registry.ts"
import { type Entity, migrationFolders, readSnapshots, startingState, stateOf } from "./state.ts"

const breakpoint = "--> statement-breakpoint\n"

const log = (message: string) => process.stderr.write(`[drizzle-matview-kit] ${message}\n`)

// bin.cjs isn't in kit's exports map, but it sits next to the `./cli` entry, which is.
const kitBin = () => join(dirname(createRequire(import.meta.url).resolve("drizzle-kit/cli")), "bin.cjs")

const runKit = (args: string[]): number =>
	spawnSync(process.execPath, [kitBin(), ...args], { stdio: "inherit" }).status ?? 1

// Loads the schema with kit's own loader, the same way the CLI run will, so the declarations made by this
// package's `pgMaterializedView` land in this process.
const declaredIndexes = async (project: Project): Promise<Entity[]> => {
	clearDeclarations()
	const result = await exportSql(project.source as Parameters<typeof exportSql>[0])
	if (result.status !== "ok") {
		throw new Error(`drizzle-kit couldn't load the schema: ${JSON.stringify("error" in result ? result.error : result)}`)
	}
	return indexEntities(declarations())
}

const newFolder = (project: Project, before: Set<string>): string | undefined => {
	const created = migrationFolders(project.out).filter((folder) => !before.has(folder))
	if (created.length > 1) throw new Error(`drizzle-kit wrote ${created.length} migrations: ${created.join(", ")}.`)
	return created[0]
}

const rewrite = async (project: Project, folder: string, curIndexes: Entity[]) => {
	const files = readSnapshots(project.out)
	const snapshot = files[folder]
	const cur = await stateOf(files, snapshot.id)
	const prev = await startingState(files, snapshot.prevIds)
	const { hints, views } = await hintsOf(files, snapshot, cur)
	const prevIndexes = startingLedger(project.out, files, snapshot.prevIds)
	const input = { prev, cur, hints, viewRenames: views, prevIndexes, curIndexes }
	const p = plan(input)
	if (needsRewrite(p)) {
		const statements = await assemble(input, p)
		writeFileSync(join(project.out, folder, "migration.sql"), statements.join(project.breakpoints ? breakpoint : "\n"))
		const indexChanges = p.dropIndexes.length + p.createIndexes.length
		log(
			`Rebuilt ${folder}/migration.sql: ${p.drops.length} view drop(s), ${p.creates.length} view create(s), ` +
				`${indexChanges} index change(s).`,
		)
	}
	writeLedger(project.out, folder, curIndexes)
}

const generate = async (args: string[]): Promise<number> => {
	const flags = parseFlags(args)
	if (flags.explain) return runKit(["generate", ...args])

	const project = await loadProject(flags)
	if (flags.custom) {
		const before = new Set(migrationFolders(project.out))
		const code = runKit(["generate", ...args])
		const folder = newFolder(project, before)
		if (code === 0 && folder) {
			const files = readSnapshots(project.out)
			writeLedger(project.out, folder, startingLedger(project.out, files, files[folder].prevIds))
		}
		return code
	}

	const curIndexes = await declaredIndexes(project)
	const before = new Set(migrationFolders(project.out))
	const code = runKit(["generate", ...args])
	if (code !== 0) return code

	let folder = newFolder(project, before)
	if (!folder) {
		// Kit sees no change when only the indexes changed, so a custom migration of kit's gives them a folder.
		const leaf = migrationFolders(project.out).at(-1)
		const files = readSnapshots(project.out)
		const prevIndexes = leaf ? ledgerAt(project.out, files, files[leaf].id) : []
		const leafState = leaf ? await stateOf(files, files[leaf].id) : undefined
		if (!leafState) return 0
		const p = plan({ prev: leafState, cur: leafState, hints: [], viewRenames: new Map(), prevIndexes, curIndexes })
		if (!needsRewrite(p)) return 0
		const customCode = runKit(["generate", "--custom", ...args])
		if (customCode !== 0) return customCode
		folder = newFolder(project, new Set([...before]))
		if (!folder) throw new Error("drizzle-kit wrote no custom migration for the index changes.")
	}
	await rewrite(project, folder, curIndexes)
	return 0
}

/** Records the declared indexes as already applied, for a database that has them from before this package. */
const baseline = async (args: string[]): Promise<number> => {
	const project = await loadProject(parseFlags(args))
	const leaf = migrationFolders(project.out).at(-1)
	if (!leaf) throw new Error(`${project.out} has no migrations to baseline.`)
	writeLedger(project.out, leaf, await declaredIndexes(project))
	log(`Recorded the declared indexes in ${leaf}.`)
	return 0
}

const usage = `Usage:
  drizzle-matview-kit generate [drizzle-kit generate options]
  drizzle-matview-kit baseline [--config <path>]`

const [command, ...args] = process.argv.slice(2)
try {
	if (command === "generate") process.exitCode = await generate(args)
	else if (command === "baseline") process.exitCode = await baseline(args)
	else {
		process.stderr.write(`${usage}\n`)
		process.exitCode = command === "--help" || command === "-h" ? 0 : 2
	}
} catch (error) {
	log((error as Error).message)
	process.exitCode = 1
}
