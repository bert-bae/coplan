import { JSDOM } from 'jsdom';

/**
 * Install a jsdom environment on globalThis.
 *
 * Must run before any module that touches `document` is imported, so tests
 * call this at the top of the file and then `await import(...)` their
 * components. React and Testing Library both read these globals at import
 * time, which is why this is not a `before()` hook.
 */
export function setupDom(url = 'http://127.0.0.1:1234/#/session/s1'): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url,
    pretendToBeVisual: true,
  });

  const win = dom.window as unknown as Record<string, unknown>;
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    HTMLElement: win['HTMLElement'],
    HTMLInputElement: win['HTMLInputElement'],
    HTMLTextAreaElement: win['HTMLTextAreaElement'],
    HTMLSelectElement: win['HTMLSelectElement'],
    Element: win['Element'],
    Node: win['Node'],
    Event: win['Event'],
    CustomEvent: win['CustomEvent'],
    KeyboardEvent: win['KeyboardEvent'],
    MouseEvent: win['MouseEvent'],
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  };

  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }

  // React Testing Library checks for this to enable act() semantics.
  (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

  // jsdom implements neither of these; the UI uses both.
  if (!('IntersectionObserver' in globalThis)) {
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      value: class {
        constructor(private cb: unknown) {}
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): unknown[] {
          return [];
        }
      },
      writable: true,
      configurable: true,
    });
  }
  if (!('ResizeObserver' in globalThis)) {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
      writable: true,
      configurable: true,
    });
  }
  // React Flow reads the canvas transform through this; jsdom has none.
  if (!('DOMMatrixReadOnly' in globalThis)) {
    Object.defineProperty(globalThis, 'DOMMatrixReadOnly', {
      value: class {
        m22: number;
        constructor(transform?: string) {
          const scale = /scale\(([\d.]+)\)/.exec(transform ?? '');
          this.m22 = scale ? Number(scale[1]) : 1;
        }
      },
      writable: true,
      configurable: true,
    });
  }
  globalThis.MutationObserver ??= dom.window.MutationObserver;
  // jsdom stubs this as a no-op that throws in some versions.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }

  // jsdom has no EventSource; tests install their own stub over this.
  if (!('EventSource' in globalThis)) {
    Object.defineProperty(globalThis, 'EventSource', {
      value: class {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        constructor(public url: string) {}
        close(): void {}
      },
      writable: true,
      configurable: true,
    });
  }

  return dom;
}

/** Route `fetch` to a handler, recording every mutating request. */
export function stubFetch(handler: (route: string, init?: RequestInit) => unknown): {
  posts: { route: string; body: Record<string, unknown> }[];
} {
  const posts: { route: string; body: Record<string, unknown> }[] = [];
  Object.defineProperty(globalThis, 'fetch', {
    value: async (input: unknown, init?: RequestInit) => {
      const route = String(input);
      if (init?.method && init.method !== 'GET') {
        posts.push({ route, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      }
      const body = handler(route, init);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (typeof body === 'string' ? 'text/plain' : 'application/json') : null) },
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      };
    },
    writable: true,
    configurable: true,
  });
  return { posts };
}
