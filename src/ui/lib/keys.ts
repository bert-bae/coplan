/** Whether a key went to a field being typed in: its keys, `[` and Alt+arrows
 *  among them, are the field's, not the page's shortcuts. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)));
}

/** Whether a key belongs to an input method still composing (Japanese,
 *  Chinese, Korean): its Enter picks characters, its Escape drops them, its
 *  Tab moves through choices. None of them is the field's, or the page's.
 *  Read off a native event, or a React one's. */
export function isComposing(e: { keyCode?: number; isComposing?: boolean; nativeEvent?: { isComposing?: boolean } }): boolean {
  return Boolean(e.isComposing ?? e.nativeEvent?.isComposing) || e.keyCode === 229;
}
