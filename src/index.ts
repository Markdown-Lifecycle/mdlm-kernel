import { validatePayloadCollectionDefinitions, type PayloadCollection, type PayloadView } from "./payload-collections.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import formatsPlugin from "ajv-formats";
import { parse } from "yaml";
import {
  validateDefinitionGraph,
  validateUnreferencedSelectors,
} from "./definition-graph.js";
import { compileDefinitionExpressions } from "./expression.js";
import {
  promptSkillReferences,
  readPackageMarkdownAsset,
} from "./markdown-asset.js";
import { validatePayloadInheritance } from "./payload-inheritance.js";
import type { DirectAction } from "./direct-contract.js";
import { DEPLOYMENT_CAPABILITY, deploymentCapabilityDiagnostics } from "./aws-cdk-deployment.js";

export {
  evaluateLifecycle,
  type ArtifactEvaluation,
  type DatumEnvelope,
  type ExactTypedEntity,
  type HistoricalLifecycleSnapshot,
  type LifecycleEvaluation,
  type LifecycleRecord,
  type LifecycleSnapshot,
  type SelectorEvaluationEvidence,
} from "./evaluator.js";
export type {
  BaselineCompositionDependencyChange,
  BaselineMembershipDependencyChange,
  ContentDependencyChange,
  DependencyChangeRecord,
  DependencyComparison,
  EvidenceTargetDependencyChange,
  OutboundLinkDependencyChange,
  ProcessProvenanceDependencyChange,
  ReviewContextDependencyChange,
  StableLinkResolution,
  StableLinkResolutionDependencyChange,
} from "./dependency-changes.js";

export interface ProcessDiagnostic {
  code: string;
  message: string;
  path?: string;
  line?: number;
  column?: number;
  source?: string;
}

export interface ProcessManifest {
  id: string;
  version: string;
  [key: string]: unknown;
}

export interface VersionedDefinition {
  id: string;
  version: number;
  kind: string;
  [key: string]: unknown;
}

export interface KernelCapabilityBinding {
  type: string;
  requirement_type?: string;
  implementation_type?: string;
  prototype_type?: string;
  criterion_type?: string;
  scope_type?: string;
  decomposition_type?: string;
  change_type?: string;
  acceptance_type?: string;
  review_type?: string;
  result_type?: string;
  prompt_ref?: string;
  subject_link?: string;
  context_link?: string;
  input_link?: string;
  subject_selector?: string;
  action?: string;
}

export interface ProcessPackage {
  root: string;
  manifest: ProcessManifest;
  kernelCapabilities: Record<string, KernelCapabilityBinding>;
  envelopeSchema: Record<string, unknown>;
  templates: Record<string, VersionedDefinition>;
  types: Record<string, VersionedDefinition>;
  policies: Record<string, VersionedDefinition>;
  states: Record<string, VersionedDefinition>;
  selectors: Record<string, VersionedDefinition>;
  primitives: Record<string, VersionedDefinition>;
  actions: Record<string, DirectAction>;
}

export interface ResolvedType {
  payloadCollections: PayloadCollection[];
  payloadViews: PayloadView[];
  id: string;
  version: number;
  name: string;
  description: string;
  templateChain: string[];
  envelopeSchema: Record<string, unknown>;
  payloadSchema: {
    $schema: string;
    type: "object";
    additionalProperties: false;
    required: string[];
    properties: Record<string, unknown>;
    allOf?: Record<string, unknown>[];
  };
  outgoingLinks: Record<string, unknown>[];
  lifecycle: Record<string, unknown>;
  kernelManagedPayloadPaths: string[];
  kernelCapabilities: string[];
}

export type ResolveTypeResult =
  | { ok: true; type: ResolvedType; diagnostics: [] }
  | { ok: false; diagnostics: ProcessDiagnostic[] };

export type LoadProcessPackageResult =
  | { ok: true; package: ProcessPackage; diagnostics: [] }
  | { ok: false; diagnostics: ProcessDiagnostic[] };

const definitionSchemas = {
  templates: "template-definition.schema.json",
  types: "type-definition.schema.json",
  policies: "policy-definition.schema.json",
  states: "state-definition.schema.json",
  selectors: "selector-definition.schema.json",
  actions: "action-definition.schema.json",
  primitives: "primitive-catalog.schema.json",
} as const;

type DefinitionGroup = keyof typeof definitionSchemas;

const exactBaselineCapability = {
  reference: "exact-baseline@1",
  managedPayloadPaths: ["definition_members", "evidence", "snapshot"],
  payloadFields: {
    definition_members: "array:string",
    evidence: "array:string",
    snapshot: "object",
  },
} as const;

const exactBaselineRelations = new Set([
  "baseline-members",
  "baseline-evidence",
  "baseline-memberships",
  "baseline-composed",
]);

function capabilityPrimitiveDiagnostics(
  definition: VersionedDefinition,
  filePath: string,
  capabilityBindings: unknown,
): ProcessDiagnostic[] {
  if (definition.kind !== "selector-definition") return [];
  if (
    typeof capabilityBindings === "object" &&
    capabilityBindings !== null &&
    Object.keys(capabilityBindings).some((reference) =>
      reference.startsWith("exact-baseline@")
    )
  ) {
    return [];
  }
  const query = typeof definition.query === "object" &&
      definition.query !== null
    ? definition.query as Record<string, unknown>
    : undefined;
  const from = typeof query?.from === "object" && query.from !== null
    ? query.from as Record<string, unknown>
    : undefined;
  if (from?.collection === "baselines") {
    return [{
      code: "capability-required",
      path: `${filePath}#query.from.collection`,
      message:
        "Collection 'baselines' requires Kernel Capability exact-baseline@1",
    }];
  }
  if (
    typeof from?.relation === "string" &&
    exactBaselineRelations.has(from.relation)
  ) {
    return [{
      code: "capability-required",
      path: `${filePath}#query.from.relation`,
      message: `Relation '${from.relation}' requires Kernel Capability exact-baseline@1`,
    }];
  }
  return [];
}

function validateKernelCapabilityBindings(
  kernelCapabilities: Record<string, KernelCapabilityBinding>,
  types: Record<string, VersionedDefinition>,
): ProcessDiagnostic[] {
  return Object.entries(kernelCapabilities).flatMap(([reference, binding]) => {
    const path = `manifest.kernel_capabilities.${reference}.type`;
    if (reference !== exactBaselineCapability.reference && reference !== "direct-observation@1" && reference !== "direct-observation@2" && reference !== "docker-verification@1" && reference !== "requirement-trace@1" && reference !== "requirement-trace@2" && reference !== "requirement-trace@3" && reference !== "requirement-trace@4" && reference !== "independent-verification@1" && reference !== "review-correction@1" && reference !== "verification-applicability@1" && reference !== "staged-requirements@1" && reference !== "interface-retarget@1" && reference !== DEPLOYMENT_CAPABILITY) {
      return [{
        code: "unknown-kernel-capability",
        path,
        message: `Unknown Kernel Capability '${reference}'`,
      }];
    }
    return types[binding.type] ? [] : [{
      code: "unknown-capability-type",
      path,
      message: `Kernel Capability '${reference}' binds unknown lifecycle type '${binding.type}'`,
    }];
  });
}

function validateKernelCapabilities(
  processPackage: ProcessPackage,
): ProcessDiagnostic[] {
  const diagnostics = validateKernelCapabilityBindings(
    processPackage.kernelCapabilities,
    processPackage.types,
  );
  if (diagnostics.length > 0) return diagnostics;
  for (const [reference, binding] of Object.entries(
    processPackage.kernelCapabilities,
  )) {
    const bindingPath = `manifest.kernel_capabilities.${reference}.type`;
    const resolved = resolveType(processPackage, binding.type);
    if (!resolved.ok) {
      diagnostics.push(...resolved.diagnostics);
      continue;
    }
    if (reference === "requirement-trace@1" || reference === "requirement-trace@2" || reference === "requirement-trace@3" || reference === "requirement-trace@4") {
      for (const field of (reference !== "requirement-trace@1" ? ["requirement_type", "implementation_type", "scope_type", "decomposition_type", "change_type", "acceptance_type", "review_type", "result_type"] : ["requirement_type", "implementation_type", "scope_type"]) as (keyof KernelCapabilityBinding)[]) {
        if (!binding[field] || !processPackage.types[binding[field]!]) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: `Requirement trace requires a declared ${field}`});
      }
      continue;
    }
    if (reference === "review-correction@1") {
      const trace = processPackage.kernelCapabilities["requirement-trace@4"];
      if (!trace || binding.type !== trace.type || binding.review_type !== trace.review_type) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: "Review correction must bind the requirement-trace@4 set and review types"});
      continue;
    }
    if (reference === "staged-requirements@1") {
      const trace = processPackage.kernelCapabilities["requirement-trace@4"];
      const action = binding.action ? processPackage.actions[binding.action] : undefined;
      if (!trace || binding.type !== trace.type || !resolved.type.kernelManagedPayloadPaths.includes("trace_complete")) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: "Staged requirements require the requirement-trace@4 set type with managed trace_complete"});
      if (!action || action.capability !== "requirements" || action.authority || !Object.keys(action.revises ?? {}).includes(binding.type)) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: "Staged requirements must name an unauthorized requirements action that revises the set"});
      continue;
    }
    if (reference === "interface-retarget@1") {
      const trace = processPackage.kernelCapabilities["requirement-trace@4"];
      const link = resolved.type.outgoingLinks.find(l => l.id === "retargets-interface");
      if (!trace || binding.type !== trace.type || !link) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: "Interface retargets require the requirement-trace@4 set type with a retargets-interface link"});
      continue;
    }
    if (reference === DEPLOYMENT_CAPABILITY) {
      for (const message of deploymentCapabilityDiagnostics(processPackage, resolved.type.kernelManagedPayloadPaths)) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message});
      continue;
    }
    if (reference === "verification-applicability@1") {
      const independent = processPackage.kernelCapabilities["independent-verification@1"];
      if (!independent || binding.type !== independent.result_type || !resolved.type.kernelManagedPayloadPaths.includes("historical_observation")) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: "Verification applicability requires the independent result type and managed historical_observation"});
      continue;
    }
    if (reference === "independent-verification@1") {
      if (!processPackage.kernelCapabilities["requirement-trace@4"]) diagnostics.push({code:"incompatible-kernel-capability",path:bindingPath,message:"Independent verification requires requirement-trace@4"});
      for (const field of ["requirement_type", "criterion_type", "implementation_type", "prototype_type", "result_type", "review_type"] as const) {
        if (!binding[field] || !processPackage.types[binding[field]!]) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: `Independent verification requires a declared ${field}`});
      }
      const resultType = binding.result_type && resolveType(processPackage, binding.result_type);
      if (resultType && resultType.ok) for (const field of ["outcome", "receipt", "case_results", "artifacts"]) {
        if (!resultType.type.kernelManagedPayloadPaths.includes(field)) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: `Independent verification requires managed result ${field}`});
      }
      continue;
    }
    if (reference === "direct-observation@1" || reference === "direct-observation@2") {
      if (reference === "direct-observation@2") {
        const [id, version] = (binding.subject_selector ?? "").split("@");
        if (!id || processPackage.selectors[id]?.version !== Number(version)) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: "Direct execution requires an exact subject selector"});
      }
      for (const field of ["implementation_type", "requirement_type"] as const) {
        if (!binding[field] || !processPackage.types[binding[field]!]) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: `Direct observation requires declared ${field}`});
      }
      for (const field of ["prompt_ref", "subject_link", "context_link", "input_link"] as const) {
        if (!binding[field]) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: `Direct observation requires ${field}`});
      }
      for (const field of ["outcome", "receipt"]) if (!resolved.type.kernelManagedPayloadPaths.includes(field)) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: `Direct observation requires managed ${field}`});
      continue;
    }
    if (reference === "docker-verification@1") {
      for (const field of ["outcome", "receipt"]) {
        if (!resolved.type.kernelManagedPayloadPaths.includes(field)) diagnostics.push({code: "incompatible-kernel-capability", path: bindingPath, message: `Docker verification requires kernel-managed '${field}'`});
      }
      continue;
    }
    const properties = resolved.type.payloadSchema.properties;
    const missingFields = Object.keys(
      exactBaselineCapability.payloadFields,
    ).filter((field) => properties[field] === undefined);
    if (missingFields.length > 0) {
      diagnostics.push({
        code: "incompatible-kernel-capability",
        path: bindingPath,
        message: `Type '${binding.type}' bound to ${reference} must define capability payload fields: ${missingFields.join(", ")}`,
      });
    }
    for (const [field, expected] of Object.entries(
      exactBaselineCapability.payloadFields,
    )) {
      const schema = properties[field];
      if (typeof schema !== "object" || schema === null) continue;
      const fieldSchema = schema as Record<string, unknown>;
      const items = typeof fieldSchema.items === "object" &&
          fieldSchema.items !== null
        ? fieldSchema.items as Record<string, unknown>
        : undefined;
      const compatible = expected === "object"
        ? fieldSchema.type === "object"
        : fieldSchema.type === "array" && items?.type === "string";
      if (!compatible) {
        diagnostics.push({
          code: "incompatible-kernel-capability",
          path: `types.${binding.type}.payload_schema.properties.${field}`,
          message: `${reference} requires '${field}' to be ${expected === "object" ? "an object" : "an array of strings"}`,
        });
      }
    }
    const compositionLink = resolved.type.outgoingLinks.find(
      (link) => link.id === "composes",
    );
    const compositionTargets =
      typeof compositionLink === "object" && compositionLink !== null &&
        Array.isArray(compositionLink.targets)
        ? compositionLink.targets
        : [];
    const supportsExactComposition = compositionTargets.some((target) => {
      if (typeof target !== "object" || target === null) return false;
      const contract = target as Record<string, unknown>;
      return contract.identity === "revision" &&
        Array.isArray(contract.types) &&
        contract.types.includes(binding.type);
    });
    if (!supportsExactComposition) {
      diagnostics.push({
        code: "incompatible-kernel-capability",
        path: `types.${binding.type}.outgoing_links`,
        message: `Type '${binding.type}' bound to ${reference} must declare the 'composes' exact-revision link to ${binding.type}`,
      });
    }
    const managedPaths = new Set(resolved.type.kernelManagedPayloadPaths);
    const missingManagedPaths = exactBaselineCapability.managedPayloadPaths.filter(
      (payloadPath) => !managedPaths.has(payloadPath),
    );
    if (missingManagedPaths.length > 0) {
      diagnostics.push({
        code: "incompatible-kernel-capability",
        path: bindingPath,
        message: `Type '${binding.type}' bound to ${reference} must declare kernel-managed payload paths: ${missingManagedPaths.join(", ")}`,
      });
    }
  }
  return diagnostics;
}

async function readYaml(filePath: string): Promise<unknown> {
  return parse(await fs.readFile(filePath, "utf8"));
}

async function yamlFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error;});
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return yamlFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".yaml") ? [entryPath] : [];
    }),
  );
  return files.flat().sort();
}

function formatAjvErrors(
  filePath: string,
  errors: ErrorObject[] | null | undefined,
): ProcessDiagnostic[] {
  return (errors ?? []).map((error) => ({
    code: "meta-schema",
    path: `${filePath}${error.instancePath}`,
    message: error.message ?? "Process definition failed meta-schema validation",
  }));
}

function legacyExpressionAuthoringDiagnostics(
  value: unknown,
  filePath: string,
): ProcessDiagnostic[] {
  if (typeof value !== "object" || value === null) return [];
  const definition = value as Record<string, unknown>;
  const diagnostics: ProcessDiagnostic[] = [];
  const check = (expression: unknown, expressionPath: string): void => {
    if (typeof expression === "object" && expression !== null) {
      diagnostics.push({
        code: "legacy-expression-authoring",
        path: `${filePath}#${expressionPath}`,
        message:
          "Expression-bearing fields require mdlm-expression@1 textual source; legacy YAML expression trees are not accepted",
      });
    }
  };
  const checkRules = (rules: unknown, prefix: string): void => {
    if (!Array.isArray(rules)) return;
    rules.forEach((rule, index) => {
      if (typeof rule !== "object" || rule === null) return;
      const ruleRecord = rule as Record<string, unknown>;
      check(ruleRecord.when, `${prefix}[${index}].when`);
      check(
        ruleRecord.explanation_evidence,
        `${prefix}[${index}].explanation_evidence`,
      );
      const blockers = Array.isArray(ruleRecord.blocked_by)
        ? ruleRecord.blocked_by
        : [];
      blockers.forEach((blocker, blockerIndex) => {
        if (typeof blocker !== "object" || blocker === null) return;
        check(
          (blocker as Record<string, unknown>).subjects,
          `${prefix}[${index}].blocked_by[${blockerIndex}].subjects`,
        );
      });
    });
  };
  const checkArguments = (argumentsValue: unknown, prefix: string): void => {
    if (typeof argumentsValue !== "object" || argumentsValue === null) return;
    for (const [name, argument] of Object.entries(argumentsValue)) {
      check(argument, `${prefix}.${name}`);
    }
  };

  switch (definition.kind) {
    case "state-definition":
    case "policy-definition":
      checkRules(definition.rules, "rules");
      break;
    case "selector-definition": {
      const query = typeof definition.query === "object" && definition.query !== null
        ? definition.query as Record<string, unknown>
        : undefined;
      const from = typeof query?.from === "object" && query.from !== null
        ? query.from as Record<string, unknown>
        : undefined;
      check(query?.where, "query.where");
      check(from?.of, "query.from.of");
      checkArguments(from?.arguments, "query.from.arguments");
      break;
    }
    case "action-definition":
      check(definition.subjects, "subjects");
      check(definition.when, "when");
      checkArguments(definition.inputs, "inputs");
      break;
  }
  return diagnostics;
}

function isVersionedDefinition(value: unknown): value is VersionedDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).version === "number" &&
    typeof (value as Record<string, unknown>).kind === "string"
  );
}

async function validateActionAssets(
  root: string,
  actions: Record<string, VersionedDefinition>,
): Promise<ProcessDiagnostic[]> {
  const diagnostics: ProcessDiagnostic[] = [];
  for (const action of Object.values(actions)) {
    if (typeof action.prompt_ref !== "string") continue;
    const prompt = await readPackageMarkdownAsset(root, action.prompt_ref);
    if (!prompt.ok) {
      diagnostics.push({
        code: `prompt-${prompt.reason}`,
        path: path.join(root, prompt.path),
        message: prompt.message,
      });
      continue;
    }
    const explicitSkills = Array.isArray(action.skills)
      ? action.skills.flatMap((value) => {
        if (typeof value !== "object" || value === null) return [];
        const reference = (value as Record<string, unknown>).reference;
        return typeof reference === "string" ? [reference] : [];
      })
      : [];
    const declaration = promptSkillReferences(prompt.asset.content);
    if (!declaration.ok) {
      diagnostics.push({
        code: "prompt-skills-invalid",
        path: path.join(root, prompt.asset.relativePath),
        message: `Prompt '${action.prompt_ref}' must declare an ordered unique array of exact skill references`,
      });
      continue;
    }
    if (
      explicitSkills.length > 0 &&
      JSON.stringify(explicitSkills) !== JSON.stringify(declaration.references)
    ) {
      diagnostics.push({
        code: "action-skill-declaration-mismatch",
        path: `actions.${action.id}.skills`,
        message: `Action '${action.id}@${action.version}' skill metadata must match its prompt declaration`,
      });
    }
    for (const skillReference of explicitSkills.length > 0
      ? explicitSkills
      : declaration.references) {
      const skill = await readPackageMarkdownAsset(root, skillReference);
      if (!skill.ok) {
        diagnostics.push({
          code: `skill-${skill.reason}`,
          path: path.join(root, skill.path),
          message: skill.message,
        });
      }
    }
  }
  return diagnostics;
}

async function createMetaValidators(
  metaDirectory: string,
): Promise<Map<string, ValidateFunction>> {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const addFormats = formatsPlugin as unknown as (
    instance: Ajv2020,
  ) => Ajv2020;
  addFormats(ajv);

  const schemaFiles = (await fs.readdir(metaDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const schemas = await Promise.all(
    schemaFiles.map(async (name) => ({
      name,
      schema: JSON.parse(await fs.readFile(path.join(metaDirectory, name), "utf8")),
    })),
  );

  for (const { schema } of schemas) ajv.addSchema(schema);

  const validators = new Map<string, ValidateFunction>();
  for (const { name, schema } of schemas) {
    const id = (schema as { $id?: string }).$id;
    if (!id) continue;
    const validator = ajv.getSchema(id);
    if (validator) validators.set(name, validator);
  }
  return validators;
}

export interface LoadProcessPackageOptions {
  /**
   * Historical authoring packages were validated by the runtime that selected
   * them. This mode retains structural loading for immutable provenance and
   * migration without retroactively applying newer asset-conformance rules.
   */
  compatibility?: "historical-authoring";
}

export async function loadProcessPackage(
  root: string,
  options: LoadProcessPackageOptions = {},
): Promise<LoadProcessPackageResult> {
  const diagnostics: ProcessDiagnostic[] = [];

  try {
    const metaDirectory = path.join(root, "meta");
    const validators = await createMetaValidators(metaDirectory);
    const envelopeSchema = JSON.parse(
      await fs.readFile(path.join(metaDirectory, "datum-envelope.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const manifestPath = path.join(root, "manifest.yaml");
    const manifest = await readYaml(manifestPath);
    if ((manifest as Record<string, unknown>).direct_contract !== "mdlm-direct@1") return {ok:false, diagnostics:[{code:"unsupported-process-contract",message:"This kernel requires a fresh mdlm-direct@1 Process Package; use the pinned historical installation for old workflows"}]};
    const manifestValidator = validators.get("manifest.schema.json");
    if (!manifestValidator || !manifestValidator(manifest)) {
      diagnostics.push(
        ...formatAjvErrors(manifestPath, manifestValidator?.errors),
      );
    }

    const definitions = {} as Record<
      DefinitionGroup,
      Record<string, VersionedDefinition>
    >;
    const definitionSources = {} as Record<
      DefinitionGroup,
      Record<string, string>
    >;
    const expressionDefinitions: {
      definition: VersionedDefinition;
      filePath: string;
    }[] = [];

    for (const [group, schemaName] of Object.entries(definitionSchemas) as [
      DefinitionGroup,
      string,
    ][]) {
      const validator = validators.get(schemaName);
      const byId: Record<string, VersionedDefinition> = {};
      const sourcesById: Record<string, string> = {};
      for (const filePath of await yamlFiles(path.join(root, group))) {
        const definition = await readYaml(filePath);
        diagnostics.push(
          ...legacyExpressionAuthoringDiagnostics(definition, filePath),
        );
        if (!validator || !validator(definition)) {
          diagnostics.push(...formatAjvErrors(filePath, validator?.errors));
          continue;
        }
        if (!isVersionedDefinition(definition)) {
          diagnostics.push({
            code: "definition-envelope",
            path: filePath,
            message: "Definition lacks a stable id, integer version, or kind",
          });
          continue;
        }
        diagnostics.push(
          ...capabilityPrimitiveDiagnostics(
            definition,
            filePath,
            typeof manifest === "object" && manifest !== null
              ? (manifest as Record<string, unknown>).kernel_capabilities
              : undefined,
          ),
        );
        if (byId[definition.id]) {
          diagnostics.push({
            code: "duplicate-definition",
            path: filePath,
            message: `Duplicate ${group} definition '${definition.id}'`,
          });
          continue;
        }
        if (
          group === "states" ||
          group === "policies" ||
          group === "selectors" ||
          group === "actions"
        ) {
          expressionDefinitions.push({ definition, filePath });
        }
        byId[definition.id] = definition;
        sourcesById[definition.id] = filePath;
      }
      definitions[group] = byId;
      definitionSources[group] = sourcesById;
    }

    if (diagnostics.length > 0) return { ok: false, diagnostics };


    const manifestCapabilities = typeof manifest === "object" &&
        manifest !== null &&
        typeof (manifest as Record<string, unknown>).kernel_capabilities ===
          "object" &&
        (manifest as Record<string, unknown>).kernel_capabilities !== null
      ? (manifest as Record<string, unknown>).kernel_capabilities as Record<
        string,
        unknown
      >
      : {};
    const capabilityBindingDiagnostics = validateKernelCapabilityBindings(
      manifestCapabilities as Record<string, KernelCapabilityBinding>,
      definitions.types,
    );
    if (capabilityBindingDiagnostics.length > 0) {
      return { ok: false, diagnostics: capabilityBindingDiagnostics };
    }
    const exactBaselineBinding = typeof manifestCapabilities[
          "exact-baseline@1"
        ] === "object" && manifestCapabilities["exact-baseline@1"] !== null
      ? manifestCapabilities["exact-baseline@1"] as Record<string, unknown>
      : undefined;
    const exactBaselineType = typeof exactBaselineBinding?.type === "string"
      ? exactBaselineBinding.type
      : undefined;

    for (const { definition, filePath } of expressionDefinitions) {
      diagnostics.push(
        ...compileDefinitionExpressions(
          definition,
          filePath,
          {
            templates: definitions.templates,
            types: definitions.types,
            selectors: definitions.selectors,
            states: definitions.states,
            policies: definitions.policies,
            ...(exactBaselineType ? { exactBaselineType } : {}),
          },
        ),
      );
    }

    diagnostics.push(...validateDefinitionGraph(manifest, definitions));
    diagnostics.push(...validatePayloadInheritance(definitions));
    diagnostics.push(...await validateActionAssets(root, definitions.actions));
    if (diagnostics.length > 0) return { ok: false, diagnostics };
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      typeof (manifest as Record<string, unknown>).id !== "string" ||
      typeof (manifest as Record<string, unknown>).version !== "string"
    ) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "manifest-envelope",
            path: manifestPath,
            message: "Manifest lacks a stable id or semantic version",
          },
        ],
      };
    }

    const processPackage: ProcessPackage = {
      root,
      manifest: manifest as ProcessManifest,
      kernelCapabilities: ((manifest as Record<string, unknown>)
        .kernel_capabilities ?? {}) as Record<
        string,
        KernelCapabilityBinding
      >,
      envelopeSchema,
      ...definitions,
      actions: definitions.actions as unknown as Record<string, DirectAction>,
    };
    diagnostics.push(...validateKernelCapabilities(processPackage));
    diagnostics.push(...validatePayloadCollectionDefinitions(processPackage, (id) => {
      const result = resolveType(processPackage, id);
      return result.ok ? result.type : undefined;
    }));
    if (diagnostics.length > 0) return { ok: false, diagnostics };

    return {
      ok: true,
      package: processPackage,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "package-load",
          path: root,
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function referenceParts(reference: unknown): [string, number] | undefined {
  if (typeof reference !== "string") return undefined;
  const match = /^(.*)@([1-9][0-9]*)$/.exec(reference);
  if (!match?.[1] || !match[2]) return undefined;
  return [match[1], Number(match[2])];
}

function payloadFragment(definition: VersionedDefinition): {
  required: string[];
  properties: Record<string, unknown>;
  constraints: Record<string, unknown>;
} {
  const schema = definition.payload_schema as Record<string, unknown> | undefined;
  const constraints = Object.fromEntries(
    Object.entries(schema ?? {}).filter(([key]) =>
      !["$schema", "type", "additionalProperties", "required", "properties"]
        .includes(key)
    ),
  );
  return {
    required: Array.isArray(schema?.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
    properties:
      typeof schema?.properties === "object" && schema.properties !== null
        ? (schema.properties as Record<string, unknown>)
        : {},
    constraints,
  };
}

export function resolveType(
  processPackage: ProcessPackage,
  typeId: string,
): ResolveTypeResult {
  const typeDefinition = processPackage.types[typeId];
  if (!typeDefinition) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "unknown-type",
          path: `types.${typeId}`,
          message: `Unknown lifecycle type '${typeId}'`,
        },
      ],
    };
  }

  const diagnostics: ProcessDiagnostic[] = [];
  const templates: VersionedDefinition[] = [];
  const visiting = new Set<string>();
  let reference = typeDefinition.extends;
  while (reference !== undefined) {
    const parts = referenceParts(reference);
    if (!parts) {
      diagnostics.push({
        code: "invalid-reference",
        path: `types.${typeId}.extends`,
        message: `Invalid template reference '${String(reference)}'`,
      });
      break;
    }
    const [templateId, expectedVersion] = parts;
    if (visiting.has(templateId)) {
      diagnostics.push({
        code: "template-cycle",
        path: `templates.${templateId}.extends`,
        message: `Template inheritance cycle includes '${templateId}'`,
      });
      break;
    }
    const template = processPackage.templates[templateId];
    if (!template) {
      diagnostics.push({
        code: "unknown-reference",
        path: `types.${typeId}.extends`,
        message: `Unknown template reference '${String(reference)}'`,
      });
      break;
    }
    if (template.version !== expectedVersion) {
      diagnostics.push({
        code: "version-mismatch",
        path: `types.${typeId}.extends`,
        message: `Template '${templateId}' is version ${template.version}, not ${expectedVersion}`,
      });
      break;
    }
    visiting.add(templateId);
    templates.unshift(template);
    reference = template.extends;
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const required = new Set<string>();
  const properties: Record<string, unknown> = {};
  const outgoingLinks: Record<string, unknown>[] = [];
  const linkIds = new Set<string>();
  const payloadConstraints: Record<string, unknown>[] = [];

  for (const definition of [...templates, typeDefinition]) {
    const fragment = payloadFragment(definition);
    fragment.required.forEach((field) => required.add(field));
    Object.assign(properties, fragment.properties);
    if (Object.keys(fragment.constraints).length > 0) {
      payloadConstraints.push(fragment.constraints);
    }
    const links = Array.isArray(definition.outgoing_links)
      ? definition.outgoing_links
      : [];
    for (const link of links) {
      if (typeof link !== "object" || link === null) continue;
      const id = (link as Record<string, unknown>).id;
      if (typeof id !== "string") continue;
      if (linkIds.has(id)) {
        diagnostics.push({
          code: "duplicate-inherited-link",
          path: `types.${typeId}.outgoing_links`,
          message: `Resolved type '${typeId}' declares outgoing link '${id}' more than once`,
        });
      } else {
        linkIds.add(id);
        outgoingLinks.push(link as Record<string, unknown>);
      }
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return {
    ok: true,
    type: {
      payloadCollections: (typeDefinition.payload_collections ?? []) as PayloadCollection[],
      payloadViews: (typeDefinition.payload_views ?? []) as PayloadView[],
      id: typeId,
      version: typeDefinition.version,
      name: String(typeDefinition.name),
      description: String(typeDefinition.description),
      templateChain: templates.map(
        (template) => `${template.id}@${template.version}`,
      ),
      envelopeSchema: processPackage.envelopeSchema,
      payloadSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: [...required].sort(),
        properties,
        ...(payloadConstraints.length > 0 ? { allOf: payloadConstraints } : {}),
      },
      outgoingLinks,
      lifecycle: (typeDefinition.lifecycle ?? {}) as Record<string, unknown>,
      kernelManagedPayloadPaths: Array.isArray(
        typeDefinition.kernel_managed_payload_paths,
      )
        ? typeDefinition.kernel_managed_payload_paths.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      kernelCapabilities: Object.entries(processPackage.kernelCapabilities)
        .filter(([, binding]) => binding.type === typeId)
        .map(([reference]) => reference)
        .sort(),
    },
    diagnostics: [],
  };
}
