/**
 * Extract file blocks from an agent's markdown output.
 * Expects:
 *   ## File: path/to/file.ts
 *   ```lang
 *   ...content...
 *   ```
 * Shared by the scaffold (greenfield) and workspace-mode apply.
 */
export function extractFiles(output: string): Map<string, string> {
  const files = new Map<string, string>();
  const pattern = /## File:\s*(.+)\n\s*```\w*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    const filePath = match[1].trim();
    const content = match[2].trimEnd() + "\n";
    files.set(filePath, content);
  }

  return files;
}

/**
 * Extract the first fenced code block's contents, ignoring the language tag.
 * Fallback for models (esp. small local ones) that emit a bare ```block``` without
 * the `## File:` header when only one target file is in play.
 */
export function extractFencedBlock(output: string): string | undefined {
  const m = output.match(/```\w*\n([\s\S]*?)```/);
  return m ? m[1].trimEnd() + "\n" : undefined;
}
