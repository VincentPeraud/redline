import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { askSecret } from "../src/secret-prompt.js";

/** A terminal the test types into, recording what the prompt echoes and whether raw mode is on. */
function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      input.isRaw = raw;
      return input;
    },
  });
  let echoed = "";
  const output = { write: (text: string) => ((echoed += text), true) };
  return { input, output, echoed: () => echoed };
}

describe("asking for a secret", () => {
  it("echoes a star per character, even for a pasted secret", async () => {
    const term = terminal();
    const answer = askSecret("Token: ", term);
    term.input.write("abt_123");
    term.input.write("\r");
    expect(await answer).toBe("abt_123");
    expect(term.echoed()).toBe("Token: *******\n");
    expect(term.input.isRaw).toBe(false);
  });

  it("erases the last character on backspace", async () => {
    const term = terminal();
    const answer = askSecret("Token: ", term);
    term.input.write("abx\u007fc\r");
    expect(await answer).toBe("abc");
    expect(term.echoed()).toBe("Token: ***\b \b*\n");
  });

  it("ignores arrow keys and other control sequences", async () => {
    const term = terminal();
    const answer = askSecret("Token: ", term);
    term.input.write("ab");
    term.input.write("\u001b[D");
    term.input.write("\tc\n");
    expect(await answer).toBe("abc");
  });

  it("gives up on Ctrl-C", async () => {
    const term = terminal();
    const answer = askSecret("Token: ", term);
    term.input.write("ab\u0003");
    await expect(answer).rejects.toThrow("Cancelled.");
    expect(term.input.isRaw).toBe(false);
  });

  it("reads a piped secret as a plain line", async () => {
    const input = new PassThrough();
    let echoed = "";
    const answer = askSecret("Token: ", { input, output: { write: (text: string) => ((echoed += text), true) } });
    input.end("abt_456\n");
    expect(await answer).toBe("abt_456");
    expect(echoed).toBe("Token: ");
  });
});
