import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { DockerVerificationResult, VerificationCaseResult } from "../src/docker-verification.js";
import { requireCoherentDeployment, type DeploymentBinding, type DeploymentResult } from "../src/aws-cdk-deployment.js";
import { refuseSecretResult, refuseSecretValues, scanForSecrets, scanStoredValue, SECRET_PATTERNS } from "../src/secret-scan.js";

// Fixture secrets are assembled at runtime so no literal credential is committed.
const join = (...parts: string[]) => parts.join("");
const hits: Record<keyof typeof SECRET_PATTERNS, string> = {
  "aws-access-key-id": join("AKIA", "IOSFODNN7EXAMPLE"),
  "aws-secret-access-key": join("aws_secret_access_key = ", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
  "aws-session-token": join("aws_session_token = ", "IQoJb3JpZ2luX2VjEXAMPLETOKENVALUE"),
  "authorization-header": join("Authorization: Bearer ", "eyJhbGciOiJIUzI1NiJ9.e30.EXAMPLE"),
  "private-key-block": join("-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----"),
};

test("each secret pattern class is found at its byte offset without echoing the match", () => {
  for (const [pattern, secret] of Object.entries(hits)) {
    const prefix = "ünïcode prefix\n";
    expect(scanForSecrets("stdoutBase64", Buffer.from(prefix + secret)), pattern).toEqual([{pattern, field: "stdoutBase64", offset: Buffer.byteLength(prefix)}]);
  }
  expect(scanForSecrets("stdout", join("ASIA", "ABCDEFGHIJKLMNOP"))[0]?.pattern).toBe("aws-access-key-id");
  expect(scanForSecrets("stdout", join('{"SecretAccessKey": "', "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", '", "SessionToken": "', "FwoGZXIvYXdzEXAMPLE0123", '"}')).map(f => f.pattern)).toEqual(["aws-secret-access-key", "aws-session-token"]);
  expect(scanForSecrets("stdout", join("{'authorization': 'AWS4-HMAC-SHA256 ", "Credential=EXAMPLE/20261021'}"))[0]?.pattern).toBe("authorization-header");
  expect(scanForSecrets("stdout", join("-----BEGIN OPENSSH ", "PRIVATE KEY-----"))[0]?.pattern).toBe("private-key-block");
  // A short credential is still a credential: Basic YTpi encodes a:b.
  const short = refuseSecretResult({...representativeResult(), stdoutBase64: Buffer.from(join("Authorization: Basic ", "YTpi")).toString("base64")});
  expect(short).toMatchObject({outcome: "error", stdoutBase64: "", secretFindings: [{pattern: "authorization-header", field: "stdoutBase64", offset: 0}]});
});

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// Deterministic pseudo-random bytes stand in for binary artifacts and screenshots.
const bytes = (seed: string, size: number) => Buffer.concat(Array.from({length: Math.ceil(size / 32)}, (_, i) => createHash("sha256").update(`${seed}:${i}`).digest())).subarray(0, size);

function representativeResult(): DockerVerificationResult {
  const report = {contract: "mdlm-verification-results@1", cases: [{case_id: "observe", outcome: "pass", actual_results: ["'2\\n'", "exit 0", "Authorization: required for /admin", "session_token unset"], evidence_refs: ["observation.txt", "screen.png"]}]};
  const screen = bytes("screen", 1024 * 1024), observation = Buffer.from("2\n");
  const stdout = `PASS count ${sha256("a")}\ncommit ${"0123456789abcdef".repeat(2).slice(0, 40)}\n${bytes("noise", 4096).toString("base64")}\n`;
  return {sourceCommit: sha256("commit").slice(0, 40), sourceTree: sha256("tree").slice(0, 40), scriptSha256: sha256("script"), image: `python@sha256:${sha256("image")}`, imageDigest: `sha256:${sha256("image")}`, imageId: `sha256:${sha256("id")}`,
    command: ["python3", "verify.py"], scriptPath: "verify.py", stdoutBase64: Buffer.from(stdout).toString("base64"), stderrBase64: Buffer.from("WARNING: AWS_SECRET_ACCESS_KEY is not set\n").toString("base64"),
    exitCode: 0, outcome: "pass", started: true, phase: "execution", startedAt: "2026-10-21T00:00:00.000Z", finishedAt: "2026-10-21T00:00:01.000Z",
    independentVerification: {sourceCommit: sha256("verifier").slice(0, 40), sourceTree: sha256("verifier-tree").slice(0, 40), scriptSha256: sha256("script"), activityRevision: "VFY-0a1b2c3d4e5f-r00001"},
    caseResults: report.cases as VerificationCaseResult[],
    artifacts: [observation, screen].map((content, i) => ({path: ["observation.txt", "screen.png"][i]!, sha256: sha256(content), bytes: content.length, contentBase64: content.toString("base64")})),
    rawReportBase64: Buffer.from(JSON.stringify(report)).toString("base64")};
}

test("representative receipts with digests, base64 reports and binary artifacts are not refused", () => {
  const result = representativeResult();
  expect(scanStoredValue(result)).toEqual([]);
  expect(refuseSecretResult(result)).toBe(result);
});

test("a match refuses the result, names the class and field, and stores nothing from that field", () => {
  const result = representativeResult(), secret = hits["aws-access-key-id"];
  result.caseResults![0]!.actual_results.push(secret);
  result.rawReportBase64 = Buffer.from(JSON.stringify({cases: result.caseResults})).toString("base64");
  result.stderrBase64 = Buffer.from(`warn\n${hits["private-key-block"]}`).toString("base64");
  const refused = refuseSecretResult(result);
  expect(refused.outcome).toBe("error");
  expect(refused.secretFindings).toEqual([
    {pattern: "private-key-block", field: "stderrBase64", offset: 5},
    {pattern: "aws-access-key-id", field: "caseResults[0].actual_results[4]", offset: 0},
    {pattern: "aws-access-key-id", field: "rawReportBase64", offset: expect.any(Number)},
  ]);
  expect(refused.diagnostic).toContain("aws-access-key-id in caseResults[0].actual_results[4]");
  expect(refused).toMatchObject({stderrBase64: "", caseResults: [], stdoutBase64: result.stdoutBase64, artifacts: result.artifacts, sourceTree: result.sourceTree});
  expect(refused.rawReportBase64).toBe("");
  const stored = JSON.stringify(refused);
  for (const leaked of [secret, "PRIVATE KEY", Buffer.from(secret).toString("base64")]) expect(stored).not.toContain(leaked);
});

test("a leaked stack output is dropped with its endpoint copies, leaving a coherent error deployment", async () => {
  const commit = "a".repeat(40), stackId = "arn:aws:cloudformation:us-east-1:123456789012:stack/mdlm-demo-credit/fake";
  const binding = {sourceCommit: commit, stack: "mdlm-demo-credit", config: {region: "us-east-1", output_allowlist: ["ApiEndpoint", "Name"], endpoint_output: "ApiEndpoint"}} as unknown as DeploymentBinding;
  const deployment = (endpoint: string): DeploymentResult => ({outcome: "pass", phase: "probe", deployAttempted: true, startedAt: "2026-10-21T00:00:00.000Z", finishedAt: "2026-10-21T00:00:01.000Z",
    access: {apmProject: "mdlm-demo", callerArn: "arn:aws:sts::123456789012:assumed-role/apm-mdlm-demo/session", account: "123456789012"},
    deploy: {exitCode: 0, stdoutBase64: Buffer.from(`deployed ${sha256("x")}\n`).toString("base64"), stderrBase64: ""},
    stack: {account: "123456789012", region: "us-east-1", name: "mdlm-demo-credit", id: stackId, status: "CREATE_COMPLETE", lastUpdatedTime: "2026-10-21T00:00:00Z"},
    outputs: {ApiEndpoint: endpoint, Name: "demo"}, endpoint, deployedVersion: commit, expiresAt: "2026-10-21T02:00:00.000Z",
    probe: {url: `${endpoint}version`, status: 200, expectedVersion: commit, matched: true, bodyBase64: Buffer.from(commit).toString("base64")}});
  const clean = deployment("https://api.example/");
  expect(refuseSecretValues(clean, "the product or its CDK app")).toBe(clean);
  const result = deployment(`https://api.example/${hits["aws-access-key-id"]}/`);
  const refused = refuseSecretValues(result, "the product or its CDK app");
  expect(refused.secretFindings!.map(finding => finding.field)).toEqual(["outputs.ApiEndpoint", "endpoint", "probe.url"]);
  expect(refused).toMatchObject({outcome: "error", outputs: {Name: "demo"}, deploy: result.deploy, stack: result.stack, probe: {status: 200, bodyBase64: result.probe!.bodyBase64}});
  expect([refused.endpoint, refused.probe!.url, refused.outputs!.ApiEndpoint]).toEqual([undefined, undefined, undefined]);
  expect(JSON.stringify(refused)).not.toContain(hits["aws-access-key-id"]);
  await expect(requireCoherentDeployment(binding, refused)).resolves.toBeUndefined();
});

test("public execution refuses a receipt whose captured output contains an AWS key", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-secret-scan-"));
  const repository = path.join(root, "lifecycle"), product = path.join(root, "product"), verifier = path.join(root, "verifier");
  const executable = process.env.MDLM_DIRECT_EXECUTABLE ?? path.join(process.cwd(), "dist/mdlm.js");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"}).trim();
  const commit = (cwd: string) => { git(cwd, "add", "."); git(cwd, "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "Fixture"); return git(cwd, "rev-parse", "HEAD"); };
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [executable, ...args, "--json"], {cwd: args[0] === "init" ? root : repository, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024});
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const guidance = (action: string, subject?: string) => cli("expectations", "show", action, ...(subject ? [subject] : []));
  const submit = async (g: any, operation: string, candidates: any[]) => {
    const file = path.join(root, `${operation}.json`);
    await fs.writeFile(file, JSON.stringify({operation, action: g.action, package: g.package, snapshot: g.snapshot, ...(g.subject ? {subject: g.subject} : {}), inputs: g.inputs, candidates}));
    const result = cli("proposal", "submit", file); commit(repository); return result.revisions[0];
  };
  const secret = hits["aws-access-key-id"];
  try {
    cli("init", repository, "--process", "iterative");
    for (const cwd of [product, verifier]) { await fs.mkdir(cwd); git(cwd, "init", "-q"); git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid"); }
    const framing = guidance("frame-experiment"), exp = framing.candidates[0];
    exp.payload = {...exp.payload, title: "Readiness experiment", criterion: "Print ready and exit zero", question: "Can this CLI report readiness?", approach: "One public invocation", constraints: "No persistent state", allowance_minutes: 5, scope_cut: "No interactive mode"};
    const experiment = await submit(framing, "frame", [exp]);
    const context = cli("verification", "context", experiment);
    // The verifier passes but leaks a key on stdout, as a misconfigured product might.
    await fs.writeFile(path.join(verifier, "verify.py"), `import json,os
from pathlib import Path
print('debug key ' + 'AKIA' + '${secret.slice(4)}')
row={'case_id':'ready','outcome':'pass','actual_results':['ready'],'evidence_refs':[]}
Path(os.environ['MDLM_EVIDENCE_DIR']+'/results.json').write_text(json.dumps({'contract':'mdlm-verification-results@1','cases':[row]}))
`);
    const plan = guidance("plan-criterion-verification", experiment), vfy = plan.candidates[0];
    vfy.payload = {...vfy.payload, title: "Readiness check", method: "CLI test", objective: "Observe the readiness signal", authoring_subject: experiment, authoring_context: context.authoringContext, repository_path: verifier, source_commit: commit(verifier), verification_image: "python@sha256:7415fbc3c9e4979cc717d92377ab2bc7b2b4a2af1ac03cc52b5f3f88efedaf3a", verification_command: ["python3", "verify.py"], verification_script: "verify.py", results_path: "results.json", cases: [{id: "ready", targets: [experiment], preconditions: ["Fresh process"], actions: ["Invoke the CLI"], expected_results: ["ready"], coverage_rationale: "The bounded criterion"}], coverage: [{target: experiment, obligations: ["Readiness output"], case_ids: ["ready"], rationale: "One invocation"}]};
    vfy.links.push({type: "verifies", target: experiment});
    const activity = await submit(plan, "plan", [vfy]);
    await fs.writeFile(path.join(product, "app.py"), "print('ready')\n");
    const preparing = guidance("prepare-prototype", experiment), trial = preparing.candidates[0];
    trial.payload = {...trial.payload, title: "Readiness CLI", repository_path: product, source_commit: commit(product), command: ["python3", "app.py"]};
    trial.links.push({type: "verification", target: activity});
    const prototype = await submit(preparing, "prototype", [trial]);
    const execution = cli("execution", "run", prototype, "leak", "--activity", activity);
    const result = execution.value.receipt.result;
    expect(result.outcome).toBe("error");
    expect(result.secretFindings).toEqual([{pattern: "aws-access-key-id", field: "stdoutBase64", offset: "debug key ".length}]);
    expect(result.diagnostic).toContain("Receipt refused");
    expect(result.stdoutBase64).toBe("");
    // Neither the CLI output nor any stored copy of the receipt holds the key.
    const stored = [JSON.stringify(execution), git(repository, "cat-file", "blob", execution.value.oid), await fs.readFile(path.join(repository, ".lifecycle/work/execution/leak/1-receipt.json"), "utf8")];
    for (const copy of stored) for (const leaked of [secret, Buffer.from(`debug key ${secret}\n`).toString("base64")]) expect(copy).not.toContain(leaked);
    expect(cli("execution", "settlement", "leak").value.receipt).toEqual(execution.value.receipt);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
}, 120_000);
