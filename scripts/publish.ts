#!/usr/bin/env bun
/**
 * Release script: bump version, build, test, commit, tag, and publish to npm.
 *
 * Usage:
 *   bun run scripts/publish.ts <patch|minor|major> [--dry-run]
 *   bun run release patch        # if "release" script is configured in package.json
 */

import { readFileSync, writeFileSync } from "fs";
import { file } from "bun";

const VALID_BUMPS = ["patch", "minor", "major"] as const;
type Bump = (typeof VALID_BUMPS)[number];

/* ------------------------------------------------------------------ */
// Helpers
/* ------------------------------------------------------------------ */

function die(msg: string): never {
  console.error(`❌  ${msg}`);
  process.exit(1);
}

function log(msg: string) {
  console.log(`🔹  ${msg}`);
}

function ok(msg: string) {
  console.log(`✅  ${msg}`);
}

async function run(cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<string> {
  const proc = Bun.spawn({
    cmd,
    cwd: opts?.cwd ?? process.cwd(),
    env: { ...process.env, ...opts?.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(stderr || stdout);
    die(`Command failed: ${cmd.join(" ")}`);
  }
  return stdout.trim();
}

function bumpVersion(current: string, bump: Bump): string {
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    die(`Invalid current version: ${current}`);
  }
  const [major, minor, patch] = parts;

  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`🤔  ${question} (y/N) `);
    process.stdin.once("data", (data) => {
      const answer = data.toString().trim().toLowerCase();
      resolve(answer === "y" || answer === "yes");
    });
  });
}

/* ------------------------------------------------------------------ */
// Main
/* ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes("--dry-run");
  const bumpArg = args.find((a) => VALID_BUMPS.includes(a as Bump)) as Bump | undefined;

  if (!bumpArg) {
    die(`Usage: bun run scripts/publish.ts <${VALID_BUMPS.join("|")}> [--dry-run]`);
  }

  if (DRY_RUN) {
    console.log("\n🧪  DRY RUN — no changes will be made\n");
  }

  // 1. Validate branch (must be main or master)
  const branch = await run(["git", "branch", "--show-current"]);
  if (branch !== "main" && branch !== "master") {
    die(`Must be on 'main' or 'master' branch. Current: ${branch}`);
  }
  ok(`On ${branch} branch`);

  // 2. Validate working tree is clean
  const status = await run(["git", "status", "--porcelain"]);
  if (status.length > 0 && !DRY_RUN) {
    die("Working tree is not clean. Commit or stash changes first.\n" + status);
  }
  if (status.length > 0 && DRY_RUN) {
    console.log(`⚠️   Working tree is not clean (ignored in dry-run):\n${status}`);
  } else {
    ok("Working tree is clean");
  }

  // 3. Read current version
  const pkgPath = "./package.json";
  const pkgRaw = await file(pkgPath).text();
  const pkg = JSON.parse(pkgRaw);
  const currentVersion = pkg.version;
  const newVersion = bumpVersion(currentVersion, bumpArg);

  log(`Bumping version: ${currentVersion} → ${newVersion}`);

  if (DRY_RUN) {
    console.log(`   (dry run) Would you like to publish v${newVersion} (${bumpArg})? → Auto-confirmed`);
  } else if (!(await confirm(`Publish v${newVersion} (${bumpArg})?`))) {
    die("Aborted.");
  }

  // 4. Run tests & build
  log("Running tests...");
  if (DRY_RUN) {
    console.log(`   (dry run) Would run: bun test`);
  } else {
    await run(["bun", "test"]);
    ok("Tests passed");
  }

  log("Running typecheck...");
  if (DRY_RUN) {
    console.log(`   (dry run) Would run: bun run typecheck`);
  } else {
    await run(["bun", "run", "typecheck"]);
    ok("Typecheck passed");
  }

  log("Running build...");
  if (DRY_RUN) {
    console.log(`   (dry run) Would run: bun run build`);
  } else {
    await run(["bun", "run", "build"]);
    ok("Build succeeded");
  }

  // 5. Bump version in package.json
  log(`Updating ${pkgPath}...`);
  if (DRY_RUN) {
    console.log(`   (dry run) Would update version to ${newVersion}`);
  } else {
    pkg.version = newVersion;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    ok(`Updated ${pkgPath}`);
  }

  // 6. Sync bun.lock
  log("Syncing bun.lock...");
  if (DRY_RUN) {
    console.log(`   (dry run) Would run: bun install`);
  } else {
    await run(["bun", "install"]);
    ok("bun.lock synced");
  }

  // 7. Commit version bump
  log("Committing changes...");
  if (DRY_RUN) {
    console.log(`   (dry run) Would run: git add package.json bun.lock`);
    console.log(`   (dry run) Would run: git commit -m "chore: release v${newVersion}"`);
  } else {
    await run(["git", "add", "package.json", "bun.lock"]);
    await run(["git", "commit", "-m", `chore: release v${newVersion}`]);
    ok(`Committed release v${newVersion}`);
  }

  // 8. Create & push tag
  log("Tagging release...");
  if (DRY_RUN) {
    console.log(`   (dry run) Would run: git tag -a v${newVersion} -m "Release v${newVersion}"`);
    console.log(`   (dry run) Would run: git push origin ${branch}`);
    console.log(`   (dry run) Would run: git push origin v${newVersion}`);
  } else {
    await run(["git", "tag", `-a`, `v${newVersion}`, "-m", `Release v${newVersion}`]);
    await run(["git", "push", "origin", branch]);
    await run(["git", "push", "origin", `v${newVersion}`]);
    ok(`Pushed tag v${newVersion}`);
  }

  // 9. Publish
  log("Publishing to npm...");
  if (DRY_RUN) {
    console.log(`   (dry run) Would run: bun publish`);
    console.log(`\n🏁  v${newVersion} would be live! This was a dry run.\n`);
  } else {
    await run(["bun", "publish"]);
    ok(`Published v${newVersion}`);
    console.log(`\n🎉  @${pkg.name}@${newVersion} is live!`);
  }
}

main().catch((err) => die(err.message || String(err)));
