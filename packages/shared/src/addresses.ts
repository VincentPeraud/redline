/** Web routes (hash part) of a page, one of its artboards on the canvas, and one of its artboards in play mode; the router and the agent's addresses for Claude build them here. */
export const pageHash = (pageId: string): string => `#/pages/${encodeURIComponent(pageId)}`;
export const artboardHash = (pageId: string, file: string): string => `${pageHash(pageId)}/artboards/${encodeURIComponent(file)}`;
export const playHash = (pageId: string, file: string): string => `${pageHash(pageId)}/play/${encodeURIComponent(file)}`;
