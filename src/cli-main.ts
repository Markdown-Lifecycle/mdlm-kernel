import { executeCommandApplication } from "./command-application.js";
import {
  type CommandOutputStream,
  writeCommandOutput,
} from "./command-output.js";
import { collectPerformanceDiagnostics } from "./performance-diagnostics.js";
import { withProgress } from "./progress.js";

export interface MdlmCliOptions {
  arguments_: string[];
  cwd: string;
  standardInput?: string | undefined;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  performanceDiagnostics: boolean;
}

export async function runMdlmCli(options: MdlmCliOptions): Promise<number> {
  const measured = await collectPerformanceDiagnostics(() =>
    withProgress((line) => { options.stderr.write(line, () => {}); }, () =>
      executeCommandApplication(
        options.arguments_,
        options.cwd,
        options.standardInput,
      )
    )
  );
  await writeCommandOutput(options.stdout, measured.value.output);
  if (options.performanceDiagnostics) {
    await writeCommandOutput(
      options.stderr,
      `${JSON.stringify(measured.diagnostics)}\n`,
    );
  }
  return measured.value.exitCode;
}
