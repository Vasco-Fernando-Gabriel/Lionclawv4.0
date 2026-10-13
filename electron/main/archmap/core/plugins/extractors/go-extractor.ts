import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild, findChildren } from "./base-extractor.js";

function extractParams(paramsNode: TreeSitterNode | null): string[] {
  if (!paramsNode) return [];
  const params: string[] = [];

  const declarations = findChildren(paramsNode, "parameter_declaration");
  for (const decl of declarations) {
    for (let i = 0; i < decl.childCount; i++) {
      const child = decl.child(i);
      if (child && child.type === "identifier") {
        params.push(child.text);
      }
    }
  }

  return params;
}

function extractResultType(node: TreeSitterNode): string | undefined {
  const result = node.childForFieldName("result");
  if (!result) return undefined;
  return result.text;
}

function extractReceiverType(receiverNode: TreeSitterNode): string | undefined {
  const decl = findChild(receiverNode, "parameter_declaration");
  if (!decl) return undefined;

  let type = decl.childForFieldName("type");
  if (type?.type === "pointer_type") type = type.namedChildren[0] ?? null;
  if (type?.type === "generic_type") type = type.childForFieldName("type");
  if (type?.type === "type_identifier") {
    return type.text;
  }
  return undefined;
}

function isExported(name: string): boolean {
  if (name.length === 0) return false;
  const first = name.charCodeAt(0);
  return first >= 65 && first <= 90;
}

export class GoExtractor implements LanguageExtractor {
  readonly languageIds = ["go"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    const methodsByReceiver = new Map<string, string[]>();

    for (let i = 0; i < rootNode.childCount; i++) {
      const node = rootNode.child(i);
      if (!node) continue;

      switch (node.type) {
        case "function_declaration":
          this.extractFunction(node, functions, exports);
          break;

        case "method_declaration":
          this.extractMethod(node, functions, exports, methodsByReceiver);
          break;

        case "type_declaration":
          this.extractTypeDeclaration(node, classes, exports);
          break;

        case "import_declaration":
          this.extractImportDeclaration(node, imports);
          break;
      }
    }

    for (const cls of classes) {
      const methods = methodsByReceiver.get(cls.name);
      if (methods) {
        cls.methods.push(...methods);
      }
    }

    return { functions, classes, imports, exports };
  }

  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[] {
    const entries: CallGraphEntry[] = [];
    const functionStack: string[] = [];

    const walkForCalls = (node: TreeSitterNode) => {
      let pushedName = false;

      if (node.type === "function_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          functionStack.push(nameNode.text);
          pushedName = true;
        }
      } else if (node.type === "method_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          functionStack.push(nameNode.text);
          pushedName = true;
        }
      }

      if (node.type === "call_expression") {
        const calleeNode = node.childForFieldName("function");
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
    exports: StructuralAnalysis["exports"],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const paramsNode = node.childForFieldName("parameters");
    const params = extractParams(paramsNode ?? null);
    const returnType = extractResultType(node);

    functions.push({
      name: nameNode.text,
      owner: "",
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      params,
      returnType,
    });

    if (isExported(nameNode.text)) {
      exports.push({
        name: nameNode.text,
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  private extractMethod(
    node: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
    methodsByReceiver: Map<string, string[]>,
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const paramsNode = node.childForFieldName("parameters");
    const params = extractParams(paramsNode ?? null);
    const returnType = extractResultType(node);
    const receiverNode = node.childForFieldName("receiver");
    const receiverType = receiverNode ? extractReceiverType(receiverNode) : undefined;

    functions.push({
      name: nameNode.text,
      owner: receiverType ?? null,
      lineRange: [
        node.startPosition.row + 1,
        node.endPosition.row + 1,
      ],
      params,
      returnType,
    });

    if (receiverType) {
      if (!methodsByReceiver.has(receiverType)) {
        methodsByReceiver.set(receiverType, []);
      }
      methodsByReceiver.get(receiverType)!.push(nameNode.text);
    }

    if (isExported(nameNode.text)) {
      exports.push({
        name: nameNode.text,
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  private extractTypeDeclaration(
    node: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const typeSpec = findChild(node, "type_spec");
    if (!typeSpec) return;

    const nameNode = typeSpec.childForFieldName("name");
    const typeNode = typeSpec.childForFieldName("type");
    if (!nameNode || !typeNode) return;

    if (typeNode.type === "struct_type") {
      this.extractStruct(node, nameNode, typeNode, classes, exports);
    } else if (typeNode.type === "interface_type") {
      this.extractInterface(node, nameNode, typeNode, classes, exports);
    }
  }

  private extractStruct(
    declNode: TreeSitterNode,
    nameNode: TreeSitterNode,
    structNode: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const properties: string[] = [];

    const fieldList = findChild(structNode, "field_declaration_list");
    if (fieldList) {
      const fields = findChildren(fieldList, "field_declaration");
      for (const field of fields) {
        for (let i = 0; i < field.childCount; i++) {
          const child = field.child(i);
          if (child && child.type === "field_identifier") {
            properties.push(child.text);
          }
        }
      }
    }

    classes.push({
      name: nameNode.text,
      lineRange: [
        declNode.startPosition.row + 1,
        declNode.endPosition.row + 1,
      ],
      methods: [],
      properties,
    });

    if (isExported(nameNode.text)) {
      exports.push({
        name: nameNode.text,
        lineNumber: declNode.startPosition.row + 1,
      });
    }
  }

  private extractInterface(
    declNode: TreeSitterNode,
    nameNode: TreeSitterNode,
    interfaceNode: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const methods: string[] = [];

    const methodElems = findChildren(interfaceNode, "method_elem");
    for (const elem of methodElems) {
      const methName = elem.childForFieldName("name");
      if (methName) {
        methods.push(methName.text);
      }
    }

    classes.push({
      name: nameNode.text,
      lineRange: [
        declNode.startPosition.row + 1,
        declNode.endPosition.row + 1,
      ],
      methods,
      properties: [],
    });

    if (isExported(nameNode.text)) {
      exports.push({
        name: nameNode.text,
        lineNumber: declNode.startPosition.row + 1,
      });
    }
  }

  private extractImportDeclaration(
    node: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const specList = findChild(node, "import_spec_list");
    if (specList) {
      const specs = findChildren(specList, "import_spec");
      for (const spec of specs) {
        this.extractImportSpec(spec, imports);
      }
    } else {
      const spec = findChild(node, "import_spec");
      if (spec) {
        this.extractImportSpec(spec, imports);
      }
    }
  }

  private extractImportSpec(
    spec: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const pathNode = spec.childForFieldName("path");
    if (!pathNode) return;

    const pathContent = findChild(pathNode, "interpreted_string_literal_content");
    const source = pathContent ? pathContent.text : pathNode.text.replace(/^"|"$/g, "");

    const nameNode = spec.childForFieldName("name");
    let specifier: string;
    if (nameNode) {
      specifier = nameNode.text;
    } else {
      const parts = source.split("/");
      specifier = parts[parts.length - 1];
    }

    imports.push({
      source,
      specifiers: [specifier],
      lineNumber: spec.startPosition.row + 1,
    });
  }
}
