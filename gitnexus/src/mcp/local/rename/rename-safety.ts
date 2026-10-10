import type Parser from 'tree-sitter';
import { SupportedLanguages, type Range, type TypeRef } from 'gitnexus-shared';

/** Providers currently expose written names, not canonical identifier identities. */
export function unsupportedIdentifierSpelling(name: string, language: SupportedLanguages): boolean {
  return (
    name.includes('\\') ||
    name.startsWith('@') ||
    name.startsWith('r#') ||
    name.startsWith('`') ||
    (language === SupportedLanguages.Python && name.normalize('NFKC') !== name)
  );
}

export function hasUnsupportedIdentifiers(
  root: Parser.SyntaxNode,
  language: SupportedLanguages,
): boolean {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type.includes('comment')) continue;
    // Escaped identifiers can have named escape children and therefore never
    // enter the planner's leaf-token audit. Inspect the identifier itself.
    if (node.type.includes('identifier') && unsupportedIdentifierSpelling(node.text, language))
      return true;
    pending.push(...node.namedChildren);
  }
  return false;
}

export function inDynamicWithScope(token: Parser.SyntaxNode): boolean {
  for (let node = token.parent; node; node = node.parent) {
    if (node.type === 'with_statement') return true;
  }
  return false;
}

export function jsxTagRole(token: Parser.SyntaxNode): 'intrinsic' | 'component' | undefined {
  const parent = token.parent;
  if (
    parent &&
    ['jsx_opening_element', 'jsx_closing_element', 'jsx_self_closing_element'].includes(
      parent.type,
    ) &&
    parent.childForFieldName('name')?.id === token.id
  )
    return /^[a-z]/.test(token.text) ? 'intrinsic' : 'component';
  return undefined;
}

export function hasPythonMangledNames(className: Parser.SyntaxNode): boolean {
  const declaration = className.parent;
  if (declaration?.type !== 'class_definition') return false;
  const pending = [...declaration.namedChildren];
  const isPrivate = (name: string) => name.startsWith('__') && !name.endsWith('__');
  while (pending.length) {
    const node = pending.pop()!;
    // A nested class body establishes its own mangling context. Its name and
    // base expressions are still evaluated in the containing class.
    if (node.type === 'class_definition') {
      if (isPrivate(node.childForFieldName('name')?.text ?? '')) return true;
      const body = node.childForFieldName('body');
      pending.push(...node.namedChildren.filter((child) => child.id !== body?.id));
      continue;
    }
    if (node.type === 'identifier' && isPrivate(node.text)) return true;
    if (
      node.type === 'identifier' &&
      node.text === '__slots__' &&
      bindsInPythonClassBody(node, declaration)
    )
      return true;
    pending.push(...node.namedChildren);
  }
  return false;
}

function bindsInPythonClassBody(token: Parser.SyntaxNode, declaration: Parser.SyntaxNode): boolean {
  for (let node = token.parent; node && node.id !== declaration.id; node = node.parent) {
    if (node.type !== 'function_definition' && node.type !== 'lambda') continue;
    // Function bodies and parameter binders do not populate the class dictionary;
    // default values and annotations still evaluate in the enclosing context.
    const body = node.childForFieldName('body');
    if (body && within(token, body)) return false;
    const parameters = node.childForFieldName('parameters');
    if (parameters && within(token, parameters)) {
      let parameter = token;
      while (parameter.parent && parameter.parent.id !== parameters.id)
        parameter = parameter.parent;
      const value = parameter.childForFieldName('value');
      const annotation = parameter.childForFieldName('type');
      if (!(value && within(token, value)) && !(annotation && within(token, annotation)))
        return false;
    }
  }
  return true;
}

function within(node: Parser.SyntaxNode, container: Parser.SyntaxNode): boolean {
  return node.startIndex >= container.startIndex && node.endIndex <= container.endIndex;
}

/** Syntactic writes only: their reaching value is deliberately not inferred. */
export function isReceiverWrite(token: Parser.SyntaxNode): boolean {
  for (let node = token.parent; node; node = node.parent) {
    // A property write does not rebind the object used to reach that property.
    if (['member_expression', 'attribute', 'field_expression'].includes(node.type)) return false;
    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name');
      return !!name && within(token, name) && node.childForFieldName('value') !== null;
    }
    if (node.type.includes('assignment') || node.type === 'for_in_statement') {
      const left = node.childForFieldName('left');
      if (left && within(token, left)) return true;
    }
    if (node.type === 'update_expression') return true;
    if (node.type.includes('statement') || node.type.includes('declaration')) return false;
  }
  return false;
}

/** Block-local provider claims cannot separate redeclarations of one hoisted var. */
export function sameHoistedVarBinding(
  token: Parser.SyntaxNode,
  initialConstructor: Parser.SyntaxNode,
): boolean {
  const writeScope = hoistedVarScope(token.parent);
  return (
    writeScope !== undefined &&
    writeScope.id === hoistedVarScope(initialConstructor.parent?.parent)?.id
  );
}

function hoistedVarScope(
  declaration: Parser.SyntaxNode | null | undefined,
): Parser.SyntaxNode | undefined {
  while (declaration && declaration.type !== 'variable_declarator') {
    if (declaration.type.includes('statement') || declaration.type.includes('declaration'))
      return undefined;
    declaration = declaration.parent;
  }
  if (
    declaration?.type !== 'variable_declarator' ||
    !declaration.parent?.children.some((child) => child.type === 'var')
  )
    return undefined;
  for (let node: Parser.SyntaxNode | null = declaration.parent; node; node = node.parent) {
    if (
      [
        'program',
        'function_declaration',
        'function_expression',
        'arrow_function',
        'generator_function_declaration',
        'generator_function',
        'method_definition',
        'class_static_block',
      ].includes(node.type)
    )
      return node;
  }
  return undefined;
}

/** TS structural annotations and merged type summaries are not receiver identity. */
export function constructorForReceiver(
  root: Parser.SyntaxNode,
  name: string,
  type: TypeRef,
): Parser.SyntaxNode | undefined {
  if (!type.bindingRange) return undefined;
  const range = type.bindingRange;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    const start = node.startPosition;
    const end = node.endPosition;
    if (
      start.row + 1 > range.startLine ||
      (start.row + 1 === range.startLine && start.column > range.startCol) ||
      end.row + 1 < range.endLine ||
      (end.row + 1 === range.endLine && end.column < range.endCol)
    )
      continue;
    if (node.type === 'variable_declarator' && sameRange(node, range)) {
      const value = node.childForFieldName('value');
      if (node.childForFieldName('name')?.text === name && value?.type === 'new_expression')
        return value.childForFieldName('constructor') ?? undefined;
      return undefined;
    }
    pending.push(...node.namedChildren);
  }
  return undefined;
}

function sameRange(node: Parser.SyntaxNode, range: Range): boolean {
  return (
    node.startPosition.row + 1 === range.startLine &&
    node.startPosition.column === range.startCol &&
    node.endPosition.row + 1 === range.endLine &&
    node.endPosition.column === range.endCol
  );
}
