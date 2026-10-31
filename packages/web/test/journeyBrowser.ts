import { chromium, type Browser, type BrowserContextOptions } from "playwright";

/**
 * Chromium for the journeys, every tab starting with the "Vue d'ensemble" mini-map folded: open, it repeats the canvas's text
 * and elements, which page-wide lookups would then find twice. The canvas overview journey opens it itself.
 */
export async function launchBrowser(): Promise<Browser> {
  const browser = await chromium.launch();
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options?: BrowserContextOptions) => {
    const context = await newContext(options);
    await context.addInitScript(() => {
      if (localStorage.getItem("redline:overview") === null) localStorage.setItem("redline:overview", "0");
    });
    return context;
  };
  browser.newPage = async (options?: BrowserContextOptions) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on("close", () => void context.close());
    return page;
  };
  return browser;
}
