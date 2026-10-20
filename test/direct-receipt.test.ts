import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
vi.mock("../src/docker-verification.js", () => ({executeDockerVerification:vi.fn(),authenticateVerificationSource:vi.fn()}));
import { executeDockerVerification, type DockerVerificationResult, type VerificationCaseResult } from "../src/docker-verification.js";
import { requireCoherentVerificationResult, runVerificationReceipt, validateVerificationReceipt, verificationRef, type VerificationBinding } from "../src/verification-receipt.js";

test("durable started or completed executions cannot be silently replayed or rebound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"mdlm-receipt-settlement-"));
  const git = (...args:string[])=>execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
  const binding:VerificationBinding = {operation:"same-operation",package:{reference:"fixture@1"},inputs:["TRY-exact-r00001"],repositoryPath:root,sourceCommit:"a".repeat(40),image:"pinned-image",command:["python3","verify.py"],scriptPath:"verify.py"};
  try {
    git("init","-q");
    const file = path.join(root,"receipt.json");
    const save = async(receipt:object) => {
      await writeFile(file,JSON.stringify(receipt));
      const oid = git("hash-object","-w",file); git("update-ref",`${verificationRef(binding)}/latest`,oid);return oid;
    };
    await save({binding,attempt:1,state:"started"});
    await expect(runVerificationReceipt(root,binding,false)).rejects.toThrow("must not be replayed automatically");
    expect(executeDockerVerification).not.toHaveBeenCalled();
    const result = {started:true,outcome:"fail",sourceTree:null,scriptSha256:null};
    const oid = await save({binding,attempt:1,state:"completed",result});
    expect((await runVerificationReceipt(root,binding,false)).oid).toBe(oid);
    expect((await runVerificationReceipt(root,binding,true)).oid).toBe(oid);
    await expect(runVerificationReceipt(root,{...binding,sourceCommit:"b".repeat(40)},false)).rejects.toThrow("do not match");
    await expect(validateVerificationReceipt({...binding,inputs:["TRY-other-r00001"]},await runVerificationReceipt(root,binding,false))).rejects.toThrow("exact execution");
    await expect(validateVerificationReceipt({...binding,formalFiles:["verify.py"]},await runVerificationReceipt(root,binding,false))).rejects.toThrow("exact execution");
    expect(executeDockerVerification).not.toHaveBeenCalled();
  } finally {await rm(root,{recursive:true,force:true});}
});

test("a fresh pass or fail receipt must agree with its own cases, report, start state and identities", async () => {
  const image = "sha256:" + "c".repeat(64), script = "d".repeat(64);
  const binding: VerificationBinding = {operation: "coherent", package: {reference: "fixture@1"}, inputs: [], repositoryPath: "/product", sourceCommit: "a".repeat(40), image,
    independentVerification: {activityRevision: "VFY-exact-r00001", repositoryPath: "/verifier", sourceCommit: "b".repeat(40), scriptPath: "verify.py", command: ["python3", "verify.py"], caseIds: ["observe"], resultsPath: "results.json"}};
  const row: VerificationCaseResult = {case_id: "observe", outcome: "pass", actual_results: ["exit 0"], evidence_refs: []};
  const report = (cases: object[]) => Buffer.from(JSON.stringify({contract: "mdlm-verification-results@1", cases})).toString("base64");
  const pass: DockerVerificationResult = {sourceCommit: "a".repeat(40), sourceTree: "e".repeat(40), scriptSha256: script, image, imageDigest: null, imageId: image, command: ["python3", "verify.py"], scriptPath: "verify.py",
    stdoutBase64: "", stderrBase64: "", exitCode: 0, outcome: "pass", started: true, phase: "execution", startedAt: "2026-10-20T00:00:00.000Z", finishedAt: "2026-10-20T00:00:01.000Z",
    independentVerification: {sourceCommit: "b".repeat(40), sourceTree: "f".repeat(40), scriptSha256: script, activityRevision: "VFY-exact-r00001"},
    caseResults: [row], artifacts: [], rawReportBase64: report([row])};
  const failed: VerificationCaseResult = {...row, outcome: "fail"};
  await expect(requireCoherentVerificationResult(binding, pass)).resolves.toBeUndefined();
  await expect(requireCoherentVerificationResult(binding, {...pass, outcome: "fail", exitCode: 1, caseResults: [failed], rawReportBase64: report([failed])})).resolves.toBeUndefined();
  await expect(requireCoherentVerificationResult(binding, {...pass, outcome: "error", started: false, caseResults: []})).resolves.toBeUndefined();
  for (const [field, altered] of [
    ["case results", {caseResults: []}],
    ["case results", {caseResults: [failed]}],
    ["report", {rawReportBase64: Buffer.from("not a report").toString("base64")}],
    ["start state", {started: false}],
    ["scriptSha256", {scriptSha256: "0".repeat(64)}],
    ["imageId", {imageId: "sha256:" + "0".repeat(64)}],
  ] as [string, Partial<DockerVerificationResult>][]) await expect(requireCoherentVerificationResult(binding, {...pass, ...altered}), field).rejects.toThrow(`Verification receipt ${field} contradicts its pass outcome`);
});

test("public execution export creates missing parents and preserves saved evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mdlm-execution-export-"));
  const repository = path.join(root, "lifecycle");
  const cli = (status: number, ...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "dist/mdlm.js"), ...args, "--json"], {
      cwd: args[0] === "init" ? root : repository, encoding: "utf8", timeout: 30_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(status);
    return JSON.parse(result.stdout);
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], {encoding: "utf8"}).trim();
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  try {
    cli(0, "init", repository, "--process", "iterative");
    const operation = "saved-export";
    const artifact = Buffer.from([0, 255, 13, 10]);
    const files = new Map([
      ["stdout", Buffer.from("captured output\n")],
      ["stderr", Buffer.from("captured warning\n")],
      ["report.json", Buffer.from('{"contract":"mdlm-verification-results@1","cases":[]}\n')],
      ["artifacts/screens/result.bin", artifact],
    ]);
    // Seed a completed receipt so this export regression never needs a Docker run.
    const receipt = JSON.stringify({
      binding: {operation, package: cli(0, "expectations").package, inputs: [], repositoryPath: path.join(root, "absent-product"),
        sourceCommit: "a".repeat(40), image: "unavailable-image", command: ["false"], scriptPath: "verify.sh"},
      attempt: 1, state: "completed",
      result: {started: true, outcome: "pass", sourceTree: null, scriptSha256: null,
        stdoutBase64: files.get("stdout")!.toString("base64"), stderrBase64: files.get("stderr")!.toString("base64"),
        rawReportBase64: files.get("report.json")!.toString("base64"),
        artifacts: [{path: "screens/result.bin", bytes: artifact.length, sha256: sha256(artifact), contentBase64: artifact.toString("base64")}]},
    });
    const receiptFile = path.join(root, "receipt.json");
    await writeFile(receiptFile, receipt);
    const oid = git("hash-object", "-w", receiptFile);
    git("update-ref", `refs/mdlm/execution/${operation}/attempt-1-receipt`, oid);
    git("update-ref", `refs/mdlm/execution/${operation}/latest`, oid);
    const before = [git("status", "--porcelain"), git("show-ref")];
    const settled = cli(0, "execution", "settlement", operation);
    const destination = path.join(root, "missing", "parents", "evidence");
    const exported = cli(0, "execution", "export", operation, destination);
    expect(exported).toMatchObject({ok: true, contract: "mdlm-execution-export@1", operation, path: destination});
    expect(exported.files).toEqual(expect.arrayContaining([...files].map(([file, bytes]) => ({path: file, bytes: bytes.length, sha256: sha256(bytes)}))));
    expect(exported.files).toHaveLength(files.size);
    const refused = cli(1, "execution", "export", operation, destination);
    expect(refused.diagnostics[0].message).toContain("EEXIST");
    for (const [file, bytes] of files) expect(await readFile(path.join(destination, file))).toEqual(bytes);
    expect(cli(0, "execution", "settlement", operation)).toEqual(settled);
    expect(git("cat-file", "blob", oid)).toBe(receipt);
    expect([git("status", "--porcelain"), git("show-ref")]).toEqual(before);
  } finally {await rm(root, {recursive: true, force: true});}
}, 30_000);
