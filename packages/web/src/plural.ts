/** The word agreeing with a count, in French: 0 and 1 are singular ("0 composant", "2 composants"). */
export const agree = (count: number, one: string, many: string): string => (count > 1 ? many : one);

/** "1 composant", "3 composants". */
export const counted = (count: number, one: string, many: string): string => `${count} ${agree(count, one, many)}`;
