/**
 * Languages that resolve via the scope-resolution pipeline (RFC #909 Ring 3).
 *
 * Kept free of `ScopeResolver` imports so worker threads can gate
 * `ParsedFile` emission without pulling in resolver implementations.
 * Keep in sync with `SCOPE_RESOLVERS` in `registry.ts`.
 */

import { SupportedLanguages } from 'gitnexus-shared';

export const SCOPE_RESOLUTION_LANGUAGES: ReadonlySet<SupportedLanguages> = new Set([
  SupportedLanguages.Python,
  SupportedLanguages.CSharp,
  SupportedLanguages.TypeScript,
  SupportedLanguages.Go,
  SupportedLanguages.Java,
  SupportedLanguages.C,
  SupportedLanguages.CPlusPlus,
  SupportedLanguages.PHP,
  SupportedLanguages.Rust,
  SupportedLanguages.JavaScript,
  SupportedLanguages.Kotlin,
  SupportedLanguages.Ruby,
  SupportedLanguages.Cobol,
  SupportedLanguages.Swift,
  SupportedLanguages.Dart,
  SupportedLanguages.Vue,
]);

export const isScopeResolutionLanguage = (
  lang: SupportedLanguages | null,
): lang is SupportedLanguages => lang !== null && SCOPE_RESOLUTION_LANGUAGES.has(lang);
