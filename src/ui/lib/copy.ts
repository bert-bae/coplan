import { store } from '../store.ts';

/** Copy a prompt for the user to paste into the agent's chat, and say so. */
/** Resolves whether it was copied. */
export async function copyText(text: string, ok: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    store.toast('success', ok);
    return true;
  } catch {
    store.toast('error', 'The browser would not let the page use the clipboard. Select the text and copy it instead.');
    return false;
  }
}
