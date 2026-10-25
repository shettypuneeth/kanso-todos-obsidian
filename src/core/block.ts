import { parseDocument } from "yaml";

export interface BlockTarget {
  id?: string;
  line: number;
  source: string;
}

export interface Fence {
  line: number;
  start: number;
  end: number;
  source: string;
}

/** Finds editable top-level fences for one Kanso widget language. */
export function fences(text: string, language: string): Fence[] {
  const result: Fence[] = [];
  const lines = text.match(/.*(?:\r?\n|$)/g) ?? [];

  let offset = 0;
  let open: { marker: string; size: number; widget: boolean; line: number; start: number } | undefined;

  lines.forEach((raw, line) => {
    const value = raw.replace(/\r?\n$/, "");

    if (open) {
      const close = value.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);

      if (close && close[1]![0] === open.marker && close[1]!.length >= open.size) {
        if (open.widget) {
          result.push({
            line: open.line,
            start: open.start,
            end: offset,
            source: text.slice(open.start, offset),
          });
        }

        open = undefined;
      }
    } else {
      const match = value.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);

      if (match) {
        open = {
          marker: match[2]![0]!,
          size: match[2]!.length,
          widget: match[1] === "" && match[3]!.trim() === language,
          line,
          start: offset + raw.length,
        };
      }
    }

    offset += raw.length;
  });

  return result;
}

function fenceId(fence: Fence): unknown {
  return parseDocument(fence.source).get("id");
}

/** Relocates a widget block against the latest note source before a mutation. */
export function locateBlock(
  text: string,
  target: BlockTarget,
  language: string,
  messages: {
    duplicate?: string;
    missing?: string;
    ambiguous?: string;
  } = {},
): Fence {
  const all = fences(text, language);

  if (target.id) {
    const matches = all.filter(fence => fenceId(fence) === target.id);

    if (matches.length !== 1) {
      throw new Error(matches.length
        ? messages.duplicate ?? "Duplicate widget block id. Fix copied IDs in Source mode."
        : messages.missing ?? "This widget block moved or was removed. Reopen the note.");
    }

    return matches[0]!;
  }

  const matches = all.filter(fence => fence.source.trim() === target.source.trim());
  const atLine = matches.find(fence => fence.line === target.line);

  if (atLine) return atLine;
  if (matches.length === 1) return matches[0]!;

  throw new Error(messages.ambiguous ??
    `Cannot safely locate this block. Use a top-level ${language} fence in the source note.`);
}
