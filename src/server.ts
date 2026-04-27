import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig, type ConfigWarning, type NtfyConfig, type SupportedEvent } from "./config.js"
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

function buildErrorMessage(projectID: string, sessionID: string | undefined, errorName: string): string {
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

export const server: Plugin = async ({ client, project, directory }) => {
  const logger = createLogger(client)
  const { config, warnings } = await loadConfig(directory)

  await logWarnings(logger, warnings)

  if (!config) {
    return {}
  }

  return {
    event: async ({ event }) => {
      try {
        if (!isConfiguredEvent(config, event.type)) {
          return
        }

        if (event.type === "session.idle") {
          const result = await sendNotification({
            server: config.server,
            topic: config.topic,
            ...buildNotificationAuth(config),
            title: "opencode: task complete",
            message: buildIdleMessage(project.id, event.properties.sessionID),
            priority: 3,
            tags: ["white_check_mark"],
          })

          await logNotificationFailure(logger, event.type, result)
          return
        }

        if (event.type === "session.error") {
          const result = await sendNotification({
            server: config.server,
            topic: config.topic,
            ...buildNotificationAuth(config),
            title: "opencode: error",
            message: buildErrorMessage(
              project.id,
              event.properties.sessionID,
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
