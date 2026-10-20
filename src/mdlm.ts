#!/usr/bin/env node
import { runMdlmCli } from "./cli-main.js";

const arguments_ = process.argv.slice(2);
const submitArguments = arguments_.filter((argument) => argument !== "--json");
const readsProposal = submitArguments[0] === "proposal" &&
  submitArguments[1] === "submit" && submitArguments[2] === "-";
let standardInput: string | undefined;
if (readsProposal) {
  process.stdin.setEncoding("utf8");
  standardInput = "";
  for await (const chunk of process.stdin) standardInput += chunk;
}
// A closed stdout also emits EPIPE as a stream event; runMdlmCli reports it from the write callback.
process.stdout.on("error", () => undefined);
process.exitCode = await runMdlmCli({
  arguments_,
  cwd: process.cwd(),
  standardInput,
  stdout: process.stdout,
  stderr: process.stderr,
  performanceDiagnostics: process.env.MDLM_PERFORMANCE === "json",
});
