'use client';

/**
 * InsightDoc — Command Palette (⌘K / Ctrl+K)
 * Fast navigation and actions: switch views, open documents in the viewer,
 * search the library, start chats, create workspaces.
 */
import { useEffect } from 'react';
import {
  BarChart3,
  FileText,
  Keyboard,
  LayoutDashboard,
  MessageSquare,
  MessageSquarePlus,
  Moon,
  Plus,
  Search,
  Sun,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { useAppStore } from './store';
import { createChat } from './api-client';

interface PaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: PaletteProps) {
  const setView = useAppStore((s) => s.setView);
  const documents = useAppStore((s) => s.documents);
  const workspaces = useAppStore((s) => s.workspaces);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const openDocument = useAppStore((s) => s.openDocument);
  const setPendingSearchQuery = useAppStore((s) => s.setPendingSearchQuery);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const theme = useAppStore((s) => s.theme);
  const upsertChat = useAppStore((s) => s.upsertChat);
  const setActiveChat = useAppStore((s) => s.setActiveChat);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [open, onOpenChange]);

  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  const newChat = async () => {
    if (!activeWorkspaceId) return;
    try {
      const chat = await createChat(activeWorkspaceId);
      upsertChat(chat);
      setActiveChat(chat.id);
      setView('chat');
    } catch (error) {
      console.error(error);
    }
  };

  const searchFor = (q: string) => {
    setPendingSearchQuery(q);
    setView('search');
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigate">
          <CommandItem onSelect={() => run(() => setView('dashboard'))}>
            <LayoutDashboard className="mr-2 h-4 w-4" /> Dashboard
          </CommandItem>
          <CommandItem onSelect={() => run(() => setView('documents'))}>
            <FileText className="mr-2 h-4 w-4" /> Document library
          </CommandItem>
          <CommandItem onSelect={() => run(() => setView('chat'))}>
            <MessageSquare className="mr-2 h-4 w-4" /> RAG chat
          </CommandItem>
          <CommandItem onSelect={() => run(() => searchFor(''))}>
            <Search className="mr-2 h-4 w-4" /> Semantic search
          </CommandItem>
          <CommandItem onSelect={() => run(() => setView('analytics'))}>
            <BarChart3 className="mr-2 h-4 w-4" /> Analytics
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => run(() => void newChat())}>
            <MessageSquarePlus className="mr-2 h-4 w-4" /> New chat
          </CommandItem>
          <CommandItem onSelect={() => run(() => searchFor('risk factors'))}>
            <Search className="mr-2 h-4 w-4" /> Search risk factors
          </CommandItem>
          <CommandItem onSelect={() => run(toggleTheme)}>
            {theme === 'dark' ? (
              <>
                <Sun className="mr-2 h-4 w-4" /> Switch to light theme
              </>
            ) : (
              <>
                <Moon className="mr-2 h-4 w-4" /> Switch to dark theme
              </>
            )}
          </CommandItem>
          <CommandItem onSelect={() => run(() => useAppStore.getState().setShortcutsOpen(true))}>
            <Keyboard className="mr-2 h-4 w-4" /> Keyboard shortcuts
            <kbd className="ml-auto">?</kbd>
          </CommandItem>
        </CommandGroup>
        {documents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Open document in viewer">
              {documents.slice(0, 6).map((d) => (
                <CommandItem key={d.id} onSelect={() => run(() => openDocument(d.id, 1))}>
                  <FileText className="mr-2 h-4 w-4" /> {d.title}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {workspaces.length > 1 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch workspace">
              {workspaces.map((w) => (
                <CommandItem
                  key={w.id}
                  onSelect={() => run(() => setActiveWorkspace(w.id))}
                >
                  <Plus className="mr-2 h-4 w-4 rotate-45" /> {w.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
