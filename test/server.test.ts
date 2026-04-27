import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { server } from "../src/server.js"
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

function createClient() {
  const logs: Array<Record<string, unknown>> = []

  return {
    logs,
    client: {
      app: {
        log: async ({ body }: { body: Record<string, unknown> }) => {
          logs.push(body)
        },
      },
    } as unknown as Parameters<typeof server>[0]["client"],
  }
}

function asFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch
}

function createContext(directory: string, client: ReturnType<typeof createClient>["client"]): Parameters<typeof server>[0] {
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

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("disables the plugin when config is missing", async () => {
    const directory = await createDirectory()
    const { client, logs } = createClient()

    const plugin = await server(createContext(directory, client))

    expect(plugin).toEqual({})
    expect(logs).toHaveLength(1)
    expect(logs[0]?.message).toBe("ntfy config not found; plugin disabled")
  })

  test("ignores unrelated events", async () => {
    const directory = await createDirectory()
    const { client } = createClient()
    await writeProjectConfig(directory, JSON.stringify({ topic: "demo" }))

    let fetchCalls = 0
    globalThis.fetch = asFetch(async () => {
      fetchCalls += 1
      return new Response(null, { status: 200 })
    })

    const plugin = await server(createContext(directory, client))
    await plugin.event?.({
      event: {
        type: "session.created",
        properties: {},
      },
    } as never)

    expect(fetchCalls).toBe(0)
  })

  test("sends session.idle notifications", async () => {
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
        type: "session.idle",
        properties: {
          sessionID: "abc123",
        },
      },
    } as never)

    const headers = new Headers(requestInit?.headers)
    expect(requestInit?.body).toBe("Project: demo-project | Session: abc123")
    expect(headers.get("Title")).toBe("opencode: task complete")
    expect(headers.get("Priority")).toBe("3")
    expect(headers.get("Tags")).toBe("white_check_mark")
  })

  test("sends session.error notifications", async () => {
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
          sessionID: "abc123",
          error: {
            name: "ProviderAuthError",
          },
        },
      },
    } as never)

    const headers = new Headers(requestInit?.headers)
    expect(requestInit?.body).toBe(
      "Project: demo-project | Session: abc123 | Error: ProviderAuthError",
    )
    expect(headers.get("Title")).toBe("opencode: error")
    expect(headers.get("Priority")).toBe("4")
    expect(headers.get("Tags")).toBe("x")
  })

  test("forwards accessToken as bearer authorization", async () => {
    const directory = await createDirectory()
    const { client } = createClient()
    await writeProjectConfig(
      directory,
      JSON.stringify({
        topic: "demo",
        accessToken: "tk_example",
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
})
