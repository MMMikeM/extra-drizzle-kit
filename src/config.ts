import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

export type Flags = Record<string, string | true>

const booleanFlags = new Set(["custom", "explain", "breakpoints", "fix-conflicts", "ignore-conflicts"])

/** kit's `generate` flags, read only for what the wrapper needs; the arguments go to kit unchanged. */
export const parseFlags = (args: string[]): Flags => {
	const flags: Flags = {}
	for (let i = 0; i < args.length; i++) {
		const match = /^--([^=]+)(?:=(.*))?$/.exec(args[i])
		if (!match) continue
		const [, name, inline] = match
		if (inline !== undefined) flags[name] = inline
		else if (booleanFlags.has(name) || args[i + 1] === undefined || args[i + 1].startsWith("--")) flags[name] = true
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

const isOn = (value: string | true | undefined) => value === true || value === "true"

// Mirrors kit's `assertCollisions`: any of these on the command line means kit ignores the config file.
const cliOnly = ["driver", "breakpoints", "schema", "out", "dialect"]

const assertPostgres = (dialect: unknown) => {
	if (dialect !== "postgresql") throw new Error(`drizzle-matview-kit supports only the postgresql dialect, not ${String(dialect)}.`)
}

export const loadProject = async (flags: Flags): Promise<Project> => {
	if (cliOnly.some((name) => name in flags)) {
		assertPostgres(flags.dialect)
		return {
			out: typeof flags.out === "string" ? flags.out : "drizzle",
			breakpoints: "breakpoints" in flags ? isOn(flags.breakpoints) : true,
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
