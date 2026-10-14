/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { delimiter } from "node:path"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const postinstallPath = fileURLToPath(new URL("./postinstall.mjs", import.meta.url))
const RENAME_NOTICE =
  "oh-my-openagent: the 'omo' command is now 'omo-agent-toolkit' (the old name was removed in this major release)."
const PACKAGE_VERSION: string = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")).version
const NATIVE_NOTICE = `oh-my-openagent: OmO Native is the same omo as one 'omo' command, with no OpenCode host: bun add -g ${PACKAGE_VERSION.includes("-") ? "omo-ai@beta" : "omo-ai"}`
const SUBPROCESS_TEST_TIMEOUT_MS = 30_000
const HANGING_OPENCODE_MS = 60_000

type PostinstallRun = {
  status: number | null
  stdout: string
  stderr: string
}

function runPostinstallInFixtureEnv(options: { readonly pathPrefix?: string; readonly timeoutMs?: number; readonly expression?: string } = {}): PostinstallRun {
  const fixtureHome = mkdtempSync(join(tmpdir(), "omo-postinstall-fixture-"))
  const inheritedPath = process.env.PATH ?? ""
  try {
    mkdirSync(join(fixtureHome, "tmp"))
    const args = options.expression === undefined ? [postinstallPath] : ["--eval", options.expression]
    const result = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: options.timeoutMs,
      env: {
        ...inheritedPlatformEnv(),
        PATH: options.pathPrefix === undefined ? inheritedPath : `${options.pathPrefix}${delimiter}${inheritedPath}`,
        HOME: fixtureHome,
        USERPROFILE: fixtureHome,
        XDG_DATA_HOME: join(fixtureHome, "data"),
        XDG_CONFIG_HOME: join(fixtureHome, "config"),
        XDG_STATE_HOME: join(fixtureHome, "state"),
        XDG_CACHE_HOME: join(fixtureHome, "cache"),
        TMPDIR: join(fixtureHome, "tmp"),
        TEMP: join(fixtureHome, "tmp"),
        TMP: join(fixtureHome, "tmp"),
      },
    })
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true })
  }
}

function writeVersionOpencodeShim(output: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "omo-postinstall-version-opencode-"))
  const scriptPath = join(binDir, "version.cjs")
  writeFileSync(scriptPath, `process.stdout.write(${JSON.stringify(output)});\n`)
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(join(binDir, "opencode"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(scriptPath)}\n`)
  chmodSync(join(binDir, "opencode"), 0o755)
  writeFileSync(join(binDir, "opencode.cmd"), `@"${process.execPath}" "${scriptPath}"\r\n`)
  return binDir
}

function writeHangingOpencodeShim(): string {
  const binDir = mkdtempSync(join(tmpdir(), "omo-postinstall-hanging-opencode-"))
  const hang = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, ${HANGING_OPENCODE_MS})"`
  writeFileSync(join(binDir, "opencode"), `#!/bin/sh\nexec ${hang}\n`)
  chmodSync(join(binDir, "opencode"), 0o755)
  writeFileSync(join(binDir, "opencode.cmd"), `@${hang}\r\n`)
  return binDir
}

function inheritedPlatformEnv(): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "TEMP", "TMP", "windir"]) {
    const value = process.env[key]
    if (value !== undefined) inherited[key] = value
  }
  return inherited
}

function countNoticeLines(output: string): number {
  return output.split("\n").filter((line) => line.trim() === RENAME_NOTICE).length
}

function countNativeNotices(output: string): number {
  return output.split("\n").filter((line) => line.trim() === NATIVE_NOTICE).length
}

describe("postinstall rename notice", () => {
  test("names the install line of the package's own channel", () => {
    const run = runPostinstallInFixtureEnv({
      expression: `import(${JSON.stringify(pathToFileURL(postinstallPath).href)}).then(({ nativeNotice }) => console.log(JSON.stringify([nativeNotice("5.0.0"), nativeNotice("5.0.0-beta.90")])));`,
    })
    const notices: unknown = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "null")

    expect(run.status).toBe(0)
    expect(notices).toEqual([
      expect.stringMatching(/bun add -g omo-ai$/),
      expect.stringMatching(/bun add -g omo-ai@beta$/),
    ])
  })

  test("announces the omo-agent-toolkit rename exactly once", () => {
    // #given
    // a fixture environment isolated from the real HOME and OpenCode plugin cache

    // #when
    const run = runPostinstallInFixtureEnv()

    // #then
    expect(countNoticeLines(run.stdout)).toBe(1)
    expect(countNativeNotices(run.stdout)).toBe(1)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test("never fails the install regardless of platform binary resolution", () => {
    // #given
    // a fixture environment isolated from the real HOME and OpenCode plugin cache

    // #when
    const run = runPostinstallInFixtureEnv()

    // #then
    expect(run.status).toBe(0)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test("finishes when the opencode version probe never returns", () => {
    // #given
    const hangingBinDir = writeHangingOpencodeShim()

    try {
      // #when
      const startedAt = Date.now()
      const run = runPostinstallInFixtureEnv({ pathPrefix: hangingBinDir, timeoutMs: HANGING_OPENCODE_MS * 2 })

      // #then
      expect(run.status).toBe(0)
      expect(Date.now() - startedAt).toBeLessThan(HANGING_OPENCODE_MS)
    } finally {
      rmSync(hangingBinDir, { recursive: true, force: true })
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  test("stays idempotent across repeated runs", () => {
    // #given
    const firstRun = runPostinstallInFixtureEnv()

    // #when
    const secondRun = runPostinstallInFixtureEnv()

    // #then
    expect(countNoticeLines(firstRun.stdout)).toBe(1)
    expect(countNoticeLines(secondRun.stdout)).toBe(1)
    expect(countNativeNotices(firstRun.stdout)).toBe(1)
    expect(countNativeNotices(secondRun.stdout)).toBe(1)
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

describe("postinstall OpenCode version probe", () => {
  test.each([
    ["1.18.31", false],
    ["v1.18.31", false],
    ["1.4.0-beta.1", false],
    ["2.0.28", false],
    ["v2.0.28", false],
    ["opencode v2.0.28", false],
    ["opencode 2.0.28", false],
    ["opencode v1.18.31", false],
    ["opencode v2.0.28-beta.1+build.3\n", false],
    ["1.3.99", true],
    ["v1.3.99", true],
    ["1.3.99-beta.1", true],
    ["opencode v1.3.99-beta.1", true],
    ["", false],
    ["unexpected diagnostic", false],
    ["configuration migration 0.1.0", false],
  ] as const)("checks the minimum version for %s", (output, warns) => {
    const versionBinDir = writeVersionOpencodeShim(output)
    try {
      const run = runPostinstallInFixtureEnv({ pathPrefix: versionBinDir })

      expect(run.status).toBe(0)
      expect(run.stderr.includes("requires OpenCode >=")).toBe(warns)
    } finally {
      rmSync(versionBinDir, { recursive: true, force: true })
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})
