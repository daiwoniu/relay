export const LOCAL_NOTES_STORAGE_KEY = 'relay.local-notes.v1';
export const LOCAL_NOTES_LIMIT = 10;
export const LOCAL_NOTE_MAX_LENGTH = 500;

export interface LocalNote {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeletedLocalNote {
  note: LocalNote;
  index: number;
}

interface LocalNotesStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function getBrowserStorage(): LocalNotesStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeStoredNotes(value: unknown): LocalNote[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const notes: LocalNote[] = [];

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Partial<LocalNote>;
    if (typeof candidate.id !== 'string' || !candidate.id || seenIds.has(candidate.id)) continue;
    if (typeof candidate.content !== 'string' || !candidate.content.trim()) continue;
    const createdAt = normalizeTimestamp(candidate.createdAt, Date.now());
    notes.push({
      id: candidate.id,
      content: candidate.content.slice(0, LOCAL_NOTE_MAX_LENGTH),
      createdAt,
      updatedAt: normalizeTimestamp(candidate.updatedAt, createdAt),
    });
    seenIds.add(candidate.id);
    if (notes.length >= LOCAL_NOTES_LIMIT) break;
  }

  return notes;
}

export function readStoredLocalNotes(storage = getBrowserStorage()): LocalNote[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOCAL_NOTES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: unknown; notes?: unknown };
    if (parsed.version !== 1) return [];
    return normalizeStoredNotes(parsed.notes);
  } catch {
    return [];
  }
}

export function writeStoredLocalNotes(
  notes: LocalNote[],
  storage = getBrowserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LOCAL_NOTES_STORAGE_KEY, JSON.stringify({ version: 1, notes }));
    return true;
  } catch {
    return false;
  }
}

export function addLocalNote(notes: LocalNote[], id: string, now = Date.now()): LocalNote[] {
  if (notes.length >= LOCAL_NOTES_LIMIT) return notes;
  return [{ id, content: '', createdAt: now, updatedAt: now }, ...notes];
}

export function updateLocalNoteContent(
  notes: LocalNote[],
  id: string,
  content: string,
  now = Date.now(),
): LocalNote[] {
  const limitedContent = content.slice(0, LOCAL_NOTE_MAX_LENGTH);
  return notes.map((note) => note.id === id
    ? { ...note, content: limitedContent, updatedAt: now }
    : note);
}

export function deleteLocalNote(
  notes: LocalNote[],
  id: string,
): { notes: LocalNote[]; deleted: DeletedLocalNote | null } {
  const index = notes.findIndex((note) => note.id === id);
  if (index < 0) return { notes, deleted: null };
  return {
    notes: notes.filter((note) => note.id !== id),
    deleted: { note: notes[index], index },
  };
}

export function restoreDeletedLocalNote(
  notes: LocalNote[],
  deleted: DeletedLocalNote | null,
): LocalNote[] {
  if (!deleted || notes.length >= LOCAL_NOTES_LIMIT || notes.some((note) => note.id === deleted.note.id)) {
    return notes;
  }
  const restored = [...notes];
  restored.splice(Math.min(Math.max(deleted.index, 0), restored.length), 0, deleted.note);
  return restored;
}

export function pruneEmptyLocalNotes(notes: LocalNote[]): LocalNote[] {
  return notes.filter((note) => note.content.trim());
}

export function appendNoteToDraft(draft: string, noteContent: string): string {
  const normalizedNote = noteContent.trim();
  if (!normalizedNote) return draft;
  const normalizedDraft = draft.trimEnd();
  return normalizedDraft ? `${normalizedDraft}\n\n${normalizedNote}` : normalizedNote;
}
