import { createHash } from "node:crypto";

// Canonical JSON and the content hash (decision H6-5). The output is what
// JSON.stringify would write for the same value, except that object keys are
// sorted recursively (plain code-unit order) and there is no whitespace:
// - undefined, functions and symbols are dropped from objects and become null
//   in arrays; a top-level one gives undefined, as JSON.stringify does;
// - non-finite numbers are null, -0 is 0;
// - toJSON() is honoured (a Date becomes its ISO string);
// - a BigInt or a cycle throws a TypeError.
// The client keeps its own copy (src/lib/syncRecords.js) and
// scripts/verify-server-contract.mjs asserts both are byte-identical.

export function canonicalJson(value) {
  return serialize(value, "", new Set());
}

function serialize(input, key, stack) {
  let value = input;

  if (value !== null && (typeof value === "object" || typeof value === "bigint") && typeof value.toJSON === "function") {
    value = value.toJSON(key);
  }

  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }

  // Boxed primitives serialize as their primitive value, as in JSON.stringify.
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return serialize(value.valueOf(), key, stack);
  }

  if (stack.has(value)) {
    throw new TypeError("Converting circular structure to JSON");
  }

  stack.add(value);

  try {
    if (Array.isArray(value)) {
      const items = [];

      for (let index = 0; index < value.length; index += 1) {
        const item = serialize(value[index], String(index), stack);
        items.push(item === undefined ? "null" : item);
      }

      return `[${items.join(",")}]`;
    }

    const parts = [];

    for (const name of Object.keys(value).sort()) {
      const item = serialize(value[name], name, stack);

      if (item !== undefined) {
        parts.push(`${JSON.stringify(name)}:${item}`);
      }
    }

    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

export function sha256Hex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

// The hash a record is stored under: "deleted" for a tombstone, otherwise the
// SHA-256 hex of the body's canonical JSON. The server never trusts a hash
// sent by a client.
export const DELETED_HASH = "deleted";

export function contentHash(body, deleted) {
  if (deleted) {
    return DELETED_HASH;
  }

  return sha256Hex(canonicalJson(body));
}
