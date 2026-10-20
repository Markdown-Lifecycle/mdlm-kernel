import { executeCommandApplication } from "./command-application.js";
import {
  type CommandOutputStream,
  writeCommandOutput,
} from "./command-output.js";
import { collectPerformanceDiagnostics } from "./performance-diagnostics.js";

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
    executeCommandApplication(
      options.arguments_,
      options.cwd,
      options.standardInput,
    )
  );
  try {
    await writeCommandOutput(options.stdout, measured.value.output);
  } catch (error) {
    // The command already ran; its durable effects and settlement stay as they are.
    const cause = error as NodeJS.ErrnoException;
    await writeCommandOutput(options.stderr, `${JSON.stringify({
      ok: false,
      diagnostics: [{
        code: "command-output-unwritable",
        message: `The command finished with exit status ${measured.value.exitCode}, but its result could not be written to stdout: ${cause.message}. Durable effects are kept; read the operation's settlement before retrying.`,
        ...(cause.code ? { cause: cause.code } : {}),
      }],
    })}\n`).catch(() => undefined);
    return 1;
  }
  if (options.performanceDiagnostics) {
    await writeCommandOutput(
      options.stderr,
      `${JSON.stringify(measured.diagnostics)}\n`,
    );
  }
  return measured.value.exitCode;
}
