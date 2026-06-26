'use client';

import { useEffect, useState } from 'react';

// Tiny client island: dark is the default; the toggle persists to localStorage.
export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const saved = (typeof window !== 'undefined' && localStorage.getItem('pigeon-theme')) as
      | 'dark'
      | 'light'
      | null;
    if (saved) setTheme(saved);
  }, []);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('pigeon-theme', next);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="toggle-bar">
      <button className="toggle-btn" onClick={toggle} aria-label="Toggle light or dark theme">
        {theme === 'dark' ? '◐ Dark' : '◑ Light'}
      </button>
    </div>
  );
}
