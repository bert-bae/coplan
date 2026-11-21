/**
 * The headless plan page's script (#headless): reads the plan from the
 * page's `#plan` block and draws it. Diagrams are `<pre class="mermaid">`
 * blocks, which an Artifact draws by itself; anywhere else — the file opened
 * on its own — Mermaid is loaded to draw them.
 */
import { planOf, planPage, type PageData } from './render.ts';

declare const mermaid: { initialize(config: object): void; run(opts: { nodes: Element[] }): Promise<void> };

const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';

const app = document.getElementById('app')!;
try {
  const data = JSON.parse(document.getElementById('plan')?.textContent || 'null') as PageData | null;
  if (data) {
    app.innerHTML = planPage(planOf(data), data.agent);
    document.title = data.title || document.title;
  }
} catch (err) {
  const p = document.createElement('p');
  p.className = 'error';
  p.textContent = `This plan could not be read: ${(err as Error).message}. Ask the agent to publish it again.`;
  app.replaceChildren(p);
}

// Give the Artifact's own renderer the first go, then draw what it left.
window.addEventListener('load', () =>
  setTimeout(() => {
    const left = [...document.querySelectorAll('pre.mermaid:not([data-processed])')].filter((el) => !el.querySelector('svg'));
    if (!left.length) return;
    const script = document.createElement('script');
    script.src = MERMAID;
    script.onload = () => {
      const theme = document.documentElement.dataset['theme'];
      const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
      void mermaid.run({ nodes: left });
    };
    document.head.append(script);
  }, 1200),
);
