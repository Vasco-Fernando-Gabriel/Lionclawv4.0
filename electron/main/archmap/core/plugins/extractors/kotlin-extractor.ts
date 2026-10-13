import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild, findChildren } from "./base-extractor.js";

function extractVisibility(declNode: TreeSitterNode): string | null {
  const modifiers = findChild(declNode, "modifiers");
  if (!modifiers) return null;
  const visibility = findChild(modifiers, "visibility_modifier");
  if (!visibility) return null;
  return visibility.text;
}

function isExported(declNode: TreeSitterNode): boolean {
  const visibility = extractVisibility(declNode);
  return visibility === null || visibility !== "private";
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
  const valueParams = findChild(declNode, "function_value_parameters");
  if (!valueParams) return params;
  for (const param of findChildren(valueParams, "parameter")) {
    const id = findChild(param, "identifier");
    if (id) params.push(id.text);
  }
  return params;
}

function extractReturnType(declNode: TreeSitterNode): string | undefined {
  let sawParams = false;
  for (let i = 0; i < declNode.childCount; i++) {
    const child = declNode.child(i);
    if (!child) continue;
    if (child.type === "function_value_parameters") {
      sawParams = true;
      continue;
    }
    if (sawParams && child.type === ":") {
      for (let j = i + 1; j < declNode.childCount; j++) {
        const next = declNode.child(j);
        if (next && next.isNamed) return next.text;
      }
    }
  }
  return undefined;
}

function collectClassBody(
  body: TreeSitterNode,
  methods: string[],
  properties: string[],
  functions: StructuralAnalysis["functions"],
  exports: StructuralAnalysis["exports"],
): void {
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member) continue;

    if (member.type === "function_declaration") {
      const name = extractDeclarationName(member);
      if (!name) continue;
      methods.push(name);
      functions.push({
        name,
        lineRange: [member.startPosition.row + 1, member.endPosition.row + 1],
        params: extractParams(member),
        returnType: extractReturnType(member),
      });
      if (isExported(member)) {
        exports.push({ name, lineNumber: member.startPosition.row + 1 });
      }
    } else if (member.type === "property_declaration") {
      const name = extractPropertyName(member);
      if (name) properties.push(name);
      if (name && isExported(member)) {
        exports.push({ name, lineNumber: member.startPosition.row + 1 });
      }
    } else if (member.type === "object_declaration") {
      const name = extractDeclarationName(member);
      if (name) properties.push(name);
    }
  }
}

function extractPropertyName(propNode: TreeSitterNode): string | null {
  const varDecl = findChild(propNode, "variable_declaration");
  if (!varDecl) return null;
  const id = findChild(varDecl, "identifier");
  return id ? id.text : null;
}

function collectPrimaryConstructorProperties(
  declNode: TreeSitterNode,
  properties: string[],
): void {
  const primary = findChild(declNode, "primary_constructor");
  if (!primary) return;
  const params = findChild(primary, "class_parameters");
  if (!params) return;
  for (const param of findChildren(params, "class_parameter")) {
    let isProperty = false;
    for (let i = 0; i < param.childCount; i++) {
      const child = param.child(i);
      if (child && (child.type === "val" || child.type === "var")) {
        isProperty = true;
        break;
      }
    }
    if (!isProperty) continue;
    const id = findChild(param, "identifier");
    if (id) properties.push(id.text);
  }
}

export class KotlinExtractor implements LanguageExtractor {
  readonly languageIds = ["kotlin"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    for (let i = 0; i < rootNode.childCount; i++) {
      const node = rootNode.child(i);
      if (!node) continue;

      switch (node.type) {
        case "package_header":
          break;

        case "import":
          this.extractImport(node, imports);
          break;

        case "function_declaration":
          this.extractTopLevelFunction(node, functions, exports);
          break;

        case "class_declaration":
          this.extractClassDeclaration(node, classes, functions, exports);
          break;

        case "object_declaration":
          this.extractObjectDeclaration(node, classes, functions, exports);
          break;
      }
    }

    return { functions, classes, imports, exports };
  }

  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[] {
    const entries: CallGraphEntry[] = [];
    const functionStack: string[] = [];

    const walk = (node: TreeSitterNode) => {
      let pushed = false;

      if (node.type === "function_declaration") {
        const name = extractDeclarationName(node);
        if (name) {
          functionStack.push(name);
          pushed = true;
        }
      }

      if (node.type === "call_expression" && functionStack.length > 0) {
        const callee = this.extractCalleeName(node);
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

  private extractTopLevelFunction(
    declNode: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const name = extractDeclarationName(declNode);
    if (!name) return;
    functions.push({
      name,
      lineRange: [declNode.startPosition.row + 1, declNode.endPosition.row + 1],
      params: extractParams(declNode),
      returnType: extractReturnType(declNode),
    });
    if (isExported(declNode)) {
      exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
    }
  }

  private extractClassDeclaration(
    declNode: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const name = extractDeclarationName(declNode);
    if (!name) return;

    const properties: string[] = [];
    const methods: string[] = [];

    collectPrimaryConstructorProperties(declNode, properties);

    const body = findChild(declNode, "class_body");
    if (body) {
      collectClassBody(body, methods, properties, functions, exports);
    }

    classes.push({
      name,
      lineRange: [declNode.startPosition.row + 1, declNode.endPosition.row + 1],
      methods,
      properties,
    });

    if (isExported(declNode)) {
      exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
    }
  }

  private extractObjectDeclaration(
    declNode: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const name = extractDeclarationName(declNode);
    if (!name) return;

    const properties: string[] = [];
    const methods: string[] = [];

    const body = findChild(declNode, "class_body");
    if (body) {
      collectClassBody(body, methods, properties, functions, exports);
    }

    classes.push({
      name,
      lineRange: [declNode.startPosition.row + 1, declNode.endPosition.row + 1],
      methods,
      properties,
    });

    if (isExported(declNode)) {
      exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
    }
  }

  private extractImport(
    declNode: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const qualified = findChild(declNode, "qualified_identifier");
    if (!qualified) return;

    const parts: string[] = [];
    for (const id of findChildren(qualified, "identifier")) {
      parts.push(id.text);
    }
    if (parts.length === 0) return;

    const source = parts.join(".");

    let specifier = parts[parts.length - 1];
    let sawWildcardStar = false;
    let sawAs = false;
    for (let i = 0; i < declNode.childCount; i++) {
      const child = declNode.child(i);
      if (!child) continue;
      if (child.type === "*") sawWildcardStar = true;
      if (child.type === "as") sawAs = true;
      else if (sawAs && child.type === "identifier") {
        specifier = child.text;
        sawAs = false;
      }
    }
    if (sawWildcardStar) specifier = "*";

    imports.push({
      source,
      specifiers: [specifier],
      lineNumber: declNode.startPosition.row + 1,
    });
  }

  private extractCalleeName(callNode: TreeSitterNode): string | null {
    const first = callNode.child(0);
    if (!first) return null;

    if (first.type === "identifier") return first.text;

    if (first.type === "navigation_expression") {
      let lastIdentifier: string | null = null;
      for (let i = 0; i < first.childCount; i++) {
        const child = first.child(i);
        if (child && child.type === "identifier") {
          lastIdentifier = child.text;
        }
      }
      return lastIdentifier;
    }
    return null;
  }
}
