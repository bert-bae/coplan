/** Whether a key went to a field being typed in: its keys, `[` and Alt+arrows
 *  among them, are the field's, not the page's shortcuts. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)));
}
