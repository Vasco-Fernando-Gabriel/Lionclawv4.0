import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild, findChildren } from "./base-extractor.js";

function unwrapDeclaratorName(node: TreeSitterNode): string | null {
  if (node.type === "identifier" || node.type === "field_identifier") {
    return node.text;
  }
  const inner = node.childForFieldName("declarator");
  if (inner) {
    return unwrapDeclaratorName(inner);
  }
  const id = findChild(node, "identifier") ?? findChild(node, "field_identifier");
  return id ? id.text : null;
}

function extractFuncDeclName(
  funcDecl: TreeSitterNode,
): { name: string; qualifier: string | null } | null {
  const declNode = funcDecl.childForFieldName("declarator");
  if (!declNode) return null;

  if (declNode.type === "identifier" || declNode.type === "field_identifier") {
    return { name: declNode.text, qualifier: null };
  }

  if (declNode.type === "qualified_identifier") {
    const nameNode = declNode.childForFieldName("name");
    const nsNode = findChild(declNode, "namespace_identifier");
    return {
      name: nameNode ? nameNode.text : declNode.text,
      qualifier: nsNode ? nsNode.text : null,
    };
  }

  return { name: declNode.text, qualifier: null };
}

function extractParams(paramsNode: TreeSitterNode | null): string[] {
  if (!paramsNode) return [];
  const params: string[] = [];

  const decls = findChildren(paramsNode, "parameter_declaration");
  for (const decl of decls) {
    const declNode = decl.childForFieldName("declarator");
    if (declNode) {
      const name = unwrapDeclaratorName(declNode);
      if (name) {
        params.push(name);
      }
    }
  }

  return params;
}

function extractReturnType(node: TreeSitterNode): string | undefined {
  const typeNode = node.childForFieldName("type");
  if (typeNode) {
    return typeNode.text;
  }
  return undefined;
}

function isStatic(node: TreeSitterNode): boolean {
  const storage = findChild(node, "storage_class_specifier");
  return storage !== null && storage.text === "static";
}

export class CppExtractor implements LanguageExtractor {
  readonly languageIds = ["cpp", "c"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    const methodsByClass = new Map<string, string[]>();

    this.walkTopLevel(rootNode, functions, classes, imports, exports, methodsByClass);

    for (const cls of classes) {
      const methods = methodsByClass.get(cls.name);
      if (methods) {
        for (const m of methods) {
          if (!cls.methods.includes(m)) {
            cls.methods.push(m);
          }
        }
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
        const name = this.extractFunctionName(node);
        if (name) {
          functionStack.push(name);
          pushedName = true;
        }
      }

      if (node.type === "call_expression") {
        if (functionStack.length > 0) {
          const callee = this.extractCalleeName(node);
          if (callee) {
            entries.push({
              caller: functionStack[functionStack.length - 1],
              callee,
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
    parentNode: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
    classes: StructuralAnalysis["classes"],
    imports: StructuralAnalysis["imports"],
    exports: StructuralAnalysis["exports"],
    methodsByClass: Map<string, string[]>,
  ): void {
    for (let i = 0; i < parentNode.childCount; i++) {
      const node = parentNode.child(i);
      if (!node) continue;

      switch (node.type) {
        case "preproc_include":
          this.extractInclude(node, imports);
          break;

        case "class_specifier":
          this.extractClassOrStruct(node, "class", classes, functions, exports);
          break;

        case "struct_specifier":
          this.extractClassOrStruct(node, "struct", classes, functions, exports);
          break;

        case "function_definition":
          this.extractFunctionDef(node, functions, exports, methodsByClass);
          break;

        case "namespace_definition": {
          const body = findChild(node, "declaration_list");
          if (body) {
            this.walkTopLevel(body, functions, classes, imports, exports, methodsByClass);
          }
          break;
        }

        case "declaration": {
          const innerClass = findChild(node, "class_specifier");
          if (innerClass) {
            this.extractClassOrStruct(innerClass, "class", classes, functions, exports);
          }
          const innerStruct = findChild(node, "struct_specifier");
          if (innerStruct) {
            this.extractClassOrStruct(innerStruct, "struct", classes, functions, exports);
          }
          break;
        }
      }
    }
  }

  private extractFunctionName(node: TreeSitterNode): string | null {
    const declNode = node.childForFieldName("declarator");
    if (!declNode || declNode.type !== "function_declarator") return null;

    const info = extractFuncDeclName(declNode);
    return info ? info.name : null;
  }

  private extractInclude(
    node: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const pathNode = node.childForFieldName("path");
    if (!pathNode) return;

    let source: string;
    if (pathNode.type === "system_lib_string") {
      source = pathNode.text.replace(/^<|>$/g, "");
    } else if (pathNode.type === "string_literal") {
      const content = findChild(pathNode, "string_content");
      source = content ? content.text : pathNode.text.replace(/^"|"$/g, "");
    } else {
      source = pathNode.text;
    }

    imports.push({
      source,
      specifiers: [source],
      lineNumber: node.startPosition.row + 1,
    });
  }

  private extractClassOrStruct(
    node: TreeSitterNode,
    kind: "class" | "struct",
    classes: StructuralAnalysis["classes"],
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const className = nameNode.text;
    const methods: string[] = [];
    const properties: string[] = [];

    const body = node.childForFieldName("body");
    if (body && body.type === "field_declaration_list") {
      let currentAccess = kind === "struct" ? "public" : "private";

      for (let j = 0; j < body.childCount; j++) {
        const member = body.child(j);
        if (!member) continue;

        if (member.type === "access_specifier") {
          const specChild = member.child(0);
          if (specChild) {
            currentAccess = specChild.text;
          }
          continue;
        }

        if (member.type === "field_declaration") {
          const declNode = member.childForFieldName("declarator");
          if (declNode && declNode.type === "function_declarator") {
            const info = extractFuncDeclName(declNode);
            if (info) {
              methods.push(info.name);
              if (currentAccess === "public") {
                exports.push({
                  name: info.name,
                  lineNumber: member.startPosition.row + 1,
                });
              }
            }
          } else if (declNode) {
            const name = unwrapDeclaratorName(declNode);
            if (name) {
              properties.push(name);
            }
          }
        }

        if (member.type === "function_definition") {
          const funcDecl = member.childForFieldName("declarator");
          if (funcDecl && funcDecl.type === "function_declarator") {
            const info = extractFuncDeclName(funcDecl);
            if (info) {
              methods.push(info.name);

              const paramsNode = funcDecl.childForFieldName("parameters");
              functions.push({
                name: info.name,
                owner: className,
                lineRange: [
                  member.startPosition.row + 1,
                  member.endPosition.row + 1,
                ],
                params: extractParams(paramsNode),
                returnType: extractReturnType(member),
              });

              if (currentAccess === "public") {
                exports.push({
                  name: info.name,
                  lineNumber: member.startPosition.row + 1,
                });
              }
            }
          }
        }
      }
    }

    classes.push({
      name: className,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      methods,
      properties,
    });

    exports.push({
      name: className,
      lineNumber: node.startPosition.row + 1,
    });
  }

  private extractFunctionDef(
    node: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
    methodsByClass: Map<string, string[]>,
  ): void {
    const funcDecl = node.childForFieldName("declarator");
    if (!funcDecl || funcDecl.type !== "function_declarator") return;

    const info = extractFuncDeclName(funcDecl);
    if (!info) return;

    const paramsNode = funcDecl.childForFieldName("parameters");
    const params = extractParams(paramsNode);
    const returnType = extractReturnType(node);

    functions.push({
      name: info.name,
      owner: info.qualifier ?? "",
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      params,
      returnType,
    });

    if (info.qualifier) {
      if (!methodsByClass.has(info.qualifier)) {
        methodsByClass.set(info.qualifier, []);
      }
      methodsByClass.get(info.qualifier)!.push(info.name);
    }

    if (!isStatic(node)) {
      exports.push({
        name: info.name,
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  private extractCalleeName(callNode: TreeSitterNode): string | null {
    const funcNode = callNode.child(0);
    if (!funcNode) return null;

    if (funcNode.type === "identifier") {
      return funcNode.text;
    }

    if (funcNode.type === "field_expression") {
      const field = funcNode.childForFieldName("field");
      return field ? field.text : funcNode.text;
    }

    if (funcNode.type === "qualified_identifier") {
      return funcNode.text;
    }

    return funcNode.text;
  }
}
