import type { Plugin } from "@opencode-ai/plugin"
import {
  loadConfig,
  type ConfigWarning,
  type NtfyConfig,
  type SupportedEvent,
} from "./config.js"
import { sendNotification } from "./notify.js"

const SERVICE_NAME = "opencode-ntfy"

type PluginContext = Parameters<Plugin>[0]

type LogExtra = Record<string, unknown>

interface Logger {
  warn(message: string, extra?: LogExtra): Promise<void>
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

function createLogger(client: PluginContext["client"]): Logger {
  return {
    async warn(message, extra) {
      try {
        const body = extra
          ? {
              service: SERVICE_NAME,
              level: "warn" as const,
              message,
              extra,
            }
          : {
              service: SERVICE_NAME,
              level: "warn" as const,
              message,
            }

        await client.app.log({ body })
      } catch {
        if (extra) {
          console.warn(`[${SERVICE_NAME}] ${message}`, extra)
          return
        }

        console.warn(`[${SERVICE_NAME}] ${message}`)
      }
    },
  }
}

async function logWarnings(logger: Logger, warnings: ConfigWarning[]): Promise<void> {
  for (const warning of warnings) {
    await logger.warn(warning.message, warning.extra)
  }
}

function isConfiguredEvent(config: NtfyConfig, eventType: string): eventType is SupportedEvent {
  return config.events.includes(eventType as SupportedEvent)
}

function getErrorName(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    error.name.trim()
  ) {
    return error.name
  }

  return "UnknownError"
}

function buildIdleMessage(projectID: string, sessionID: string): string {
  return `Project: ${projectID} | Session: ${sessionID}`
}

function buildErrorMessage(
  projectID: string,
  sessionID: string | undefined,
  errorName: string,
): string {
  return `Project: ${projectID} | Session: ${sessionID ?? "n/a"} | Error: ${errorName}`
}

function buildNotificationAuth(config: NtfyConfig): Pick<NtfyConfig, "accessToken"> | {} {
  return config.accessToken ? { accessToken: config.accessToken } : {}
}

async function logNotificationFailure(
  logger: Logger,
  eventType: SupportedEvent,
  result: Awaited<ReturnType<typeof sendNotification>>,
): Promise<void> {
  if (result.ok) {
    return
  }

  await logger.warn("Failed to send ntfy notification", {
    eventType,
    reason: result.message,
    status: result.status,
    error: result.error,
  })
}

function startSessionRun(
  sessionStartTimes: Map<string, number>,
  handledSessions: Set<string>,
  sessionID: string,
  startedAt: number,
): void {
  handledSessions.delete(sessionID)

  sessionStartTimes.set(sessionID, startedAt)
}

function ensureSessionRun(
  sessionStartTimes: Map<string, number>,
  handledSessions: Set<string>,
  sessionID: string,
  startedAt: number,
): void {
  handledSessions.delete(sessionID)

  if (!sessionStartTimes.has(sessionID)) {
    sessionStartTimes.set(sessionID, startedAt)
  }
}

function takeSessionStartTime(
  sessionStartTimes: Map<string, number>,
  handledSessions: Set<string>,
  sessionID: string | undefined,
): number | null | undefined {
  if (!sessionID) {
    return undefined
  }

  if (handledSessions.has(sessionID)) {
    return null
  }

  handledSessions.add(sessionID)

  const startedAt = sessionStartTimes.get(sessionID)
  sessionStartTimes.delete(sessionID)
  return startedAt
}

function shouldSendNotification(
  config: NtfyConfig,
  sessionID: string | undefined,
  sessionStartTime: number | undefined,
): boolean {
  if (config.minSessionDurationSeconds <= 0 || sessionID === undefined) {
    return true
  }

  if (sessionStartTime === undefined) {
    return false
  }

  return Date.now() - sessionStartTime >= config.minSessionDurationSeconds * 1000
}

export const server: Plugin = async ({ client, project, directory }) => {
  const logger = createLogger(client)
  const { config, warnings } = await loadConfig(directory)

  await logWarnings(logger, warnings)

  if (!config) {
    return {}
  }

  const sessionStartTimes = new Map<string, number>()
  const handledSessions = new Set<string>()

  return {
    "chat.message": async ({ sessionID }, output) => {
      const created = output.message.time?.created
      startSessionRun(
        sessionStartTimes,
        handledSessions,
        sessionID,
        typeof created === "number" ? created : Date.now(),
      )
    },
    event: async ({ event }) => {
      try {
        if (event.type === "session.status") {
          if (event.properties.status.type !== "idle") {
            ensureSessionRun(
              sessionStartTimes,
              handledSessions,
              event.properties.sessionID,
              Date.now(),
            )
          }
          return
        }

        if (event.type === "session.deleted") {
          const id = event.properties?.info?.id
          if (typeof id === "string") {
            sessionStartTimes.delete(id)
            handledSessions.delete(id)
          }
          return
        }

        if (!isConfiguredEvent(config, event.type)) {
          return
        }

        if (event.type === "session.idle") {
          const sessionID = event.properties.sessionID
          const sessionStartTime = takeSessionStartTime(
            sessionStartTimes,
            handledSessions,
            sessionID,
          )

          if (
            sessionStartTime === null ||
            !shouldSendNotification(config, sessionID, sessionStartTime)
          ) {
            return
          }

          const result = await sendNotification({
            server: config.server,
            topic: config.topic,
            ...buildNotificationAuth(config),
            title: "opencode: task complete",
            message: buildIdleMessage(project.id, sessionID),
            priority: 3,
            tags: ["white_check_mark"],
          })

          await logNotificationFailure(logger, event.type, result)
          return
        }

        if (event.type === "session.error") {
          const sessionID = event.properties.sessionID
          const sessionStartTime = takeSessionStartTime(
            sessionStartTimes,
            handledSessions,
            sessionID,
          )

          if (
            sessionStartTime === null ||
            !shouldSendNotification(config, sessionID, sessionStartTime)
          ) {
            return
          }

          const result = await sendNotification({
            server: config.server,
            topic: config.topic,
            ...buildNotificationAuth(config),
            title: "opencode: error",
            message: buildErrorMessage(
              project.id,
              sessionID,
              getErrorName(event.properties.error),
            ),
            priority: 4,
            tags: ["x"],
          })

          await logNotificationFailure(logger, event.type, result)
        }
      } catch (error) {
        await logger.warn("Unexpected ntfy plugin failure", {
          eventType: event.type,
          error: formatError(error),
        })
      }
    },
  }
}

const plugin = {
  id: "@madflow/opencode-ntfy",
  server,
}

export default plugin
