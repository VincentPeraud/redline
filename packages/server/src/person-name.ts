/** How a person is named on screen and in messages: the name, else the e-mail, else `fallback`. */
export const nameOf = (person: { name: string; email: string } | undefined, fallback = ""): string => person?.name || person?.email || fallback;
