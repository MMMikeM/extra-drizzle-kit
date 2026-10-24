import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export type Flags = Record<string, string | boolean>

const booleanFlags = new Set(["custom", "explain", "breakpoints", "fix-conflicts", "ignore-conflicts"])

/**
 * kit's `generate` flags, read only for what the wrapper needs; the arguments go to kit unchanged. A boolean
 * flag takes an optional `true` or `false`, as `--custom false` or `--explain=false`, because kit reads it.
 */
export const parseFlags = (args: string[]): Flags => {
	const flags: Flags = {}
	for (let i = 0; i < args.length; i++) {
		const match = /^--([^=]+)(?:=(.*))?$/.exec(args[i])
		if (!match) continue
		const [, name, inline] = match
		const next = args[i + 1]
		if (booleanFlags.has(name)) {
			const value = inline ?? (next === "true" || next === "false" ? args[++i] : "true")
			flags[name] = value === "true"
		} else if (inline !== undefined) flags[name] = inline
		else if (next === undefined || next.startsWith("--")) flags[name] = true
		else flags[name] = args[++i]
	}
	return flags
}

export type Project = {
	out: string
	breakpoints: boolean
	/** What kit's SDK needs to load the same schema the CLI will. */
	source: { config: string } | { schema: string; dialect: string }
}

// Mirrors kit's `assertCollisions`: any of these on the command line means kit ignores the config file.
const cliOnly = ["driver", "breakpoints", "schema", "out", "dialect"]

const assertPostgres = (dialect: unknown) => {
	if (dialect !== "postgresql") throw new Error(`drizzle-kit-matview supports only the postgresql dialect, not ${String(dialect)}.`)
}

export const loadProject = async (flags: Flags): Promise<Project> => {
	if (cliOnly.some((name) => name in flags)) {
		assertPostgres(flags.dialect)
		return {
			out: typeof flags.out === "string" ? flags.out : "drizzle",
			breakpoints: flags.breakpoints !== false,
			source: { schema: String(flags.schema), dialect: "postgresql" },
		}
	}
	const config =
		typeof flags.config === "string" ? flags.config : existsSync("drizzle.config.ts") ? "drizzle.config.ts" : "drizzle.config.js"
	const path = resolve(config)
	if (!existsSync(path)) throw new Error(`Can't find the drizzle config ${path}.`)
	const loaded = (await import(pathToFileURL(path).href)) as { default?: Record<string, unknown> }
	const content = loaded.default ?? {}
	assertPostgres(content.dialect)
	return {
		out: typeof content.out === "string" ? content.out : "drizzle",
		breakpoints: content.breakpoints === undefined ? true : content.breakpoints === true,
		source: { config },
	}
}
