import { useEffect, useRef } from 'react';

let openDialogs = 0;
let originalOverflow = '';

export function useDialog(onClose, ready = true) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement;
    if (!openDialogs) originalOverflow = document.body.style.overflow;
    openDialogs++;
    document.body.style.overflow = 'hidden';
    const focusable = () => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
      .filter((el) => el.getClientRects().length);
    if (!dialog.contains(previous)) (focusable()[0] ?? dialog).focus();
    function onKeyDown(e) {
      if ([...document.querySelectorAll('[aria-modal="true"]')].at(-1) !== dialog) return;
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current?.(); }
      if (e.key !== 'Tab') return;
      const items = focusable();
      const index = items.indexOf(document.activeElement);
      if (!items.length || index < 0 || (!e.shiftKey && index === items.length - 1) || (e.shiftKey && index === 0)) {
        e.preventDefault();
        (e.shiftKey ? items.at(-1) ?? dialog : items[0] ?? dialog).focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      openDialogs--;
      document.body.style.overflow = openDialogs ? 'hidden' : originalOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [ready]);
  return ref;
}
