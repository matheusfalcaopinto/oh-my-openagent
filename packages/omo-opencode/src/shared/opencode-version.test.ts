import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import {
  parseVersion,
  compareVersions,
  getOpenCodeVersion,
  isOpenCodeVersionAtLeast,
  resetVersionCache,
  setVersionCache,
  MINIMUM_OPENCODE_VERSION,
  OPENCODE_NATIVE_AGENTS_INJECTION_VERSION,
} from "./opencode-version"

type ProbeReceipt = { directory: string; artifactPath: string; pid: number }

function parseProbeReceipt(text: string): ProbeReceipt {
  const value: unknown = JSON.parse(text)
  if (
    typeof value !== "object" || value === null ||
    !("directory" in value) || typeof value.directory !== "string" ||
    !("artifactPath" in value) || typeof value.artifactPath !== "string" ||
    !("pid" in value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0
  ) throw new Error("invalid version probe receipt")
  return { directory: value.directory, artifactPath: value.artifactPath, pid: value.pid }
}

function createProbeFixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-version-probe-fixture-"))
  const home = join(root, "home")
  const temp = join(root, "tmp")
  const bin = join(root, "bin")
  for (const directory of [home, temp, bin]) mkdirSync(directory)
  const receiptPath = join(root, "receipt.jsonl")
  const sentinel = join(temp, "caller-owned.txt")
  writeFileSync(sentinel, "caller-owned")
  const scriptPath = join(bin, "opencode.cjs")
  writeFileSync(scriptPath, [
    'const fs = require("node:fs");',
    'const directory = require("node:os").tmpdir();',
    'const artifactPath = require("node:path").join(directory, "native-version-artifact.so");',
    'fs.writeFileSync(artifactPath, "native extraction");',
    'fs.appendFileSync(process.env.OMO_VERSION_PROBE_RECEIPT, JSON.stringify({ directory, artifactPath, pid: process.pid }) + "\\n");',
    'if (process.env.OMO_VERSION_PROBE_MODE === "success") process.stdout.write("opencode v2.0.28\\n");',
    'else if (process.env.OMO_VERSION_PROBE_MODE === "error") process.exit(17);',
    'else { process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); }',
    "",
  ].join("\n"))
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(join(bin, "opencode"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(scriptPath)}\n`)
  chmodSync(join(bin, "opencode"), 0o755)
  writeFileSync(join(bin, "opencode.cmd"), `@"${process.execPath}" "${scriptPath}"\r\n`)
  return { root, home, temp, bin, receiptPath, sentinel }
}

function cleanupProbeFixture(fixture: ReturnType<typeof createProbeFixture>): void {
  try {
    if (existsSync(fixture.receiptPath)) {
      for (const line of readFileSync(fixture.receiptPath, "utf8").trim().split("\n")) {
        const { pid } = parseProbeReceipt(line)
        try {
          process.kill(pid, "SIGKILL")
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
        }
      }
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

describe("opencode-version", () => {
  describe("parseVersion", () => {
    test("parses simple version", () => {
      // given a simple version string
      const version = "1.2.3"

      // when parsed
      const result = parseVersion(version)

      // then returns array of numbers
      expect(result).toEqual([1, 2, 3])
    })

    test("handles v prefix", () => {
      // given version with v prefix
      const version = "v1.2.3"

      // when parsed
      const result = parseVersion(version)

      // then strips prefix and parses correctly
      expect(result).toEqual([1, 2, 3])
    })

    test("handles prerelease suffix", () => {
      // given version with prerelease
      const version = "1.2.3-beta.1"

      // when parsed
      const result = parseVersion(version)

      // then ignores prerelease part
      expect(result).toEqual([1, 2, 3])
    })

    test("handles two-part version", () => {
      // given two-part version
      const version = "1.2"

      // when parsed
      const result = parseVersion(version)

      // then returns two numbers
      expect(result).toEqual([1, 2])
    })
  })

  describe("compareVersions", () => {
    test("returns 0 for equal versions", () => {
      // given two equal versions
      // when compared
      const result = compareVersions("1.1.1", "1.1.1")

      // then returns 0
      expect(result).toBe(0)
    })

    test("returns 1 when a > b", () => {
      // given a is greater than b
      // when compared
      const result = compareVersions("1.2.0", "1.1.0")

      // then returns 1
      expect(result).toBe(1)
    })

    test("returns -1 when a < b", () => {
      // given a is less than b
      // when compared
      const result = compareVersions("1.0.9", "1.1.0")

      // then returns -1
      expect(result).toBe(-1)
    })

    test("handles different length versions", () => {
      // given versions with different lengths
      // when compared
      expect(compareVersions("1.1", "1.1.0")).toBe(0)
      expect(compareVersions("1.1.1", "1.1")).toBe(1)
      expect(compareVersions("1.1", "1.1.1")).toBe(-1)
    })

    test("handles major version differences", () => {
      // given major version difference
      // when compared
      expect(compareVersions("2.0.0", "1.9.9")).toBe(1)
      expect(compareVersions("1.9.9", "2.0.0")).toBe(-1)
    })
  })


  describe("getOpenCodeVersion", () => {
    beforeEach(() => {
      resetVersionCache()
    })

    afterEach(() => {
      resetVersionCache()
    })

    test("returns cached version on subsequent calls", () => {
      // given version is set in cache
      setVersionCache("1.2.3")

      // when getting version
      const result = getOpenCodeVersion()

      // then returns cached value
      expect(result).toBe("1.2.3")
    })

    test("returns null when cache is set to null", () => {
      // given cache is explicitly set to null
      setVersionCache(null)

      // when getting version (cache is already set)
      const result = getOpenCodeVersion()

      // then returns null without executing command
      expect(result).toBe(null)
    })

    test("reads adjacent package version before executing opencode binary", () => {
      // given an opencode package next to the resolved binary
      const calls: string[] = []
      const packageRoot = join("/tmp", "opencode-ai")
      const binaryPath = join(packageRoot, "bin", "opencode")
      const packagePath = join(packageRoot, "package.json")

      // when getting version
      const result = getOpenCodeVersion({
        getBinaryPath: () => binaryPath,
        realpath: (filePath) => filePath,
        exists: (filePath) => filePath === packagePath,
        readText: (filePath) => {
          calls.push(`read:${filePath}`)
          return JSON.stringify({ name: "opencode-ai", version: "1.14.41" })
        },
        execCommand: () => {
          calls.push("exec")
          return "1.14.41"
        },
      })

      // then the version is resolved without spawning the CLI
      expect(result).toBe("1.14.41")
      expect(calls).toEqual([`read:${packagePath}`])
    })

    test("falls back to opencode binary when package version is unavailable", () => {
      // given no adjacent package version can be read
      const calls: string[] = []

      // when getting version
      const result = getOpenCodeVersion({
        getBinaryPath: () => "/tmp/custom-opencode",
        realpath: (filePath) => filePath,
        exists: () => false,
        readText: () => {
          calls.push("read")
          return ""
        },
        execCommand: () => {
          calls.push("exec")
          return "opencode 1.14.42"
        },
      })

      // then the original CLI fallback remains intact
      expect(result).toBe("1.14.42")
      expect(calls).toEqual(["exec"])
    })

    test("falls back to opencode binary when adjacent package JSON is invalid", () => {
      // given adjacent package JSON cannot be parsed

      // when getting version
      const result = getOpenCodeVersion({
        getBinaryPath: () => "/tmp/opencode-ai/bin/opencode",
        realpath: (filePath) => filePath,
        exists: (filePath) => filePath === "/tmp/opencode-ai/package.json",
        readText: () => "{not json",
        execCommand: () => "opencode 1.14.43",
      })

      // then the CLI fallback remains intact
      expect(result).toBe("1.14.43")
    })

    test("falls back to opencode binary when resolving the adjacent package fails", () => {
      // given the binary realpath lookup fails

      // when getting version
      const result = getOpenCodeVersion({
        getBinaryPath: () => "/tmp/opencode-ai/bin/opencode",
        realpath: () => {
          throw new Error("realpath failed")
        },
        exists: () => true,
        readText: () => JSON.stringify({ name: "opencode-ai", version: "1.14.44" }),
        execCommand: () => "opencode 1.14.44",
      })

      // then the CLI fallback remains intact
      expect(result).toBe("1.14.44")
    })

    test("returns null when opencode binary execution fails", () => {
      // given package lookup is unavailable and the binary command fails

      // when getting version
      const result = getOpenCodeVersion({
        getBinaryPath: () => null,
        realpath: (filePath) => filePath,
        exists: () => false,
        readText: () => "",
        execCommand: () => {
          throw new Error("opencode missing")
        },
      })

      // then version detection remains fail-safe
      expect(result).toBeNull()
    })

    test.each([
      ["success", "2.0.28"],
      ["error", null],
      ["timeout", null],
    ] as const)("cleans native extraction files after a %s probe", (mode, expectedVersion) => {
      const fixture = createProbeFixture()
      try {
        const env: NodeJS.ProcessEnv = {
          PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
          HOME: fixture.home,
          USERPROFILE: fixture.home,
          XDG_DATA_HOME: join(fixture.home, "data"),
          XDG_CONFIG_HOME: join(fixture.home, "config"),
          XDG_STATE_HOME: join(fixture.home, "state"),
          XDG_CACHE_HOME: join(fixture.home, "cache"),
          TMPDIR: fixture.temp,
          TEMP: fixture.temp,
          TMP: fixture.temp,
          OMO_VERSION_PROBE_MODE: mode,
          OMO_VERSION_PROBE_RECEIPT: fixture.receiptPath,
        }
        for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "windir"]) {
          const value = process.env[key]
          if (value !== undefined) env[key] = value
        }
        const moduleUrl = new URL("./opencode-version.ts", import.meta.url).href
        const expression = `const { getOpenCodeVersion } = await import(${JSON.stringify(moduleUrl)}); const originalTemp = [process.env.TMPDIR, process.env.TEMP, process.env.TMP]; const version = getOpenCodeVersion(); const cachedVersion = getOpenCodeVersion(); console.log(JSON.stringify({ version, cachedVersion, originalTemp, afterTemp: [process.env.TMPDIR, process.env.TEMP, process.env.TMP] }));`
        const run = spawnSync(process.execPath, ["--eval", expression], {
          cwd: fixture.root, env, encoding: "utf8", timeout: 20_000,
        })
        expect(run.status).toBe(0)
        const result: unknown = JSON.parse(run.stdout.trim())
        expect(result).toEqual({
          version: expectedVersion, cachedVersion: expectedVersion,
          originalTemp: [fixture.temp, fixture.temp, fixture.temp],
          afterTemp: [fixture.temp, fixture.temp, fixture.temp],
        })
        const receipts = readFileSync(fixture.receiptPath, "utf8").trim().split("\n")
        expect(receipts).toHaveLength(1)
        const receipt = parseProbeReceipt(receipts[0] ?? "null")
        expect(existsSync(receipt.artifactPath)).toBe(false)
        expect(existsSync(receipt.directory)).toBe(false)
        expect(readFileSync(fixture.sentinel, "utf8")).toBe("caller-owned")
      } finally {
        cleanupProbeFixture(fixture)
      }
    }, 30_000)
  })

  describe("isOpenCodeVersionAtLeast", () => {
    beforeEach(() => {
      resetVersionCache()
    })

    afterEach(() => {
      resetVersionCache()
    })

    test("returns true for exact version", () => {
      // given version is 1.1.1
      setVersionCache("1.1.1")

      // when checking against 1.1.1
      const result = isOpenCodeVersionAtLeast("1.1.1")

      // then returns true
      expect(result).toBe(true)
    })

    test("returns true for versions above target", () => {
      // given version is above target
      setVersionCache("1.2.0")

      // when checking against 1.1.1
      const result = isOpenCodeVersionAtLeast("1.1.1")

      // then returns true
      expect(result).toBe(true)
    })

    test("returns false for versions below target", () => {
      // given version is below target
      setVersionCache("1.1.0")

      // when checking against 1.1.1
      const result = isOpenCodeVersionAtLeast("1.1.1")

      // then returns false
      expect(result).toBe(false)
    })

    test("returns true when version cannot be detected", () => {
      // given version is null (undetectable)
      setVersionCache(null)

      // when checking
      const result = isOpenCodeVersionAtLeast("1.1.1")

      // then returns true (assume newer version)
      expect(result).toBe(true)
    })
  })

  describe("MINIMUM_OPENCODE_VERSION", () => {
    test("is set to 1.4.0", () => {
      expect(MINIMUM_OPENCODE_VERSION).toBe("1.4.0")
    })
  })

  describe("OPENCODE_NATIVE_AGENTS_INJECTION_VERSION", () => {
    test("is set to 1.1.37", () => {
      // given the native agents injection version constant
      // when exported
      // then it should be 1.1.37 (PR #10678)
      expect(OPENCODE_NATIVE_AGENTS_INJECTION_VERSION).toBe("1.1.37")
    })

    test("version detection works correctly with native agents version", () => {
      // given OpenCode version at or above native agents injection version
      setVersionCache("1.1.37")

      // when checking against native agents version
      const result = isOpenCodeVersionAtLeast(OPENCODE_NATIVE_AGENTS_INJECTION_VERSION)

      // then returns true (native support available)
      expect(result).toBe(true)
    })

    test("version detection returns false for older versions", () => {
      // given OpenCode version below native agents injection version
      setVersionCache("1.1.36")

      // when checking against native agents version
      const result = isOpenCodeVersionAtLeast(OPENCODE_NATIVE_AGENTS_INJECTION_VERSION)

      // then returns false (no native support)
      expect(result).toBe(false)
    })

    test("returns true when version detection fails (fail-safe)", () => {
      // given version cannot be detected
      setVersionCache(null)

      // when checking against native agents version
      const result = isOpenCodeVersionAtLeast(OPENCODE_NATIVE_AGENTS_INJECTION_VERSION)

      // then returns true (assume latest, enable native support)
      expect(result).toBe(true)
    })
  })
})
