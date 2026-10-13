import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild } from "./base-extractor.js";

const IMPORT_METHODS = new Set(["require", "require_relative"]);

const ATTR_METHODS = new Set(["attr_accessor", "attr_reader", "attr_writer"]);

function extractParams(paramsNode: TreeSitterNode | null): string[] {
  if (!paramsNode) return [];
  const params: string[] = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child) continue;

    switch (child.type) {
      case "identifier":
        params.push(child.text);
        break;

      case "optional_parameter": {
        const ident = child.childForFieldName("name");
        if (ident) params.push(ident.text);
        break;
      }

      case "splat_parameter": {
        const ident = child.childForFieldName("name");
        if (ident) params.push("*" + ident.text);
        break;
      }

      case "hash_splat_parameter": {
        const ident = child.childForFieldName("name");
        if (ident) params.push("**" + ident.text);
        break;
      }

      case "block_parameter": {
        const ident = child.childForFieldName("name");
        if (ident) params.push("&" + ident.text);
        break;
      }
    }
  }

  return params;
}

function extractAttrProperties(callNode: TreeSitterNode): string[] {
  const properties: string[] = [];
  const args = callNode.childForFieldName("arguments");
  if (!args) return properties;

  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (child && child.type === "simple_symbol") {
      properties.push(child.text.slice(1));
    }
  }

  return properties;
}

function getStringContent(node: TreeSitterNode): string {
  const content = findChild(node, "string_content");
  if (content) return content.text;
  return node.text.replace(/^['"`]|['"`]$/g, "");
}

export class RubyExtractor implements LanguageExtractor {
  readonly languageIds = ["ruby"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    for (let i = 0; i < rootNode.childCount; i++) {
      const node = rootNode.child(i);
      if (!node) continue;

      switch (node.type) {
        case "method":
          this.extractMethod(node, functions);
          exports.push({
            name: this.getMethodName(node),
            lineNumber: node.startPosition.row + 1,
          });
          break;

        case "singleton_method":
          this.extractSingletonMethod(node, functions);
          exports.push({
            name: "self." + this.getSingletonMethodName(node),
            lineNumber: node.startPosition.row + 1,
          });
          break;

        case "class":
          this.extractClass(node, classes, functions);
          exports.push({
            name: this.getClassName(node),
            lineNumber: node.startPosition.row + 1,
          });
          break;

        case "module":
          this.extractModule(node, classes, functions);
          exports.push({
            name: this.getModuleName(node),
            lineNumber: node.startPosition.row + 1,
          });
          break;

        case "call":
          this.extractTopLevelCall(node, imports);
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

      if (node.type === "method") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          functionStack.push(nameNode.text);
          pushedName = true;
        }
      } else if (node.type === "singleton_method") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          functionStack.push("self." + nameNode.text);
          pushedName = true;
        }
      }

      if (node.type === "call") {
        const methodNode = node.childForFieldName("method");
        if (methodNode && functionStack.length > 0) {
          const methodName = methodNode.text;

          if (!IMPORT_METHODS.has(methodName) && !ATTR_METHODS.has(methodName)) {
            const receiverNode = node.childForFieldName("receiver");
            const callee = receiverNode
              ? receiverNode.text + "." + methodName
              : methodName;

            entries.push({
              caller: functionStack[functionStack.length - 1],
              callee,
              lineNumber: node.startPosition.row + 1,
            });
          }
        }
      }

      if (
        node.type === "identifier" &&
        node.parent?.type === "body_statement" &&
        functionStack.length > 0
      ) {
        entries.push({
          caller: functionStack[functionStack.length - 1],
          callee: node.text,
          lineNumber: node.startPosition.row + 1,
        });
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

  private getMethodName(node: TreeSitterNode): string {
    const nameNode = node.childForFieldName("name");
    return nameNode ? nameNode.text : "";
  }

  private getSingletonMethodName(node: TreeSitterNode): string {
    const nameNode = node.childForFieldName("name");
    return nameNode ? nameNode.text : "";
  }

  private getClassName(node: TreeSitterNode): string {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return "";
    return nameNode.text;
  }

  private getModuleName(node: TreeSitterNode): string {
    const nameNode = node.childForFieldName("name");
    return nameNode ? nameNode.text : "";
  }

  private extractMethod(
    node: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const paramsNode = node.childForFieldName("parameters");
    const params = extractParams(paramsNode ?? null);

    functions.push({
      name: nameNode.text,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      params,
    });
  }

  private extractSingletonMethod(
    node: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const paramsNode = node.childForFieldName("parameters");
    const params = extractParams(paramsNode ?? null);

    functions.push({
      name: "self." + nameNode.text,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      params,
    });
  }

  private extractClass(
    node: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
    functions: StructuralAnalysis["functions"],
  ): void {
    const name = this.getClassName(node);
    if (!name) return;

    const methods: string[] = [];
    const properties: string[] = [];

    const body = node.childForFieldName("body");
    if (body) {
      this.extractClassBody(body, methods, properties, functions);
    }

    classes.push({
      name,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      methods,
      properties,
    });
  }

  private extractModule(
    node: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
    functions: StructuralAnalysis["functions"],
  ): void {
    const name = this.getModuleName(node);
    if (!name) return;

    const methods: string[] = [];
    const properties: string[] = [];

    const body = node.childForFieldName("body");
    if (body) {
      this.extractClassBody(body, methods, properties, functions);
    }

    classes.push({
      name,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      methods,
      properties,
    });
  }

  private extractClassBody(
    body: TreeSitterNode,
    methods: string[],
    properties: string[],
    functions: StructuralAnalysis["functions"],
  ): void {
    for (let i = 0; i < body.childCount; i++) {
      const member = body.child(i);
      if (!member) continue;

      if (member.type === "method") {
        const nameNode = member.childForFieldName("name");
        if (nameNode) {
          methods.push(nameNode.text);
          this.extractMethod(member, functions);
        }
      } else if (member.type === "singleton_method") {
        const nameNode = member.childForFieldName("name");
        if (nameNode) {
          methods.push("self." + nameNode.text);
          this.extractSingletonMethod(member, functions);
        }
      } else if (member.type === "call") {
        const methodNode = member.childForFieldName("method");
        if (methodNode && ATTR_METHODS.has(methodNode.text)) {
          properties.push(...extractAttrProperties(member));
        }
      }
    }
  }

  private extractTopLevelCall(
    node: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const methodNode = node.childForFieldName("method");
    if (!methodNode) return;

    if (IMPORT_METHODS.has(methodNode.text)) {
      const args = node.childForFieldName("arguments");
      if (!args) return;

      const firstArg = findChild(args, "string");
      if (firstArg) {
        const source = getStringContent(firstArg);
        imports.push({
          source,
          specifiers: [source],
          lineNumber: node.startPosition.row + 1,
        });
      }
    }
  }
}
