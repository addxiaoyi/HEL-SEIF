import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";

const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const releaseWorkflow = yaml.load(workflow);
const windows = releaseWorkflow.jobs.windows;

test("formal Windows releases default to a signed build and allow explicit unsigned mode", () => {
  assert.equal(releaseWorkflow.on.push, undefined);
  assert.equal(releaseWorkflow.on.workflow_dispatch.inputs.signing_mode.default, "signed");
  assert.deepEqual(releaseWorkflow.on.workflow_dispatch.inputs.signing_mode.options, ["signed", "unsigned"]);
  assert.match(windows.env.HELSELF_SIGNING_MODE, /inputs\.signing_mode/);
  assert.match(windows.env.HELSELF_REQUIRE_SIGNING, /inputs\.signing_mode/);
  assert.match(windows.env.HELSELF_SIGN_CERT_SHA1, /vars\.HELSELF_SIGN_CERT_SHA1/);
  const preflight = windows.steps.findIndex((step) => step.run?.includes("Cert:\\CurrentUser\\My"));
  const build = windows.steps.findIndex((step) => step.run === "npm run desktop:dist");
  assert.ok(preflight >= 0 && build > preflight);
  assert.equal(windows.steps[preflight].if, "env.HELSELF_SIGNING_MODE == 'signed'");
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

test("unsigned mode calls the verifier's explicit unsigned path", () => {
  const verificationStep = windows.steps.find((step) => step.run?.includes("verify-windows-release-signatures.ps1"));
  assert.match(verificationStep.run, /HELSELF_SIGNING_MODE -eq 'unsigned'/);
  assert.match(verificationStep.run, /-AllowUnsigned/);
});
