export const DEFAULT_TIMEOUT_MS = 5000

export interface SendNotificationOptions {
  server: string
  topic: string
  accessToken?: string
  title: string
  message: string
  priority?: number
  tags?: string[]
  timeoutMs?: number
  fetchImplementation?: FetchImplementation
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type SendNotificationResult =
  | { ok: true }
  | {
      ok: false
      message: string
      status?: number
      error?: string
    }

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

function buildTopicUrl(server: string, topic: string): string {
  const url = new URL(server)
  url.search = ""
  url.hash = ""

  const basePath = url.pathname.replace(/\/+$/, "")
  url.pathname = `${basePath}/${encodeURIComponent(topic)}`

  return url.toString()
}

export async function sendNotification(
  options: SendNotificationOptions,
): Promise<SendNotificationResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    Title: options.title,
    Priority: String(options.priority ?? 3),
  })

  if (options.accessToken) {
    headers.set("Authorization", `Bearer ${options.accessToken}`)
  }

  if (options.tags && options.tags.length > 0) {
    headers.set("Tags", options.tags.join(","))
  }

  try {
    const response = await (options.fetchImplementation ?? fetch)(buildTopicUrl(options.server, options.topic), {
      method: "POST",
      body: options.message,
      headers,
      signal: controller.signal,
    })

    if (!response.ok) {
      return {
        ok: false,
        message: `ntfy responded with status ${response.status}`,
        status: response.status,
      }
    }

    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: controller.signal.aborted
        ? "ntfy request timed out"
        : "Failed to send ntfy notification",
      error: formatError(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}
