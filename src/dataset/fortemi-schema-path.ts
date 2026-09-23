import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a pinned external contract file shipped under `schemas/`.
 * Source and built installations sit at different depths, so walk up to the
 * package root instead of assuming a relative offset.
 */
export function fortemiPinnedSchemaPath(relativePath: string): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: string };
      if (metadata.name === "aiwg" || metadata.name === "@aiwg/cli") return join(directory, relativePath);
    } catch { /* Not the package root; keep walking. */ }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("FORTEMI_PINNED_SCHEMA_UNAVAILABLE");
    directory = parent;
  }
}
