import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild, findChildren, getStringValue } from "./base-extractor.js";

function isExported(name: string): boolean {
  return !name.startsWith("_");
}

function extractFunctionName(sig: TreeSitterNode): string | null {
  const id = findChild(sig, "identifier");
  return id ? id.text : null;
}

function extractParamName(paramNode: TreeSitterNode): string | null {
  const direct = findChild(paramNode, "identifier");
  if (direct) return direct.text;

  for (let i = 0; i < paramNode.childCount; i++) {
    const child = paramNode.child(i);
    if (!child) continue;
    if (child.type === "constructor_param" || child.type === "super_formal_parameter") {
      let last: string | null = null;
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (inner && inner.type === "identifier") last = inner.text;
      }
      if (last) return last;
    }
  }
  return null;
}

function extractParams(sig: TreeSitterNode): string[] {
  const params: string[] = [];
  const list = findChild(sig, "formal_parameter_list");
  if (!list) return params;
  for (let i = 0; i < list.childCount; i++) {
    const child = list.child(i);
    if (!child) continue;
    if (child.type === "formal_parameter") {
      const name = extractParamName(child);
      if (name) params.push(name);
    } else if (child.type === "optional_formal_parameters") {
      for (const sub of findChildren(child, "formal_parameter")) {
        const name = extractParamName(sub);
        if (name) params.push(name);
      }
    }
  }
  return params;
}

function extractReturnType(sig: TreeSitterNode): string | undefined {
  const parts: string[] = [];
  for (let i = 0; i < sig.childCount; i++) {
    const child = sig.child(i);
    if (!child || !child.isNamed) continue;
    if (
      child.type === "identifier" ||
      child.type === "formal_parameter_list" ||
      child.type === "type_parameters"
    ) {
      break;
    }
    parts.push(child.text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function pushMethod(
  declNode: TreeSitterNode,
  sig: TreeSitterNode,
  name: string,
  methods: string[],
  functions: StructuralAnalysis["functions"],
  exports: StructuralAnalysis["exports"],
): void {
  methods.push(name);
  functions.push({
    name,
    lineRange: [declNode.startPosition.row + 1, declNode.endPosition.row + 1],
    params: extractParams(sig),
    returnType: extractReturnType(sig),
  });
  if (isExported(name)) {
    exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
  }
}

function uriText(uriNode: TreeSitterNode): string | null {
  const lit = findChild(uriNode, "string_literal");
  if (!lit) return null;
  return getStringValue(lit);
}

function constructorName(sig: TreeSitterNode): string | null {
  const ids = findChildren(sig, "identifier");
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0].text;
  return `${ids[0].text}.${ids[1].text}`;
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

    if (member.type === "method_signature") {
      const factory = findChild(member, "factory_constructor_signature");
      if (factory) {
        const name = constructorName(factory);
        if (name) {
          pushMethod(member, factory, name, methods, functions, exports);
        }
        continue;
      }
      const getter = findChild(member, "getter_signature");
      if (getter) {
        const name = extractFunctionName(getter);
        if (name) pushMethod(member, getter, name, methods, functions, exports);
        continue;
      }
      const setter = findChild(member, "setter_signature");
      if (setter) {
        const name = extractFunctionName(setter);
        if (name) pushMethod(member, setter, name, methods, functions, exports);
        continue;
      }
      const inner = findChild(member, "function_signature");
      if (!inner) continue;
      const name = extractFunctionName(inner);
      if (!name) continue;
      pushMethod(member, inner, name, methods, functions, exports);
    } else if (member.type === "declaration") {
      const ctor = findChild(member, "constructor_signature");
      if (ctor) {
        const name = constructorName(ctor);
        if (name) {
          pushMethod(member, ctor, name, methods, functions, exports);
        }
        continue;
      }
      const absGetter = findChild(member, "getter_signature");
      if (absGetter) {
        const name = extractFunctionName(absGetter);
        if (name) pushMethod(member, absGetter, name, methods, functions, exports);
        continue;
      }
      const absSetter = findChild(member, "setter_signature");
      if (absSetter) {
        const name = extractFunctionName(absSetter);
        if (name) pushMethod(member, absSetter, name, methods, functions, exports);
        continue;
      }
      const fnSig = findChild(member, "function_signature");
      if (fnSig) {
        const name = extractFunctionName(fnSig);
        if (name) {
          pushMethod(member, fnSig, name, methods, functions, exports);
        }
        continue;
      }
      const list = findChild(member, "initialized_identifier_list");
      if (!list) continue;
      for (const init of findChildren(list, "initialized_identifier")) {
        const id = findChild(init, "identifier");
        if (id) properties.push(id.text);
      }
    }
  }
}

export class DartExtractor implements LanguageExtractor {
  readonly languageIds = ["dart"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    for (let i = 0; i < rootNode.childCount; i++) {
      const node = rootNode.child(i);
      if (!node) continue;

      switch (node.type) {
        case "function_signature":
          this.extractTopLevelFunction(node, functions, exports);
          break;
        case "class_definition":
          this.extractClassLikeDeclaration(node, "class_body", classes, functions, exports);
          break;
        case "mixin_declaration":
          this.extractClassLikeDeclaration(node, "class_body", classes, functions, exports);
          break;
        case "extension_declaration":
          this.extractExtensionDeclaration(node, classes, functions, exports);
          break;
        case "enum_declaration":
          this.extractEnumDeclaration(node, classes, exports);
          break;
        case "import_or_export":
          this.extractImportOrExport(node, imports, exports);
          break;
      }
    }

    return { functions, classes, imports, exports };
  }

  private extractTopLevelFunction(
    sig: TreeSitterNode,
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const name = extractFunctionName(sig);
    if (!name) return;
    functions.push({
      name,
      lineRange: [sig.startPosition.row + 1, sig.endPosition.row + 1],
      params: extractParams(sig),
      returnType: extractReturnType(sig),
    });
    if (isExported(name)) {
      exports.push({ name, lineNumber: sig.startPosition.row + 1 });
    }
  }

  private extractClassLikeDeclaration(
    declNode: TreeSitterNode,
    bodyNodeType: string,
    classes: StructuralAnalysis["classes"],
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
    nameOverride?: string,
  ): void {
    let name: string;
    if (nameOverride !== undefined) {
      name = nameOverride;
    } else {
      const nameNode = findChild(declNode, "identifier");
      if (!nameNode) return;
      name = nameNode.text;
    }

    const methods: string[] = [];
    const properties: string[] = [];

    const body = findChild(declNode, bodyNodeType);
    if (body) {
      collectClassBody(body, methods, properties, functions, exports);
    }

    classes.push({
      name,
      lineRange: [declNode.startPosition.row + 1, declNode.endPosition.row + 1],
      methods,
      properties,
    });

    if (isExported(name)) {
      exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
    }
  }

  private extractExtensionDeclaration(
    declNode: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
    functions: StructuralAnalysis["functions"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const idNode = findChild(declNode, "identifier");
    if (idNode) {
      this.extractClassLikeDeclaration(
        declNode,
        "extension_body",
        classes,
        functions,
        exports,
      );
      return;
    }

    const onType = findChild(declNode, "type_identifier");
    if (!onType) return;
    this.extractClassLikeDeclaration(
      declNode,
      "extension_body",
      classes,
      functions,
      exports,
      `on ${onType.text}`,
    );
  }

  private extractEnumDeclaration(
    declNode: TreeSitterNode,
    classes: StructuralAnalysis["classes"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const nameNode = findChild(declNode, "identifier");
    if (!nameNode) return;
    const name = nameNode.text;

    const properties: string[] = [];
    const body = findChild(declNode, "enum_body");
    if (body) {
      for (const k of findChildren(body, "enum_constant")) {
        const id = findChild(k, "identifier");
        if (id) properties.push(id.text);
      }
    }

    classes.push({
      name,
      lineRange: [declNode.startPosition.row + 1, declNode.endPosition.row + 1],
      methods: [],
      properties,
    });

    if (isExported(name)) {
      exports.push({ name, lineNumber: declNode.startPosition.row + 1 });
    }
  }

  private extractImportOrExport(
    declNode: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
    exports: StructuralAnalysis["exports"],
  ): void {
    const libImport = findChild(declNode, "library_import");
    if (libImport) {
      this.extractLibraryImport(libImport, imports);
      return;
    }
    const libExport = findChild(declNode, "library_export");
    if (libExport) {
      this.extractLibraryExport(libExport, declNode, exports);
    }
  }

  private extractLibraryImport(
    libImport: TreeSitterNode,
    imports: StructuralAnalysis["imports"],
  ): void {
    const spec = findChild(libImport, "import_specification");
    if (!spec) return;

    const configurable = findChild(spec, "configurable_uri");
    const uri = configurable ? findChild(configurable, "uri") : null;
    if (!uri) return;
    const source = uriText(uri);
    if (!source) return;

    const specifiers: string[] = [];

    const combinators = findChildren(spec, "combinator");
    for (const c of combinators) {
      const first = c.child(0);
      if (first && first.type === "hide") continue;
      for (const id of findChildren(c, "identifier")) {
        specifiers.push(id.text);
      }
    }

    const asId = findChild(spec, "identifier");
    if (asId && specifiers.length === 0) {
      specifiers.push(asId.text);
    }

    imports.push({
      source,
      specifiers,
      lineNumber: libImport.startPosition.row + 1,
    });
  }

  private extractLibraryExport(
    libExport: TreeSitterNode,
    outerNode: TreeSitterNode,
    exports: StructuralAnalysis["exports"],
  ): void {
    const configurable = findChild(libExport, "configurable_uri");
    const uri = configurable ? findChild(configurable, "uri") : null;
    if (!uri) return;
    const source = uriText(uri);
    if (!source) return;
    exports.push({
      name: source,
      lineNumber: outerNode.startPosition.row + 1,
    });
  }

  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[] {
    const entries: CallGraphEntry[] = [];
    const functionStack: string[] = [];

    const walkNode = (node: TreeSitterNode) => {
      if (
        node.type === "selector" &&
        findChild(node, "argument_part") &&
        functionStack.length > 0
      ) {
        const callee = this.extractCalleeName(node);
        if (callee) {
          entries.push({
            caller: functionStack[functionStack.length - 1],
            callee,
            lineNumber: node.startPosition.row + 1,
          });
        }
      }

      if (
        (node.type === "const_object_expression" ||
          node.type === "new_expression") &&
        functionStack.length > 0
      ) {
        const typeNode = findChild(node, "type_identifier");
        if (typeNode) {
          entries.push({
            caller: functionStack[functionStack.length - 1],
            callee: typeNode.text,
            lineNumber: node.startPosition.row + 1,
          });
        }
      }

      walkSiblings(node);
    };

    const walkSiblings = (parent: TreeSitterNode) => {
      let pendingName: string | null = null;

      for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (!child) continue;

        if (child.type === "function_signature") {
          pendingName = extractFunctionName(child);
          walkSiblings(child);
        } else if (child.type === "method_signature") {
          const fn =
            findChild(child, "function_signature") ??
            findChild(child, "getter_signature") ??
            findChild(child, "setter_signature");
          if (fn) {
            pendingName = extractFunctionName(fn);
          } else {
            const ctor =
              findChild(child, "constructor_signature") ??
              findChild(child, "factory_constructor_signature");
            if (ctor) pendingName = constructorName(ctor);
          }
          walkSiblings(child);
        } else if (child.type === "function_body") {
          const pushed = pendingName !== null;
          if (pendingName) {
            functionStack.push(pendingName);
            pendingName = null;
          }
          walkNode(child);
          if (pushed) functionStack.pop();
        } else {
          walkNode(child);
        }
      }
    };

    walkSiblings(rootNode);
    return entries;
  }

  private extractCalleeName(callSelector: TreeSitterNode): string | null {
    const parent = callSelector.parent;
    if (!parent) return null;

    let myIdx = -1;
    for (let i = 0; i < parent.childCount; i++) {
      const c = parent.child(i);
      if (c && c.startIndex === callSelector.startIndex) {
        myIdx = i;
        break;
      }
    }
    if (myIdx <= 0) return null;

    const prev = parent.child(myIdx - 1);
    if (!prev) return null;

    if (prev.type === "identifier") return prev.text;

    if (prev.type === "selector") {
      const inner = findChild(prev, "unconditional_assignable_selector");
      if (inner) {
        let last: string | null = null;
        for (let i = 0; i < inner.childCount; i++) {
          const child = inner.child(i);
          if (child && child.type === "identifier") last = child.text;
        }
        return last;
      }
    }

    return null;
  }
}
