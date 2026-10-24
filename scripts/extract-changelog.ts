// The release notes for one version, from its CHANGELOG.md section. It runs under Node's type stripping, so it
// keeps to erasable syntax.
import { readFileSync } from "node:fs"

const [version, path = "CHANGELOG.md"] = process.argv.slice(2)
if (!version) {
	console.error("usage: extract-changelog.ts <version> [changelogPath]")
	process.exit(2)
}

const sectionOf = (lines: string[], target: string): string | null => {
	const heading = new RegExp(`^##\\s+\\[${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`)
	const start = lines.findIndex((line) => heading.test(line))
	if (start === -1) return null
	const next = lines.findIndex((line, i) => i > start && /^##\s+\[/.test(line))
	return lines
		.slice(start + 1, next === -1 ? lines.length : next)
		.join("\n")
		.trim()
}

const body = sectionOf(readFileSync(path, "utf8").split("\n"), version)
if (!body) {
	console.error(body === null ? `No section for version ${version} in ${path}` : `Section for ${version} is empty`)
	process.exit(1)
}
process.stdout.write(`${body}\n`)
