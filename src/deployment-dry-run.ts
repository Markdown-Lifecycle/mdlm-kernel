import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { deploymentRunBinding, executeDeployment, type DeploymentBinding, type DeploymentResult } from "./aws-cdk-deployment.js";
import { directState } from "./direct-proposal.js";
import { refuseSecretValues } from "./secret-scan.js";

// ADR-0009 section 5. A dry-run deployment publishes no lifecycle data and registers no
// refs; its record lives beside the receipts and is never deployment evidence.
export const DEPLOYMENT_DRY_RUN_CONTRACT = "mdlm-deployment-dry-run@1";
const DRY_RUN_LIFETIME_MINUTES = 120;
const DRY_RUN_ID = /^dry-[0-9a-f-]{36}$/;

export interface DeploymentDryRunRecord {contract: typeof DEPLOYMENT_DRY_RUN_CONTRACT; credit: false; id: string; binding: DeploymentBinding; state: "started" | "completed"; result?: DeploymentResult}
const recordFile = (root: string, id: string) => path.join(root, ".lifecycle/work/deployments", `${id}.json`);

/** Deploy one exact product commit to a dry-run slot. Each call is a new deployment with a fresh ID. */
export async function runDeploymentDryRun(root: string, subject: string, options: {stack: string; awsProfile: string; source?: string | undefined}, execute = executeDeployment) {
  if (options.source !== undefined && !/^[a-f0-9]{40}$/.test(options.source)) throw new Error("--source must name an exact 40-character product commit");
  const id = `dry-${randomUUID()}`;
  const credit = deploymentRunBinding(await directState(root), subject, id, options);
  const slots = credit.config.dry_run_slots ?? [];
  if (!slots.includes(options.stack)) throw new Error(`Stack '${options.stack}' is not one of the package's dry-run slots${slots.length ? `: ${slots.join(", ")}` : " (the package declares none)"}`);
  const binding: DeploymentBinding = {...credit, contract: DEPLOYMENT_DRY_RUN_CONTRACT, sourceCommit: options.source ?? credit.sourceCommit,
    config: {...credit.config, max_lifetime_minutes: Math.min(credit.config.max_lifetime_minutes, DRY_RUN_LIFETIME_MINUTES)}};
  const file = recordFile(root, id);
  await fs.mkdir(path.dirname(file), {recursive: true});
  // The started record is durable before anything runs, so an interrupted dry run still names its slot for teardown.
  await fs.writeFile(file, `${JSON.stringify({contract: DEPLOYMENT_DRY_RUN_CONTRACT, credit: false, id, binding, state: "started"} satisfies DeploymentDryRunRecord, null, 2)}\n`, {flag: "wx"});
  const record: DeploymentDryRunRecord = {contract: DEPLOYMENT_DRY_RUN_CONTRACT, credit: false, id, binding, state: "completed", result: refuseSecretValues(await execute(binding), "the product or its CDK app")};
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
  await fs.rename(temporary, file);
  return {ok: true, contract: DEPLOYMENT_DRY_RUN_CONTRACT, credit: false, id, record: file, value: record};
}

/** A completed, passing, unexpired dry-run deployment of this exact product repository and commit. */
export async function requireDeploymentDryRun(root: string, id: string, product: {repositoryPath: string; sourceCommit: string}) {
  if (!DRY_RUN_ID.test(id)) throw new Error(`'${id}' is not a dry-run deployment ID`);
  const record = await fs.readFile(recordFile(root, id), "utf8").then(source => JSON.parse(source) as DeploymentDryRunRecord, () => undefined);
  if (record?.contract !== DEPLOYMENT_DRY_RUN_CONTRACT || record.id !== id) throw new Error(`No dry-run deployment '${id}'`);
  const {binding, result} = record;
  if (record.state !== "completed" || result?.outcome !== "pass" || !result.assembly || !result.expiresAt) throw new Error(`Dry-run deployment '${id}' did not pass`);
  if (path.resolve(binding.repositoryPath) !== path.resolve(product.repositoryPath) || binding.sourceCommit !== product.sourceCommit) throw new Error(`Dry-run deployment '${id}' deployed ${binding.sourceCommit}, not product commit ${product.sourceCommit}`);
  if (Date.parse(result.expiresAt) <= Date.now()) throw new Error(`Dry-run deployment '${id}' expired at ${result.expiresAt}`);
  return {id, assembly: result.assembly};
}
