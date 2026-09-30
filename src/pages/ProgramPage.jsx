import { useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  Plus,
  Upload,
  X,
} from "lucide-react";
import AiProgramImportAssistant from "../components/AiProgramImportAssistant.jsx";
import ProgramCard, { formatProgramDate } from "../components/program/ProgramCard.jsx";
import ProgramStudio from "../components/ProgramStudio.jsx";
import { getProgramFileRejection, PROGRAM_FILE_DOCUMENT_HINT } from "../lib/importAssistant.js";
import { createBlankProgramDraft, draftFromProgram, draftFromShare } from "../lib/programDraft.js";
import {
  deleteStoredDraft,
  listStoredDrafts,
  loadStoredDraft,
  validateProgramShareStrict,
} from "../lib/programStorage.js";
import { resolveStudioModeForDraft } from "../lib/programStudio.js";

export default function ProgramPage({
  programs,
  archivedPrograms = [],
  activeProgramId,
  onDuplicateProgram,
  onSetActiveProgram,
  onArchiveProgram,
  onUpdateProgramMetadata,
  onUpdateProgramExerciseTarget,
  onImportProgramShare,
  studio = null,
  studioMessage = "",
  onOpenStudio,
  onCloseStudio,
  onStudioDraftChange,
  onSaveStudioDraft,
  onDismissStudioMessage,
}) {
  const visiblePrograms = programs.filter((program) => !program.isArchived);
  const activeProgram = visiblePrograms.find((program) => program.id === activeProgramId);
  const importInputRef = useRef(null);
  const [importMessage, setImportMessage] = useState("");
  const [importError, setImportError] = useState("");
  const [archiveError, setArchiveError] = useState("");
  const [studioError, setStudioError] = useState("");
  // Phase H2: a validated share waiting for "Review in Studio" / "Import as is".
  const [pendingImport, setPendingImport] = useState(null);
  const [draftsRevision, setDraftsRevision] = useState(0);
  // Stored (autosaved) drafts the user can resume; re-read when the studio
  // closes or a draft is discarded.
  const storedDrafts = useMemo(() => (studio ? [] : listStoredDrafts()), [studio, programs, draftsRevision]);

  function handleRestoreProgram(programId) {
    const result = onArchiveProgram?.(programId, false);

    if (result && !result.ok) {
      setArchiveError(result.error ?? "The program could not be restored.");
      return;
    }

    setArchiveError("");
  }

  function handleImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    setImportMessage("");
    setImportError("");
    setPendingImport(null);

    // Program files are the JSON shares this app exports. A document or an
    // image (a .docx dropped here) is never read: it belongs to the assistant.
    const rejection = getProgramFileRejection(file.name, file.type);

    if (rejection) {
      setImportError(rejection);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      let share;

      try {
        share = JSON.parse(String(reader.result));
      } catch {
        setImportError(`That file is not valid JSON. Program files are the .json files exported by this app. ${PROGRAM_FILE_DOCUMENT_HINT}.`);
        return;
      }

      const validation = validateProgramShareStrict(share);

      if (!validation.valid) {
        setImportError(validation.error ?? "The program file could not be imported.");
        return;
      }

      const dayCount = Array.isArray(share.days) ? share.days.length : 0;
      const exerciseCount = Array.isArray(share.programExercises) ? share.programExercises.length : 0;
      setPendingImport({ share, fileName: file.name, programName: share.program?.name ?? "", dayCount, exerciseCount });
    };
    reader.onerror = () => {
      setImportError("The file could not be read.");
    };
    reader.readAsText(file);
  }

  function importPendingAsIs() {
    if (!pendingImport) {
      return;
    }

    const result = onImportProgramShare(pendingImport.share);

    if (!result.valid) {
      setImportError(result.error ?? "The program file could not be imported.");
      return;
    }

    setPendingImport(null);
    setImportMessage(
      `Imported "${result.program.name}" with ${result.importedDayCount} ${result.importedDayCount === 1 ? "day" : "days"} and ${result.importedExerciseCount} exercises. It was added as a new program - your existing programs were not touched.`,
    );
  }

  function reviewPendingInStudio() {
    if (!pendingImport) {
      return;
    }

    const converted = draftFromShare(pendingImport.share, { origin: "file-import" });

    if (!converted.ok) {
      setImportError(converted.error ?? "The program file could not be opened in the Studio.");
      return;
    }

    setPendingImport(null);
    onOpenStudio({
      draft: converted.draft,
      mode: "review",
      review: { title: `Imported file: ${pendingImport.fileName}`, origin: "file-import" },
    });
  }

  function openNewProgram() {
    setStudioError("");
    onOpenStudio({ draft: createBlankProgramDraft(), mode: "create" });
  }

  function openEditProgram(programId) {
    const result = draftFromProgram(programId);

    if (!result.ok) {
      setStudioError(result.error ?? "This program cannot be edited.");
      return;
    }

    setStudioError("");
    onOpenStudio({ draft: result.draft, mode: "edit" });
  }

  function resumeStoredDraft(draftId) {
    const draft = loadStoredDraft(draftId);

    if (!draft) {
      setStudioError("That draft is no longer stored.");
      setDraftsRevision((current) => current + 1);
      return;
    }

    const mode = resolveStudioModeForDraft(draft);
    // The AI's change / removed / uncertainty notes travel with the stored
    // draft (draft.reviewNotes), so a resumed review shows them again.
    const notes = draft.reviewNotes ?? {};
    const review =
      mode === "review"
        ? {
            title:
              draft.origin === "ai-edit"
                ? "AI edit review (resumed draft)"
                : draft.origin === "ai-import"
                  ? "AI import review (resumed draft)"
                  : "Resumed draft review",
            instruction: draft.aiInstruction,
            origin: draft.origin,
            changes: notes.changes ?? [],
            removed: (notes.removed ?? []).map((name) => ({ name })),
            uncertainty: notes.uncertainty ?? [],
          }
        : null;
    setStudioError("");
    onOpenStudio({ draft, mode, review, isResumed: true });
  }

  function discardStoredDraft(draftId) {
    // One tap next to "Resume" must not silently delete the only copy of an
    // autosaved edit: same confirmation as the Studio's own Cancel.
    if (
      typeof window !== "undefined" &&
      typeof window.confirm === "function" &&
      !window.confirm("Discard this unsaved draft? It cannot be recovered. Your saved programs are not affected.")
    ) {
      return;
    }

    const result = deleteStoredDraft(draftId);

    if (!result.ok) {
      setStudioError(result.error ?? "The draft could not be discarded.");
    }

    setDraftsRevision((current) => current + 1);
  }

  if (studio) {
    return (
      <ProgramStudio
        key={studio.draft.draftId}
        draft={studio.draft}
        initialDraft={studio.initialDraft ?? studio.draft}
        mode={studio.mode}
        review={studio.review ?? null}
        isResumed={Boolean(studio.isResumed)}
        onSave={onSaveStudioDraft}
        onCancel={onCloseStudio}
        onDraftChange={onStudioDraftChange}
      />
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Program administration
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">Local programs</h2>
        <div className="mt-4 rounded-[8px] border border-lime-300/30 bg-lime-300/10 px-3 py-3">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-200/80">
            Active Program
          </p>
          <p className="mt-1 text-lg font-black text-white">
            {activeProgram?.name ?? "No active program"}
          </p>
          {activeProgram?.nickname && (
            <p className="mt-1 text-sm font-bold text-lime-100">
              Nickname: {activeProgram.nickname}
            </p>
          )}
        </div>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          Manage local guest-mode programs. Build a program from scratch or edit a custom program day by
          day in the Program Studio; defaults stay protected (duplicate them first).
        </p>
        {studioMessage && (
          <div
            role="status"
            className="mt-3 flex items-start justify-between gap-3 rounded-[8px] border border-lime-300/40 bg-lime-300/10 px-3 py-2"
          >
            <p className="min-w-0 break-words text-sm font-bold text-lime-100">{studioMessage}</p>
            <button
              type="button"
              onClick={onDismissStudioMessage}
              aria-label="Dismiss message"
              className="focus-ring shrink-0 rounded-[8px] p-1 text-lime-200 hover:text-white"
            >
              <X aria-hidden="true" size={16} />
            </button>
          </div>
        )}
        {studioError && (
          <p
            role="alert"
            className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm font-bold text-red-100"
          >
            {studioError}
          </p>
        )}
        {storedDrafts.length > 0 && (
          <div className="mt-4 rounded-[8px] border border-amber-400/40 bg-amber-400/10 px-3 py-3">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-200">
              Resume unsaved draft
            </p>
            <ul className="mt-2 space-y-2">
              {storedDrafts.map((entry) => (
                <li
                  key={entry.draftId}
                  className="flex flex-col gap-2 rounded-[8px] border border-zinc-800 bg-[#111111] p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-black text-white">
                      {entry.programName || "Untitled program"}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-zinc-400">
                      {entry.sourceProgramId ? "Edit of a saved program" : "New program draft"} | {entry.dayCount}{" "}
                      {entry.dayCount === 1 ? "day" : "days"} | {entry.exerciseCount}{" "}
                      {entry.exerciseCount === 1 ? "exercise" : "exercises"} | kept {formatProgramDate(entry.updatedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => resumeStoredDraft(entry.draftId)}
                      className="focus-ring min-h-10 rounded-[8px] bg-amber-300 px-3 text-xs font-black text-zinc-950"
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      onClick={() => discardStoredDraft(entry.draftId)}
                      className="focus-ring min-h-10 rounded-[8px] border border-zinc-700 px-3 text-xs font-black text-zinc-100 hover:bg-zinc-800"
                    >
                      Discard
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={openNewProgram}
            className="focus-ring flex min-h-11 w-full items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200 sm:w-auto"
          >
            <Plus aria-hidden="true" size={16} />
            New Program
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleImportFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="focus-ring flex min-h-11 w-full items-center justify-center gap-2 rounded-[8px] border border-zinc-700 px-4 text-sm font-black text-zinc-100 hover:bg-zinc-800 sm:w-auto"
          >
            <Upload aria-hidden="true" size={16} />
            Import Program File
          </button>
        </div>
        <div>
          {pendingImport && (
            <div className="mt-3 rounded-[8px] border border-lime-300/30 bg-lime-300/5 px-3 py-3">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-200/80">
                Program file checked - nothing imported yet
              </p>
              <p className="mt-1 break-words text-sm font-black text-white">
                {pendingImport.programName || "Untitled program"}
              </p>
              <p className="mt-1 text-xs font-semibold text-zinc-400">
                {pendingImport.fileName} | {pendingImport.dayCount} {pendingImport.dayCount === 1 ? "day" : "days"} |{" "}
                {pendingImport.exerciseCount} {pendingImport.exerciseCount === 1 ? "exercise" : "exercises"}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={reviewPendingInStudio}
                  className="focus-ring min-h-11 flex-1 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
                >
                  Review in Studio
                </button>
                <button
                  type="button"
                  onClick={importPendingAsIs}
                  className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 px-4 text-sm font-black text-zinc-100 hover:bg-zinc-800"
                >
                  Import as is
                </button>
                <button
                  type="button"
                  onClick={() => setPendingImport(null)}
                  className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 px-4 text-sm font-black text-zinc-300 hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {importMessage && (
            <p
              role="status"
              className="mt-3 rounded-[8px] border border-lime-300/40 bg-lime-300/10 px-3 py-2 text-sm font-bold text-lime-100"
            >
              {importMessage}
            </p>
          )}
          {importError && (
            <p
              role="alert"
              className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm font-bold text-red-100"
            >
              {importError}
            </p>
          )}
        </div>
        <div className="mt-4 space-y-3">
          {visiblePrograms.map((program) => {
            const isActive = program.id === activeProgramId;
            return (
              <ProgramCard
                key={program.id}
                program={program}
                isActive={isActive}
                onDuplicateProgram={onDuplicateProgram}
                onSetActiveProgram={onSetActiveProgram}
                onArchiveProgram={onArchiveProgram}
                onUpdateProgramMetadata={onUpdateProgramMetadata}
                onUpdateProgramExerciseTarget={onUpdateProgramExerciseTarget}
                onEditProgram={openEditProgram}
                onOpenStudio={onOpenStudio}
              />
            );
          })}
        </div>

        {archivedPrograms.length > 0 && (
          <details className="mt-4 rounded-[8px] border border-zinc-800 bg-[#171717] px-3 py-2">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-black text-zinc-100">
              <span className="flex items-center gap-2">
                <Archive aria-hidden="true" size={16} className="text-zinc-400" />
                Archived programs ({archivedPrograms.length})
              </span>
              <ChevronDown aria-hidden="true" size={16} className="shrink-0 text-zinc-400" />
            </summary>
            <div className="space-y-2 border-t border-zinc-800 pt-3">
              <p className="text-xs font-semibold leading-5 text-zinc-400">
                Archived programs keep their days, targets and history. They are hidden from the
                program list and cannot be set active until restored.
              </p>
              {archivedPrograms.map((program) => (
                <div
                  key={program.id}
                  className="flex flex-col gap-2 rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-black text-white">{program.name}</p>
                    <p className="mt-1 text-xs font-semibold text-zinc-400">
                      {program.nickname ? `${program.nickname} | ` : ""}
                      Updated {formatProgramDate(program.updatedAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRestoreProgram(program.id)}
                    className="focus-ring min-h-10 shrink-0 rounded-[8px] border border-zinc-700 px-3 text-xs font-black text-zinc-100 hover:bg-zinc-800"
                  >
                    Restore
                  </button>
                </div>
              ))}
              {archiveError && (
                <p
                  role="alert"
                  className="rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm font-bold text-red-100"
                >
                  {archiveError}
                </p>
              )}
            </div>
          </details>
        )}
      </section>

      <AiProgramImportAssistant
        onSaveProgramDraft={onSaveStudioDraft}
        onReviewDraft={(draft, review) => onOpenStudio({ draft, mode: "review", review })}
      />
    </div>
  );
}
