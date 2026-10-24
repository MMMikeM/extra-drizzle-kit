import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vite-plus/test"

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url))

describe("extra-drizzle-kit push", () => {
	it("refuses, and says to generate and migrate instead", () => {
		const result = spawnSync(process.execPath, [cli, "push"], { encoding: "utf8" })
		expect(result.status).toBe(2)
		expect(result.stderr).toContain("push isn't supported")
		expect(result.stderr).toContain("drizzle-kit migrate")
	})
})
