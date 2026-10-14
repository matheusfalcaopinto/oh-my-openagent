import { describe, expect, test } from "bun:test"
import { discoverPluginBuiltRuntimes, evaluateBuiltRuntimeProbe, KNOWN_BUILT_RUNTIMES, requiredBuiltRuntimes } from "./no-raw-tls-client-scan"

describe("built omowright runtime probe (CI)", () => {
  test("#given CI and a missing KNOWN_BUILT_RUNTIMES file #when probed #then the failure names the expected path", () => {
    const verdict = evaluateBuiltRuntimeProbe({
      known: KNOWN_BUILT_RUNTIMES,
      present: () => false,
      discovered: [],
      ci: "true",
    })
    expect(
      verdict.failures.some((line) => line.includes("packages/omo-codex/plugin/skills/browser/runtime/omowright/index.js")),
      JSON.stringify(verdict),
    ).toBe(true)
    expect(verdict.scanned).toEqual([])
  })

  test("#given CI and a staged runtime file missing from KNOWN_BUILT_RUNTIMES #when probed #then the failure names the file", () => {
    const staged = "packages/omo-codex/plugin/skills/browser/runtime/omowright/worker.js"
    const verdict = evaluateBuiltRuntimeProbe({
      known: KNOWN_BUILT_RUNTIMES,
      present: () => true,
      discovered: [...KNOWN_BUILT_RUNTIMES, staged],
      ci: "true",
    })
    expect(
      verdict.failures.some((line) => line.includes(staged) && line.includes("KNOWN_BUILT_RUNTIMES")),
      JSON.stringify(verdict),
    ).toBe(true)
  })

  test("#given no CI #when a runtime is absent or unlisted #then the probe scans what exists without failing", () => {
    const verdict = evaluateBuiltRuntimeProbe({
      known: KNOWN_BUILT_RUNTIMES,
      present: (file) => file === KNOWN_BUILT_RUNTIMES[0],
      discovered: [KNOWN_BUILT_RUNTIMES[0], "packages/omo-codex/plugin/skills/browser/runtime/omowright/worker.js"],
      ci: undefined,
    })
    expect(verdict).toEqual({ scanned: [KNOWN_BUILT_RUNTIMES[0]], failures: [] })
  })

  test("#given the built tree #when runtime directories are discovered #then every staged omowright file is a KNOWN_BUILT_RUNTIMES entry", () => {
    const unlisted = discoverPluginBuiltRuntimes().filter((file) => !KNOWN_BUILT_RUNTIMES.includes(file))
    expect(unlisted, "built omowright runtimes missing from KNOWN_BUILT_RUNTIMES").toEqual([])
  })

  test("#given ordinary CI without a native build #when probed #then Codex and Senpi stay mandatory while no absent native payload is required", () => {
    const present = (file: string) => !file.startsWith("packages/omo-native/")
    const required = requiredBuiltRuntimes(present)
    expect(required).toHaveLength(4)
    expect(evaluateBuiltRuntimeProbe({ known: KNOWN_BUILT_RUNTIMES, required, present, discovered: required, ci: "true" }).failures).toEqual([])
    const missing = "packages/omo-senpi/plugin/skills/browser/runtime/omowright/index.js"
    expect(evaluateBuiltRuntimeProbe({ known: KNOWN_BUILT_RUNTIMES, required, present: file => present(file) && file !== missing, discovered: required, ci: "true" }).failures.some(line => line.includes(missing))).toBe(true)
  })

  test("#given a staged native payload missing its browser runtime #when CI probes #then both native runtime files are required", () => {
    const present = (file: string) => !file.startsWith("packages/omo-native/") || file === "packages/omo-native/plugin/package.json"
    const verdict = evaluateBuiltRuntimeProbe({ known: KNOWN_BUILT_RUNTIMES, required: requiredBuiltRuntimes(present), present, discovered: [], ci: "true" })
    expect(verdict.failures).toHaveLength(2)
    expect(verdict.failures.some(line => line.includes("omo-native/plugin/skills/browser/runtime/omowright/index.js"))).toBe(true)
    expect(verdict.failures.some(line => line.includes("omo-native/plugin/skills/browser/runtime/omowright/page-bundle.js"))).toBe(true)
  })

  test("#given a partial native runtime with no payload manifest #when CI probes #then the absent partner and an unlisted worker still fail", () => {
    const index = "packages/omo-native/plugin/skills/browser/runtime/omowright/index.js"
    const page = "packages/omo-native/plugin/skills/browser/runtime/omowright/page-bundle.js"
    const worker = "packages/omo-native/plugin/skills/browser/runtime/omowright/worker.js"
    const present = (file: string) => !file.startsWith("packages/omo-native/") || file === index
    const verdict = evaluateBuiltRuntimeProbe({ known: KNOWN_BUILT_RUNTIMES, required: requiredBuiltRuntimes(present), present, discovered: [index, worker], ci: "true" })
    expect(verdict.scanned).toContain(index)
    expect(verdict.failures.some(line => line.includes(page))).toBe(true)
    expect(verdict.failures.some(line => line.includes(worker))).toBe(true)
  })
})
