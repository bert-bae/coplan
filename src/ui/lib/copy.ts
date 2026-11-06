import { store } from '../store.ts';

/** Copy a prompt for the user to paste into the agent's chat, and say so. */
export async function copyText(text: string, ok: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    store.toast('success', ok);
  } catch {
    store.toast('error', 'The browser would not let the page use the clipboard. Select the prompt and copy it instead.');
  }
}
