import { UsageError } from "../core/args.ts";
import { loadConfig } from "../core/config.ts";
import { deriveState } from "../core/store.ts";
import { formatDelta, relativeAge, since, table } from "../core/format.ts";
import { ECOSYSTEMS, HEADLINE_METRIC, SCHEMA_VERSION, type Ecosystem } from "../core/types.ts";

export type ListPayload = {
  schemaVersion: number;
  generatedAt: string;
  ecosystem: Ecosystem;
  targets: {
    id: string;
    name: string;
    discovered: "auto" | "config";
    summary: string;
    stale: boolean;
    fetchedAt: string;
  }[];
};

export function parseEcosystem(value: string | undefined): Ecosystem {
  if (value === "gh") return "github";
  if (value && (ECOSYSTEMS as string[]).includes(value)) return value as Ecosystem;
  throw new UsageError(`list needs an ecosystem, one of ${ECOSYSTEMS.join(", ")}`);
}

export function listPayload(ecosystem: Ecosystem): ListPayload {
  const config = loadConfig();
  const state = deriveState(config);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: state.generatedAt,
    ecosystem,
    targets: state.targets
      .filter((t) => t.ecosystem === ecosystem)
      .map((t) => {
        const metric = HEADLINE_METRIC[t.ecosystem];
        const delta = t.deltas ? (t.deltas[metric] ?? null) : null;
        return {
          id: t.id,
          name: t.name,
          discovered: t.discovered,
          summary: `${metric} ${t.metrics[metric] ?? "-"}, ${formatDelta(delta)}${since(t.deltaBaselineAt)}`,
          stale: t.stale,
          fetchedAt: t.fetchedAt,
        };
      }),
  };
}

export function listTable(payload: ListPayload): string {
  if (payload.targets.length === 0) {
    return `no ${payload.ecosystem} targets in the store, run "qplex refresh --only ${payload.ecosystem}"`;
  }
  return table(
    payload.targets.map((t) => [
      t.stale ? "!" : " ",
      t.name,
      t.summary,
      t.discovered,
      relativeAge(t.fetchedAt),
    ]),
    ["left", "left", "left", "left", "right"],
  );
}
