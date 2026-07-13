import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const PROJECT_ROOT = path.resolve(".");
const MANIFEST_PATH = path.join(PROJECT_ROOT, "scripts/runtime-manifest.env");
const POSIX_BOOTSTRAP_PATH = path.join(PROJECT_ROOT, "bootstrap.sh");
const WINDOWS_BOOTSTRAP_PATH = path.join(PROJECT_ROOT, "bootstrap.ps1");

function readManifest() {
  const values = {};
  for (const rawLine of readFileSync(MANIFEST_PATH, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    assert.notEqual(separator, -1, `Invalid runtime manifest line: ${line}`);
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

test("runtime manifest pins supported official Node archives and SHA-256 hashes", () => {
  assert.equal(existsSync(MANIFEST_PATH), true);
  const manifest = readManifest();
  assert.match(manifest.NODE_VERSION, /^24\.\d+\.\d+$/);
  assert.equal(manifest.NODE_BASE_URL, "https://nodejs.org/dist");

  for (const target of [
    "DARWIN_ARM64",
    "DARWIN_X64",
    "LINUX_ARM64",
    "LINUX_X64",
    "WIN_ARM64",
    "WIN_X64"
  ]) {
    const archive = manifest[`NODE_${target}_ARCHIVE`];
    const sha256 = manifest[`NODE_${target}_SHA256`];
    assert.match(archive, new RegExp(`^node-v${manifest.NODE_VERSION.replaceAll(".", "\\.")}-`));
    assert.match(sha256, /^[a-f0-9]{64}$/);
  }
});

test("POSIX bootstrap supports checked local runtime installation without package managers", () => {
  assert.equal(existsSync(POSIX_BOOTSTRAP_PATH), true);
  const source = readFileSync(POSIX_BOOTSTRAP_PATH, "utf8");

  assert.match(source, /runtime-manifest\.env/);
  assert.match(source, /nodejs\.org/);
  assert.match(source, /sha256sum|shasum/);
  assert.match(source, /\.cache\/whoami_\/runtime/);
  assert.match(source, /scripts\/launch-editor\.mjs/);
  assert.doesNotMatch(source, /brew install|apt(?:-get)? install|dnf install|yum install/);
  if (process.platform !== "win32") {
    assert.notEqual(statSync(POSIX_BOOTSTRAP_PATH).mode & 0o111, 0);
    const result = spawnSync("/bin/sh", [POSIX_BOOTSTRAP_PATH, "--check"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Bootstrap check passed/);
  }
});

test("Windows bootstrap uses a per-user runtime and verifies downloads", () => {
  assert.equal(existsSync(WINDOWS_BOOTSTRAP_PATH), true);
  const source = readFileSync(WINDOWS_BOOTSTRAP_PATH, "utf8");

  assert.match(source, /runtime-manifest\.env/);
  assert.match(source, /nodejs\.org/);
  assert.match(source, /Get-FileHash/);
  assert.match(source, /LOCALAPPDATA/);
  assert.match(source, /whoami_/);
  assert.match(source, /scripts[\\/]launch-editor\.mjs/);
  assert.match(source, /\[switch\]\$Check/);
  assert.doesNotMatch(source, /^'@\s+\S/m);
  assert.doesNotMatch(source, /winget install|choco install|scoop install/);

  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      WINDOWS_BOOTSTRAP_PATH,
      "-Check"
    ], {
      cwd: PROJECT_ROOT,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Bootstrap check passed/);
  }
});
