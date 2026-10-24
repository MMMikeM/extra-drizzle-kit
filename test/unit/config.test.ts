import { describe, expect, it } from "vite-plus/test"
import { parseFlags } from "../../src/config.ts"

describe("parseFlags", () => {
	it("reads a boolean flag's value the way drizzle-kit does", () => {
		expect(parseFlags(["--custom", "false", "--name", "x"])).toEqual({ custom: false, name: "x" })
		expect(parseFlags(["--explain=false", "--breakpoints"])).toEqual({ explain: false, breakpoints: true })
		expect(parseFlags(["--custom", "--name=x"])).toEqual({ custom: true, name: "x" })
	})

	it("leaves a word after a boolean flag to the next argument", () => {
		expect(parseFlags(["--explain", "--config", "drizzle.config.ts"])).toEqual({ explain: true, config: "drizzle.config.ts" })
	})
})
