import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild, findChildren } from "./base-extractor.js";

function extractParams(paramsNode: TreeSitterNode | null): string[] {
  if (!paramsNode) return [];
  const params: string[] = [];

  const paramNodes = findChildren(paramsNode, "parameter");
  for (const param of paramNodes) {
    const nameNode = param.childForFieldName("name");
    if (nameNode) {
      params.push(nameNode.text);
    }
  }

  return params;
}

function extractReturnType(node: TreeSitterNode): string | undefined {
  const typeNode = node.childForFieldName("returns");
  if (!typeNode) return undefined;
  return typeNode.text;
}

function hasModifier(node: TreeSitterNode, modifier: string): boolean {
  const modifierNodes = findChildren(node, "modifier");
  for (const mod of modifierNodes) {
    for (let i = 0; i < mod.childCount; i++) {
      const child = mod.child(i);
      if (child && child.text === modifier) return true;
    }
  }
  return false;
}

function extractUsingSource(node: TreeSitterNode): string | null {
  const hasEquals = findChild(node, "=") !== null;

  if (hasEquals) {
    const qualifiedName = findChild(node, "qualified_name");
    return qualifiedName ? qualifiedName.text : null;
  }

  const qualifiedName = findChild(node, "qualified_name");
  if (qualifiedName) return qualifiedName.text;

  const identifier = findChild(node, "identifier");
  return identifier ? identifier.text : null;
}

function lastComponent(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1];
}

function extractInvocationName(node: TreeSitterNode): string | null {
  const funcNode = node.childForFieldName("function");
  if (!funcNode) return null;
  return funcNode.text;
}

export class CSharpExtractor implements LanguageExtractor {
  readonly languageIds = ["csharp"];

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

      if (node.type === "invocation_expression") {
        if (functionStack.length > 0) {
          const callee = extractInvocationName(node);
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
          const typeNode = findChild(node, "identifier") ?? findChild(node, "generic_name");
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

      switch (child.type) {
        case "using_directive":
          this.extractUsing(child, imports);
          break;

        case "namespace_declaration":
          this.walkNamespaceBody(child, functions, classes, imports, exports);
          break;

        case "file_scoped_namespace_declaration":
          break;

        case "class_declaration":
        case "record_declaration":
        case "struct_declaration":
          this.extractClass(child, functions, classes, exports);
          break;

        case "interface_declaration":
          this.extractInterface(child, functions, classes, exports);
          break;
      }
    }
  }

  private walkNamespaceBody(
    nsNode: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
    classes: StructuralAnalysis["classes"],
    imports: StructuralAnalysis["imports"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const body = nsNode.childForFieldName("body");
    if (!body) return;

    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (!child) continue;

      switch (child.type) {
        case "class_declaration":
        case "record_declaration":
        case "struct_declaration":
          this.extractClass(child, functions, classes, exports);
          break;

        case "interface_declaration":
          this.extractInterface(child, functions, classes, exports);
          break;

        case "namespace_declaration":
          this.walkNamespaceBody(child, functions, classes, imports, exports);
          break;
      }
    }
  }

  private extractUsing(
    node: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const source = extractUsingSource(node);
    if (!source) return;

    imports.push({
      source,
      specifiers: [lastComponent(source)],
      lineNumber: node.startPosition.row + 1,
    });
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
      this.extractClassBodyMembers(body, methods, properties, functions, exports);
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

      const propNodes = findChildren(body, "property_declaration");
      for (const propNode of propNodes) {
        const propNameNode = propNode.childForFieldName("name");
        if (propNameNode) {
          properties.push(propNameNode.text);
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
        case "method_declaration":
          this.extractMethod(child, methods, functions, exports);
          break;

        case "constructor_declaration":
          this.extractConstructor(child, methods, functions, exports);
          break;

        case "property_declaration":
          this.extractProperty(child, properties, exports);
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

  private extractProperty(
    node: TreeSitterNode,
    properties: string[],
    exports: StructuralAnalysis["exports"],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    properties.push(nameNode.text);

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
    const varDecl = findChild(node, "variable_declaration");
    if (!varDecl) return;

    const declarators = findChildren(varDecl, "variable_declarator");
    for (const decl of declarators) {
      const nameNode = findChild(decl, "identifier");
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
