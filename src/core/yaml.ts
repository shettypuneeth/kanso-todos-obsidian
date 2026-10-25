import { isAlias, isMap, isScalar, parseDocument, visit } from "yaml";

/** Parses the safe YAML subset shared by all Kanso widget schemas. */
export function readYamlDocument(source: string) {
  const document = parseDocument(source, { version: "1.2", uniqueKeys: true });

  if (document.errors.length) throw new Error(`Invalid YAML: ${document.errors[0]!.message}`);
  if (document.warnings.length) throw new Error(`Unsupported YAML: ${document.warnings[0]!.message}`);

  visit(document, (_key, node) => {
    if (isAlias(node) || (node && typeof node === "object" && "tag" in node && node.tag)) {
      throw new Error("YAML aliases and explicit tags are not supported. Use ordinary fields.");
    }

    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value === "<<") {
          throw new Error("Use string field names without YAML merge keys.");
        }
      }
    }
  });

  return document;
}
