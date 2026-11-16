// The Help line for what this app keeps on the device (fm-5hww, defect 22): the stored size of the saved faces, the
// last session and this tab's words, and one Clear for exactly those. Clear keeps the downloaded models and the
// slider setting (app-storage.ts). The size is read whenever the line scrolls into view and again after Clear.
import { useEffect, useRef, useState } from 'react';
import { clearAppStorage, storedSize } from '../session/app-storage.ts';

export function storedBytes(bytes: number): string {
  if (bytes <= 0) return 'nothing';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

export function StoredData() {
  const line = useRef<HTMLParagraphElement>(null);
  const [size, setSize] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Only the latest reading lands: a look at the line during Clear must not bring back the old size.
  const reading = useRef(0);
  const measure = () => {
    const id = ++reading.current;
    return storedSize().then(
      (s) => id === reading.current && setSize(s.total),
      () => id === reading.current && setSize(0),
    );
  };
  useEffect(() => {
    const el = line.current;
    if (!el || typeof IntersectionObserver !== 'function') {
      void measure();
      return;
    }
    // Measured each time the line comes into view, not only the first: faces made after a first look made the
    // figure stale ("1 KB" beside a session of saved faces).
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void measure();
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const clear = async () => {
    setBusy(true);
    try {
      await clearAppStorage();
      setNote(
        'Cleared. Faces on screen stay until you leave this page; new faces are saved again as you make them.',
      );
    } catch {
      setNote('This browser did not let us clear the saved faces.');
    } finally {
      await measure();
      setBusy(false);
    }
  };
  return (
    <p className="next-stored" data-next-stored={size ?? ''} ref={line}>
      {'Saved on this device for your faces, last session and the words kept in this tab: '}
      <strong className="next-stored-size">{size === null ? '…' : storedBytes(size)}</strong>
      {'. '}
      <button
        type="button"
        className="button is-small next-stored-clear"
        disabled={busy || size === null}
        onClick={() => void clear()}
      >
        {'Clear'}
      </button>{' '}
      {
        'Clear removes those saved faces, the last session and the kept words. It keeps the downloaded models and your slider setting.'
      }
      {note && (
        <span className="next-stored-note" role="status">
          {' '}
          {note}
        </span>
      )}
    </p>
  );
}
