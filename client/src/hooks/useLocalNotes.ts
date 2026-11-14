import { useCallback, useRef, useState } from 'react';
import {
  LOCAL_NOTES_LIMIT,
  addLocalNote,
  deleteLocalNote,
  pruneEmptyLocalNotes,
  readStoredLocalNotes,
  restoreDeletedLocalNote,
  updateLocalNoteContent,
  writeStoredLocalNotes,
  type DeletedLocalNote,
  type LocalNote,
} from '../stores/local-notes';
import { generateUUID } from '../utils/uuid';

type NotesTransform = (notes: LocalNote[]) => LocalNote[];

export function useLocalNotes() {
  const initialNotesRef = useRef<LocalNote[] | null>(null);
  if (initialNotesRef.current === null) initialNotesRef.current = readStoredLocalNotes();
  const notesRef = useRef(initialNotesRef.current);
  const [notes, setNotes] = useState(initialNotesRef.current);
  const [storageError, setStorageError] = useState(false);

  const commit = useCallback((transform: NotesTransform) => {
    const nextNotes = transform(notesRef.current);
    notesRef.current = nextNotes;
    setNotes(nextNotes);
    setStorageError(!writeStoredLocalNotes(nextNotes));
    return nextNotes;
  }, []);

  const createNote = useCallback((): LocalNote | null => {
    if (notesRef.current.length >= LOCAL_NOTES_LIMIT) return null;
    const id = generateUUID();
    const now = Date.now();
    const nextNotes = commit((current) => addLocalNote(current, id, now));
    return nextNotes.find((note) => note.id === id) ?? null;
  }, [commit]);

  const updateNote = useCallback((id: string, content: string) => {
    commit((current) => updateLocalNoteContent(current, id, content));
  }, [commit]);

  const removeNote = useCallback((id: string): DeletedLocalNote | null => {
    let deleted: DeletedLocalNote | null = null;
    commit((current) => {
      const result = deleteLocalNote(current, id);
      deleted = result.deleted;
      return result.notes;
    });
    return deleted;
  }, [commit]);

  const restoreNote = useCallback((deleted: DeletedLocalNote | null) => {
    commit((current) => restoreDeletedLocalNote(current, deleted));
  }, [commit]);

  const removeEmptyNotes = useCallback(() => {
    commit(pruneEmptyLocalNotes);
  }, [commit]);

  return {
    notes,
    storageError,
    createNote,
    updateNote,
    removeNote,
    restoreNote,
    removeEmptyNotes,
  };
}
