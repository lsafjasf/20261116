// Stable serialization: object keys sorted recursively so identical data
// always yields identical bytes regardless of insertion order.
export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = keys
    .filter((key) => value[key] !== undefined)
    .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]));
  return "{" + parts.join(",") + "}";
}

// 32-bit FNV-1a over UTF-8 bytes. Returned as 8 uppercase hex chars so the
// checksum is easy to spot in the UI and in logs.
export function checksum(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

export function checksumText(text) {
  return checksum(new TextEncoder().encode(text));
}
