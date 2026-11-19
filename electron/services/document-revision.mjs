import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** @param {{ title?: unknown, content?: unknown, markdown?: unknown, bindings?: unknown, updatedAt?: unknown }} doc */
export function documentRevision(doc) {
  return bytesToHex(
    sha256(
      utf8ToBytes(
        JSON.stringify({
          title: doc.title,
          content: doc.content,
          markdown: doc.markdown,
          bindings: doc.bindings,
          updatedAt: doc.updatedAt,
        }),
      ),
    ),
  );
}

export class DocumentConflictError extends Error {
  code = "document-conflict";

  constructor(message = "文档已在其他位置修改，请先另存副本，再重新打开文档。") {
    super(message);
    this.name = "DocumentConflictError";
  }
}
