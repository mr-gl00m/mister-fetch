import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Tool, ToolContext } from './registry.js';
import { assertPublicUrl } from './ssrf.js';

/**
 * Headless-Chromium browser tool. Provides a persistent, per-fetch browser
 * context so a Fetch can navigate → extract → click → re-extract across
 * multiple tool calls. The contract is built around mister-fetch's
 * throw-on-error Tool interface, with return values shaped as structured
 * data (so the validator's grounding corpus can tokenize page text, not a
 * pre-formatted string).
 *
 * Isolation: each Fetch ID gets its own BrowserContext (separate cookies,
 * localStorage, cache). Contexts share a single Chromium process. Idle
 * sessions are torn down after 5 minutes; supervisor.stop() tears
 * everything down via shutdownBrowser().
 *
 * Security:
 *  - Headless. No visible window.
 *  - http/https only — no file://, data://, javascript://.
 *  - Private IPs, link-local, and cloud-metadata hosts blocked (SSRF).
 *  - localhost blocked (no useful target for a web-research fetch).
 *  - No page.evaluate of arbitrary agent-supplied JS.
 *  - Screenshots jailed under {cwd}/.mister-fetch/screenshots.
 */

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  idleTimer: ReturnType<typeof setTimeout>;
}

let browser: Browser | null = null;
let browserPending: Promise<Browser> | null = null;
let keepWarm = false;
const sessions = new Map<string, BrowserSession>();

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const MAX_TEXT_LENGTH = 50_000;
const NAV_TEXT_LENGTH = 8_000;
const SCREENSHOT_DIR = '.mister-fetch/screenshots';
const DEFAULT_SESSION_KEY = '__default__';

async function ensureBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (browserPending) return browserPending;
  console.warn('[browser] launching headless Chromium...');
  browserPending = chromium
    .launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
      ],
    })
    .then((b) => {
      browser = b;
      browserPending = null;
      return b;
    })
    .catch((e) => {
      browserPending = null;
      throw e;
    });
  return browserPending;
}

/**
 * Pre-launch Chromium at supervisor start so the first browser-using Fetch
 * pays ~100ms for a fresh context instead of ~1.5s for a cold launch. Also
 * sets keepWarm=true so the browser process survives across Fetch boundaries
 * (individual per-Fetch contexts still tear down on idle/session close).
 * Fire-and-forget from supervisor.start(); failures are logged and swallowed.
 */
export async function warmupBrowser(): Promise<void> {
  keepWarm = true;
  try {
    await ensureBrowser();
  } catch (e) {
    console.warn('[browser] warmup failed:', e instanceof Error ? e.message : String(e));
  }
}

function touchIdle(key: string): void {
  const session = sessions.get(key);
  if (!session) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    void closeBrowserSession(key);
  }, IDLE_TIMEOUT_MS);
}

async function ensurePage(key: string): Promise<Page> {
  const existing = sessions.get(key);
  if (existing && !existing.page.isClosed()) {
    touchIdle(key);
    return existing.page;
  }
  if (existing) await closeBrowserSession(key);

  const b = await ensureBrowser();
  const context = await b.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    acceptDownloads: false,
  });
  await context.route('**/*', async (route) => {
    try {
      await assertPublicUrl(route.request().url());
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);

  const idleTimer = setTimeout(() => {
    void closeBrowserSession(key);
  }, IDLE_TIMEOUT_MS);
  sessions.set(key, { context, page, idleTimer });
  return page;
}

export async function closeBrowserSession(key: string): Promise<void> {
  const session = sessions.get(key);
  if (!session) return;
  clearTimeout(session.idleTimer);
  sessions.delete(key);
  try { await session.page.close(); } catch { /* ignore */ }
  try { await session.context.close(); } catch { /* ignore */ }
  if (!keepWarm && sessions.size === 0 && browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
  }
}

export async function shutdownBrowser(): Promise<void> {
  keepWarm = false;
  const keys = [...sessions.keys()];
  await Promise.all(keys.map((k) => closeBrowserSession(k)));
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
  }
}

interface BrowserArgs {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  direction?: string;
  fullPage?: boolean;
}

function parseArgs(raw: unknown): BrowserArgs {
  if (!raw || typeof raw !== 'object') {
    throw new Error('browser: args must be an object');
  }
  const r = raw as Record<string, unknown>;
  const action = typeof r.action === 'string' ? r.action : '';
  if (!action) throw new Error('browser: missing required "action"');
  return {
    action,
    url: typeof r.url === 'string' ? r.url : undefined,
    selector: typeof r.selector === 'string' ? r.selector : undefined,
    text: typeof r.text === 'string' ? r.text : undefined,
    key: typeof r.key === 'string' ? r.key : undefined,
    direction: typeof r.direction === 'string' ? r.direction : undefined,
    fullPage: typeof r.fullPage === 'boolean' ? r.fullPage : false,
  };
}

async function extractBodyText(p: Page): Promise<string> {
  return p.evaluate(() => {
    function extract(el: Element): string {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD'].includes(el.tagName)) return '';
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
      let out = '';
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent?.trim();
          if (t) out += t + ' ';
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          out += extract(child as Element);
        }
      }
      return out;
    }
    return extract(document.body).replace(/\s+/g, ' ').trim();
  });
}

interface NavigateResult {
  action: 'navigate';
  url: string;
  status: number;
  title: string;
  text: string;
  truncated: boolean;
}

async function actionNavigate(p: Page, url: string): Promise<NavigateResult> {
  try {
    await assertPublicUrl(url);
  } catch {
    throw new Error(`url blocked by security policy: ${url} (only public http/https allowed)`);
  }
  const response = await p.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT_MS,
  });
  const status = response?.status() ?? 0;
  const title = await p.title();
  let text = '';
  try {
    text = await extractBodyText(p);
  } catch {
    text = '';
  }
  const truncated = text.length > NAV_TEXT_LENGTH;
  if (truncated) text = text.slice(0, NAV_TEXT_LENGTH);
  return {
    action: 'navigate',
    url: p.url(),
    status,
    title,
    text,
    truncated,
  };
}

async function actionClick(p: Page, selector: string): Promise<unknown> {
  await p.click(selector, { timeout: ACTION_TIMEOUT_MS });
  await p.waitForTimeout(1000);
  return {
    action: 'click',
    selector,
    url: p.url(),
    title: await p.title(),
  };
}

async function actionType(p: Page, selector: string, text: string): Promise<unknown> {
  try {
    await p.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
  } catch {
    await p.click(selector, { timeout: ACTION_TIMEOUT_MS });
    await p.keyboard.type(text, { delay: 20 });
  }
  return { action: 'type', selector, length: text.length };
}

async function actionPressKey(p: Page, key: string): Promise<unknown> {
  await p.keyboard.press(key);
  await p.waitForTimeout(1000);
  return { action: 'press_key', key, url: p.url() };
}

async function actionGetText(p: Page, selector?: string): Promise<unknown> {
  let text: string;
  if (selector) {
    text = await p.locator(selector).first().innerText({ timeout: ACTION_TIMEOUT_MS });
  } else {
    text = await extractBodyText(p);
  }
  const truncated = text.length > MAX_TEXT_LENGTH;
  if (truncated) text = text.slice(0, MAX_TEXT_LENGTH);
  return { action: 'get_text', selector: selector ?? null, text, truncated };
}

async function actionGetLinks(p: Page, selector?: string): Promise<unknown> {
  const links = await p.evaluate((sel) => {
    const container = sel ? document.querySelector(sel) ?? document.body : document.body;
    const anchors = container.querySelectorAll('a[href]');
    const out: Array<{ text: string; href: string }> = [];
    for (const a of anchors) {
      const t = (a as HTMLAnchorElement).innerText?.trim().slice(0, 120) ?? '';
      const href = (a as HTMLAnchorElement).href;
      if (t && href && !href.startsWith('javascript:')) {
        out.push({ text: t, href });
      }
      if (out.length >= 50) break;
    }
    return out;
  }, selector ?? null);
  return { action: 'get_links', count: links.length, links };
}

async function actionScroll(p: Page, direction: string): Promise<unknown> {
  const amount = direction === 'up' ? -600 : 600;
  await p.evaluate((dy) => window.scrollBy(0, dy), amount);
  await p.waitForTimeout(500);
  const position = await p.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  }));
  return { action: 'scroll', direction, ...position };
}

async function actionScreenshot(p: Page, fullPage: boolean): Promise<unknown> {
  const workspace = process.cwd();
  const dir = join(workspace, SCREENSHOT_DIR);
  await mkdir(dir, { recursive: true });
  const filename = `screenshot-${Date.now()}.png`;
  const filePath = join(dir, filename);
  await p.screenshot({ path: filePath, fullPage, type: 'png' });
  return {
    action: 'screenshot',
    path: relative(workspace, filePath),
    url: p.url(),
    title: await p.title(),
  };
}

async function actionWaitFor(p: Page, selector: string): Promise<unknown> {
  await p.waitForSelector(selector, { timeout: ACTION_TIMEOUT_MS, state: 'visible' });
  return { action: 'wait_for', selector, visible: true };
}

export const browserTool: Tool = {
  name: 'browser',
  description:
    'Headless browser. Args: { action: "navigate"|"click"|"type"|"press_key"|"get_text"|"get_links"|"scroll"|"screenshot"|"wait_for"|"close", url?, selector?, text?, key?, direction?, fullPage? }. ' +
    'Use navigate to open a URL — returns { url, status, title, text } with up to ~8000 chars of visible page text (grounding-quality). ' +
    'Use get_text (optionally with a CSS selector) to re-read the current page. ' +
    'Use get_links for an anchor list. ' +
    'State persists across calls within a single Fetch.',

  async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
    const parsed = parseArgs(args);
    const sessionKey = ctx.sessionKey ?? DEFAULT_SESSION_KEY;

    if (parsed.action === 'close') {
      await closeBrowserSession(sessionKey);
      return { action: 'close', closed: true };
    }

    const page = await ensurePage(sessionKey);

    switch (parsed.action) {
      case 'navigate': {
        if (!parsed.url) throw new Error('browser.navigate: missing "url"');
        return actionNavigate(page, parsed.url);
      }
      case 'click': {
        if (!parsed.selector) throw new Error('browser.click: missing "selector"');
        return actionClick(page, parsed.selector);
      }
      case 'type': {
        if (!parsed.selector) throw new Error('browser.type: missing "selector"');
        if (parsed.text === undefined) throw new Error('browser.type: missing "text"');
        return actionType(page, parsed.selector, parsed.text);
      }
      case 'press_key': {
        if (!parsed.key) throw new Error('browser.press_key: missing "key"');
        return actionPressKey(page, parsed.key);
      }
      case 'get_text':
        return actionGetText(page, parsed.selector);
      case 'get_links':
        return actionGetLinks(page, parsed.selector);
      case 'scroll':
        return actionScroll(page, parsed.direction ?? 'down');
      case 'screenshot':
        return actionScreenshot(page, parsed.fullPage ?? false);
      case 'wait_for': {
        if (!parsed.selector) throw new Error('browser.wait_for: missing "selector"');
        return actionWaitFor(page, parsed.selector);
      }
      default:
        throw new Error(
          `browser: unknown action "${parsed.action}" — available: navigate, click, type, press_key, get_text, get_links, scroll, screenshot, wait_for, close`,
        );
    }
  },
};
