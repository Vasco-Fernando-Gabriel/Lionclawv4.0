import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild, findChildren } from "./base-extractor.js";

const TYPE_DEFINITION_KINDS = new Set([
  "class_definition",
  "trait_definition",
  "object_definition",
  "package_object",
  "enum_definition",
]);

const FUNCTION_DEFINITION_KINDS = new Set([
  "function_definition",
  "function_declaration",
]);

const FIELD_DEFINITION_KINDS = new Set([
  "val_definition",
  "var_definition",
  "val_declaration",
  "var_declaration",
]);

function extractAccessModifier(declNode: TreeSitterNode): string | null {
  const modifiers = findChild(declNode, "modifiers");
  if (!modifiers) return null;
  const access = findChild(modifiers, "access_modifier");
  if (!access) return null;
  return access.text;
}

function isExported(declNode: TreeSitterNode): boolean {
  const access = extractAccessModifier(declNode);
  return access === null || !access.startsWith("private");
}

function extractDeclarationName(declNode: TreeSitterNode): string | null {
  for (let i = 0; i < declNode.childCount; i++) {
    const child = declNode.child(i);
    if (child && child.type === "identifier") return child.text;
  }
  return null;
}

function extractParams(declNode: TreeSitterNode): string[] {
  const params: string[] = [];
  for (const paramList of findChildren(declNode, "parameters")) {
    for (const param of findChildren(paramList, "parameter")) {
      const id = findChild(param, "identifier");
      if (id) params.push(id.text);
    }
  }
  return params;
}

function extractReturnType(declNode: TreeSitterNode): string | undefined {
  for (let i = 0; i < declNode.childCount; i++) {
    const child = declNode.child(i);
    if (!child || child.type !== ":") continue;
    for (let j = i + 1; j < declNode.childCount; j++) {
      const next = declNode.child(j);
      if (next && next.isNamed) return next.text;
    }
  }
  return undefined;
}

function isCaseDefinition(declNode: TreeSitterNode): boolean {
  for (let i = 0; i < declNode.childCount; i++) {
    const child = declNode.child(i);
    if (child && child.type === "case") return true;
    if (child && child.type === "identifier") break;
  }
  return false;
}

function collectClassParameterProperties(
  declNode: TreeSitterNode,
  properties: string[],
): void {
  const caseClass = isCaseDefinition(declNode);
  for (const paramList of findChildren(declNode, "class_parameters")) {
    for (const param of findChildren(paramList, "class_parameter")) {
      let isProperty = caseClass;
      if (!isProperty) {
        for (let i = 0; i < param.childCount; i++) {
          const child = param.child(i);
          if (child && (child.type === "val" || child.type === "var")) {
            isProperty = true;
            break;
          }
        }
      }
      if (!isProperty) continue;
      const id = findChild(param, "identifier");
      if (id) properties.push(id.text);
    }
  }
}

function extractFieldName(fieldNode: TreeSitterNode): string | null {
  return extractDeclarationName(fieldNode);
}

export class ScalaExtractor implements LanguageExtractor {
  readonly languageIds = ["scala"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    this.walkTopLevel(rootNode, functions, classes, imports, exports);

    return { functions, classes, imports, exports };
  }

  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[] {
    const entries: CallGraphEntry[] = [];
    const functionStack: string[] = [];

    const walk = (node: TreeSitterNode) => {
      let pushed = false;

      if (node.type === "function_definition") {
        const name = extractDeclarationName(node);
        if (name) {
          functionStack.push(name);
          pushed = true;
        }
      }

      if (functionStack.length > 0) {
        const callee = this.extractCallLikeName(node);
        if (callee) {
          entries.push({
            caller: functionStack[functionStack.length - 1],
            callee,
            lineNumber: node.startPosition.row + 1,
          });
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walk(child);
      }

      if (pushed) functionStack.pop();
    };

    walk(rootNode);
    return entries;
  }

  private walkTopLevel(
    node: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
    classes: StructuralAnalysis["classes"],
    imports: StructuralAnalysis["imports"],
    exports: StructuralAnalysis["exports"],
  ): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;

      if (child.type === "package_clause") {
        this.walkTopLevel(child, functions, classes, imports, exports);
      } else if (child.type === "template_body") {
        this.walkTopLevel(child, functions, classes, imports, exports);
      } else if (child.type === "import_declaration") {
        this.extractImport(child, imports);
      } else if (child.type === "export_declaration") {
        this.extractExportDeclaration(child, exports);
      } else if (FUNCTION_DEFINITION_KINDS.has(child.type)) {
        this.extractFunction(child, functions, exports);
      } else if (TYPE_DEFINITION_KINDS.has(child.type)) {
        this.extractTypeDefinition(child, classes, functions, exports);
      } else if (FIELD_DEFINITION_KINDS.has(child.type)) {
        const name = extractFieldName(child);
        if (name && isExported(child)) {
          exports.push({ name, lineNumber: child.startPosition.row + 1 });
        }
      } else if (child.type === "extension_definition") {
        this.extractExtensionDefinition(child, null, functions, exports);
      } else if (child.type === "given_definition") {
        const name = extractDeclarationName(child);
        if (name && isExported(child)) {
          exports.push({ name, lineNumber: child.startPosition.row + 1 });
        }
      }
    }
  }

  private extractFunction(
    declNode: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
    exportAllowed = true,
  ): void {
    const name = extractDeclarationName(declNode);
    if (!name) return;
    functions.push({
      name,
      lineRange: [declNode.startPosition.row + 1, declNode.endPosition.row + 1],
      params: extractParams(declNode),
      returnType: extractReturnType(declNode),
    });
    if (exportAllowed && isExported(declNode)) {
      exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
    }
  }

  private extractTypeDefinition(
    declNode: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
    exportAllowed = true,
  ): void {
    const name = extractDeclarationName(declNode);
    if (!name) return;

    const properties: string[] = [];
    const methods: string[] = [];
    const memberExportAllowed = exportAllowed && isExported(declNode);

    collectClassParameterProperties(declNode, properties);

    const body =
      findChild(declNode, "template_body") ?? findChild(declNode, "enum_body");
    if (body) {
      this.collectTemplateBody(
        body,
        methods,
        properties,
        classes,
        functions,
        exports,
        memberExportAllowed,
      );
    }

    classes.push({
      name,
      lineRange: [declNode.startPosition.row + 1, declNode.endPosition.row + 1],
      methods,
      properties,
    });

    if (memberExportAllowed) {
      exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
    }
  }

  private collectTemplateBody(
    body: TreeSitterNode,
    methods: string[],
    properties: string[],
    classes: StructuralAnalysis["classes"],
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
    exportAllowed = true,
  ): void {
    for (let i = 0; i < body.childCount; i++) {
      const member = body.child(i);
      if (!member) continue;

      if (FUNCTION_DEFINITION_KINDS.has(member.type)) {
        const name = extractDeclarationName(member);
        if (!name) continue;
        methods.push(name);
        functions.push({
          name,
          lineRange: [member.startPosition.row + 1, member.endPosition.row + 1],
          params: extractParams(member),
          returnType: extractReturnType(member),
        });
        if (exportAllowed && isExported(member)) {
          exports.push({ name, lineNumber: member.startPosition.row + 1 });
        }
      } else if (FIELD_DEFINITION_KINDS.has(member.type)) {
        const name = extractFieldName(member);
        if (!name) continue;
        properties.push(name);
        if (exportAllowed && isExported(member)) {
          exports.push({ name, lineNumber: member.startPosition.row + 1 });
        }
      } else if (TYPE_DEFINITION_KINDS.has(member.type)) {
        this.extractTypeDefinition(member, classes, functions, exports, exportAllowed);
      } else if (member.type === "extension_definition") {
        this.extractExtensionDefinition(
          member,
          methods,
          functions,
          exports,
          exportAllowed,
        );
      } else if (member.type === "enum_case_definitions") {
        for (let j = 0; j < member.childCount; j++) {
          const enumCase = member.child(j);
          if (!enumCase || !enumCase.isNamed) continue;
          const id = findChild(enumCase, "identifier");
          if (id) properties.push(id.text);
        }
      }
    }
  }

  private extractImport(
    declNode: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const itemChildren: TreeSitterNode[][] = [];
    let current: TreeSitterNode[] = [];

    for (let i = 0; i < declNode.childCount; i++) {
      const child = declNode.child(i);
      if (!child) continue;
      if (child.type === ",") {
        if (current.length > 0) itemChildren.push(current);
        current = [];
      } else if (child.isNamed) {
        current.push(child);
      }
    }
    if (current.length > 0) itemChildren.push(current);

    for (const item of itemChildren) {
      this.extractImportItem(item, declNode.startPosition.row + 1, imports);
    }
  }

  private extractImportItem(
    itemChildren: TreeSitterNode[],
    lineNumber: number,
    imports: StructuralAnalysis["imports"],
  ): void {
    const parts: string[] = [];
    for (const child of itemChildren) {
      if (child.type === "identifier") parts.push(child.text);
    }

    const selectors = itemChildren.find((child) => child.type === "namespace_selectors");
    const wildcard = itemChildren.find((child) => child.type === "namespace_wildcard");

    let source: string;
    let specifiers: string[];

    if (wildcard) {
      if (parts.length === 0) return;
      source = parts.join(".");
      specifiers = ["*"];
    } else if (selectors) {
      if (parts.length === 0) return;
      source = parts.join(".");
      specifiers = this.extractSelectorSpecifiers(selectors);
      if (specifiers.length === 0) specifiers = ["*"];
    } else {
      if (parts.length === 0) return;
      source = parts.join(".");
      specifiers = [parts[parts.length - 1]];
    }

    imports.push({
      source,
      specifiers,
      lineNumber,
    });
  }

  private extractSelectorSpecifiers(selectors: TreeSitterNode): string[] {
    const specifiers: string[] = [];
    for (let i = 0; i < selectors.childCount; i++) {
      const child = selectors.child(i);
      if (!child || !child.isNamed) continue;

      if (child.type === "identifier") {
        specifiers.push(child.text);
      } else if (child.type === "namespace_wildcard") {
        specifiers.push("*");
      } else {
        if (findChild(child, "wildcard")) continue;
        const ids = findChildren(child, "identifier");
        if (ids.length > 0) specifiers.push(ids[0].text);
      }
    }
    return specifiers;
  }

  private extractExtensionDefinition(
    declNode: TreeSitterNode,
    methods: string[] | null,
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
    exportAllowed = true,
  ): void {
    for (const fn of findChildren(declNode, "function_definition")) {
      const name = extractDeclarationName(fn);
      if (name && methods) methods.push(name);
      this.extractFunction(fn, functions, exports, exportAllowed);
    }
  }

  private extractExportDeclaration(
    declNode: TreeSitterNode,
    exports: StructuralAnalysis["exports"],
  ): void {
    const selectors = findChild(declNode, "namespace_selectors");
    const names = selectors
      ? this.extractExportSelectorNames(selectors)
      : this.extractExportedPathName(declNode);

    for (const name of names) {
      if (name !== "*") {
        exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
      }
    }
  }

  private extractExportSelectorNames(selectors: TreeSitterNode): string[] {
    const names: string[] = [];
    for (let i = 0; i < selectors.childCount; i++) {
      const child = selectors.child(i);
      if (!child || !child.isNamed) continue;

      if (child.type === "identifier") {
        names.push(child.text);
      } else if (child.type === "namespace_wildcard") {
        names.push("*");
      } else if (!findChild(child, "wildcard")) {
        const ids = findChildren(child, "identifier");
        if (ids.length > 0) names.push(ids[ids.length - 1].text);
      }
    }
    return names;
  }

  private extractExportedPathName(declNode: TreeSitterNode): string[] {
    let name: string | null = null;
    for (const id of findChildren(declNode, "identifier")) {
      name = id.text;
    }
    return name ? [name] : [];
  }

  private extractCallLikeName(node: TreeSitterNode): string | null {
    if (node.type === "call_expression") return this.extractCalleeName(node);
    if (node.type === "infix_expression") return this.extractInfixName(node);
    if (node.type === "instance_expression") return this.extractConstructorName(node);
    return null;
  }

  private extractCalleeName(callNode: TreeSitterNode): string | null {
    let target = callNode.child(0);
    if (!target) return null;

    if (target.type === "generic_function") {
      target = target.child(0);
      if (!target) return null;
    }

    if (target.type === "identifier") return target.text;

    if (target.type === "field_expression") {
      let lastIdentifier: string | null = null;
      for (let i = 0; i < target.childCount; i++) {
        const child = target.child(i);
        if (child && child.type === "identifier") {
          lastIdentifier = child.text;
        }
      }
      return lastIdentifier;
    }
    return null;
  }

  private extractInfixName(infixNode: TreeSitterNode): string | null {
    const identifiers: string[] = [];
    for (let i = 0; i < infixNode.childCount; i++) {
      const child = infixNode.child(i);
      if (child && child.type === "identifier") identifiers.push(child.text);
    }
    return identifiers[1] ?? identifiers[0] ?? null;
  }

  private extractConstructorName(instanceNode: TreeSitterNode): string | null {
    for (let i = 0; i < instanceNode.childCount; i++) {
      const child = instanceNode.child(i);
      if (child && (child.type === "type_identifier" || child.type === "identifier")) {
        return child.text;
      }
    }
    return null;
  }
}
