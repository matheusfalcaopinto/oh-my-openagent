import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { CACHE_FILENAME } from "../bin/lib/setup-detect-cache.js"

const SOURCE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const TTY_DRIVER = resolve(fileURLToPath(new URL("tty-driver.py", import.meta.url)))
const ANSI_RED = "\u001b[31m"
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** A copied launcher over a fake engine that records its spawn and exits 0. */
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-banner-color-"))
  roots.push(root)
  const packageRoot = join(root, "app")
  cpSync(join(SOURCE_ROOT, "bin"), join(packageRoot, "bin"), { recursive: true })
  write(join(packageRoot, "package.json"), JSON.stringify({
    name: "omo-ai", version: "1.2.3-test.0", type: "module",
    dependencies: { "@code-yeongyu/senpi": "2026.8.9" },
  }))
  const senpiRoot = join(packageRoot, "node_modules", "@code-yeongyu", "senpi")
  write(join(senpiRoot, "package.json"), JSON.stringify({
    name: "@code-yeongyu/senpi", version: "2026.8.9", type: "module", exports: { ".": "./dist/index.js" },
  }))
  write(join(senpiRoot, "dist", "index.js"), "export const fixture = true\n")
  write(join(senpiRoot, "dist", "cli.js"), `
import { writeFileSync } from "node:fs"
writeFileSync(process.env.CAPTURE_FILE, "spawned")
process.exit(0)
`)
  write(join(senpiRoot, "dist", "core", "brand.js"), "export {}\n")
  for (const artifact of [
    "plugin/package.json", "plugin/extensions/omo.js", "plugin/runtime/lsp-daemon/dist/cli.js",
    "plugin/runtime/agent-toolkit/cli.js",
  ]) write(join(packageRoot, artifact), "fixture\n")
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  return {
    launcher: join(packageRoot, "bin", "omo.js"),
    captureFile: join(root, "capture.txt"),
    env: { HOME: home, SENPI_CODING_AGENT_DIR: join(root, "senpi-agent"), XDG_DATA_HOME: join(root, "xdg") },
  }
}

describe("interactive launch banner styling (#8442)", () => {
  test.skipIf(process.platform === "win32")("#given a color-enabled terminal #when an interactive launch prints the version banner #then the banner carries no error coloring", async () => {
    // given
    const fixture = createFixture()
    const inherited: NodeJS.ProcessEnv = { ...process.env, CAPTURE_FILE: fixture.captureFile, FORCE_COLOR: "1" }
    delete inherited.OMO_CODING_AGENT_DIR
    delete inherited.PI_CODING_AGENT_DIR
    delete inherited.NO_COLOR

    // The cold launch owns a detached refresh; subscribe before it can commit its cache.
    const agentDir = fixture.env.SENPI_CODING_AGENT_DIR
    mkdirSync(agentDir, { recursive: true })
    let watcher: FSWatcher | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const refreshWritten = new Promise<void>((resolve, reject) => {
      watcher = watch(agentDir, (_event, filename) => {
        if (filename && filename.toString() !== CACHE_FILENAME) return
        try {
          JSON.parse(readFileSync(join(agentDir, CACHE_FILENAME), "utf8"))
          resolve()
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return
          reject(error)
        }
      })
      watcher.once("error", reject)
      timer = setTimeout(() => reject(new Error("waited 10s for the fixture refresh to commit its cache")), 10_000)
    })

    try {
      // when
      const result = spawnSync("python3", [TTY_DRIVER, "", "", process.execPath, fixture.launcher], {
        encoding: "utf8",
        env: { ...inherited, ...fixture.env },
      })
      await refreshWritten

      // then
      expect(result.status).toBe(0)
      const output = `${result.stdout}${result.stderr}`
      expect(output).toContain("omo (omo-ai beta 1.2.3-test.0)")
      expect(output).not.toContain(ANSI_RED)
      expect(readFileSync(fixture.captureFile, "utf8")).toBe("spawned")
    } finally {
      if (timer) clearTimeout(timer)
      watcher?.close()
    }
  })
})
