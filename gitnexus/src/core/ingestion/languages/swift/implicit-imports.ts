/**
 * Swift same-module implicit IMPORTS-edge emission for the
 * `emitImplicitImportEdges` hook.
 *
 * Swift gives every file in a module (an SPM target) visibility of every
 * other file's top-level declarations WITHOUT any `import` statement
 * (whole-module visibility). The legacy DAG models this with File→File
 * IMPORTS edges via `wireSwiftImplicitImports`; under registry-primary
 * that wirer's `addImportEdge` is gated off, and the scope-resolution
 * import pipeline (`emitImportEdges`) only materializes edges from
 * finalized `ImportEdge`s — of which there are none here, because there
 * is no syntactic `import`. This hook emits the missing edges directly.
 *
 * Module identity: Swift has no in-source `package X` marker. Module
 * membership is the SPM target *subtree* (`Sources/<Target>/…`), threaded
 * in via the SPM target map (`resolutionConfig` → `coerceSwiftTargets`)
 * and grouped by `groupSwiftFilesBySpmTarget`. The helper preserves the
 * legacy `groupSwiftFilesByTarget` bucketing contract for ordinary layouts
 * while intentionally fixing #2931's repeated-prefix edge case. With no
 * target map (no Package.swift and no scanned `Sources/*`) the map is null
 * and all files form one `__default__` module (single-Xcode-project
 * assumption). An inferred folder map must keep sibling folders isolated.
 * Every pair of distinct `.swift`
 * files in the same module gets a directed IMPORTS edge in both directions
 * (whole-module visibility is symmetric).
 *
 * That is n·(n−1) edges per module, and the graph keeps every relationship in
 * one Map capped by V8 at 2^24 entries (#3355). Emission is therefore bounded
 * by a total budget across all modules, filled smallest module first; a module
 * that does not fit gets no implicit edges and a warning.
 *
 * Node identity + edge construction mirror the generic `emitImportEdges`
 * convention (`graph-bridge/imports-to-edges.ts`): `generateId('File', path)`
 * for endpoints and `generateId('IMPORTS', key)` for the relationship id,
 * deduped by `(sourceFile -> targetFile)`. Re-invocation idempotency comes
 * from `graph.addRelationship` id-dedup (the same `IMPORTS` id is produced
 * for a given ordered pair), so no local `seen` set is needed.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { generateId } from '../../../../lib/utils.js';
import { logger } from '../../../logger.js';
import { coerceSwiftTargets, groupSwiftFilesBySpmTarget } from './target-grouping.js';

/** Total implicit IMPORTS edges per call: a quarter of V8's 2^24 Map limit. */
export const MAX_SWIFT_IMPLICIT_IMPORT_EDGES = 4_000_000;

export function emitSwiftImplicitImportEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  _nodeLookup: GraphNodeLookup,
  resolutionConfig?: unknown,
  edgeBudget = MAX_SWIFT_IMPLICIT_IMPORT_EDGES,
): void {
  const targets = coerceSwiftTargets(resolutionConfig);
  const filesByTarget = groupSwiftFilesBySpmTarget(
    parsedFiles,
    (parsed) => parsed.filePath,
    targets,
  );

  // Smallest first so the budget covers as many modules as possible.
  const modules = [...filesByTarget].sort(
    ([a, x], [b, y]) => x.length - y.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  let remaining = edgeBudget;
  for (const [moduleKey, group] of modules) {
    if (group.length < 2) continue;
    const pairs = group.length * (group.length - 1);
    if (pairs > remaining) {
      logger.warn(
        `[swift] skipping implicit imports for module ${moduleKey} (${group.length} files, ${pairs} edges): over the remaining budget of ${remaining} of ${edgeBudget}`,
      );
      continue;
    }
    remaining -= pairs;
    for (const source of group) {
      for (const dest of group) {
        if (source.filePath === dest.filePath) continue;
        const dedupKey = `${source.filePath}->${dest.filePath}`;
        graph.addRelationship({
          id: generateId('IMPORTS', dedupKey),
          sourceId: generateId('File', source.filePath),
          targetId: generateId('File', dest.filePath),
          type: 'IMPORTS',
          confidence: 1.0,
          reason: 'swift-scope: implicit module visibility',
        });
      }
    }
  }
}
