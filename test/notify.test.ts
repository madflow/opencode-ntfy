import { describe, expect, test } from "bun:test"
import { sendNotification, type FetchImplementation } from "../src/notify.js"

function createFetchStub(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): FetchImplementation {
  return implementation
}

describe("sendNotification", () => {
  test("sends the expected ntfy request", async () => {
    let requestUrl = ""
    let requestInit: RequestInit | undefined

    const result = await sendNotification({
      server: "https://ntfy.sh",
      topic: "my topic",
      title: "opencode: task complete",
      message: "Project: test | Session: abc123",
      priority: 4,
      tags: ["x"],
      fetchImplementation: createFetchStub(async (url, init) => {
        requestUrl = String(url)
        requestInit = init
        return new Response(null, { status: 200 })
      }),
    })

    expect(result).toEqual({ ok: true })
    expect(requestUrl).toBe("https://ntfy.sh/my%20topic")
    expect(requestInit?.method).toBe("POST")
    expect(requestInit?.body).toBe("Project: test | Session: abc123")

    const headers = new Headers(requestInit?.headers)
    expect(headers.get("Content-Type")).toBe("text/plain; charset=utf-8")
    expect(headers.get("Title")).toBe("opencode: task complete")
    expect(headers.get("Priority")).toBe("4")
    expect(headers.get("Tags")).toBe("x")
  })

  test("preserves server subpaths when building the ntfy endpoint", async () => {
    let requestUrl = ""

    const result = await sendNotification({
      server: "https://example.com/ntfy",
      topic: "my topic",
      title: "title",
      message: "message",
      fetchImplementation: createFetchStub(async (url) => {
        requestUrl = String(url)
        return new Response(null, { status: 200 })
      }),
    })

    expect(result).toEqual({ ok: true })
    expect(requestUrl).toBe("https://example.com/ntfy/my%20topic")
  })

  test("adds bearer authorization when accessToken is configured", async () => {
    let requestInit: RequestInit | undefined

    const result = await sendNotification({
      server: "https://ntfy.sh",
      topic: "demo",
      accessToken: "tk_example",
      title: "title",
      message: "message",
      fetchImplementation: createFetchStub(async (_, init) => {
        requestInit = init
        return new Response(null, { status: 200 })
      }),
    })

    expect(result).toEqual({ ok: true })

    const headers = new Headers(requestInit?.headers)
    expect(headers.get("Authorization")).toBe("Bearer tk_example")
  })

  test("uses default priority and omits tags when none are provided", async () => {
    let requestInit: RequestInit | undefined

    const result = await sendNotification({
      server: "https://ntfy.sh",
      topic: "demo",
      title: "title",
      message: "message",
      fetchImplementation: createFetchStub(async (_, init) => {
        requestInit = init
        return new Response(null, { status: 200 })
      }),
    })

    expect(result).toEqual({ ok: true })

    const headers = new Headers(requestInit?.headers)
    expect(headers.get("Priority")).toBe("3")
    expect(headers.has("Tags")).toBe(false)
  })

  test("returns an error for non-2xx responses", async () => {
    const result = await sendNotification({
      server: "https://ntfy.sh",
      topic: "demo",
      title: "title",
      message: "message",
      fetchImplementation: createFetchStub(async () => new Response(null, { status: 500 })),
    })

    expect(result).toEqual({
      ok: false,
      message: "ntfy responded with status 500",
      status: 500,
    })
  })

  test("returns an error when fetch rejects", async () => {
    const result = await sendNotification({
      server: "https://ntfy.sh",
      topic: "demo",
      title: "title",
      message: "message",
      fetchImplementation: createFetchStub(async () => {
        throw new Error("network down")
      }),
    })

    expect(result).toEqual({
      ok: false,
      message: "Failed to send ntfy notification",
      error: "network down",
    })
  })

  test("aborts timed out requests", async () => {
    let wasAborted = false

    const result = await sendNotification({
      server: "https://ntfy.sh",
      topic: "demo",
      title: "title",
      message: "message",
      timeoutMs: 10,
      fetchImplementation: createFetchStub(async (_, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            wasAborted = true
            reject(new DOMException("Aborted", "AbortError"))
          })
        }),
      ),
    })

    expect(wasAborted).toBe(true)
    expect(result).toEqual({
      ok: false,
      message: "ntfy request timed out",
      error: "Aborted",
    })
  })
})
