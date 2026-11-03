export const OPEN_MARKDOWN_IMPORT = "helself:open-markdown-import";
export const MARKDOWN_IMPORTED = "helself:markdown-imported";

export function requestMarkdownImport() {
  window.dispatchEvent(new Event(OPEN_MARKDOWN_IMPORT));
}
