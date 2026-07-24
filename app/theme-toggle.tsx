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
 if (saved) {
 setTheme(saved);
 // Re-assert the attribute on the DOM after mount. The pre-paint bootstrap sets it,
 // but React 19 hydration resets <html data-theme> to the server literal ("dark"), so
 // the saved preference would otherwise be lost on reload. Make the client
 // authoritative here. Idempotent.
 document.documentElement.setAttribute('data-theme', saved);
 }
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
 {/* The word is a separate span so mobile can drop it and leave a symmetric icon pill
 opposite the account button — at 320px the labelled pill collided with the mark. */}
 <button className="toggle-btn" onClick={toggle} aria-label="Toggle light or dark theme">
 <span aria-hidden>{theme === 'dark' ? '◐' : '◑'}</span>
 <span className="toggle-btn-label">{theme === 'dark' ? 'Dark' : 'Light'}</span>
 </button>
 </div>
 );
}
