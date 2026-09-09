'use client';

/**
 * InsightDoc — Keyboard Shortcuts Help Dialog
 * Opened with `?` (when not typing) or from the sidebar footer. Documents every
 * global shortcut so power users can discover the palette, view switching and
 * upload affordances.
 */
import { useEffect } from 'react';
import { Command, Keyboard } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAppStore, type AppView } from './store';

interface ShortcutRow {
  keys: string[];
  label: string;
}

const VIEW_KEYS: Array<{ view: AppView; label: string; n: string }> = [
  { view: 'dashboard', label: 'Dashboard', n: '1' },
  { view: 'documents', label: 'Documents', n: '2' },
  { view: 'chat', label: 'RAG Chat', n: '3' },
  { view: 'search', label: 'Search', n: '4' },
  { view: 'analytics', label: 'Analytics', n: '5' },
];

const GENERAL: ShortcutRow[] = [
  { keys: ['⌘', 'K'], label: 'Open command palette' },
  { keys: ['?'], label: 'Show this help' },
  { keys: ['Drag', 'PDF'], label: 'Drop anywhere to upload' },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border bg-muted px-1.5 font-mono text-[11px] font-medium text-foreground shadow-sm">
      {children}
    </kbd>
  );
}

export function ShortcutsDialog() {
  const open = useAppStore((s) => s.shortcutsOpen);
  const setOpen = useAppStore((s) => s.setShortcutsOpen);
  const setView = useAppStore((s) => s.setView);

  // Alt+1..5 view switching + `?` help toggle — mounted once, globally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.closest('[role="dialog"] [contenteditable]'));

      if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        const found = VIEW_KEYS[Number(e.key) - 1];
        if (found) setView(found.view);
        return;
      }
      if (!typing && e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        useAppStore.getState().setShortcutsOpen(!useAppStore.getState().shortcutsOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-primary" /> Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Move faster through the platform — every list here works globally.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <Command className="h-3 w-3" /> Views
            </h3>
            <div className="overflow-hidden rounded-lg border">
              {VIEW_KEYS.map((v, i) => (
                <button
                  key={v.view}
                  onClick={() => {
                    setView(v.view);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between px-3 py-2 text-sm transition hover:bg-accent/60"
                >
                  <span>
                    <span className="mr-2 font-mono text-[10px] text-muted-foreground">
                      Alt+{v.n}
                    </span>
                    {v.label}
                  </span>
                  <Kbd>Alt {v.n}</Kbd>
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              General
            </h3>
            <div className="divide-y overflow-hidden rounded-lg border">
              {GENERAL.map((s) => (
                <div key={s.label} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>{s.label}</span>
                  <span className="flex gap-1">
                    {s.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
