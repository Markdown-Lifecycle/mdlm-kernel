---
status: proposed
---

# Deploy and verify against AWS environments

So far large MDLM runs have verified only local products. The native runtime
(`src/docker-verification.ts`, [contract](../contracts/direct-work.md#native-verification-runtime))
runs each activity in a disposable container with `--network none`, no host
environment, a 60-second wait and 16 MiB source archives. That is right for local
products and stays the default. A product that ships to AWS also needs evidence
that the deployed product works. This ADR adds deployment as a lifecycle
activity, a second, explicitly declared networked runtime mode, and the controls
that keep credentials, cost and leftover resources bounded. Under ADR-0002 the
lifecycle structure (types, actions, Expectations) stays in the Process Package.
The kernel adds only the capabilities: a deployment receipt, the networked
runtime, redaction, teardown and orphan detection.

This is a design. Nothing here has been run against AWS. Statements about
aws-permissions-manager (APM) and CDK behavior come from the `aws-access` skill
and CDK documentation and are marked as **unverified** where a candidate issue
has to confirm them first.

## 1. Deployment is an activity with a receipt

A package action of a new kernel action kind, `deployment`, deploys one exact
product commit. The package declares a deployment record type (`DPL`). It links
the DPL to the product revision it deploys (`deploys`) and declares the kernel
capability `aws-cdk-deployment@1`. `mdlm deployment run <DPL> <operation>` has
two steps:

1. **Synthesize in the sandbox.** The product's committed CDK app runs as
   `cdk synth` in a pinned synth image under today's runtime (with the 300-second wait), with
   `--network none` and no credentials, and writes the cloud assembly
   (`cdk.out`) to `/evidence`. All product code, including Lambda bundling with
   esbuild, runs here.
2. **Deploy from the host.** The kernel runs a pinned CDK CLI on the host as
   `cdk deploy --app <cdk.out>` with the operator's APM profile (section 3).
   Deploying a pre-synthesized assembly uploads its file assets and deploys its
   template without executing product code (**unverified** with
   `CliCredentialsStackSynthesizer` through APM; D1 checks it first).

The kernel then fills the DPL's kernel-managed fields from a **deployment receipt**,
just as it fills RES fields from an Execution Receipt today
(`src/direct-proposal.ts:260-280`).

The receipt is stored the same way: a started marker before anything runs, one
write-once attempt record, refs created only if absent
(`src/verification-receipt.ts:34-58`). An interrupted deployment is never
silently re-run. Its next step is a teardown or an orphan check, not a second
deploy. The receipt records:

- **Source:** product commit and tree, synth image digest, CDK app path, and
  the host CDK CLI version.
- **What was deployed:** SHA-256 of the synthesized CloudFormation template and
  of each asset in `cdk.out/manifest.json`. These come from the commit, not from
  AWS, so the same commit and image should yield the same digests (**unverified**
  for CDK bundling; the first kernel issue checks it).
- **Where:** AWS account ID, region, stack name, CloudFormation stack ID, and the
  stack's `LastUpdatedTime` after the deploy.
- **Outputs:** only the stack outputs the package allowlists, for example
  `ApiEndpoint`. The kernel never records `NoEcho` outputs or outputs that aren't
  allowlisted.
- **Endpoint and deployed version:** the endpoint URL from an allowlisted output,
  and the result of a version probe. The kernel sends `GET <endpoint><probe_path>`
  and requires the deployed product commit in the response body. The CDK app
  receives `MDLM_PRODUCT_COMMIT` and bakes it into the deployed code. A mismatch
  is a deployment `error`.
- **Access:** the APM project name and the caller identity ARN from
  `sts:GetCallerIdentity`. No key material (section 3).
- **Teardown deadline:** `expires_at`, from the package's maximum lifetime
  (section 4).

A matching **teardown** action (`mdlm deployment teardown <DPL> <operation>`)
deletes the stack. Its receipt records the final `DELETE_COMPLETE` stack status
and an empty tag query (section 4). The DPL stays immutable. Teardown is a
separate record that links to it, so history shows both events.

## 2. Verification against a deployed environment

An independent verification activity may link to one exact DPL
(`verified-against`). The kernel then runs it in a **networked** mode instead of
`--network none`. No other activity gets a network.

- **Network policy:** the verifier container joins a per-run Docker `--internal`
  network. Its only route out is a kernel-started egress proxy container attached
  to that network and the default bridge. The proxy accepts HTTPS `CONNECT` only
  to the host:port pairs in the DPL's allowlisted endpoint outputs, for example
  `abc123.execute-api.us-east-1.amazonaws.com:443`, and refuses everything else.
  The container gets `HTTPS_PROXY`. A verifier that ignores it has no route out.
  Every other runtime constraint is unchanged: read-only root, dropped
  capabilities, PID limit, pinned image, exact-commit archives.
- **No AWS credentials:** verifiers never receive AWS credentials. They test the
  product the way a user would, through its endpoint. An activity that needs to
  inspect AWS state directly is out of scope for V1.
- **Endpoint and version come from the kernel:** the kernel reads the endpoint
  from the DPL receipt and passes it as `MDLM_ENDPOINT`. The author does not
  supply it. Before and after the run, the kernel repeats the version probe and
  re-reads the stack's `LastUpdatedTime` from the host with the APM profile. The
  Execution Receipt gains the DPL revision, the endpoint, both probe results and
  the proxy's connection log (host, port, bytes and time, never request bodies).
  If a probe disagrees or the stack changed during the run, the outcome is
  `error` (environment), never `fail`. Q4 found that treating an incomplete
  observation as a product failure was a recurring verifier defect.
- **Reproducible in practice:** a networked run is not bit-for-bit reproducible.
  MDLM guarantees what can be re-checked. Each result names the exact verifier,
  image, product commit, template and asset digests, stack ID and probed version
  it ran against. Anyone can redeploy those digests to a fresh stack and re-run
  the activity. To keep runs on a shared environment independent, the kernel
  passes a unique `MDLM_RUN_ID` per execution. Package guidance requires
  verifiers to namespace any data they create with it and not to depend on data
  created by other activities.
- **Time limit:** networked runs get a fixed, longer wait of 300 seconds. That is
  today's internal maximum (`src/docker-verification.ts:196`). It is exposed for
  this mode only, still with no per-activity override.

## 3. Credentials

All AWS access goes through APM. The operator runs `get_aws_credentials` for the
package-named APM project, which sets up the profile `apm-<project>`, and passes
`--aws-profile apm-<project>` to `mdlm deployment run|teardown|orphans`. The kernel
never reads `~/.aws` keys, never uses another profile and never stores
credentials.

- **Scope:** APM grants are per project. The demo project's grants name its stacks
  and one region (APM refuses stack writes on every stack or on a wildcard
  region). They also name the services the template uses. APM never grants IAM
  writes or `sts:AssumeRole`, which has two consequences for CDK:
  - CDK's default synthesizer deploys by assuming bootstrap roles, so it can't
    run through APM. Products use `CliCredentialsStackSynthesizer`, which deploys
    with the caller's credentials (**unverified** against APM).
  - Stacks can't create IAM roles, and APM only lets a caller pass the project's
    own role. The Lambda functions therefore need a pre-existing execution role
    that APM allows the project to pass, with a Lambda trust policy and
    permissions scoped to the demo's tables and log groups. Whether APM can
    register such a runtime role, or the project's own role has to serve, is an
    open question for O1, and it **blocks D1**. The CDK app imports the role
    with `Role.fromRoleArn(..., { mutable: false })`.
- **Short-lived, and never copied:** credentials stay inside APM's profile
  mechanism. Only host-side kernel steps use the profile: the CDK CLI deploy and
  destroy, the stack and tag reads, and `sts:GetCallerIdentity`. The kernel runs
  them with `AWS_PROFILE=apm-<project>`, and the profile refreshes its own
  short-lived session. The kernel never exports, prints or copies credentials,
  and no container ever receives them. The synth container and verifiers run
  without credentials. The receipt records only the APM project and the caller
  identity ARN.
- **No secrets in records, evidence or review packets:** before a receipt is
  written, the kernel scans everything it would store: container stdout, stderr
  and artifacts, the host CDK CLI output, stack outputs and the proxy log. It
  looks for AWS key patterns (`AKIA`/`ASIA` + 16 characters),
  `aws_secret_access_key`, `aws_session_token`, `Authorization:` headers and PEM
  private-key blocks. A match **refuses** the receipt instead of rewriting it.
  The outcome is `error`, with the stream and byte offset of the match but not
  the match itself, and nothing from that stream is written. Because the kernel
  never holds credential values, a match means a secret leaked from somewhere
  else. The author fixes the leak; MDLM doesn't hide it.

  Review packets are built from receipts (`src/external-review.ts`), so they
  inherit this protection with no separate scrubbing. The scan applies to every
  receipt, including today's `--network none` runs, which currently store output
  verbatim.

## 4. Infrastructure, cost and teardown

- **CDK by default:** the product repository contains a CDK app (TypeScript) as
  ordinary product source. It is reviewed like code and pinned to the product
  commit. CDK and its dependencies exceed the 16 MiB source archive limit, so the
  pinned synth image carries `aws-cdk-lib`, the CDK CLI and esbuild. The product
  commit carries only the app. `aws-cdk-deployment@1` names the image digest and
  the host CDK CLI version. Other tools (Terraform, SAM) would need their own capability and are
  out of scope.
- **Fixed stack slots, not free names:** the package declares a small pool of
  stack names: one for-credit slot and two dry-run slots for the demo, for
  example `mdlm-demo-credit`, `mdlm-demo-dry-1` and `mdlm-demo-dry-2`. Each APM
  grant names exactly those stacks. The pool caps concurrency and spend and
  bounds where orphans can be. `deployment run` refuses a slot that already
  holds a stack.
- **Cost limits are enforced before deploying:** billing data lags by hours, so
  MDLM can't stop spend while a run is in progress. Instead,
  `aws-cdk-deployment@1` checks the synthesized template before calling AWS and
  refuses it unless:
  - every resource type is on the package allowlist (V1: Lambda, API Gateway v2
    HTTP API, DynamoDB on-demand, CloudWatch log groups);
  - the template has no custom resources (`Custom::*`,
    `AWS::CloudFormation::CustomResource`). CDK backs these with provider
    functions and IAM roles the stack can't create. This rules out S3
    `autoDeleteObjects`, so V1 keeps S3 buckets out of product stacks. CDK file
    assets go to the bootstrap bucket outside the stack, which has a 7-day
    expiry rule (O1);
  - every Lambda function sets reserved concurrency of 10 or less;
  - the HTTP API sets stage throttling;
  - every log group has 1-day retention;
  - every stateful resource uses `RemovalPolicy.DESTROY`;
  - every resource carries the required tags (below).

  Anything that bills while idle is off the allowlist: NAT gateways, EC2, RDS,
  provisioned concurrency, and CloudFront, which also takes too long to deploy
  and tear down. As a backstop, Taylor sets an AWS Budgets alert once per
  account (O1), because APM can't grant billing actions.
- **Teardown is mandatory:** the package adds an Expectation that every DPL has a
  successful teardown before the repository reaches any terminal state: accepted,
  or stopped with findings. A DPL whose `expires_at` has passed shows as a Loose
  End that blocks new deployments. Lambda's implicit log groups sit outside the
  stack, so the template policy requires explicit log groups that the stack owns.
- **Orphan detection:** every resource is tagged with `mdlm:repository`,
  `mdlm:deployment`, `mdlm:mode` (`dry-run` or `credit`) and `mdlm:expires-at`.
  `mdlm:deployment` holds the DPL ID for a for-credit deployment or the dry-run
  deployment ID (section 5). `mdlm deployment orphans --aws-profile …` lists
  every stack in the slot pool and every resource tagged `mdlm:repository` (via
  `tag:GetResources`) that is an orphan. A resource is an orphan when its
  `mdlm:deployment` names neither a DPL nor a dry-run deployment record in the
  repository, when that deployment already has a teardown, or when
  `mdlm:expires-at` has passed. It runs automatically before each deployment and
  as part of each teardown, and it only reports. Cleanup is explicit and run by
  the operator:
  - `mdlm deployment teardown --orphan-stack <slot>` deletes a stack in the
    slot pool.
  - Resources left without a stack (a `DELETE_FAILED` stack, or a resource that
    outlived its stack) are deleted one at a time with
    `mdlm deployment teardown --orphan-resource <arn>`. V1 deletes only the
    allowlisted resource types and asks for confirmation before each deletion.
    Any other resource type is reported for Taylor to remove by hand.
  - A teardown succeeds only when the stack is `DELETE_COMPLETE` and the tag
    query for its deployment ID comes back empty. Otherwise it fails and names
    the remaining ARNs.

## 5. Dry runs and for-credit runs

This follows the split in #1111 and package #46. Dry runs are non-credit and
re-run only what a change affects. For credit, one pass runs everything on a
single frozen version.

- **Dry run:** `mdlm deployment dry-run <commit> --slot <dry-n>` deploys any exact
  commit to a dry-run slot, tagged `mdlm:mode=dry-run`, with a short lifetime (V1:
  2 hours). It publishes no lifecycle data and creates no DPL. Instead it writes
  a durable dry-run deployment record under `.lifecycle/work/deployments/`,
  alongside the #1111 dry-run cache. The record holds the same receipt fields
  and a dry-run deployment ID, which goes in the `mdlm:deployment` tag. Teardown
  and orphan checks use that record the same way they use a DPL. `mdlm execution dry-run`
  can target that ephemeral deployment. Its cache key adds the template and asset
  digests, so a product change that leaves the deployed artifact unchanged keeps
  its cache hits. Dry-run deployments and their results are never evidence and
  can't be linked from a DPL or RES. The same teardown and orphan rules apply.
- **For credit:** the frozen product commit is deployed **once**, as a published
  DPL in the credit slot. Every for-credit verification activity in the pass
  links to that one DPL. The package rejects a for-credit pass whose results
  name more than one DPL. If the deployment fails, drifts (a probe mismatch or a
  changed `LastUpdatedTime`) or expires mid-pass, the affected results are
  `error`, the DPL is torn down, and the pass restarts on a new DPL. Results from
  two deployments are never mixed. Any product change means a new frozen commit,
  a new DPL and a full pass. Each for-credit deployment starts with empty state,
  so the pass doesn't depend on dry-run leftovers.

## 6. The smallest feature set before a large AWS demo

These are candidate issues; none are filed. Sizes use the deep-dive scale (S is
about a day or less, M a few days, L about a week or more).

| # | Where | Candidate issue | Size | Needs |
| --- | --- | --- | --- | --- |
| D1 | Kernel | `deployment` action kind, `aws-cdk-deployment@1` capability, `mdlm deployment run`: sandboxed `cdk synth`, then a host-side `cdk deploy --app cdk.out` with the APM profile. Deployment receipt with the output allowlist and version probe. First, confirm `CliCredentialsStackSynthesizer` with a pre-synthesized assembly through APM, and that asset digests are deterministic. | L | D3, O1 |
| D2 | Kernel | Networked verification mode: `verified-against` DPL link, per-run internal network and allowlist proxy, `MDLM_ENDPOINT` and `MDLM_RUN_ID`, pre/post probes, receipt fields, `error` on drift. | M | D1 |
| D3 | Kernel | Secret-pattern scan with receipt refusal, for all runtimes and the host CDK CLI output. | S | — |
| D4 | Kernel | `mdlm deployment teardown` (including `--orphan-stack` and `--orphan-resource` for allowlisted types) and `mdlm deployment orphans`: required tags, teardown receipt, tag-query check, pre-deploy orphan check, dry-run deployment records. | M | D1 |
| D5 | Kernel | Pre-deploy template policy check: package-declared resource allowlist, no custom resources, concurrency, throttling, retention, removal-policy and tag rules, slot pool. | M | D1 |
| D6 | Kernel | `mdlm deployment dry-run` to dry-run slots, and template/asset digests in the #1111 cache key. | S | D1, #1111 |
| D7 | Package | DPL and teardown types and actions, `deploys`/`verified-against` links, the teardown-before-terminal Expectation, the expiry Loose End, and the one-DPL-per-for-credit-pass rule. | M | D1, D4, package #46 |
| D8 | Package | Guidance: CDK app conventions (synthesizer, imported role, explicit log groups, DESTROY, tags, version endpoint), writing endpoint verifiers (run-scoped data, environment `error` versus product `fail`), and the demo's pinned synth image. | S | D7 |
| O1 | Taylor, one-time | APM project `mdlm-demo` with grants on the three slot stacks in one region and on the template's services. A Lambda execution role that APM lets the project pass, with a Lambda trust policy and permissions scoped to the demo's table and log groups; whether APM supports this is still open and blocks D1. The CDK bootstrap asset bucket, with a 7-day expiry rule. An AWS Budgets alert at $10 a month. Activating the `mdlm:*` cost-allocation tags. This is outside MDLM and needs Taylor's approval and account access. | S | — |

The critical path is O1 (execution role) → D1 → D2/D4/D5 → D7, with D3, D6 and
D8 alongside. D3 is
worth shipping first on its own, because today's receipts already store output
verbatim.

Deliberately left out of V1: custom domains and TLS certificates (APM can't
register domains), CloudFront, AWS-state inspection by verifiers, multi-region
deployments, non-CDK tools, automatic spend stops from billing data, and
per-run cost reports. Add each only when a run shows the need.

## 7. Proposed first demo

**Product:** a small link shortener with click counts, built as an HTTP API.
Users create a short link (with URL validation and an optional expiry), follow
it (302, or 404/410), and read its stats. A minimal HTML page is served from the
same Lambda function. It is small enough to finish but touches what a deployed
product adds: concurrent click counting (atomic DynamoDB updates), expiry
against a clock, validation at the boundary, cold start, and a version endpoint.

**Infrastructure:** one stack per slot containing an API Gateway HTTP API, one
Lambda function (Node.js 22, arm64, 256 MB, reserved concurrency 10), one
on-demand DynamoDB table, and one log group with 1-day retention. Every resource
bills per request, so a forgotten stack costs close to nothing while idle.

**Estimated cost per run** in us-east-1, from published list prices I recall
(**not re-checked** against current AWS pricing pages). The run is assumed to be
about five dry-run deployments plus one for-credit deployment, with about 100
activities each sending about 200 requests per pass. That is about 120,000
requests in total, or about 220,000 including a modest timing or load check.

| Item | Basis | Estimate |
| --- | --- | --- |
| HTTP API | about $1.00 per million requests | ~$0.22 |
| Lambda | requests + ~100 ms × 256 MB arm64 | ~$0.10 |
| DynamoDB on-demand | ~2 operations per request | ~$0.15 |
| CloudWatch Logs | ~1 KB per request ingested | ~$0.11 |
| S3 assets, CloudFormation | small objects; CloudFormation is free for AWS resource types | <$0.01 |
| **Total** | | **~$0.60 per run** (free tier may cover most of it) |

The proposed budget is $5 per run, an approval budget rather than an enforced
cap, which leaves room for retries and redeploys. V1 can't enforce a monetary
ceiling. The template policy limits the cost rate (no resources that bill while
idle, capped concurrency and throttling) but not total requests, storage or
retries. The $10 monthly account alert arrives hours after the spend. A deploy should
take about 1–3 minutes and a teardown about 1–2 minutes (**unverified**). The
main cost of the demo is agent time, not AWS.

## Consequences

- The `--network none` runtime stays the default and unchanged. Networking is
  available only through a linked DPL, and only to that DPL's endpoint. No
  container receives AWS credentials. Only host-side kernel steps use the APM
  profile.
- Deployment adds one new kind of operation with a real external side effect.
  The started-marker, no-replay design already covers it. Recovery is teardown
  plus an orphan check, never a blind retry.
- Product source now includes infrastructure code, and independent review covers
  it.
- Only the template policy check and the account alert bound cost. Spend that
  billing data reveals later is investigated after the fact, not stopped in
  progress.
- Before any AWS demo runs, Taylor approves O1 (account setup and spend) and the
  demo plan.
