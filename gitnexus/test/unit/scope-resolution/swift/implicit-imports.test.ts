/**
 * Intra-group implicit IMPORTS. @_exported is client-facing
 * (`resolveSwiftImportTarget`); siblings in the exporting target
 * must not gain edges to the reexported module.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, ParsedImport, ScopeId } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { generateId } from '../../../../src/lib/utils.js';
import {
  emitSwiftImplicitImportEdges,
  MAX_SWIFT_IMPLICIT_IMPORT_EDGES,
} from '../../../../src/core/ingestion/languages/swift/implicit-imports.js';
import { _captureLogger } from '../../../../src/core/logger.js';
import { resolveSwiftImportTarget } from '../../../../src/core/ingestion/languages/swift/import-target.js';

const DECLARED = {
  origin: 'package.swift' as const,
  targets: new Map([
    ['A', 'Sources/A'],
    ['B', 'Sources/B'],
  ]),
};

function stubFile(filePath: string, parsedImports: ParsedImport[] = []): ParsedFile {
  return {
    filePath,
    moduleScope: `module:${filePath}` as ScopeId,
    scopes: [],
    parsedImports,
    localDefs: [],
    referenceSites: [],
  };
}

function reexport(targetRaw: string): ParsedImport {
  return { kind: 'reexport', localName: targetRaw, importedName: targetRaw, targetRaw };
}

function ns(targetRaw: string): ParsedImport {
  return { kind: 'namespace', localName: targetRaw, importedName: targetRaw, targetRaw };
}

function importPair(rels: readonly { sourceId: string; targetId: string; type: string }[]) {
  return rels
    .filter((rel) => rel.type === 'IMPORTS')
    .map((rel) => `${rel.sourceId}->${rel.targetId}`)
    .sort();
}

describe('emitSwiftImplicitImportEdges', () => {
  it('does not paint sibling files into a @_exported module', () => {
    const a = 'Sources/A/A.swift';
    const other = 'Sources/A/Other.swift';
    const b = 'Sources/B/B.swift';
    const parsed = [stubFile(a, [reexport('B')]), stubFile(other), stubFile(b)];
    const graph = createKnowledgeGraph();

    emitSwiftImplicitImportEdges(graph, parsed, new Map(), DECLARED);

    const pairs = importPair(graph.relationships);
    expect(pairs).toEqual(
      [
        `${generateId('File', a)}->${generateId('File', other)}`,
        `${generateId('File', other)}->${generateId('File', a)}`,
      ].sort(),
    );
    expect(pairs.some((pair) => pair.includes(generateId('File', b)))).toBe(false);

    const fromApp = resolveSwiftImportTarget(ns('A'), {
      fromFile: 'Sources/App/main.swift',
      allFilePaths: new Set([a, other, b, 'Sources/App/main.swift']),
      resolutionConfig: DECLARED,
      parsedFiles: parsed,
    });
    expect(fromApp).toEqual(expect.arrayContaining([a, other, b]));
  });
});

describe('emitSwiftImplicitImportEdges — total edge budget (#3355)', () => {
  const files = (dir: string, n: number): ParsedFile[] =>
    Array.from({ length: n }, (_, i) => stubFile(`${dir}/F${i}.swift`));
  const importCount = (graph: ReturnType<typeof createKnowledgeGraph>): number =>
    graph.relationships.filter((rel) => rel.type === 'IMPORTS').length;

  it('stays under a quarter of the V8 Map limit by default', () => {
    expect(MAX_SWIFT_IMPLICIT_IMPORT_EDGES).toBeLessThanOrEqual(2 ** 24 / 4);
  });

  it('emits every pair of a module that fits the budget', () => {
    const graph = createKnowledgeGraph();
    emitSwiftImplicitImportEdges(graph, files('Sources/A', 4), new Map(), DECLARED, 12);
    expect(importCount(graph)).toBe(12);
  });

  it('skips a module over the budget and names it in a warning', () => {
    const graph = createKnowledgeGraph();
    const cap = _captureLogger();
    try {
      emitSwiftImplicitImportEdges(graph, files('App', 5), new Map(), null, 12);
      expect(importCount(graph)).toBe(0);
      expect(cap.text()).toContain('module __default__ (5 files');
    } finally {
      cap.restore();
    }
  });

  it('bounds the total across modules, filling smallest modules first', () => {
    const config = {
      origin: 'directories' as const,
      targets: new Map([
        ['A', 'Sources/A'],
        ['B', 'Sources/B'],
        ['C', 'Sources/C'],
      ]),
    };
    const parsed = [...files('Sources/A', 3), ...files('Sources/B', 3), ...files('Sources/C', 2)];
    const graph = createKnowledgeGraph();
    const cap = _captureLogger();
    try {
      // 6 + 2 fit a budget of 12; the second 3-file module (6 more) does not.
      emitSwiftImplicitImportEdges(graph, parsed, new Map(), config, 12);
      expect(importCount(graph)).toBe(8);
      expect(cap.text()).toContain('module B (3 files');
      expect(cap.text()).not.toContain('module A (');
    } finally {
      cap.restore();
    }
  });
});
