/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { extractSemverFromOutput } from "../../../shared/extract-semver"

const DOCTOR_CHECKS_DIR = import.meta.dir
const RAW_BUN_RUNTIME_RE = /(?<!runtime\.)\bBun\.(?:version|which)\b/

type ProbeReceipt = { directory: string; artifactPath: string; selectors: string[]; pid: number }

function parseProbeReceipt(text: string): ProbeReceipt {
  const value: unknown = JSON.parse(text)
  if (
    typeof value !== "object" || value === null ||
    !("directory" in value) || typeof value.directory !== "string" ||
    !("artifactPath" in value) || typeof value.artifactPath !== "string" ||
    !("selectors" in value) || !Array.isArray(value.selectors) || !value.selectors.every((item) => typeof item === "string") ||
    !("pid" in value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0
  ) throw new Error("invalid doctor version probe receipt")
  return { directory: value.directory, artifactPath: value.artifactPath, selectors: value.selectors, pid: value.pid }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

function createProbeFixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-doctor-probe-fixture-"))
  try {
    const home = join(root, "home")
    const temp = join(root, "tmp")
    mkdirSync(home)
    mkdirSync(temp)
    const receiptPath = join(root, "receipt.jsonl")
    const sentinel = join(temp, "caller-owned.txt")
    writeFileSync(sentinel, "caller-owned")
    const scriptPath = join(root, "opencode.cjs")
    writeFileSync(scriptPath, [
      'const fs = require("node:fs");',
      'const directory = require("node:os").tmpdir();',
      'const artifactPath = require("node:path").join(directory, "native-version-artifact.so");',
      'fs.writeFileSync(artifactPath, "native extraction");',
      'fs.appendFileSync(process.env.OMO_DOCTOR_PROBE_RECEIPT, JSON.stringify({ directory, artifactPath, selectors: [process.env.TMPDIR, process.env.TEMP, process.env.TMP], pid: process.pid }) + "\\n");',
      'if (process.env.OMO_DOCTOR_PROBE_MODE === "success") process.stdout.write("opencode v2.0.28\\n");',
      'else if (process.env.OMO_DOCTOR_PROBE_MODE === "error") process.exit(17);',
      'else { process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000); }',
      "",
    ].join("\n"))
    const binaryPath = join(root, process.platform === "win32" ? "opencode.ps1" : "opencode")
    if (process.platform === "win32") {
      writeFileSync(binaryPath, [
        '$directory = [System.IO.Path]::GetTempPath().TrimEnd("\\", "/")',
        '$artifactPath = Join-Path $directory "native-version-artifact.so"',
        '[System.IO.File]::WriteAllText($artifactPath, "native extraction")',
        '$receipt = @{ directory = $directory; artifactPath = $artifactPath; selectors = @($env:TMPDIR, $env:TEMP, $env:TMP); pid = $PID } | ConvertTo-Json -Compress',
        '[System.IO.File]::AppendAllText($env:OMO_DOCTOR_PROBE_RECEIPT, $receipt + "`n")',
        'if ($env:OMO_DOCTOR_PROBE_MODE -eq "success") { Write-Output "opencode v2.0.28"; exit 0 }',
        'if ($env:OMO_DOCTOR_PROBE_MODE -eq "error") { exit 17 }',
        'while ($true) { Start-Sleep -Seconds 1 }',
        "",
      ].join("\n"))
    } else {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      writeFileSync(binaryPath, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(scriptPath)}\n`)
      chmodSync(binaryPath, 0o755)
    }
    return { root, home, temp, binaryPath, receiptPath, sentinel }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function cleanupProbeFixture(fixture: ReturnType<typeof createProbeFixture>): void {
  try {
    if (existsSync(fixture.receiptPath)) {
      for (const line of readFileSync(fixture.receiptPath, "utf8").trim().split("\n")) {
        const { pid } = parseProbeReceipt(line)
        if (isProcessRunning(pid)) process.kill(pid, "SIGKILL")
      }
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

describe("getOpenCodeVersion subprocess ownership", () => {
  it.each(["success", "error", "timeout", "missing", "unexecutable", "concurrent"] as const)("cleans only child-owned native extraction after %s", (mode) => {
    const fixture = createProbeFixture()
    try {
      const count = mode === "concurrent" ? 2 : 1
      const binaryPath = mode === "missing" ? join(fixture.root, "missing-opencode")
        : mode === "unexecutable" ? fixture.root : fixture.binaryPath
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: fixture.home, USERPROFILE: fixture.home,
        XDG_DATA_HOME: join(fixture.home, "data"), XDG_CONFIG_HOME: join(fixture.home, "config"),
        XDG_STATE_HOME: join(fixture.home, "state"), XDG_CACHE_HOME: join(fixture.home, "cache"),
        TMPDIR: fixture.temp, TEMP: fixture.temp, TMP: fixture.temp,
        OMO_DOCTOR_PROBE_MODE: mode === "concurrent" ? "success" : mode,
        OMO_DOCTOR_PROBE_RECEIPT: fixture.receiptPath,
      }
      const moduleUrl = new URL("./system-binary.ts", import.meta.url).href
      const expression = `const { getOpenCodeVersion } = await import(${JSON.stringify(moduleUrl)}); const originalEnv = JSON.stringify(process.env); const originalTemp = [process.env.TMPDIR, process.env.TEMP, process.env.TMP]; const versions = await Promise.all(Array.from({ length: ${count} }, () => getOpenCodeVersion(${JSON.stringify(binaryPath)}))); console.log(JSON.stringify({ versions, originalTemp, afterTemp: [process.env.TMPDIR, process.env.TEMP, process.env.TMP], parentEnvUnchanged: JSON.stringify(process.env) === originalEnv }));`
      const run = spawnSync(process.execPath, ["--eval", expression], {
        cwd: fixture.root, env, encoding: "utf8", timeout: 15_000,
      })
      expect(run.status).toBe(0)
      const result: unknown = JSON.parse(run.stdout.trim())
      const expectedVersion = mode === "success" || mode === "concurrent" ? "2.0.28" : null
      expect(result).toEqual({
        versions: Array.from({ length: count }, () => expectedVersion),
        originalTemp: [fixture.temp, fixture.temp, fixture.temp],
        afterTemp: [fixture.temp, fixture.temp, fixture.temp], parentEnvUnchanged: true,
      })
      const receipts = existsSync(fixture.receiptPath)
        ? readFileSync(fixture.receiptPath, "utf8").trim().split("\n").map(parseProbeReceipt)
        : []
      expect(receipts).toHaveLength(mode === "missing" || mode === "unexecutable" ? 0 : count)
      expect(new Set(receipts.map((receipt) => receipt.directory)).size).toBe(receipts.length)
      for (const receipt of receipts) {
        expect(receipt.selectors).toEqual([receipt.directory, receipt.directory, receipt.directory])
        expect(existsSync(receipt.artifactPath)).toBe(false)
        expect(dirname(receipt.directory)).toBe(fixture.temp)
        expect(existsSync(receipt.directory)).toBe(false)
        expect(isProcessRunning(receipt.pid)).toBe(false)
      }
      expect(readdirSync(fixture.temp)).toEqual(["caller-owned.txt"])
      expect(readFileSync(fixture.sentinel, "utf8")).toBe("caller-owned")
    } finally {
      cleanupProbeFixture(fixture)
    }
  })
})

describe("findOpenCodeBinary node fallback safety", () => {
  it("#given doctor runs under node fallback #when check sources are audited #then they avoid raw Bun globals", () => {
    // given
    const sources = readdirSync(DOCTOR_CHECKS_DIR)
      .filter((fileName) => fileName.endsWith(".ts") && !fileName.endsWith(".test.ts"))
      .map((fileName) => ({ fileName, source: readFileSync(join(DOCTOR_CHECKS_DIR, fileName), "utf8") }))

    // when
    const offenders = sources
      .filter(({ source }) => RAW_BUN_RUNTIME_RE.test(source))
      .map(({ fileName }) => fileName)

    // then
    expect(offenders).toEqual([])
  })
})

describe("extractSemverFromOutput", () => {
  describe("#given clean version output #when extractSemverFromOutput #then returns the semver token", () => {
    it("plain semver", () => {
      expect(extractSemverFromOutput("1.14.33")).toBe("1.14.33")
    })

    it("v-prefixed semver strips the prefix", () => {
      expect(extractSemverFromOutput("v1.14.33")).toBe("1.14.33")
    })

    it("trailing whitespace and newlines are tolerated", () => {
      expect(extractSemverFromOutput("  1.14.33\n")).toBe("1.14.33")
    })

    it("pre-release suffix is preserved", () => {
      expect(extractSemverFromOutput("1.0.0-beta.1")).toBe("1.0.0-beta.1")
    })

    it("build metadata is preserved", () => {
      expect(extractSemverFromOutput("1.0.0+build.42")).toBe("1.0.0+build.42")
    })
  })

  describe("#given Electron log-polluted stdout #when extractSemverFromOutput #then ignores the timestamp and finds the version", () => {
    it("regression for #3765: Electron desktop dumps log lines into stdout", () => {
      const polluted = "00:24:25.202 > app starting { version: '1.14.33', packaged: true }"
      expect(extractSemverFromOutput(polluted)).toBe("1.14.33")
    })

    it("multi-line stdout with log prefix and trailing version", () => {
      const polluted = "12:00:00.001 [info] starting opencode\n1.14.33\n"
      expect(extractSemverFromOutput(polluted)).toBe("1.14.33")
    })

    it("timestamp-only stdout returns null", () => {
      expect(extractSemverFromOutput("00:24:25.202 some log line")).toBe(null)
    })
  })

  describe("#given empty or invalid output #when extractSemverFromOutput #then returns null", () => {
    it("empty string", () => {
      expect(extractSemverFromOutput("")).toBe(null)
    })

    it("only whitespace", () => {
      expect(extractSemverFromOutput("   \n  ")).toBe(null)
    })

    it("text without any semver-shaped token", () => {
      expect(extractSemverFromOutput("hello world")).toBe(null)
    })

    it("incomplete semver (only major.minor) is rejected", () => {
      expect(extractSemverFromOutput("1.14")).toBe(null)
    })
  })
})
