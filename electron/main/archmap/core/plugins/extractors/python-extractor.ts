import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild, findChildren } from "./base-extractor.js";

function extractParams(paramsNode: TreeSitterNode | null): string[] {
  if (!paramsNode) return [];
  const params: string[] = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child) continue;

    switch (child.type) {
      case "identifier":
        if (child.text !== "self" && child.text !== "cls") {
          params.push(child.text);
        }
        break;

      case "typed_parameter": {
        const ident = findChild(child, "identifier");
        if (ident && ident.text !== "self" && ident.text !== "cls") {
          params.push(ident.text);
        }
        break;
      }

      case "default_parameter": {
        const ident = findChild(child, "identifier");
        if (ident && ident.text !== "self" && ident.text !== "cls") {
          params.push(ident.text);
        }
        break;
      }

      case "typed_default_parameter": {
        const ident = findChild(child, "identifier");
        if (ident && ident.text !== "self" && ident.text !== "cls") {
          params.push(ident.text);
        }
        break;
      }

      case "list_splat_pattern": {
        const ident = findChild(child, "identifier");
        if (ident) params.push("*" + ident.text);
        break;
      }

      case "dictionary_splat_pattern": {
        const ident = findChild(child, "identifier");
        if (ident) params.push("**" + ident.text);
        break;
      }
    }
  }

  return params;
}

function extractReturnType(node: TreeSitterNode): string | undefined {
  const returnType = node.childForFieldName("return_type");
  if (returnType) {
    return returnType.text;
  }
  return undefined;
}

function unwrapDecorated(node: TreeSitterNode): TreeSitterNode {
  if (node.type === "decorated_definition") {
    const inner =
      findChild(node, "function_definition") ??
      findChild(node, "class_definition");
    if (inner) return inner;
  }
  return node;
}

export class PythonExtractor implements LanguageExtractor {
  readonly languageIds = ["python"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    for (let i = 0; i < rootNode.childCount; i++) {
      const node = rootNode.child(i);
      if (!node) continue;

      const inner = unwrapDecorated(node);

      switch (inner.type) {
        case "function_definition":
          this.extractFunction(inner, functions);
          this.addExport(inner, node, exports);
          break;

        case "class_definition":
          this.extractClass(inner, classes);
          this.addExport(inner, node, exports);
          break;

        case "import_statement":
          this.extractImport(inner, imports);
          break;

        case "import_from_statement":
          this.extractFromImport(inner, imports);
          break;
      }
    }

    return { functions, classes, imports, exports };
  }

  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[] {
    const entries: CallGraphEntry[] = [];
    const functionStack: string[] = [];

    const walkForCalls = (node: TreeSitterNode) => {
      let pushedName = false;

      if (node.type === "function_definition") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          functionStack.push(nameNode.text);
          pushedName = true;
        }
      }

      if (node.type === "call") {
        const calleeNode = node.children.find(
          (c) =>
            c.type === "identifier" ||
            c.type === "attribute",
        );
        if (calleeNode && functionStack.length > 0) {
          entries.push({
            caller: functionStack[functionStack.length - 1],
            callee: calleeNode.text,
            lineNumber: node.startPosition.row + 1,
          });
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walkForCalls(child);
      }

      if (pushedName) {
        functionStack.pop();
      }
    };

    walkForCalls(rootNode);

    return entries;
  }

  private extractFunction(
    node: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const paramsNode = node.childForFieldName("parameters");
    const params = extractParams(paramsNode ?? null);
    const returnType = extractReturnType(node);

    functions.push({
      name: nameNode.text,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      params,
      returnType,
    });
  }

  private extractClass(
    node: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const methods: string[] = [];
    const properties: string[] = [];

    const body = node.childForFieldName("body");
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i);
        if (!member) continue;

        const innerMember = unwrapDecorated(member);
        if (innerMember.type === "function_definition") {
          const methodName = innerMember.childForFieldName("name");
          if (methodName) methods.push(methodName.text);
        }

        if (member.type === "expression_statement") {
          const assignment = findChild(member, "assignment");
          if (assignment) {
            const typeNode = findChild(assignment, "type");
            const nameIdent = findChild(assignment, "identifier");
            if (typeNode && nameIdent) {
              properties.push(nameIdent.text);
            }
          }
        }
      }
    }

    classes.push({
      name: nameNode.text,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      methods,
      properties,
    });
  }

  private extractImport(
    node: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const dottedNames = findChildren(node, "dotted_name");
    const aliasedImports = findChildren(node, "aliased_import");

    for (const dn of dottedNames) {
      imports.push({
        source: dn.text,
        specifiers: [dn.text],
        lineNumber: node.startPosition.row + 1,
      });
    }

    for (const ai of aliasedImports) {
      const dottedName = findChild(ai, "dotted_name");
      const alias = ai.children.find(
        (c) => c.type === "identifier",
      );
      if (dottedName) {
        imports.push({
          source: dottedName.text,
          specifiers: [alias ? alias.text : dottedName.text],
          lineNumber: node.startPosition.row + 1,
        });
      }
    }
  }

  private extractFromImport(
    node: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const moduleNode = node.childForFieldName("module_name");
    const source = moduleNode ? moduleNode.text : "";
    const moduleNodeId = moduleNode?.id;

    const specifiers: string[] = [];

    const allDottedNames = findChildren(node, "dotted_name");
    for (const dn of allDottedNames) {
      if (dn.id === moduleNodeId) continue;
      specifiers.push(dn.text);
    }

    const aliasedImports = findChildren(node, "aliased_import");
    for (const ai of aliasedImports) {
      const alias = ai.children.find(
        (c) => c.type === "identifier",
      );
      if (alias) {
        specifiers.push(alias.text);
      }
    }

    if (findChild(node, "wildcard_import")) {
      specifiers.push("*");
    }

    imports.push({
      source,
      specifiers,
      lineNumber: node.startPosition.row + 1,
    });
  }

  private addExport(
    inner: TreeSitterNode,
    outer: TreeSitterNode,
    exports: StructuralAnalysis["exports"],
  ): void {
    const nameNode = inner.childForFieldName("name");
    if (nameNode) {
      exports.push({
        name: nameNode.text,
        lineNumber: outer.startPosition.row + 1,
      });
    }
  }
}
