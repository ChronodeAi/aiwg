// Parse research-query CLI options.
import type { ResearchQueryOptions } from './query-cli.js';
import type { GraphType } from '../artifacts/types.js';

export function usage(): string {
  return [
    "Usage: aiwg research-query <question> [--backend fortemi-core|local] [--graph <name>]",
    "                           [--depth quick|thorough] [--sources-only] [--max-sources N]",
    "                           [--include-diagnostics] [--json] [--save]",
  ].join("\n");
}

function flagValue(
  args: string[],
  flag: string,
  errorMessage: string,
): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(errorMessage);
  }
  return value;
}

function positiveIntegerFlag(
  args: string[],
  flag: string,
  defaultValue: number,
  errorMessage: string,
): number {
  const value = flagValue(args, flag, errorMessage);
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(errorMessage);
  }
  return parsed;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function stripFlags(args: string[]): string[] {
  const valueFlags = new Set([
    "--backend",
    "--graph",
    "--depth",
    "--max-sources",
  ]);
  const bareFlags = new Set([
    "--sources-only",
    "--include-diagnostics",
    "--json",
    "--save",
  ]);
  const question: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (valueFlags.has(arg)) {
      index++;
      continue;
    }
    if (bareFlags.has(arg)) continue;
    question.push(arg);
  }
  return question;
}

export function parseArgs(args: string[]): ResearchQueryOptions {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(usage());
    process.exit(0);
  }

  const backend = flagValue(
    args,
    "--backend",
    "--backend must be local or fortemi-core",
  ) as ResearchQueryOptions["backend"];
  if (backend && backend !== "local" && backend !== "fortemi-core") {
    throw new Error("--backend must be local or fortemi-core");
  }

  const depth = (flagValue(
    args,
    "--depth",
    "--depth must be quick or thorough",
  ) ?? "thorough") as ResearchQueryOptions["depth"];
  if (depth !== "quick" && depth !== "thorough") {
    throw new Error("--depth must be quick or thorough");
  }

  const maxSources = positiveIntegerFlag(
    args,
    "--max-sources",
    10,
    "--max-sources must be a positive integer",
  );

  const question = stripFlags(args).join(" ").trim();
  if (!question) throw new Error("question is required");

  return {
    question,
    backend: backend ?? "fortemi-core",
    graph: (flagValue(args, "--graph", "--graph requires a graph name") ??
      "project") as GraphType,
    depth,
    maxSources,
    sourcesOnly: hasFlag(args, "--sources-only"),
    includeDiagnostics: hasFlag(args, "--include-diagnostics"),
    json: hasFlag(args, "--json"),
    save: hasFlag(args, "--save"),
  };
}

