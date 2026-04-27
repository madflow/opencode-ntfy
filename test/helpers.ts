import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function createProjectDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "opencode-ntfy-"))
}

export async function writeProjectConfig(directory: string, config: string): Promise<void> {
  await mkdir(join(directory, ".opencode"), { recursive: true })
  await writeFile(join(directory, ".opencode", "ntfy.json"), config)
}

export async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}
