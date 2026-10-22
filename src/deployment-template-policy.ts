import type { DeploymentConfig } from "./aws-cdk-deployment.js";

// ADR-0009 section 4. Billing data lags by hours, so the cost and cleanup limits are
// enforced on the synthesized template before anything calls AWS.
const FUNCTION = "AWS::Lambda::Function", API = "AWS::ApiGatewayV2::Api", STAGE = "AWS::ApiGatewayV2::Stage", TABLE = "AWS::DynamoDB::Table", LOG_GROUP = "AWS::Logs::LogGroup";
/** Top-level types a package may allowlist: the kernel knows each one's cost rules and how to delete it. */
export const POLICY_RESOURCE_TYPES = [FUNCTION, API, TABLE, LOG_GROUP];
const MAX_RESERVED_CONCURRENCY = 10;
/** Children allowed only under an allowlisted parent in the same template; AWS deletes them with it. */
const CHILDREN: Record<string, {parent: string; reference: string}> = {
  [STAGE]: {parent: API, reference: "ApiId"},
  "AWS::ApiGatewayV2::Route": {parent: API, reference: "ApiId"},
  "AWS::ApiGatewayV2::Integration": {parent: API, reference: "ApiId"},
  "AWS::Lambda::Permission": {parent: FUNCTION, reference: "FunctionName"},
};
/** CDK's version-reporting resource creates nothing in the account. */
const BOOKKEEPING = "AWS::CDK::Metadata";
const STATEFUL = new Set([TABLE, LOG_GROUP]);

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
/** The logical ID a `Ref` or `Fn::GetAtt` points at. */
function target(value: unknown): string | undefined {
  if (!object(value)) return undefined;
  if (typeof value.Ref === "string") return value.Ref;
  const attribute = value["Fn::GetAtt"];
  return Array.isArray(attribute) ? String(attribute[0]) : typeof attribute === "string" ? attribute.split(".")[0] : undefined;
}
/** Tags must be literal so the policy can read them; an intrinsic key or a conditional collection could resolve to an mdlm: key. */
function tagProblem(tags: unknown): string | undefined {
  if (tags === undefined) return undefined;
  const keys = Array.isArray(tags) ? tags.map(tag => tag?.Key) : object(tags) ? Object.keys(tags) : [undefined];
  if (keys.some(key => typeof key !== "string" || key.startsWith("Fn::") || key === "Ref")) return "sets tags that are not literal key-value pairs";
  if (keys.some(key => key.startsWith("mdlm:"))) return "sets mdlm: tags, which only the kernel applies";
  return undefined;
}
const hasTransform = (value: unknown): boolean => Array.isArray(value) ? value.some(hasTransform) : object(value) && Object.entries(value).some(([key, item]) => key === "Fn::Transform" || hasTransform(item));
const positive = (value: unknown) => typeof value === "number" && value > 0;

/** Every rule the template breaks; an empty list means it may be deployed. */
export function templatePolicyProblems(template: unknown, stack: {name: string; tags?: unknown}, config: Pick<DeploymentConfig, "stack_slots" | "resource_allowlist">): string[] {
  const problems: string[] = [];
  if (!config.stack_slots.includes(stack.name)) problems.push(`stack '${stack.name}' is not in the package's slot pool`);
  const stackTagProblem = tagProblem(stack.tags);
  if (stackTagProblem) problems.push(`the stack ${stackTagProblem}`);
  if (!object(template) || !object(template.Resources)) return [...problems, "the template has no Resources"];
  // CloudFormation expands transforms and macros after this check, so they could add anything.
  if (template.Transform !== undefined || hasTransform(template)) problems.push("the template uses a transform or macro, which CloudFormation expands after this check");
  const resources = template.Resources as Record<string, any>;
  const typeOf = (id: string | undefined) => id !== undefined && object(resources[id]) ? resources[id].Type : undefined;
  const allowed = (type: string) => config.resource_allowlist.includes(type);
  for (const [id, resource] of Object.entries(resources)) {
    const type = String(resource?.Type), properties = object(resource?.Properties) ? resource.Properties : {}, at = `${id} (${type})`;
    if (type.startsWith("Custom::") || type === "AWS::CloudFormation::CustomResource") { problems.push(`${at} is a custom resource`); continue; }
    const child = CHILDREN[type];
    if (child) {
      if (typeOf(target(properties[child.reference])) !== child.parent || !allowed(child.parent)) problems.push(`${at} is allowed only as a child of an allowlisted ${child.parent} in this stack`);
    } else if (type !== BOOKKEEPING && !allowed(type)) { problems.push(`${at} is not on the package resource allowlist`); continue; }
    const resourceTagProblem = tagProblem(properties.Tags);
    if (resourceTagProblem) problems.push(`${at} ${resourceTagProblem}`);
    // Deletion protection makes AWS refuse the delete that DESTROY promises.
    if (properties.DeletionProtectionEnabled !== undefined && properties.DeletionProtectionEnabled !== false) problems.push(`${at} must not enable deletion protection`);
    const deletion = resource.DeletionPolicy, replacement = resource.UpdateReplacePolicy;
    if ((STATEFUL.has(type) ? deletion !== "Delete" : (deletion ?? "Delete") !== "Delete") || (replacement ?? "Delete") !== "Delete") problems.push(`${at} must use RemovalPolicy.DESTROY (DeletionPolicy and UpdateReplacePolicy Delete)`);
    if (type === FUNCTION) {
      const reserved = properties.ReservedConcurrentExecutions;
      if (!Number.isInteger(reserved) || reserved < 0 || reserved > MAX_RESERVED_CONCURRENCY) problems.push(`${at} must set ReservedConcurrentExecutions to ${MAX_RESERVED_CONCURRENCY} or less`);
      // Lambda's implicit log group would sit outside the stack and outlive teardown.
      if (typeOf(target(properties.LoggingConfig?.LogGroup)) !== LOG_GROUP) problems.push(`${at} must log to an explicit log group in this stack`);
    }
    if (type === API) {
      if (properties.ProtocolType !== "HTTP") problems.push(`${at} must be an HTTP API`);
      // Quick create adds an unthrottled default stage outside the template.
      if (properties.Target !== undefined) problems.push(`${at} must not use quick create (Target)`);
      if (!Object.values(resources).some(other => other?.Type === STAGE && target(other.Properties?.ApiId) === id)) problems.push(`${at} needs a stage that sets throttling`);
    }
    if (type === STAGE && !(positive(properties.DefaultRouteSettings?.ThrottlingBurstLimit) && positive(properties.DefaultRouteSettings?.ThrottlingRateLimit))) problems.push(`${at} must set stage throttling (ThrottlingBurstLimit and ThrottlingRateLimit)`);
    if (type === LOG_GROUP && properties.RetentionInDays !== 1) problems.push(`${at} must set 1-day retention`);
    if (type === TABLE && properties.BillingMode !== "PAY_PER_REQUEST") problems.push(`${at} must use on-demand billing (PAY_PER_REQUEST)`);
  }
  return problems;
}
