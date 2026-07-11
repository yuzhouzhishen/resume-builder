import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import yaml from "js-yaml";

function loadWorkflow() {
  const source = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8"
  );
  return yaml.load(source);
}

test("CI runs the complete local gate with least privilege", () => {
  const workflow = loadWorkflow();
  const job = workflow.jobs["test-and-privacy"];

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(Object.hasOwn(workflow.on, "push"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 20);

  const checkout = job.steps.find(({ uses }) => uses === "actions/checkout@v4");
  const setupNode = job.steps.find(({ uses }) => uses === "actions/setup-node@v4");
  const commands = job.steps.map(({ run = "" }) => run).join("\n");

  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(setupNode.with["node-version"], 22);
  assert.equal(setupNode.with.cache, "npm");
  assert.match(commands, /npm ci/);
  assert.match(commands, /fonts-noto-cjk/);
  assert.match(commands, /npx playwright install --with-deps chromium/);
  assert.match(commands, /npm run ci/);
});
