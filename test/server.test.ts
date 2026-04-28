import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { server } from "../src/server.js"
import { createProjectDirectory, removeDirectory, writeProjectConfig } from "./helpers.js"

const directories: string[] = []
const DEFAULT_SESSION_TITLE = "Build release flow"

interface CreateClientOptions {
  sessionGet?: (sessionID: string) => Promise<unknown>
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => removeDirectory(directory)))
})

async function createDirectory(): Promise<string> {
  const directory = await createProjectDirectory()
  directories.push(directory)
  return directory
}

function createClient(options: CreateClientOptions = {}) {
  const logs: Array<Record<string, unknown>> = []

  return {
    logs,
    client: {
      app: {
        log: async ({ body }: { body: Record<string, unknown> }) => {
          logs.push(body)
        },
      },
      session: {
        get: ({ path }: { path: { id: string } }) =>
          options.sessionGet?.(path.id) ??
          Promise.resolve({
            data: {
              title: DEFAULT_SESSION_TITLE,
            },
          }),
      },
    } as unknown as Parameters<typeof server>[0]["client"],
  }
}

function asFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch
}

function createContext(
  directory: string,
  client: ReturnType<typeof createClient>["client"],
): Parameters<typeof server>[0] {
  return {
    client,
    directory,
    worktree: directory,
    project: {
      id: "demo-project",
      worktree: directory,
      time: {
        created: Date.now(),
      },
    },
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://opencode.test"),
    $: undefined as never,
  }
}

describe("server plugin", () => {
  let originalFetch: typeof fetch
  let originalDateNow: typeof Date.now

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalDateNow = Date.now
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    Date.now = originalDateNow
    mock.restore()
  })

  test("disables the plugin when config is missing", async () => {
    const directory = await createDirectory()
    const { client, logs } = createClient()

    const plugin = await server(createContext(directory, client))

    expect(plugin).toEqual({})
    expect(logs).toHaveLength(1)
    expect(logs[0]?.message).toBe("ntfy config not found; plugin disabled")
  })

  test("sends session.idle notifications when no minimum is configured", async () => {
    const directory = await createDirectory()
    const { client } = createClient()
    await writeProjectConfig(
      directory,
      JSON.stringify({ topic: "demo", minSessionDurationSeconds: 0 }),
    )

    let requestInit: RequestInit | undefined
    globalThis.fetch = asFetch(async (_, init) => {
      requestInit = init
      return new Response(null, { status: 200 })
    })

    const plugin = await server(createContext(directory, client))
    await plugin.event?.({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "abc123",
        },
      },
    } as never)

    const headers = new Headers(requestInit?.headers)
    expect(requestInit?.body).toBe(`Project: demo-project | Session: ${DEFAULT_SESSION_TITLE}`)
    expect(headers.get("Title")).toBe("opencode: task complete")
  })

  test("falls back to the session ID when the session title cannot be loaded", async () => {
    const directory = await createDirectory()
    const { client } = createClient({
      sessionGet: async () => {
        throw new Error("session lookup failed")
      },
    })
    await writeProjectConfig(
      directory,
      JSON.stringify({ topic: "demo", minSessionDurationSeconds: 0 }),
    )

    let requestInit: RequestInit | undefined
    globalThis.fetch = asFetch(async (_, init) => {
      requestInit = init
      return new Response(null, { status: 200 })
    })

    const plugin = await server(createContext(directory, client))
    await plugin.event?.({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "abc123",
        },
      },
    } as never)

    expect(requestInit?.body).toBe("Project: demo-project | Session: abc123")
  })

  test("sends session.error notifications without sessionID", async () => {
    const directory = await createDirectory()
    const { client } = createClient()
    await writeProjectConfig(directory, JSON.stringify({ topic: "demo" }))

    let requestInit: RequestInit | undefined
    globalThis.fetch = asFetch(async (_, init) => {
      requestInit = init
      return new Response(null, { status: 200 })
    })

    const plugin = await server(createContext(directory, client))
    await plugin.event?.({
      event: {
        type: "session.error",
        properties: {
          error: {
            name: "ProviderAuthError",
          },
        },
      },
    } as never)

    const headers = new Headers(requestInit?.headers)
    expect(requestInit?.body).toBe("Project: demo-project | Session: n/a | Error: ProviderAuthError")
    expect(headers.get("Title")).toBe("opencode: error")
  })

  test("forwards accessToken as bearer authorization", async () => {
    const directory = await createDirectory()
    const { client } = createClient()
    await writeProjectConfig(
      directory,
      JSON.stringify({
        topic: "demo",
        accessToken: "tk_example",
        minSessionDurationSeconds: 0,
      }),
    )

    let requestInit: RequestInit | undefined
    globalThis.fetch = asFetch(async (_, init) => {
      requestInit = init
      return new Response(null, { status: 200 })
    })

    const plugin = await server(createContext(directory, client))
    await plugin.event?.({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "abc123",
        },
      },
    } as never)

    const headers = new Headers(requestInit?.headers)
    expect(headers.get("Authorization")).toBe("Bearer tk_example")
  })

  test("logs notification failures without throwing", async () => {
    const directory = await createDirectory()
    const { client, logs } = createClient()
    await writeProjectConfig(directory, JSON.stringify({ topic: "demo" }))

    globalThis.fetch = asFetch(async () => new Response(null, { status: 503 }))

    const plugin = await server(createContext(directory, client))
    await plugin.event?.({
      event: {
        type: "session.error",
        properties: {
          error: {
            name: "APIError",
          },
        },
      },
    } as never)

    expect(logs.some((log) => log.message === "Failed to send ntfy notification")).toBe(true)
  })

  test("skips session.idle when the current run is shorter than minSessionDurationSeconds", async () => {
    const directory = await createDirectory()
    const { client } = createClient()
    await writeProjectConfig(
      directory,
      JSON.stringify({ topic: "demo", minSessionDurationSeconds: 30 }),
    )

    let fetchCalls = 0
    globalThis.fetch = asFetch(async () => {
      fetchCalls += 1
      return new Response(null, { status: 200 })
    })

    Date.now = () => 1_005

    const plugin = await server(createContext(directory, client))
    await plugin["chat.message"]?.(
      {
        sessionID: "abc123",
      },
      {
        message: {
          time: {
            created: 1_000,
          },
        },
        parts: [],
      } as never,
    )

    await plugin.event?.({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "abc123",
        },
      },
    } as never)

    expect(fetchCalls).toBe(0)
  })

  test("sends session.idle when the current run exceeds minSessionDurationSeconds", async () => {
    const directory = await createDirectory()
    const { client } = createClient()
    await writeProjectConfig(
      directory,
      JSON.stringify({ topic: "demo", minSessionDurationSeconds: 30 }),
    )

    let requestInit: RequestInit | undefined
    globalThis.fetch = asFetch(async (_, init) => {
      requestInit = init
      return new Response(null, { status: 200 })
    })

    Date.now = () => 31_500

    const plugin = await server(createContext(directory, client))
    await plugin["chat.message"]?.(
      {
        sessionID: "abc123",
      },
      {
        message: {
          time: {
            created: 1_000,
          },
        },
        parts: [],
      } as never,
    )

    await plugin.event?.({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "abc123",
        },
      },
    } as never)

    expect(requestInit?.body).toBe(`Project: demo-project | Session: ${DEFAULT_SESSION_TITLE}`)
  })

  test("does not send a delayed idle notification for the same handled run", async () => {
    const directory = await createDirectory()
    const { client } = createClient()
    await writeProjectConfig(
      directory,
      JSON.stringify({ topic: "demo", minSessionDurationSeconds: 30 }),
    )

    let fetchCalls = 0
    globalThis.fetch = asFetch(async () => {
      fetchCalls += 1
      return new Response(null, { status: 200 })
    })

    let now = 1_005
    Date.now = () => now

    const plugin = await server(createContext(directory, client))
    await plugin["chat.message"]?.(
      {
        sessionID: "abc123",
      },
      {
        message: {
          time: {
            created: 1_000,
          },
        },
        parts: [],
      } as never,
    )

    await plugin.event?.({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "abc123",
        },
      },
    } as never)

    now = 45_000

    await plugin.event?.({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "abc123",
        },
      },
    } as never)

    expect(fetchCalls).toBe(0)
  })

  test("uses session.status as a fallback run start when chat.message is not available", async () => {
    const directory = await createDirectory()
    const { client } = createClient()
    await writeProjectConfig(
      directory,
      JSON.stringify({ topic: "demo", minSessionDurationSeconds: 30 }),
    )

    let requestInit: RequestInit | undefined
    globalThis.fetch = asFetch(async (_, init) => {
      requestInit = init
      return new Response(null, { status: 200 })
    })

    let now = 1_000
    Date.now = () => now

    const plugin = await server(createContext(directory, client))
    await plugin.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "abc123",
          status: {
            type: "busy",
          },
        },
      },
    } as never)

    now = 31_500

    await plugin.event?.({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "abc123",
        },
      },
    } as never)

    expect(requestInit?.body).toBe(`Project: demo-project | Session: ${DEFAULT_SESSION_TITLE}`)
  })

  test("skips session-scoped notifications when no current run start is known", async () => {
    const directory = await createDirectory()
    const { client } = createClient()
    await writeProjectConfig(
      directory,
      JSON.stringify({ topic: "demo", minSessionDurationSeconds: 30 }),
    )

    let fetchCalls = 0
    globalThis.fetch = asFetch(async () => {
      fetchCalls += 1
      return new Response(null, { status: 200 })
    })

    const plugin = await server(createContext(directory, client))
    await plugin.event?.({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "abc123",
        },
      },
    } as never)

    expect(fetchCalls).toBe(0)
  })
})
