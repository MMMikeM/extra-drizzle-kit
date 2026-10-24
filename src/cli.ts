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
import { type Ledger, startingLedger, writeLedger } from "./ledger.ts"
import { clearDeclarations, declarations, declaredExtensions } from "./registry.ts"
import { folderOf, leafIds, migrationFolders, readSnapshots, startingState, stateOf } from "./state.ts"

const breakpoint = "--> statement-breakpoint\n"

const log = (message: string) => process.stderr.write(`[extra-drizzle-kit] ${message}\n`)

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
// package's `pgMaterializedView` and `pgExtension` land in this process.
const declared = async (project: Project): Promise<Ledger> => {
	clearDeclarations()
	const result = await exportSql(project.source as Parameters<typeof exportSql>[0])
	if (result.status !== "ok") {
		throw new Error(`drizzle-kit couldn't load the schema: ${JSON.stringify("error" in result ? result.error : result)}`)
	}
	return { indexes: await indexEntities(declarations()), extensions: declaredExtensions() }
}

const inputOf = (prev: Ledger, cur: Ledger) => ({
	prevIndexes: prev.indexes,
	curIndexes: cur.indexes,
	prevExtensions: prev.extensions,
	curExtensions: cur.extensions,
})

const newFolder = (project: Project, before: Set<string>): string | undefined => {
	const created = migrationFolders(project.out).filter((folder) => !before.has(folder))
	if (created.length > 1) throw new Error(`drizzle-kit wrote ${created.length} migrations: ${created.join(", ")}.`)
	return created[0]
}

const rewrite = async (project: Project, folder: string, wanted: Ledger) => {
	const files = readSnapshots(project.out)
	const snapshot = files[folder]
	const cur = await stateOf(files, snapshot.id)
	const prev = await startingState(files, snapshot.prevIds)
	const { hints, views } = await hintsOf(files, snapshot, cur)
	const input = { prev, cur, hints, viewRenames: views, ...inputOf(startingLedger(project.out, files, snapshot.prevIds), wanted) }
	const p = plan(input)
	if (needsRewrite(p)) {
		const statements = await assemble(input, p)
		writeFileSync(join(project.out, folder, "migration.sql"), statements.join(project.breakpoints ? breakpoint : "\n"))
		const indexChanges = p.dropIndexes.length + p.createIndexes.length
		log(
			`Rebuilt ${folder}/migration.sql: ${p.drops.length} view drop(s), ${p.creates.length} view create(s), ` +
				`${indexChanges} index change(s), ${p.createExtensions.length} new extension(s).`,
		)
	}
	for (const { name } of p.removedExtensions) {
		log(`Extension ${name} is no longer declared. It stays in the database; drop it by hand if you mean to.`)
	}
	writeLedger(project.out, folder, wanted)
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

// Kit sees no change when only the package's part of the schema changed. The state is that of kit's leaves,
// combined when the folder has several, because that is the state a new migration starts from.
const onlyPackageChanged = async (project: Project, wanted: Ledger): Promise<boolean> => {
	const files = readSnapshots(project.out)
	const leaves = leafIds(files)
	if (leaves.length === 0) return false
	const state = await startingState(files, leaves)
	const input = { prev: state, cur: state, hints: [], viewRenames: new Map(), ...inputOf(startingLedger(project.out, files, leaves), wanted) }
	return needsRewrite(plan(input))
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

	const wanted = await declared(project)
	const json = flags.output === "json"
	const before = new Set(migrationFolders(project.out))
	const first = runKit(["generate", ...args], json)

	let folder = newFolder(project, before)
	let envelope = first.stdout
	if (first.code !== 0 || (!folder && !(await onlyPackageChanged(project, wanted)))) {
		process.stdout.write(envelope)
		return first.code
	}
	if (!folder) {
		const custom = runKit(["generate", "--custom", ...args], json)
		if (custom.code !== 0) {
			process.stdout.write(custom.stdout)
			return custom.code
		}
		folder = newFolder(project, before)
		if (!folder) throw new Error("drizzle-kit wrote no custom migration for the package's changes.")
		envelope = custom.stdout
	}
	const written = folder
	await finishing(project, written, () => rewrite(project, written, wanted))
	// Only now, so that a JSON envelope saying "ok" never names a migration the package then removed.
	process.stdout.write(envelope)
	return 0
}

/**
 * Records the declared indexes and extensions as already applied, for a database that has them from before this
 * package.
 */
const baseline = async (args: string[]): Promise<number> => {
	const project = await loadProject(parseFlags(args))
	const files = readSnapshots(project.out)
	const leaves = leafIds(files).map((id) => folderOf(files, id)!)
	if (leaves.length === 0) throw new Error(`${project.out} has no migrations to baseline.`)
	if (leaves.length > 1) throw new Error(`${project.out} has ${leaves.length} branches. Merge them with generate first.`)
	const [leaf] = leaves
	writeLedger(project.out, leaf, await declared(project))
	log(`Recorded the declared indexes and extensions in ${leaf}.`)
	return 0
}

const usage = `Usage:
  extra-drizzle-kit generate [drizzle-kit generate options]
  extra-drizzle-kit baseline [--config <path>]`

const pushUnsupported = `push isn't supported. drizzle-kit push never reads migration files, so it creates no indexes
on materialized views and no extensions, and it never updates an edited view. Run
\`extra-drizzle-kit generate\`, then \`drizzle-kit migrate\`.`

const [command, ...args] = process.argv.slice(2)
try {
	if (command === "generate") process.exitCode = await generate(args)
	else if (command === "baseline") process.exitCode = await baseline(args)
	else if (command === "push") {
		log(pushUnsupported)
		process.exitCode = 2
	}
	else {
		process.stderr.write(`${usage}\n`)
		process.exitCode = command === "--help" || command === "-h" ? 0 : 2
	}
} catch (error) {
	log((error as Error).message)
	process.exitCode = 1
}
