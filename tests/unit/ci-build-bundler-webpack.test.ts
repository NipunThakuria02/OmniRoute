/**
 * Which bundler CI uses when it compiles the app (16/10/2026).
 *
 * A Turbopack production build of this tree needs ~36-49 GB (measured 2026-10-16 on the
 * 32-vCPU .113 with a cgroup cap and swap off: Next 16.3.5/16.3.6/16.3.8 peak at 33-37 GB
 * under the cap, 49 GB uncapped, and finish in 23-25 min; 16.4.2 needs more than 36 GB in
 * the compile phase alone and is OOM-killed). The .113 was raised from 48 to 64 GB on
 * 2026-10-16 and the build passed there with three lint jobs alongside; the 16 GB hosted
 * runners cannot hold it. The backend-only nightlies share the .113 with the light runners,
 * so they stay on webpack (14 GB) - with Turbopack they had not been green since 10-13.
 *
 * Policy: the ci.yml Build uses Turbopack only when it lands on the opt-in self-hosted slot
 * (USE_VPS_RUNNER and USE_VPS_BUILD_RUNNER both 'true') and webpack everywhere else; the
 * nightly build:cli steps always use webpack. Flip a step only with a measurement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDir = path.join(repoRoot, ".github/workflows");

type Step = { name?: string; run?: string; env?: Record<string, unknown> };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function readWorkflow(name: string): Workflow {
  return load(fs.readFileSync(path.join(workflowDir, name), "utf8")) as Workflow;
}

/** Every step of `name` whose `run` matches `pattern`, tagged "file:job:step". */
function buildSteps(name: string, pattern: RegExp): Array<{ id: string; step: Step }> {
  const out: Array<{ id: string; step: Step }> = [];
  for (const [job, def] of Object.entries(readWorkflow(name).jobs ?? {})) {
    (def.steps ?? []).forEach((step, i) => {
      if (typeof step.run === "string" && pattern.test(step.run)) {
        out.push({ id: `${name}:${job}:${step.name ?? `#${i + 1}`}`, step });
      }
    });
  }
  return out;
}

const NIGHTLIES = [
  "nightly-llm-security.yml",
  "nightly-resilience.yml",
  "nightly-schemathesis.yml",
];

test("the nightly backend-only builds compile with webpack", () => {
  const steps = NIGHTLIES.flatMap((wf) => buildSteps(wf, /npm run build:cli/));
  assert.equal(steps.length, 4, "promptfoo-guard, garak, k6-soak and schemathesis each build once");
  const onTurbopack = steps
    .filter(({ step }) => String(step.env?.OMNIROUTE_USE_TURBOPACK) !== "0")
    .map(({ id }) => id);
  assert.deepEqual(onTurbopack, [], "these steps would run the Turbopack build that OOMs the .113");
});

test("the ci.yml Build job uses Turbopack only on the self-hosted build slot", () => {
  const [build] = buildSteps("ci.yml", /^npm run build$/m);
  assert.ok(build, "ci.yml build job runs `npm run build`");
  const sw = String(build.step.env?.OMNIROUTE_USE_TURBOPACK);
  assert.match(sw, /vars\.USE_VPS_BUILD_RUNNER == 'true'/, "Turbopack is tied to the opt-in slot");
  assert.match(sw, /&& '1' \|\| '0' \}\}$/, "hosted runners (16 GB) fall back to webpack");
});
