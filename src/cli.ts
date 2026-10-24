#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { exportSql } from "drizzle-kit/cli"
import { assemble, needsRewrite, plan } from "./assemble.ts"
import { loadProject, parseFlags, type Project } from "./config.ts"
import { hintsOf } from "./hints.ts"
import { indexEntities } from "./index-entities.ts"
import { startingLedger, writeLedger } from "./ledger.ts"
import { clearDeclarations, declarations } from "./registry.ts"
import { type Entity, folderOf, leafIds, migrationFolders, readSnapshots, startingState, stateOf } from "./state.ts"

const breakpoint = "--> statement-breakpoint\n"

const log = (message: string) => process.stderr.write(`[drizzle-matview-kit] ${message}\n`)

// bin.cjs isn't in kit's exports map, but it sits next to the `./cli` entry, which is.
const kitBin = () => join(dirname(createRequire(import.meta.url).resolve("drizzle-kit/cli")), "bin.cjs")

type KitRun = { code: number; stdout: string }

// `held` keeps kit's stdout instead of printing it, for a `--output json` run whose envelope may be replaced by
// a second run's. JSON output never prompts, so holding stdout back costs nothing.
const runKit = (args: string[], held = false): KitRun => {
	const result = spawnSync(process.execPath, [kitBin(), ...args], {
		stdio: ["inherit", held ? "pipe" : "inherit", "inherit"],
		encoding: "utf8",
	})
	return { code: result.status ?? 1, stdout: result.stdout ?? "" }
}

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

// Kit has written `folder` by the time this runs. If the package can't finish it, it removes the folder, so the
// next run regenerates the migration instead of finding kit's unordered SQL and no ledger.
const finishing = async (project: Project, folder: string, work: () => Promise<void>) => {
	try {
		await work()
	} catch (error) {
		rmSync(join(project.out, folder), { recursive: true, force: true })
		throw new Error(`${(error as Error).message}\nRemoved ${folder}, which drizzle-kit wrote, so the next run writes it again.`)
	}
}

// Kit sees no change when only the indexes changed. The state is that of kit's leaves, combined when the folder
// has several, because that is the state a new migration starts from.
const indexesChanged = async (project: Project, curIndexes: Entity[]): Promise<boolean> => {
	const files = readSnapshots(project.out)
	const leaves = leafIds(files)
	if (leaves.length === 0) return false
	const state = await startingState(files, leaves)
	const prevIndexes = startingLedger(project.out, files, leaves)
	return needsRewrite(plan({ prev: state, cur: state, hints: [], viewRenames: new Map(), prevIndexes, curIndexes }))
}

const generate = async (args: string[]): Promise<number> => {
	const flags = parseFlags(args)
	if (flags.explain === true) return runKit(["generate", ...args]).code

	const project = await loadProject(flags)
	if (flags.custom === true) {
		const before = new Set(migrationFolders(project.out))
		const { code } = runKit(["generate", ...args])
		const folder = newFolder(project, before)
		if (code === 0 && folder) {
			await finishing(project, folder, async () => {
				const files = readSnapshots(project.out)
				writeLedger(project.out, folder, startingLedger(project.out, files, files[folder].prevIds))
			})
		}
		return code
	}

	const curIndexes = await declaredIndexes(project)
	const json = flags.output === "json"
	const before = new Set(migrationFolders(project.out))
	const first = runKit(["generate", ...args], json)

	let folder = newFolder(project, before)
	if (first.code !== 0 || folder || !(await indexesChanged(project, curIndexes))) {
		process.stdout.write(first.stdout)
		if (first.code !== 0) return first.code
		if (!folder) return 0
	} else {
		const custom = runKit(["generate", "--custom", ...args])
		if (custom.code !== 0) return custom.code
		folder = newFolder(project, before)
		if (!folder) throw new Error("drizzle-kit wrote no custom migration for the index changes.")
	}
	const written = folder
	await finishing(project, written, () => rewrite(project, written, curIndexes))
	return 0
}

/** Records the declared indexes as already applied, for a database that has them from before this package. */
const baseline = async (args: string[]): Promise<number> => {
	const project = await loadProject(parseFlags(args))
	const files = readSnapshots(project.out)
	const leaves = leafIds(files).map((id) => folderOf(files, id)!)
	if (leaves.length === 0) throw new Error(`${project.out} has no migrations to baseline.`)
	if (leaves.length > 1) throw new Error(`${project.out} has ${leaves.length} branches. Merge them with generate first.`)
	const [leaf] = leaves
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
