import { readFileSync } from "node:fs"
import { defineConfig } from "vite-plus"

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		// Each integration test starts a Postgres container and runs drizzle-kit as a child process.
		testTimeout: 120_000,
		hookTimeout: 180_000,
	},
	pack: {
		entry: ["./src/index.ts", "./src/cli.ts"],
		format: ["esm"],
		dts: true,
		clean: true,
		unbundle: true,
		// attw, publint and the bundler only warn by default; these make each one fail the build instead.
		failOnWarn: true,
		attw: { profile: "esm-only", level: "error" },
		publint: { strict: true },
		plugins: [
			{
				name: "agents-md",
				generateBundle() {
					this.emitFile({ type: "asset", fileName: "AGENTS.md", source: readFileSync("docs/AGENTS.md", "utf8") })
				},
			},
		],
	},
})
