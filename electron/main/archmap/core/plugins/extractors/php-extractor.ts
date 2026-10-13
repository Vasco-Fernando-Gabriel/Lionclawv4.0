import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild, findChildren } from "./base-extractor.js";

function extractParams(paramsNode: TreeSitterNode | null): string[] {
  if (!paramsNode) return [];
  const params: string[] = [];

  const simpleParams = findChildren(paramsNode, "simple_parameter");
  for (const param of simpleParams) {
    const varName = findChild(param, "variable_name");
    if (varName) {
      params.push(varName.text);
    }
  }

  return params;
}

function extractReturnType(node: TreeSitterNode): string | undefined {
  let foundColon = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === ":" && child.text === ":") {
      foundColon = true;
      continue;
    }

    if (foundColon) {
      if (
        child.type === "primitive_type" ||
        child.type === "named_type" ||
        child.type === "optional_type" ||
        child.type === "union_type"
      ) {
        return child.text;
      }
    }
  }

  return undefined;
}

function extractUseName(clause: TreeSitterNode, prefix: string): string {
  const qualifiedName = findChild(clause, "qualified_name");
  if (qualifiedName) {
    return qualifiedName.text;
  }
  const nameNode = findChild(clause, "name");
  if (nameNode && prefix) {
    return prefix + "\\" + nameNode.text;
  }
  if (nameNode) {
    return nameNode.text;
  }
  return clause.text;
}

function lastSegment(fqn: string): string {
  const parts = fqn.split("\\");
  return parts[parts.length - 1];
}

export class PhpExtractor implements LanguageExtractor {
  readonly languageIds = ["php"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    this.walkStatements(rootNode, functions, classes, imports, exports);

    return { functions, classes, imports, exports };
  }

  private walkStatements(
    parent: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
    classes: StructuralAnalysis["classes"],
    imports: StructuralAnalysis["imports"],
    exports: StructuralAnalysis["exports"],
  ): void {
    for (let i = 0; i < parent.childCount; i++) {
      const node = parent.child(i);
      if (!node) continue;

      switch (node.type) {
        case "function_definition":
          this.extractFunction(node, functions);
          exports.push({
            name: this.getFunctionName(node),
            lineNumber: node.startPosition.row + 1,
          });
          break;

        case "class_declaration":
          this.extractClass(node, classes, functions);
          exports.push({
            name: this.getClassName(node),
            lineNumber: node.startPosition.row + 1,
          });
          break;

        case "interface_declaration":
          this.extractInterface(node, classes);
          exports.push({
            name: this.getInterfaceName(node),
            lineNumber: node.startPosition.row + 1,
          });
          break;

        case "namespace_use_declaration":
          this.extractUseDeclaration(node, imports);
          break;

        case "namespace_definition": {
          const body = findChild(node, "compound_statement");
          if (body) {
            this.walkStatements(body, functions, classes, imports, exports);
          }
          break;
        }
      }
    }
  }

  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[] {
    const entries: CallGraphEntry[] = [];
    const functionStack: string[] = [];

    const walkForCalls = (node: TreeSitterNode) => {
      let pushedName = false;

      if (node.type === "function_definition" || node.type === "method_declaration") {
        const nameNode = findChild(node, "name");
        if (nameNode) {
          functionStack.push(nameNode.text);
          pushedName = true;
        }
      }

      if (functionStack.length > 0) {
        const caller = functionStack[functionStack.length - 1];

        if (node.type === "function_call_expression") {
          const nameNode = findChild(node, "name");
          if (nameNode) {
            entries.push({
              caller,
              callee: nameNode.text,
              lineNumber: node.startPosition.row + 1,
            });
          }
        } else if (node.type === "member_call_expression") {
          const nameNode = findChild(node, "name");
          if (nameNode) {
            const firstChild = node.child(0);
            const receiver = firstChild ? firstChild.text : "";
            const callee = receiver
              ? receiver + "->" + nameNode.text
              : nameNode.text;
            entries.push({
              caller,
              callee,
              lineNumber: node.startPosition.row + 1,
            });
          }
        } else if (node.type === "scoped_call_expression") {
          const scopeNode = node.child(0);
          const methodNode = node.child(2);
          if (scopeNode && methodNode && methodNode.type === "name") {
            entries.push({
              caller,
              callee: scopeNode.text + "::" + methodNode.text,
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

  private getFunctionName(node: TreeSitterNode): string {
    const nameNode = findChild(node, "name");
    return nameNode ? nameNode.text : "";
  }

  private getClassName(node: TreeSitterNode): string {
    const nameNode = findChild(node, "name");
    return nameNode ? nameNode.text : "";
  }

  private getInterfaceName(node: TreeSitterNode): string {
    const nameNode = findChild(node, "name");
    return nameNode ? nameNode.text : "";
  }

  private extractFunction(
    node: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
  ): void {
    const nameNode = findChild(node, "name");
    if (!nameNode) return;

    const paramsNode = findChild(node, "formal_parameters");
    const params = extractParams(paramsNode);
    const returnType = extractReturnType(node);

    functions.push({
      name: nameNode.text,
      lineRange: [node.startPosition.row + 1, node.endPosition.row + 1],
      params,
      returnType,
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

    const declList = findChild(node, "declaration_list");
    if (declList) {
      this.extractDeclarationList(declList, methods, properties, functions);
    }

    classes.push({
      name,
      lineRange: [node.startPosition.row + 1, node.endPosition.row + 1],
      methods,
      properties,
    });
  }

  private extractInterface(
    node: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
  ): void {
    const name = this.getInterfaceName(node);
    if (!name) return;

    const methods: string[] = [];
    const properties: string[] = [];

    const declList = findChild(node, "declaration_list");
    if (declList) {
      const methodDecls = findChildren(declList, "method_declaration");
      for (const methodDecl of methodDecls) {
        const methodName = findChild(methodDecl, "name");
        if (methodName) {
          methods.push(methodName.text);
        }
      }
    }

    classes.push({
      name,
      lineRange: [node.startPosition.row + 1, node.endPosition.row + 1],
      methods,
      properties,
    });
  }

  private extractDeclarationList(
    declList: TreeSitterNode,
    methods: string[],
    properties: string[],
    functions: StructuralAnalysis["functions"],
  ): void {
    for (let i = 0; i < declList.childCount; i++) {
      const member = declList.child(i);
      if (!member) continue;

      if (member.type === "method_declaration") {
        const nameNode = findChild(member, "name");
        if (nameNode) {
          methods.push(nameNode.text);

          const paramsNode = findChild(member, "formal_parameters");
          const params = extractParams(paramsNode);
          const returnType = extractReturnType(member);

          functions.push({
            name: nameNode.text,
            lineRange: [member.startPosition.row + 1, member.endPosition.row + 1],
            params,
            returnType,
          });
        }
      } else if (member.type === "property_declaration") {
        const propElement = findChild(member, "property_element");
        if (propElement) {
          const varName = findChild(propElement, "variable_name");
          if (varName) {
            const dollarChild = findChild(varName, "name");
            if (dollarChild) {
              properties.push(dollarChild.text);
            } else {
              properties.push(varName.text.replace(/^\$/, ""));
            }
          }
        }
      }
    }
  }

  private extractUseDeclaration(
    node: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const useGroup = findChild(node, "namespace_use_group");
    if (useGroup) {
      const nsName = findChild(node, "namespace_name");
      const prefix = nsName ? nsName.text : "";

      const clauses = findChildren(useGroup, "namespace_use_clause");
      const specifiers: string[] = [];
      for (const clause of clauses) {
        const name = extractUseName(clause, prefix);
        specifiers.push(lastSegment(name));
      }

      const source = prefix
        ? prefix + "\\{" + specifiers.join(", ") + "}"
        : specifiers.join(", ");

      imports.push({
        source,
        specifiers,
        lineNumber: node.startPosition.row + 1,
      });
      return;
    }

    const clauses = findChildren(node, "namespace_use_clause");
    for (const clause of clauses) {
      const fqn = extractUseName(clause, "");
      const specifier = lastSegment(fqn);

      imports.push({
        source: fqn,
        specifiers: [specifier],
        lineNumber: node.startPosition.row + 1,
      });
    }
  }
}
