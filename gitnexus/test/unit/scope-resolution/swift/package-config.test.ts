/**
 * Package.swift target loading (PR 3105 / #2964).
 *
 * `loadSwiftPackageConfig` must distinguish a declaration map
 * (`origin: 'package.swift'`) from an inferred `Sources/*` folder map
 * (`origin: 'directories'`). Grouping uses either; explicit import
 * resolve uses only the declared origin.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSwiftPackageConfig,
  loadSwiftWorkspaceConfig,
  parseSwiftPackageManifest,
  swiftDeclaredTargetPrefix,
} from '../../../../src/core/ingestion/language-config.js';
import {
  coerceDeclaredSwiftTargets,
  coerceSwiftTargets,
  groupSwiftFilesBySpmTarget,
} from '../../../../src/core/ingestion/languages/swift/target-grouping.js';
import { _captureLogger } from '../../../../src/core/logger.js';

const roots: string[] = [];

function repo(files: Readonly<Record<string, string | null>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-swift-pkg-'));
  roots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (contents === null) {
      fs.mkdirSync(full, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const MODELS_APP = `
let package = Package(
    name: "Demo",
    targets: [
        .target(name: "Models"),
        .target(name: "App"),
    ]
)
`;

describe('parseSwiftPackageManifest', () => {
  it('maps .target(name:) with no path to Sources/<name>', () => {
    const parsed = parseSwiftPackageManifest(MODELS_APP);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
    expect(parsed.targets.get('App')).toBe('Sources/App');
  });

  it('honors an explicit path:', () => {
    const src = `
      .target(name: "Core", path: "Modules/Core")
    `;
    const parsed = parseSwiftPackageManifest(src);
    expect({ complete: parsed.complete, entries: [...parsed.targets] }).toEqual({
      complete: true,
      entries: [['Core', 'Modules/Core']],
    });
  });

  it('maps .testTarget to Tests/<name>', () => {
    const parsed = parseSwiftPackageManifest(`.testTarget(name: "AppTests")`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('AppTests')).toBe('Tests/AppTests');
  });

  it('skips binary / plugin / systemLibrary targets', () => {
    const parsed = parseSwiftPackageManifest(`
      .binaryTarget(name: "Lib", path: "Lib.xcframework")
      .plugin(name: "Gen")
      .systemLibrary(name: "CFoo")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.size).toBe(0);
  });

  it('treats #if as a completeness hazard', () => {
    const parsed = parseSwiftPackageManifest(`
#if os(macOS)
    .target(name: "MacOnly")
#endif
    .target(name: "Models")
`);
    expect(parsed.complete).toBe(false);
  });

  it('treats a helper-built targets: list as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(name: "Demo", targets: makeTargets())
`);
    expect(parsed.complete).toBe(false);
  });

  it('treats a computed name: as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: targetName)`);
    expect(parsed.complete).toBe(false);
  });

  it('treats a computed path: as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "Core", path: corePath)`);
    expect(parsed.complete).toBe(false);
  });

  it('ignores a block-commented factory', () => {
    const parsed = parseSwiftPackageManifest(`
      /* .target(name: "Ghost") */
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('records path: "." as the package root', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "Lib", path: ".")`);
    expect({ complete: parsed.complete, entries: [...parsed.targets] }).toEqual({
      complete: true,
      entries: [['Lib', '.']],
    });
  });

  it('ignores a // commented factory', () => {
    const parsed = parseSwiftPackageManifest(`
      // .target(name: "Ghost")
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('does not treat a dependency .target(name:) as a declared target', () => {
    const parsed = parseSwiftPackageManifest(`
      .target(name: "App", dependencies: [.target(name: "Core")])
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('App')).toBe('Sources/App');
    expect(parsed.targets.has('Core')).toBe(false);
  });

  it('prefers an explicit path over an earlier same-name factory', () => {
    const parsed = parseSwiftPackageManifest(`
      .target(name: "Core")
      .target(name: "Core", path: "Modules/Core")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Core')).toBe('Modules/Core');
  });

  it('treats a string-interpolated path as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "Core", path: "Modules/\\(name)")`);
    expect(parsed.complete).toBe(false);
  });

  it('treats a parenthesized name string as a complete factory', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "Foo (experimental)")`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Foo (experimental)')).toBe('Sources/Foo (experimental)');
  });

  it('ignores a commented parenthesis while balancing a factory', () => {
    const parsed = parseSwiftPackageManifest(`
      .target(name: "Core", // )
       path: "Modules/Core")
    `);
    expect({ complete: parsed.complete, entries: [...parsed.targets] }).toEqual({
      complete: true,
      entries: [['Core', 'Modules/Core']],
    });
  });

  it('ignores a block-comment parenthesis while balancing a factory', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "Core", /* ) */ path: "Modules/Core")`);
    expect({ complete: parsed.complete, entries: [...parsed.targets] }).toEqual({
      complete: true,
      entries: [['Core', 'Modules/Core']],
    });
  });

  it('treats a mixed literal + helper-built targets: list as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(name: "Demo", targets: [.target(name: "Core")] + makeTargets())
`);
    expect(parsed.complete).toBe(false);
  });

  it('treats a helper-built list concatenated before literals as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(name: "Demo", targets: makeTargets() + [.target(name: "Core")])
`);
    expect(parsed.complete).toBe(false);
  });

  it('does not treat .library(..., targets: names) as a helper-built list', () => {
    const parsed = parseSwiftPackageManifest(`
      .library(name: "Demo", targets: libTargets)
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('ignores a factory-like spelling inside a string literal', () => {
    const parsed = parseSwiftPackageManifest(`
      let example = ".target(name: 'Ghost')"
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('treats a variable-prefix targets: concatenation as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(name: "Demo", targets: extraTargets + [.target(name: "Core")])
`);
    expect(parsed.complete).toBe(false);
  });

  it('skips a commented name: field and uses the real one', () => {
    const parsed = parseSwiftPackageManifest(`.target(/* name: "Ghost" */ name: "Models")`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('does not treat a commented #if as a completeness hazard', () => {
    const parsed = parseSwiftPackageManifest(`
      // #if os(macOS)
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('does not treat a block-commented #if as a completeness hazard', () => {
    const parsed = parseSwiftPackageManifest(`
/*
#if os(macOS)
    .target(name: "MacOnly")
#endif
*/
      .target(name: "Models")
    `);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('MacOnly')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('rejects a name string with a Swift escape', () => {
    const parsed = parseSwiftPackageManifest(`.target(name: "\\u{43}ore")`);
    expect(parsed.complete).toBe(false);
    expect(parsed.targets.size).toBe(0);
  });

  it('does not treat https:// on the same line as a commented factory', () => {
    const parsed = parseSwiftPackageManifest(
      'let package = Package(name: "Demo", dependencies: [.package(url: "https://example.com/foo.git", from: "1.0.0")], targets: [.target(name: "T")])',
    );
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('T')).toBe('Sources/T');
  });

  it('ignores a commented helper-built targets: list', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(
    name: "Demo",
    targets: [
        .target(name: "Models"),
    ]
)
// targets: makeTargets()
`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('ignores a helper-built targets: spelling inside a string', () => {
    const parsed = parseSwiftPackageManifest(`
let note = "targets: makeTargets()"
let package = Package(name: "Demo", targets: [.target(name: "Models")])
`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });

  it('treats Package(targets: variable) as incomplete even when a factory was collected', () => {
    const parsed = parseSwiftPackageManifest(`
func unused() { _ = Target.target(name: "Ghost") }
let package = Package(name: "Demo", targets: actualTargets)
.target(name: "Incidental")
`);
    expect(parsed.complete).toBe(false);
    expect(parsed.targets.size).toBe(0);
  });

  it('does not collect a factory outside Package(targets: [...])', () => {
    const parsed = parseSwiftPackageManifest(`
func unused() { _ = Target.target(name: "Ghost") }
let package = Package(name: "Demo", targets: [.target(name: "Incidental")])
`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Incidental')).toBe('Sources/Incidental');
  });

  it('treats a computed element inside the targets: array as incomplete', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(name: "Demo", targets: [makeTargets()])
`);
    expect(parsed.complete).toBe(false);
    expect(parsed.targets.size).toBe(0);
  });

  it('does not collect factories when Package omits targets:', () => {
    const parsed = parseSwiftPackageManifest(`
let unused = Target.target(name: "Ghost")
let package = Package(name: "Empty")
`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.size).toBe(0);
  });

  it('does not treat a line comment after a label colon as live source', () => {
    const parsed = parseSwiftPackageManifest(`
let package = Package(
    name: "Demo",
    targets: [
        .target(name: // .target(name: "Ghost")
            "Models"),
    ]
)
`);
    expect(parsed.complete).toBe(true);
    expect(parsed.targets.has('Ghost')).toBe(false);
    expect(parsed.targets.get('Models')).toBe('Sources/Models');
  });
});

describe('swiftDeclaredTargetPrefix', () => {
  it('treats . and ./ as the package root', () => {
    expect(swiftDeclaredTargetPrefix('.')).toBe('');
    expect(swiftDeclaredTargetPrefix('./')).toBe('');
    expect(swiftDeclaredTargetPrefix('./.')).toBe('');
  });

  it('strips a leading ./ from a relative target path', () => {
    expect(swiftDeclaredTargetPrefix('./Sources/Core')).toBe('Sources/Core/');
    expect(swiftDeclaredTargetPrefix('Sources/Core')).toBe('Sources/Core/');
  });
});

describe('loadSwiftPackageConfig', () => {
  it('returns a declared map from Package.swift and ignores undeclared Sources/* folders', async () => {
    const root = repo({
      'Package.swift': MODELS_APP,
      'Sources/Models/User.swift': '',
      'Sources/App/main.swift': '',
      'Sources/Foundation/Thing.swift': '',
    });

    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('package.swift');
    expect([...cfg!.targets.keys()].sort()).toEqual(['App', 'Models']);
    expect(cfg!.targets.has('Foundation')).toBe(false);
  });

  it('returns an empty declared map when the manifest only has skipped target kinds', async () => {
    const root = repo({
      'Package.swift': `
let package = Package(
    name: "OnlyBinary",
    targets: [.binaryTarget(name: "Lib", path: "Lib.xcframework")]
)
`,
      'Sources/Foundation/Thing.swift': '',
    });

    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('package.swift');
    expect(cfg!.declaredTargets?.size).toBe(0);
    // Grouping still uses inferred folders so App/Foundation stay isolated.
    expect(cfg!.targets.get('Foundation')).toBe('Sources/Foundation');
    expect(coerceDeclaredSwiftTargets(cfg)?.size).toBe(0);
  });

  it('infers Sources/* folders when Package.swift is missing', async () => {
    const root = repo({
      'Sources/App/main.swift': '',
      'Sources/Models/User.swift': '',
    });

    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('directories');
    expect(cfg!.targets.get('App')).toBe('Sources/App');
    expect(cfg!.targets.get('Models')).toBe('Sources/Models');
  });

  it('infers directories when Package.swift is unreadable (is a directory)', async () => {
    const root = repo({
      'Package.swift': null,
      'Sources/App/main.swift': '',
    });

    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('directories');
    expect(cfg!.targets.get('App')).toBe('Sources/App');
  });

  it('infers directories when the manifest has completeness hazards', async () => {
    const root = repo({
      'Package.swift': `
#if os(Linux)
    .target(name: "LinuxOnly")
#endif
`,
      'Sources/App/main.swift': '',
    });

    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('directories');
    expect(cfg!.targets.get('App')).toBe('Sources/App');
    expect(cfg!.targets.has('LinuxOnly')).toBe(false);
  });

  it('returns null when there is no manifest and no source folders', async () => {
    const root = repo({ 'README.md': '' });
    expect(await loadSwiftPackageConfig(root)).toBeNull();
  });

  it('declares a one-line manifest that includes an https:// dependency URL', async () => {
    const root = repo({
      'Package.swift':
        'let package = Package(name: "Demo", dependencies: [.package(url: "https://example.com/foo.git", from: "1.0.0")], targets: [.target(name: "T")])',
      'Sources/T/T.swift': '',
    });
    const cfg = await loadSwiftPackageConfig(root);
    expect(cfg?.origin).toBe('package.swift');
    expect(cfg!.declaredTargets?.get('T')).toBe('Sources/T');
    expect(cfg!.targets.get('T')).toBe('Sources/T');
  });
});

const pkg = (...targets: string[]): string =>
  `let package = Package(name: "P", targets: [${targets.join(', ')}])`;

describe('loadSwiftWorkspaceConfig — nested Package.swift manifests (#3355)', () => {
  it('adds each nested package target keyed by its repo-relative directory', async () => {
    const root = repo({
      'Core/Net/Package.swift': pkg('.target(name: "Net")'),
      'Core/Net/Sources/Net/Client.swift': '',
      'Features/Login/Package.swift': pkg(
        '.target(name: "Login")',
        '.testTarget(name: "LoginTests")',
      ),
      'Features/Login/Sources/Login/View.swift': '',
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect(cfg?.origin).toBe('directories');
    expect([...cfg!.targets.keys()].sort()).toEqual([
      'Core/Net/Sources/Net',
      'Features/Login/Sources/Login',
      'Features/Login/Tests/LoginTests',
    ]);
    expect(coerceDeclaredSwiftTargets(cfg)).toBeNull();
  });

  it('keeps two packages declaring the same target name as two modules', async () => {
    const root = repo({
      'Core/A/Package.swift': pkg('.target(name: "Core")'),
      'Core/B/Package.swift': pkg('.target(name: "Core")'),
    });

    const cfg = await loadSwiftWorkspaceConfig(root);
    const groups = groupSwiftFilesBySpmTarget(
      ['Core/A/Sources/Core/X.swift', 'Core/B/Sources/Core/Y.swift'],
      (p) => p,
      coerceSwiftTargets(cfg),
    );

    expect(groups.get('Core/A/Sources/Core')).toEqual(['Core/A/Sources/Core/X.swift']);
    expect(groups.get('Core/B/Sources/Core')).toEqual(['Core/B/Sources/Core/Y.swift']);
  });

  it('groups a nested file under its own package even when a root target shares the tail', async () => {
    const root = repo({
      'Package.swift': pkg('.target(name: "Core")'),
      'Features/A/Package.swift': pkg('.target(name: "Core")'),
    });

    const cfg = await loadSwiftWorkspaceConfig(root);
    const groups = groupSwiftFilesBySpmTarget(
      ['Sources/Core/Root.swift', 'Features/A/Sources/Core/Nested.swift'],
      (p) => p,
      coerceSwiftTargets(cfg),
    );

    expect(groups.get('Core')).toEqual(['Sources/Core/Root.swift']);
    expect(groups.get('Features/A/Sources/Core')).toEqual(['Features/A/Sources/Core/Nested.swift']);
  });

  it('keeps the root declaration as the only import-resolution map', async () => {
    const root = repo({
      'Package.swift': MODELS_APP,
      'Features/Login/Package.swift': pkg('.target(name: "Login")'),
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect(cfg?.origin).toBe('package.swift');
    expect([...cfg!.declaredTargets!.keys()].sort()).toEqual(['App', 'Models']);
    expect([...coerceDeclaredSwiftTargets(cfg)!.keys()].sort()).toEqual(['App', 'Models']);
    expect([...cfg!.targets.keys()].sort()).toEqual([
      'App',
      'Features/Login/Sources/Login',
      'Models',
    ]);
  });

  it('joins a custom path with the package directory and drops one escaping the repo', async () => {
    const root = repo({
      'Pkgs/Lib/Package.swift': pkg(
        '.target(name: "Lib", path: "Code")',
        '.target(name: "Shared", path: "../Shared")',
        '.target(name: "Outside", path: "../../../Outside")',
        '.target(name: "Root", path: "../..")',
        '.target(name: "Drive", path: "C:/Elsewhere")',
      ),
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect([...cfg!.targets.keys()].sort()).toEqual(['Pkgs/Lib/Code', 'Pkgs/Shared']);
  });

  it('infers Sources/* folders for a nested manifest with a completeness hazard', async () => {
    const root = repo({
      'Core/Hazard/Package.swift': '#if os(Linux)\n.target(name: "L")\n#endif\n',
      'Core/Hazard/Sources/App/main.swift': '',
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect([...cfg!.targets.keys()]).toEqual(['Core/Hazard/Sources/App']);
  });

  it('skips manifests under build output, dependencies, and every Xcode bundle suffix', async () => {
    const root = repo({
      '.build/checkouts/Dep/Package.swift': pkg('.target(name: "Dep")'),
      'node_modules/x/Package.swift': pkg('.target(name: "X")'),
      'App.xcodeproj/Package.swift': pkg('.target(name: "Proj")'),
      'Assets.xcassets/Package.swift': pkg('.target(name: "Assets")'),
      'App.xcworkspace/Package.swift': pkg('.target(name: "Ws")'),
      'en.lproj/Package.swift': pkg('.target(name: "Loc")'),
      'Res.bundle/Package.swift': pkg('.target(name: "Res")'),
      'Core/Real/Package.swift': pkg('.target(name: "Real")'),
    });

    const cfg = await loadSwiftWorkspaceConfig(root);

    expect([...cfg!.targets.keys()]).toEqual(['Core/Real/Sources/Real']);
  });

  it('warns and keeps shallower packages when the walk passes the depth cap', async () => {
    const deep = Array.from({ length: 26 }, (_, i) => `d${i}`).join('/');
    const root = repo({
      'Core/Shallow/Package.swift': pkg('.target(name: "Shallow")'),
      [`${deep}/Package.swift`]: pkg('.target(name: "Deep")'),
    });

    const cap = _captureLogger();
    try {
      const cfg = await loadSwiftWorkspaceConfig(root);
      expect([...cfg!.targets.keys()]).toEqual(['Core/Shallow/Sources/Shallow']);
      expect(cap.text()).toContain('Package.swift scan');
    } finally {
      cap.restore();
    }
  });

  it('returns the root config unchanged when no nested package exists', async () => {
    const root = repo({ 'Sources/App/main.swift': '' });
    expect(await loadSwiftWorkspaceConfig(root)).toEqual(await loadSwiftPackageConfig(root));
  });

  it('returns null with no manifest and no source folders anywhere', async () => {
    const root = repo({ 'README.md': '' });
    expect(await loadSwiftWorkspaceConfig(root)).toBeNull();
  });
});
