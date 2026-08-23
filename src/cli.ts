import { parseArgv, UsageError } from "./core/args.ts";
import { HELP } from "./core/help.ts";
import { rejectUnscopedFresh } from "./commands/guards.ts";
import { listPayload, listTable, parseEcosystem } from "./commands/list.ts";
import { statusPayload, statusTable } from "./commands/status.ts";
import pkg from "../package.json" with { type: "json" };

function print(json: boolean, payload: unknown, text: string): void {
  console.log(json ? JSON.stringify(payload, null, 2) : text);
}

export async function run(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArgv(argv);
  const json = flags.json === true;

  if (flags.help || flags.h || command === "help") {
    console.log(HELP);
    return 0;
  }
  if (flags.version || flags.v) {
    console.log(pkg.version);
    return 0;
  }

  switch (command) {
    case "status": {
      rejectUnscopedFresh("status", flags);
      const payload = statusPayload();
      print(json, payload, statusTable(payload));
      return 0;
    }
    case "list": {
      rejectUnscopedFresh("list", flags);
      const payload = listPayload(parseEcosystem(positionals[0]));
      print(json, payload, listTable(payload));
      return 0;
    }
    case "": {
      const payload = statusPayload();
      print(json, payload, statusTable(payload));
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${command}"\n\n${HELP}`);
  }
}

export async function main(argv: string[]): Promise<void> {
  try {
    process.exitCode = await run(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
