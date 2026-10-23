/** "7c2e…a91": the start and end of an engine session id. */
export function shortSessionId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-3)}`;
}
