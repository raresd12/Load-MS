import { useEffect, useRef, useState } from "react";
import { draftTechniqueNotesWithAi } from "../../lib/aiTechnique.js";
import { runTechniqueBatches } from "../../lib/importAssistant.js";

const EMPTY_TECHNIQUE_STATE = Object.freeze({
  busy: false,
  busyIds: [],
  progress: "",
  error: "",
  items: [],
  uncertainty: [],
  model: "",
});

/**
 * Technique-note drafts held in component memory (decision H3-6): requested
 * only by an explicit action, in batches of 5, never stored. An item is
 * { id, name, status: "draft" | "rejected" | "accepted", draft, errors }.
 * The caller applies an accepted draft (acceptTechniqueDraftInto...) and then
 * calls markAccepted; discard drops the draft text.
 */
export function useTechniqueDrafts() {
  const [state, setState] = useState(EMPTY_TECHNIQUE_STATE);
  const controllerRef = useRef(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  async function request(exercises, language) {
    const list = (exercises ?? []).filter((exercise) => exercise?.id && exercise?.name);

    if (!list.length || controllerRef.current) {
      return;
    }

    const controller = new AbortController();
    const requestedIds = list.map((exercise) => String(exercise.id));
    controllerRef.current = controller;
    setState((current) => ({
      ...current,
      busy: true,
      busyIds: requestedIds,
      error: "",
      progress:
        list.length > 1
          ? `Drafting notes for ${list.length} exercises...`
          : `Drafting notes for "${list[0].name}"...`,
    }));

    const result = await runTechniqueBatches({
      exercises: list,
      language,
      request: draftTechniqueNotesWithAi,
      signal: controller.signal,
      onProgress: ({ completedBatches, totalBatches }) => {
        if (mountedRef.current && totalBatches > 1) {
          setState((current) => ({
            ...current,
            progress: `Batch ${completedBatches} of ${totalBatches} done...`,
          }));
        }
      },
    });

    if (controllerRef.current === controller) {
      controllerRef.current = null;
    }

    if (!mountedRef.current || controller.signal.aborted) {
      return;
    }

    const fresh = [
      ...result.drafts.map((draft) => ({
        id: String(draft.id),
        name: draft.name,
        status: "draft",
        draft,
        errors: [],
      })),
      ...result.rejected.map((entry) => ({
        id: String(entry.id),
        name: entry.name,
        status: "rejected",
        draft: null,
        errors: entry.errors ?? [],
      })),
    ];
    const freshIds = new Set(fresh.map((item) => item.id));

    setState((current) => ({
      busy: false,
      busyIds: [],
      progress: "",
      error: result.error,
      items: [...current.items.filter((item) => !freshIds.has(item.id)), ...fresh],
      uncertainty: [...new Set([...current.uncertainty, ...result.uncertainty])],
      model: result.model || current.model,
    }));
  }

  function discard(id) {
    setState((current) => ({
      ...current,
      items: current.items.filter((item) => item.id !== String(id)),
    }));
  }

  function markAccepted(id) {
    setState((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.id === String(id) ? { ...item, status: "accepted" } : item,
      ),
    }));
  }

  function clear() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(EMPTY_TECHNIQUE_STATE);
  }

  return { ...state, request, discard, markAccepted, clear };
}
