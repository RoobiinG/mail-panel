import { useState, useEffect } from 'react';

// Reaktive Handy-Erkennung per Media Query (Standard: < 768px = Tailwind md).
// Übernommen vom Überwachungs-Panel, damit beide Panels sich gleich verhalten.
export function useIsMobile(query = '(max-width: 767px)') {
  const get = () => typeof window !== 'undefined' && window.matchMedia(query).matches;
  const [isMobile, setIsMobile] = useState(get);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = () => setIsMobile(mq.matches);
    handler();
    mq.addEventListener ? mq.addEventListener('change', handler) : mq.addListener(handler);
    return () => (mq.removeEventListener ? mq.removeEventListener('change', handler) : mq.removeListener(handler));
  }, [query]);

  return isMobile;
}
