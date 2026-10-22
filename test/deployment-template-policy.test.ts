import { expect, test } from "vitest";
import { templatePolicyProblems } from "../src/deployment-template-policy.js";

const config = {stack_slots: ["mdlm-demo-credit", "mdlm-demo-dry-1"], resource_allowlist: ["AWS::Lambda::Function", "AWS::ApiGatewayV2::Api", "AWS::DynamoDB::Table", "AWS::Logs::LogGroup"]};
const Delete = {DeletionPolicy: "Delete", UpdateReplacePolicy: "Delete"};
// The ADR-0009 demo stack, as CDK synthesizes it with the conventions the policy requires.
const compliant = () => ({Resources: {
  Fn: {Type: "AWS::Lambda::Function", Properties: {ReservedConcurrentExecutions: 10, LoggingConfig: {LogGroup: {Ref: "Logs"}}, Tags: [{Key: "app", Value: "demo"}]}},
  Perm: {Type: "AWS::Lambda::Permission", Properties: {FunctionName: {"Fn::GetAtt": ["Fn", "Arn"]}}},
  Api: {Type: "AWS::ApiGatewayV2::Api", Properties: {ProtocolType: "HTTP", Tags: {app: "demo"}}},
  Stage: {Type: "AWS::ApiGatewayV2::Stage", Properties: {ApiId: {Ref: "Api"}, DefaultRouteSettings: {ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10}}},
  Route: {Type: "AWS::ApiGatewayV2::Route", Properties: {ApiId: {Ref: "Api"}}},
  Integration: {Type: "AWS::ApiGatewayV2::Integration", Properties: {ApiId: {Ref: "Api"}}},
  Logs: {Type: "AWS::Logs::LogGroup", Properties: {RetentionInDays: 1}, ...Delete},
  Table: {Type: "AWS::DynamoDB::Table", Properties: {BillingMode: "PAY_PER_REQUEST"}, ...Delete},
  CDKMetadata: {Type: "AWS::CDK::Metadata", Properties: {}},
}} as {Resources: Record<string, any>});
const stack = {name: "mdlm-demo-credit"};

test("the template policy accepts the demo stack", () => {
  expect(templatePolicyProblems(compliant(), stack, config)).toEqual([]);
});

test("each template policy rule refuses a template that breaks it", () => {
  const cases: [string, (t: {Resources: Record<string, any>}) => void, string][] = [
    ["allowlist", t => { t.Resources.Queue = {Type: "AWS::SQS::Queue"}; }, "Queue (AWS::SQS::Queue) is not on the package resource allowlist"],
    ["allowlist", t => { t.Resources.Nat = {Type: "AWS::EC2::NatGateway"}; }, "is not on the package resource allowlist"],
    ["custom resource", t => { t.Resources.Cleanup = {Type: "Custom::S3AutoDeleteObjects"}; }, "Cleanup (Custom::S3AutoDeleteObjects) is a custom resource"],
    ["custom resource", t => { t.Resources.Cleanup = {Type: "AWS::CloudFormation::CustomResource"}; }, "is a custom resource"],
    ["orphaned child", t => { t.Resources.Route.Properties.ApiId = "abc123"; }, "Route (AWS::ApiGatewayV2::Route) is allowed only as a child of an allowlisted AWS::ApiGatewayV2::Api"],
    ["orphaned child", t => { t.Resources.Perm.Properties.FunctionName = "someone-elses-function"; }, "Perm (AWS::Lambda::Permission) is allowed only as a child"],
    ["concurrency", t => { delete t.Resources.Fn.Properties.ReservedConcurrentExecutions; }, "Fn (AWS::Lambda::Function) must set ReservedConcurrentExecutions to 10 or less"],
    ["concurrency", t => { t.Resources.Fn.Properties.ReservedConcurrentExecutions = 11; }, "ReservedConcurrentExecutions to 10 or less"],
    ["explicit log group", t => { delete t.Resources.Fn.Properties.LoggingConfig; }, "Fn (AWS::Lambda::Function) must log to an explicit log group in this stack"],
    ["throttling", t => { delete t.Resources.Stage.Properties.DefaultRouteSettings; }, "Stage (AWS::ApiGatewayV2::Stage) must set stage throttling"],
    ["throttling", t => { delete t.Resources.Stage; }, "Api (AWS::ApiGatewayV2::Api) needs a stage that sets throttling"],
    ["HTTP API", t => { t.Resources.Api.Properties.ProtocolType = "WEBSOCKET"; }, "Api (AWS::ApiGatewayV2::Api) must be an HTTP API"],
    ["retention", t => { t.Resources.Logs.Properties.RetentionInDays = 7; }, "Logs (AWS::Logs::LogGroup) must set 1-day retention"],
    ["on-demand", t => { t.Resources.Table.Properties.BillingMode = "PROVISIONED"; }, "Table (AWS::DynamoDB::Table) must use on-demand billing"],
    ["removal policy", t => { t.Resources.Table.DeletionPolicy = "Retain"; }, "Table (AWS::DynamoDB::Table) must use RemovalPolicy.DESTROY"],
    ["removal policy", t => { delete t.Resources.Logs.DeletionPolicy; }, "Logs (AWS::Logs::LogGroup) must use RemovalPolicy.DESTROY"],
    ["removal policy", t => { t.Resources.Fn.UpdateReplacePolicy = "Retain"; }, "Fn (AWS::Lambda::Function) must use RemovalPolicy.DESTROY"],
    ["tags", t => { t.Resources.Fn.Properties.Tags.push({Key: "mdlm:expires-at", Value: "2099-01-01T00:00:00Z"}); }, "Fn (AWS::Lambda::Function) sets mdlm: tags, which only the kernel applies"],
    ["tags", t => { t.Resources.Api.Properties.Tags["mdlm:deployment"] = "forged"; }, "Api (AWS::ApiGatewayV2::Api) sets mdlm: tags"],
    ["tags", t => { t.Resources.Fn.Properties.Tags.push({Key: {"Fn::Join": ["", ["mdlm:", "deployment"]]}, Value: "forged"}); }, "Fn (AWS::Lambda::Function) sets tags that are not literal"],
    ["tags", t => { t.Resources.Fn.Properties.Tags = {"Fn::If": ["Cond", [{Key: "mdlm:mode", Value: "credit"}], []]}; }, "Fn (AWS::Lambda::Function) sets tags that are not literal"],
    ["removal policy", t => { t.Resources.Table.Properties.DeletionProtectionEnabled = true; }, "Table (AWS::DynamoDB::Table) must not enable deletion protection"],
    ["throttling", t => { t.Resources.Api.Properties.Target = {"Fn::GetAtt": ["Fn", "Arn"]}; }, "Api (AWS::ApiGatewayV2::Api) must not use quick create (Target)"],
  ];
  for (const [rule, mutate, message] of cases) {
    const template = compliant();
    mutate(template);
    const problems = templatePolicyProblems(template, stack, config);
    expect(problems, rule).toHaveLength(1);
    expect(problems[0], rule).toContain(message);
  }
  // A child is allowed only while its parent type is on the package's allowlist.
  expect(templatePolicyProblems(compliant(), stack, {...config, resource_allowlist: config.resource_allowlist.filter(type => type !== "AWS::ApiGatewayV2::Api")}))
    .toEqual(expect.arrayContaining([expect.stringContaining("Api (AWS::ApiGatewayV2::Api) is not on the package resource allowlist"), expect.stringContaining("Route (AWS::ApiGatewayV2::Route) is allowed only as a child")]));
  // Stack-level rules: the slot pool, and tags only the kernel applies.
  expect(templatePolicyProblems(compliant(), {name: "mdlm-demo-dry-9"}, config)).toEqual(["stack 'mdlm-demo-dry-9' is not in the package's slot pool"]);
  expect(templatePolicyProblems(compliant(), {...stack, tags: {"mdlm:mode": "credit"}}, config)).toEqual(["the stack sets mdlm: tags, which only the kernel applies"]);
  expect(templatePolicyProblems({}, stack, config)).toEqual(["the template has no Resources"]);
});
