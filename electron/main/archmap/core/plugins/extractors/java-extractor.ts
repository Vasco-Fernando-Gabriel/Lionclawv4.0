import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild, findChildren } from "./base-extractor.js";

function extractParams(paramsNode: TreeSitterNode | null): string[] {
  if (!paramsNode) return [];
  const params: string[] = [];

  const declarations = findChildren(paramsNode, "formal_parameter");
  for (const decl of declarations) {
    const nameNode = decl.childForFieldName("name");
    if (nameNode) {
      params.push(nameNode.text);
    }
  }

  const spreadParams = findChildren(paramsNode, "spread_parameter");
  for (const spread of spreadParams) {
    const nameNode = spread.childForFieldName("name");
    if (nameNode) {
      params.push(nameNode.text);
    }
  }

  return params;
}

function extractReturnType(node: TreeSitterNode): string | undefined {
  const typeNode = node.childForFieldName("type");
  if (!typeNode) return undefined;
  return typeNode.text;
}

function hasModifier(node: TreeSitterNode, modifier: string): boolean {
  const modifiers = findChild(node, "modifiers");
  if (!modifiers) return false;
  for (let i = 0; i < modifiers.childCount; i++) {
    const child = modifiers.child(i);
    if (child && child.text === modifier) return true;
  }
  return false;
}

function extractScopedIdentifierPath(node: TreeSitterNode): string {
  return node.text;
}

function lastComponent(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1];
}

export class JavaExtractor implements LanguageExtractor {
  readonly languageIds = ["java"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    for (let i = 0; i < rootNode.childCount; i++) {
      const node = rootNode.child(i);
      if (!node) continue;

      switch (node.type) {
        case "import_declaration":
          this.extractImport(node, imports);
          break;

        case "class_declaration":
        case "enum_declaration":
        case "record_declaration":
          this.extractClass(node, functions, classes, exports);
          break;

        case "interface_declaration":
          this.extractInterface(node, functions, classes, exports);
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

      if (
        node.type === "method_declaration" ||
        node.type === "constructor_declaration"
      ) {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          functionStack.push(nameNode.text);
          pushedName = true;
        }
      }

      if (node.type === "method_invocation") {
        if (functionStack.length > 0) {
          const callee = this.extractMethodInvocationName(node);
          if (callee) {
            entries.push({
              caller: functionStack[functionStack.length - 1],
              callee,
              lineNumber: node.startPosition.row + 1,
            });
          }
        }
      }

      if (node.type === "object_creation_expression") {
        if (functionStack.length > 0) {
          const typeNode = node.childForFieldName("type");
          if (typeNode) {
            entries.push({
              caller: functionStack[functionStack.length - 1],
              callee: `new ${typeNode.text}`,
              lineNumber: node.startPosition.row + 1,
            });
          }
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

  private extractMethodInvocationName(node: TreeSitterNode): string | null {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;

    const objectNode = node.childForFieldName("object");
    if (objectNode) {
      return `${objectNode.text}.${nameNode.text}`;
    }

    return nameNode.text;
  }

  private extractImport(
    node: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const hasAsterisk = findChild(node, "asterisk") !== null;

    const scopedId = findChild(node, "scoped_identifier");
    if (!scopedId) return;

    const fullPath = extractScopedIdentifierPath(scopedId);

    if (hasAsterisk) {
      imports.push({
        source: fullPath,
        specifiers: ["*"],
        lineNumber: node.startPosition.row + 1,
      });
    } else {
      imports.push({
        source: fullPath,
        specifiers: [lastComponent(fullPath)],
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  private extractClass(
    node: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
    classes: StructuralAnalysis["classes"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const methods: string[] = [];
    const properties: string[] = [];

    const body = node.childForFieldName("body");
    if (body) {
      this.extractClassBodyMembers(
        body,
        methods,
        properties,
        functions,
        exports,
      );
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

    if (hasModifier(node, "public")) {
      exports.push({
        name: nameNode.text,
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  private extractInterface(
    node: TreeSitterNode,
    _functions: StructuralAnalysis["functions"],
    classes: StructuralAnalysis["classes"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const methods: string[] = [];
    const properties: string[] = [];

    const body = node.childForFieldName("body");
    if (body) {
      const methodNodes = findChildren(body, "method_declaration");
      for (const methodNode of methodNodes) {
        const methNameNode = methodNode.childForFieldName("name");
        if (methNameNode) {
          methods.push(methNameNode.text);
        }
      }

      const fields = findChildren(body, "constant_declaration");
      for (const field of fields) {
        const declarators = findChildren(field, "variable_declarator");
        for (const decl of declarators) {
          const declName = decl.childForFieldName("name");
          if (declName) {
            properties.push(declName.text);
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

    if (hasModifier(node, "public")) {
      exports.push({
        name: nameNode.text,
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  private extractClassBodyMembers(
    body: TreeSitterNode,
    methods: string[],
    properties: string[],
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
  ): void {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (!child) continue;

      switch (child.type) {
        case "enum_body_declarations":
          this.extractClassBodyMembers(
            child,
            methods,
            properties,
            functions,
            exports,
          );
          break;

        case "method_declaration":
          this.extractMethod(child, methods, functions, exports);
          break;

        case "constructor_declaration":
          this.extractConstructor(child, methods, functions, exports);
          break;

        case "field_declaration":
          this.extractField(child, properties, exports);
          break;
      }
    }
  }

  private extractMethod(
    node: TreeSitterNode,
    methods: string[],
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const paramsNode = node.childForFieldName("parameters");
    const params = extractParams(paramsNode ?? null);
    const returnType = extractReturnType(node);

    methods.push(nameNode.text);

    functions.push({
      name: nameNode.text,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      params,
      returnType,
    });

    if (hasModifier(node, "public")) {
      exports.push({
        name: nameNode.text,
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  private extractConstructor(
    node: TreeSitterNode,
    methods: string[],
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const paramsNode = node.childForFieldName("parameters");
    const params = extractParams(paramsNode ?? null);

    methods.push(nameNode.text);

    functions.push({
      name: nameNode.text,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      params,
    });

    if (hasModifier(node, "public")) {
      exports.push({
        name: nameNode.text,
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  private extractField(
    node: TreeSitterNode,
    properties: string[],
    exports: StructuralAnalysis["exports"],
  ): void {
    const declarators = findChildren(node, "variable_declarator");
    for (const decl of declarators) {
      const nameNode = decl.childForFieldName("name");
      if (nameNode) {
        properties.push(nameNode.text);

        if (hasModifier(node, "public")) {
          exports.push({
            name: nameNode.text,
            lineNumber: node.startPosition.row + 1,
          });
        }
      }
    }
  }
}
