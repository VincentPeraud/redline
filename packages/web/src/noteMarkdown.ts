export type NoteInline =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "link"; text: string; href: string };

export type NoteBlock = { type: "paragraph"; content: NoteInline[] } | { type: "list"; items: NoteInline[][] };

const INLINE = /\*\*([^*]+)\*\*|\*([^*]+)\*|(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function parseInline(source: string): NoteInline[] {
  const out: NoteInline[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (text === "") return;
    const previous = out[out.length - 1];
    if (previous?.type === "text") previous.text += text;
    else out.push({ type: "text", text });
  };
  for (const match of source.matchAll(INLINE)) {
    pushText(source.slice(last, match.index));
    if (match[1] !== undefined) out.push({ type: "bold", text: match[1] });
    else if (match[2] !== undefined) out.push({ type: "italic", text: match[2] });
    else out.push({ type: "link", text: match[3]!, href: match[4]! });
    last = match.index + match[0].length;
  }
  pushText(source.slice(last));
  return out;
}

/** The markdown subset of text and sticky notes: bold, italic, bullet lists, http(s) links. Anything else stays plain text. */
export function parseNoteMarkdown(source: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let paragraph: string[] = [];
  let items: NoteInline[][] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", content: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (items.length > 0) blocks.push({ type: "list", items });
    items = [];
  };
  for (const line of source.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      items.push(parseInline(bullet[1]!));
      continue;
    }
    flushList();
    if (line.trim() === "") flushParagraph();
    else paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}
