/**
 * Xcode target membership from `project.pbxproj` (#3355).
 *
 * Each Xcode native target compiles to its own Swift module, so its source
 * files see each other's `internal` declarations and nothing else without an
 * `import`. Without this, every Swift file outside a SwiftPM target falls into
 * one `__default__` module that merges the app, its extensions, and its test
 * bundles.
 *
 * `project.pbxproj` is an old-style (OpenStep) property list. Membership comes
 * from two places:
 *   - classic groups: PBXNativeTarget → PBXSourcesBuildPhase → PBXBuildFile →
 *     PBXFileReference, with each reference's path resolved through its
 *     parent PBXGroup chain;
 *   - Xcode 16 synchronized folders: a target lists
 *     PBXFileSystemSynchronizedRootGroup folders whose files all belong to it,
 *     minus the paths in PBXFileSystemSynchronizedBuildFileExceptionSet
 *     `membershipExceptions` for that target.
 *
 * Only `<group>` and `SOURCE_ROOT` paths are resolved. SDK, build-product, and
 * absolute references point outside the repo and are skipped. Paths that
 * escape the repo are dropped. The module name is the target name; a custom
 * `PRODUCT_MODULE_NAME` build setting is not read.
 */

import { normalizeZigDepPath } from '../../language-config.js';

type PlistValue = string | PlistValue[] | { [key: string]: PlistValue };
type PlistDict = { [key: string]: PlistValue };

export interface XcodeTargetMembership {
  readonly name: string;
  /** Repo-relative `.swift` files listed in the target's sources phase. */
  readonly files: string[];
  /** Repo-relative synchronized folders; every file below is a member. */
  readonly folders: string[];
  /** Repo-relative files excluded from this target's synchronized folders. */
  readonly excluded: string[];
}

export interface XcodeProjectParse {
  readonly targets: XcodeTargetMembership[];
  /** False when the file could not be parsed as a property list. */
  readonly complete: boolean;
}

/**
 * Parse `source` (the text of `<projectDir>/<Name>.xcodeproj/project.pbxproj`)
 * into target membership. `projectDir` is the repo-relative directory holding
 * the `.xcodeproj` bundle ('' for the repo root).
 */
export function parseXcodeProject(source: string, projectDir: string): XcodeProjectParse {
  let root: PlistValue;
  try {
    root = new PlistParser(source).parseDocument();
  } catch {
    return { targets: [], complete: false };
  }
  if (!isDict(root)) return { targets: [], complete: false };
  const objects = root.objects;
  const rootId = root.rootObject;
  if (!isDict(objects) || typeof rootId !== 'string') return { targets: [], complete: false };
  const project = objects[rootId];
  if (!isDict(project)) return { targets: [], complete: false };

  const obj = (id: PlistValue | undefined): PlistDict | undefined =>
    typeof id === 'string' && isDict(objects[id]) ? (objects[id] as PlistDict) : undefined;

  const base =
    typeof project.projectDirPath === 'string' && project.projectDirPath !== ''
      ? `${projectDir}/${project.projectDirPath}`
      : projectDir;
  const sourceRoot = normalizeZigDepPath(base);

  // Resolve every group/file path by walking down from the main group.
  const pathById = new Map<string, string>();
  const visit = (id: string, parentPath: string | null): void => {
    const node = obj(id);
    if (node === undefined || pathById.has(id)) return;
    const own = resolveReferencePath(node, parentPath, sourceRoot);
    if (own !== null) pathById.set(id, own);
    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === 'string') visit(child, own);
      }
    }
  };
  if (typeof project.mainGroup === 'string') visit(project.mainGroup, sourceRoot);

  const targets: XcodeTargetMembership[] = [];
  const targetIds = Array.isArray(project.targets) ? project.targets : [];
  const targetNameById = new Map<string, string>();
  for (const targetId of targetIds) {
    const target = obj(targetId);
    if (target?.isa === 'PBXNativeTarget' && typeof target.name === 'string') {
      targetNameById.set(targetId as string, target.name);
    }
  }

  for (const [targetId, name] of targetNameById) {
    const target = obj(targetId)!;
    const files: string[] = [];
    for (const phaseId of asArray(target.buildPhases)) {
      const phase = obj(phaseId);
      if (phase?.isa !== 'PBXSourcesBuildPhase') continue;
      for (const buildFileId of asArray(phase.files)) {
        const fileRef = obj(buildFileId)?.fileRef;
        const filePath = typeof fileRef === 'string' ? pathById.get(fileRef) : undefined;
        if (filePath !== undefined && filePath.endsWith('.swift')) files.push(filePath);
      }
    }

    const folders: string[] = [];
    const excluded: string[] = [];
    for (const groupId of asArray(target.fileSystemSynchronizedGroups)) {
      const folder = typeof groupId === 'string' ? pathById.get(groupId) : undefined;
      if (folder === undefined) continue;
      folders.push(folder);
      for (const exceptionId of asArray(obj(groupId)?.exceptions)) {
        const exception = obj(exceptionId);
        if (exception?.target !== targetId) continue;
        for (const rel of asArray(exception.membershipExceptions)) {
          if (typeof rel !== 'string') continue;
          const joined = normalizeZigDepPath(folder === '' ? rel : `${folder}/${rel}`);
          if (joined !== null && joined !== '') excluded.push(joined);
        }
      }
    }

    targets.push({ name, files, folders, excluded });
  }

  return { targets, complete: true };
}

/**
 * Repo-relative path of a group or file reference, or null when it does not
 * live in the repo. A group with no `path` inherits its parent's path.
 */
function resolveReferencePath(
  node: PlistDict,
  parentPath: string | null,
  sourceRoot: string | null,
): string | null {
  const own = typeof node.path === 'string' ? node.path : undefined;
  const tree = typeof node.sourceTree === 'string' ? node.sourceTree : '<group>';
  let anchor: string | null;
  if (tree === '<group>') anchor = parentPath;
  else if (tree === 'SOURCE_ROOT') anchor = sourceRoot;
  else return null;
  if (anchor === null) return null;
  if (own === undefined) return anchor;
  return normalizeZigDepPath(anchor === '' ? own : `${anchor}/${own}`);
}

function isDict(v: PlistValue | undefined): v is PlistDict {
  return v !== undefined && typeof v === 'object' && !Array.isArray(v);
}

function asArray(v: PlistValue | undefined): readonly PlistValue[] {
  return Array.isArray(v) ? v : [];
}

/** Minimal OpenStep property-list parser: dicts, arrays, strings. */
class PlistParser {
  private i = 0;

  constructor(private readonly src: string) {}

  parseDocument(): PlistValue {
    const value = this.parseValue();
    this.skipTrivia();
    if (this.i < this.src.length) throw new Error('trailing content');
    return value;
  }

  private parseValue(): PlistValue {
    this.skipTrivia();
    const ch = this.src[this.i];
    if (ch === '{') return this.parseDict();
    if (ch === '(') return this.parseArray();
    if (ch === '"') return this.parseQuoted();
    return this.parseBare();
  }

  private parseDict(): PlistDict {
    this.i++; // {
    const out: PlistDict = Object.create(null) as PlistDict;
    for (;;) {
      this.skipTrivia();
      if (this.src[this.i] === '}') {
        this.i++;
        return out;
      }
      const key = this.src[this.i] === '"' ? this.parseQuoted() : this.parseBare();
      this.expect('=');
      out[key] = this.parseValue();
      this.expect(';');
    }
  }

  private parseArray(): PlistValue[] {
    this.i++; // (
    const out: PlistValue[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.src[this.i] === ')') {
        this.i++;
        return out;
      }
      out.push(this.parseValue());
      this.skipTrivia();
      if (this.src[this.i] === ',') this.i++;
      else if (this.src[this.i] !== ')') throw new Error(`expected , or ) at ${this.i}`);
    }
  }

  private parseQuoted(): string {
    this.i++; // opening quote
    let out = '';
    while (this.i < this.src.length) {
      const ch = this.src[this.i++];
      if (ch === '"') return out;
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const esc = this.src[this.i++];
      if (esc === 'n') out += '\n';
      else if (esc === 't') out += '\t';
      else if (esc === 'U' || esc === 'u') {
        out += String.fromCharCode(parseInt(this.src.slice(this.i, this.i + 4), 16));
        this.i += 4;
      } else out += esc;
    }
    throw new Error('unterminated string');
  }

  private parseBare(): string {
    const start = this.i;
    while (this.i < this.src.length && !/[\s{}();=,"]/.test(this.src[this.i]!)) this.i++;
    if (this.i === start) throw new Error(`unexpected character at ${this.i}`);
    return this.src.slice(start, this.i);
  }

  private expect(ch: string): void {
    this.skipTrivia();
    if (this.src[this.i] !== ch) throw new Error(`expected ${ch} at ${this.i}`);
    this.i++;
  }

  private skipTrivia(): void {
    for (;;) {
      while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++;
      if (this.src.startsWith('//', this.i)) {
        const nl = this.src.indexOf('\n', this.i);
        this.i = nl === -1 ? this.src.length : nl + 1;
      } else if (this.src.startsWith('/*', this.i)) {
        const close = this.src.indexOf('*/', this.i + 2);
        if (close === -1) throw new Error('unterminated comment');
        this.i = close + 2;
      } else return;
    }
  }
}
