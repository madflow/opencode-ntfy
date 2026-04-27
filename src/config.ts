import { readFile } from "node:fs/promises"
import { join } from "node:path"

export const CONFIG_RELATIVE_PATH = ".opencode/ntfy.json"
export const DEFAULT_SERVER = "https://ntfy.sh"
export const DEFAULT_EVENTS = ["session.idle", "session.error"] as const
export const DEFAULT_MIN_SESSION_DURATION_SECONDS = 30

export type SupportedEvent = (typeof DEFAULT_EVENTS)[number]

export interface NtfyConfig {
  server: string
  topic: string
  accessToken?: string
  events: SupportedEvent[]
  minSessionDurationSeconds: number
}

export interface ConfigWarning {
  message: string
  extra?: Record<string, unknown>
}

export interface LoadConfigResult {
  config: NtfyConfig | null
  warnings: ConfigWarning[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code
  }

  return undefined
}

function formatServerUrl(url: URL): string {
  const auth = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ""}@`
    : ""
  const base = `${url.protocol}//${auth}${url.host}`
  const pathname = url.pathname.replace(/\/+$/, "")

  return pathname && pathname !== "/" ? `${base}${pathname}` : base
}

function normalizeServer(value: unknown, warnings: ConfigWarning[]): string {
  if (typeof value !== "string") {
    if (value !== undefined) {
      warnings.push({
        message: "Invalid ntfy server in .opencode/ntfy.json; using default server",
        extra: { providedType: typeof value },
      })
    }

    return DEFAULT_SERVER
  }

  const trimmed = value.trim()
  if (!trimmed) {
    warnings.push({
      message: "Blank ntfy server in .opencode/ntfy.json; using default server",
    })
    return DEFAULT_SERVER
  }

  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported protocol ${url.protocol}`)
    }

    if (url.search || url.hash) {
      warnings.push({
        message: "ntfy server URL should not include query or fragment; ignoring them",
        extra: {
          hasQuery: Boolean(url.search),
          hasFragment: Boolean(url.hash),
        },
      })
      url.search = ""
      url.hash = ""
    }

    return formatServerUrl(url)
  } catch (error) {
    warnings.push({
      message: "Invalid ntfy server in .opencode/ntfy.json; using default server",
      extra: {
        error: formatError(error),
      },
    })
    return DEFAULT_SERVER
  }
}

function normalizeEvents(value: unknown, warnings: ConfigWarning[]): SupportedEvent[] {
  if (value === undefined) {
    return [...DEFAULT_EVENTS]
  }

  if (!Array.isArray(value)) {
    warnings.push({
      message: "Invalid ntfy events in .opencode/ntfy.json; using default events",
      extra: { events: value },
    })
    return [...DEFAULT_EVENTS]
  }

  const filtered = new Set<SupportedEvent>()
  const invalidEvents: unknown[] = []

  for (const event of value) {
    if (event === "session.idle" || event === "session.error") {
      filtered.add(event)
      continue
    }

    invalidEvents.push(event)
  }

  if (invalidEvents.length > 0) {
    warnings.push({
      message: "Ignoring unsupported ntfy events from .opencode/ntfy.json",
      extra: { events: invalidEvents },
    })
  }

  if (filtered.size === 0) {
    warnings.push({
      message: "No supported ntfy events configured in .opencode/ntfy.json; using default events",
    })
    return [...DEFAULT_EVENTS]
  }

  return [...filtered]
}

function normalizeMinSessionDurationSeconds(value: unknown, warnings: ConfigWarning[]): number {
  if (value === undefined) {
    return DEFAULT_MIN_SESSION_DURATION_SECONDS
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    warnings.push({
      message: "Invalid minSessionDurationSeconds in .opencode/ntfy.json; using default",
      extra: { providedType: typeof value },
    })
    return DEFAULT_MIN_SESSION_DURATION_SECONDS
  }

  if (value < 0) {
    warnings.push({
      message: "Negative minSessionDurationSeconds in .opencode/ntfy.json; using default",
      extra: { providedValue: value },
    })
    return DEFAULT_MIN_SESSION_DURATION_SECONDS
  }

  return value
}

export async function loadConfig(directory: string): Promise<LoadConfigResult> {
  const configPath = join(directory, ".opencode", "ntfy.json")

  let content: string
  try {
    content = await readFile(configPath, "utf8")
  } catch (error) {
    const code = getErrorCode(error)

    return {
      config: null,
      warnings: [
        {
          message:
            code === "ENOENT"
              ? "ntfy config not found; plugin disabled"
              : "Failed to read ntfy config; plugin disabled",
          extra: {
            path: CONFIG_RELATIVE_PATH,
            code,
            error: formatError(error),
          },
        },
      ],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    return {
      config: null,
      warnings: [
        {
          message: "Invalid JSON in .opencode/ntfy.json; plugin disabled",
          extra: {
            path: CONFIG_RELATIVE_PATH,
            error: formatError(error),
          },
        },
      ],
    }
  }

  if (!isPlainObject(parsed)) {
    return {
      config: null,
      warnings: [
        {
          message: "Invalid ntfy config format in .opencode/ntfy.json; plugin disabled",
          extra: {
            path: CONFIG_RELATIVE_PATH,
          },
        },
      ],
    }
  }

  const topic = typeof parsed.topic === "string" ? parsed.topic.trim() : ""
  if (!topic) {
    return {
      config: null,
      warnings: [
        {
          message: "Missing ntfy topic in .opencode/ntfy.json; plugin disabled",
          extra: {
            path: CONFIG_RELATIVE_PATH,
          },
        },
      ],
    }
  }

  const warnings: ConfigWarning[] = []
  const server = normalizeServer(parsed.server, warnings)
  const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : ""
  const events = normalizeEvents(parsed.events, warnings)
  const minSessionDurationSeconds = normalizeMinSessionDurationSeconds(
    parsed.minSessionDurationSeconds,
    warnings,
  )

  return {
    config: {
      server,
      topic,
      ...(accessToken ? { accessToken } : {}),
      events,
      minSessionDurationSeconds,
    },
    warnings,
  }
}
