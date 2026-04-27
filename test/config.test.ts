import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_EVENTS,
  DEFAULT_MIN_SESSION_DURATION_SECONDS,
  DEFAULT_SERVER,
  loadConfig,
} from "../src/config.js"
import { createProjectDirectory, removeDirectory, writeProjectConfig } from "./helpers.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => removeDirectory(directory)))
})

async function createDirectory(): Promise<string> {
  const directory = await createProjectDirectory()
  directories.push(directory)
  return directory
}

describe("loadConfig", () => {
  test("returns null when config is missing", async () => {
    const directory = await createDirectory()
    const result = await loadConfig(directory)

    expect(result.config).toBeNull()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.message).toContain("plugin disabled")
  })

  test("returns a read error when config cannot be read", async () => {
    const directory = await createDirectory()
    await mkdir(join(directory, ".opencode", "ntfy.json"), { recursive: true })

    const result = await loadConfig(directory)

    expect(result.config).toBeNull()
    expect(result.warnings[0]?.message).toContain("Failed to read ntfy config")
    expect(result.warnings[0]?.extra?.code).toBe("EISDIR")
  })

  test("returns null for invalid JSON", async () => {
    const directory = await createDirectory()
    await writeProjectConfig(directory, "{not-json")

    const result = await loadConfig(directory)

    expect(result.config).toBeNull()
    expect(result.warnings[0]?.message).toContain("Invalid JSON")
  })

  test("returns null when topic is missing", async () => {
    const directory = await createDirectory()
    await writeProjectConfig(directory, JSON.stringify({ server: "https://ntfy.sh" }))

    const result = await loadConfig(directory)

    expect(result.config).toBeNull()
    expect(result.warnings[0]?.message).toContain("Missing ntfy topic")
  })

  test("applies default server and events", async () => {
    const directory = await createDirectory()
    await writeProjectConfig(directory, JSON.stringify({ topic: "demo" }))

    const result = await loadConfig(directory)

    expect(result.config).toEqual({
      server: DEFAULT_SERVER,
      topic: "demo",
      events: [...DEFAULT_EVENTS],
      minSessionDurationSeconds: DEFAULT_MIN_SESSION_DURATION_SECONDS,
    })
    expect(result.warnings).toHaveLength(0)
  })

  test("normalizes server and filters unknown events", async () => {
    const directory = await createDirectory()
    await writeProjectConfig(
      directory,
      JSON.stringify({
        server: "https://example.com///",
        topic: "demo",
        events: ["session.idle", "nope", "session.error"],
      }),
    )

    const result = await loadConfig(directory)

    expect(result.config).toEqual({
      server: "https://example.com",
      topic: "demo",
      events: ["session.idle", "session.error"],
      minSessionDurationSeconds: DEFAULT_MIN_SESSION_DURATION_SECONDS,
    })
    expect(result.warnings[0]?.message).toContain("unsupported ntfy events")
  })

  test("strips query and fragment from the ntfy server URL", async () => {
    const directory = await createDirectory()
    await writeProjectConfig(
      directory,
      JSON.stringify({
        server: "https://example.com/ntfy/?tenant=a#fragment",
        topic: "demo",
      }),
    )

    const result = await loadConfig(directory)

    expect(result.config).toEqual({
      server: "https://example.com/ntfy",
      topic: "demo",
      events: [...DEFAULT_EVENTS],
      minSessionDurationSeconds: DEFAULT_MIN_SESSION_DURATION_SECONDS,
    })
    expect(result.warnings[0]?.message).toContain("should not include query or fragment")
  })

  test("includes accessToken when configured", async () => {
    const directory = await createDirectory()
    await writeProjectConfig(
      directory,
      JSON.stringify({
        topic: "demo",
        accessToken: "tk_example",
      }),
    )

    const result = await loadConfig(directory)

    expect(result.config).toEqual({
      server: DEFAULT_SERVER,
      topic: "demo",
      accessToken: "tk_example",
      events: [...DEFAULT_EVENTS],
      minSessionDurationSeconds: DEFAULT_MIN_SESSION_DURATION_SECONDS,
    })
  })

  test("falls back to defaults for invalid server and unsupported events", async () => {
    const directory = await createDirectory()
    await writeProjectConfig(
      directory,
      JSON.stringify({
        server: "ftp://invalid",
        topic: "demo",
        events: ["unknown"],
      }),
    )

    const result = await loadConfig(directory)

    expect(result.config).toEqual({
      server: DEFAULT_SERVER,
      topic: "demo",
      events: [...DEFAULT_EVENTS],
      minSessionDurationSeconds: DEFAULT_MIN_SESSION_DURATION_SECONDS,
    })
    expect(result.warnings).toHaveLength(3)
  })

  test("parses custom minSessionDurationSeconds", async () => {
    const directory = await createDirectory()
    await writeProjectConfig(
      directory,
      JSON.stringify({
        topic: "demo",
        minSessionDurationSeconds: 120,
      }),
    )

    const result = await loadConfig(directory)

    expect(result.config).toEqual({
      server: DEFAULT_SERVER,
      topic: "demo",
      events: [...DEFAULT_EVENTS],
      minSessionDurationSeconds: 120,
    })
    expect(result.warnings).toHaveLength(0)
  })

  test("falls back to default for invalid minSessionDurationSeconds", async () => {
    const directory = await createDirectory()
    await writeProjectConfig(
      directory,
      JSON.stringify({
        topic: "demo",
        minSessionDurationSeconds: "not-a-number",
      }),
    )

    const result = await loadConfig(directory)

    expect(result.config).toEqual({
      server: DEFAULT_SERVER,
      topic: "demo",
      events: [...DEFAULT_EVENTS],
      minSessionDurationSeconds: DEFAULT_MIN_SESSION_DURATION_SECONDS,
    })
    expect(result.warnings[0]?.message).toContain("Invalid minSessionDurationSeconds")
  })

  test("falls back to default for negative minSessionDurationSeconds", async () => {
    const directory = await createDirectory()
    await writeProjectConfig(
      directory,
      JSON.stringify({
        topic: "demo",
        minSessionDurationSeconds: -5,
      }),
    )

    const result = await loadConfig(directory)

    expect(result.config).toEqual({
      server: DEFAULT_SERVER,
      topic: "demo",
      events: [...DEFAULT_EVENTS],
      minSessionDurationSeconds: DEFAULT_MIN_SESSION_DURATION_SECONDS,
    })
    expect(result.warnings[0]?.message).toContain("Negative minSessionDurationSeconds")
  })
})
