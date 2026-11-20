import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";

const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const releaseWorkflow = yaml.load(workflow);
const windows = releaseWorkflow.jobs.windows;

test("formal Windows releases check the signing environment before building", () => {
  assert.equal(windows.env.HELSELF_REQUIRE_SIGNING, "1");
  assert.match(windows.env.HELSELF_SIGN_CERT_SHA1, /vars\.HELSELF_SIGN_CERT_SHA1/);
  const preflight = windows.steps.findIndex((step) => step.run?.includes("Cert:\\CurrentUser\\My"));
  const build = windows.steps.findIndex((step) => step.run === "npm run desktop:dist");
  assert.ok(preflight >= 0 && build > preflight);
  assert.notEqual(windows.steps[preflight]["continue-on-error"], true);
});

test("artifact verification is a blocking step before publication", () => {
  const verificationStep = windows.steps.findIndex((step) =>
    step.run?.includes("verify-windows-release-signatures.ps1"),
  );
  const publishStep = windows.steps.findIndex((step) => step.run?.includes("gh release create"));
  assert.ok(verificationStep >= 0 && publishStep > verificationStep);
  assert.equal(windows.steps[verificationStep]["continue-on-error"], undefined);
  assert.equal(windows.steps[verificationStep].if, undefined);
  assert.equal(windows.steps[publishStep].if, undefined);
});
