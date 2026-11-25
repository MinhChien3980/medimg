import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { reportsApi } from '@/api/endpoints';
import { toAppError } from '@/api/problem';
import { queryKeys } from '@/api/queryKeys';
import type { KeyImageOrderItem, ReportDto } from '@/api/types';
import { cachedRowVersion, reloadReport, REPORT_SCOPE, storeReport } from './hooks';
import {
  sameSections,
  sectionsOf,
  updateRequest,
  withKeyImages,
  type ReportSections,
} from './reportModel';

/** Quiet time after the last keystroke before the draft is saved. */
export const AUTOSAVE_DELAY_MS = 1000;

/**
 * - `saved`: the server has what is on screen
 * - `pending`: edited, a save is scheduled
 * - `saving`: a save is in flight
 * - `conflict`: the server has a newer version (409); saving stops until the user reloads
 * - `error`: the last save failed (retried on the next edit or flush)
 */
export type SaveState = 'saved' | 'pending' | 'saving' | 'conflict' | 'error';

/**
 * Local copy of a draft's sections, saved with `PUT /reports/{id}` and the report's row version
 * after `AUTOSAVE_DELAY_MS` of quiet. Edits made while a save is in flight are saved right after
 * it. A 409 means someone else saved the draft meanwhile: autosave stops and `reload()` replaces
 * the local text with the server's. `replace()` takes a draft the server rewrote (a refill).
 * Pending edits are saved when the editor unmounts.
 *
 * Key image order and captions travel in the same `PUT` (the server takes every image once, in
 * order): `saveKeyImages` shows the change at once and saves it right away with the sections.
 *
 * Mount one editor per report (key it by report id): the local copy is initialised once.
 */
export function useDraftAutosave(report: ReportDto) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<ReportSections>(() => sectionsOf(report));
  const [state, setState] = useState<SaveState>('saved');
  const [error, setError] = useState<unknown>(null);

  const reportRef = useRef(report);
  const valuesRef = useRef(values);
  const savedRef = useRef(sectionsOf(report));
  const timerRef = useRef<number | null>(null);
  /** Latest `save`, for timers (a callback cannot schedule itself by name). */
  const saveRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const conflictRef = useRef(false);
  /** Key image order / caption change not saved yet. */
  const keyImagesRef = useRef<KeyImageOrderItem[] | null>(null);

  useEffect(() => {
    reportRef.current = report;
  });

  const mutation = useMutation({
    scope: REPORT_SCOPE,
    mutationFn: ({
      sections,
      keyImages,
    }: {
      sections: ReportSections;
      keyImages: KeyImageOrderItem[] | null;
    }) =>
      reportsApi.update(
        reportRef.current.id,
        updateRequest(
          sections,
          cachedRowVersion(queryClient, reportRef.current),
          keyImages ?? undefined,
        ),
      ),
  });
  const mutateAsync = mutation.mutateAsync;

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const save = useCallback(async (): Promise<boolean> => {
    clearTimer();
    // One save at a time; whatever was typed meanwhile is saved by the next round.
    while (inFlightRef.current) await inFlightRef.current;
    if (conflictRef.current) return false;
    const sending = valuesRef.current;
    const keyImages = keyImagesRef.current;
    if (sameSections(sending, savedRef.current) && !keyImages) {
      setState('saved');
      return true;
    }
    setState('saving');
    const run = mutateAsync({ sections: sending, keyImages }).then(
      (saved) => {
        storeReport(queryClient, saved);
        savedRef.current = sending;
        if (keyImagesRef.current === keyImages) keyImagesRef.current = null;
        if (sameSections(valuesRef.current, sending)) {
          setState('saved');
        } else {
          setState('pending');
          timerRef.current = window.setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
        }
        setError(null);
        return true;
      },
      (e: unknown) => {
        if (keyImages) {
          // Undo the optimistic key image change: show what the server has.
          keyImagesRef.current = null;
          void reloadReport(queryClient, reportRef.current.id).catch(() => undefined);
        }
        if (toAppError(e).status === 409) {
          conflictRef.current = true;
          setState('conflict');
        } else {
          setState('error');
          setError(e);
        }
        return false;
      },
    );
    inFlightRef.current = run;
    void run.finally(() => {
      if (inFlightRef.current === run) inFlightRef.current = null;
    });
    return run;
  }, [mutateAsync, queryClient]);

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const change = useCallback(
    <K extends keyof ReportSections>(field: K, value: ReportSections[K]) => {
      valuesRef.current = { ...valuesRef.current, [field]: value };
      setValues(valuesRef.current);
      if (conflictRef.current) return;
      setState('pending');
      clearTimer();
      timerRef.current = window.setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
    },
    [],
  );

  /** Saves now (before a preview or signing); false when the draft could not be saved. */
  const flush = save;

  /** New key image order and / or caption (every image once), shown now and saved at once. */
  const saveKeyImages = useCallback(
    (items: KeyImageOrderItem[]) => {
      if (conflictRef.current) return Promise.resolve(false);
      const current = queryClient.getQueryData<ReportDto>(
        queryKeys.reports.detail(reportRef.current.id),
      );
      storeReport(queryClient, withKeyImages(current ?? reportRef.current, items));
      keyImagesRef.current = items;
      return save();
    },
    [queryClient, save],
  );

  /** Drops local edits and shows `fresh`, a version the server returned, as saved. */
  const replace = useCallback((fresh: ReportDto) => {
    clearTimer();
    conflictRef.current = false;
    keyImagesRef.current = null;
    savedRef.current = sectionsOf(fresh);
    valuesRef.current = sectionsOf(fresh);
    setValues(valuesRef.current);
    setState('saved');
    setError(null);
  }, []);

  /** Drops local edits and takes the server's current draft (after a conflict). */
  const reload = useCallback(async () => {
    clearTimer();
    const fresh = await reloadReport(queryClient, reportRef.current.id);
    replace(fresh);
    return fresh;
  }, [queryClient, replace]);

  // Leaving the editor saves what is left (fire and forget); closing the tab asks first.
  useEffect(
    () => () => {
      clearTimer();
      // After a save in flight (whose result updates what the server is known to have).
      void (inFlightRef.current ?? Promise.resolve(true))
        .then(() => {
          const target = valuesRef.current;
          if (conflictRef.current || sameSections(target, savedRef.current)) return;
          const current = reportRef.current;
          return reportsApi
            .update(current.id, updateRequest(target, cachedRowVersion(queryClient, current)))
            .then((saved) => storeReport(queryClient, saved));
        })
        .catch(() => undefined);
    },
    [queryClient],
  );

  const unsaved = state === 'pending' || state === 'saving' || state === 'error';
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  return { values, change, state, error, flush, reload, replace, saveKeyImages };
}
