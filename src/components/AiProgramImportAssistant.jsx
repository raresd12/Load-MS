import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  clearGeminiApiKey,
  extractProgramDraftWithAi,
  getGeminiApiKey,
  getLibraryCatalog,
  MAX_SOURCE_TEXT_CHARS,
  setGeminiApiKey,
} from "../lib/aiProgram.js";
import {
  acceptTechniqueDraftIntoShare,
  classifyExtractionError,
  createExtractionTracker,
  detectLibraryLanguage,
  getExtractBlocker,
  listNewExercisesOfShare,
  moveListItem,
  planFilePick,
  planPhotoPick,
  removeListItem,
} from "../lib/importAssistant.js";
import { draftFromShare, validateProgramDraft } from "../lib/programDraft.js";
import { buildImageBundle, buildTextSource, readSourceFile } from "../lib/sourceFiles.js";
import SourcePicker from "./import/SourcePicker.jsx";
import SourceReviewPanel from "./import/SourceReviewPanel.jsx";
import TechniqueDraftReview from "./import/TechniqueDraftReview.jsx";
import { useTechniqueDrafts } from "./import/useTechniqueDrafts.js";

function maskKey(key) {
  if (!key) {
    return "";
  }

  return `••••${key.slice(-4)}`;
}

// Module-level cache so an extracted draft survives tab switches
// (ProgramPage unmounts when the user navigates away). Memory only, and the
// DRAFT only: the source (text, photos, files, object URLs) lives in this
// component's state and is gone when the component unmounts (decision H3-5).
let cachedDraft = null;
let photoIdCounter = 0;

/**
 * Counts the AI preview's per-field provenance ("source" / "default") so the
 * user sees how much of the draft came from the source before importing.
 */
function countPreviewProvenance(preview) {
  const counts = { source: 0, default: 0 };

  (preview?.days ?? []).forEach((day) => {
    (day.exercises ?? []).forEach((exercise) => {
      Object.values(exercise.provenance ?? {}).forEach((value) => {
        if (value in counts) {
          counts[value] += 1;
        }
      });
    });
  });

  return counts;
}

function UncertaintyList({ lines }) {
  return (
    <ul className="mt-1 ml-3 list-disc space-y-0.5">
      {lines.map((line, index) => (
        <li key={`${index}-${line}`} className="break-words text-xs font-bold text-amber-100">
          {line}
        </li>
      ))}
    </ul>
  );
}

/**
 * Phase H2: both "Add to my programs" and "Edit draft in Studio" go through
 * the shared draft model (draftFromShare -> validateProgramDraft ->
 * saveProgramDraft). `onSaveProgramDraft(draft)` returns the writer result;
 * `onReviewDraft(draft, review)` opens the Studio in review mode.
 *
 * Phase H3: the source is picked through SourcePicker (text, several photos
 * in page order, one PDF / DOCX / XLSX / text file), read by sourceFiles.js,
 * shown next to the extraction (SourceReviewPanel) and never written
 * anywhere; technique notes for the NEW exercises are drafted only on
 * request and applied only after Accept.
 */
export default function AiProgramImportAssistant({ onSaveProgramDraft, onReviewDraft }) {
  const [isOpen, setIsOpen] = useState(false);
  const [savedKeyMask, setSavedKeyMask] = useState(() => maskKey(getGeminiApiKey()));
  const [isKeySectionOpen, setIsKeySectionOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const [keyMessage, setKeyMessage] = useState("");
  const [sourceMode, setSourceMode] = useState("text");
  const [sourceText, setSourceText] = useState("");
  const [photos, setPhotos] = useState([]);
  const [photoError, setPhotoError] = useState("");
  const [pickedFile, setPickedFile] = useState(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionError, setExtractionError] = useState("");
  const [draft, setDraftState] = useState(() => cachedDraft);
  const [reviewSource, setReviewSource] = useState(null);
  const [reviewTab, setReviewTab] = useState("extraction");
  const [importMessage, setImportMessage] = useState("");
  const [techniqueAcceptErrors, setTechniqueAcceptErrors] = useState({});
  const technique = useTechniqueDrafts();
  // Every object URL this component created and has not revoked yet.
  const objectUrlsRef = useRef(new Set());
  const reviewSourceRef = useRef(null);
  const fileReadTokenRef = useRef(0);
  const mountedRef = useRef(false);
  // The one extraction request this assistant has open (fix round 2).
  const extractionRef = useRef(null);

  if (extractionRef.current === null) {
    extractionRef.current = createExtractionTracker();
  }

  useEffect(() => {
    mountedRef.current = true;
    const urls = objectUrlsRef.current;

    return () => {
      mountedRef.current = false;
      fileReadTokenRef.current += 1;
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  function createObjectUrl(file) {
    const url = URL.createObjectURL(file);
    objectUrlsRef.current.add(url);
    return url;
  }

  function revokeObjectUrl(url) {
    if (url && objectUrlsRef.current.has(url)) {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(url);
    }
  }

  function releaseReviewSource() {
    const current = reviewSourceRef.current;

    if (current?.kind === "images") {
      current.items.forEach((item) => revokeObjectUrl(item.url));
    } else if (current?.kind === "pdf") {
      revokeObjectUrl(current.url);
    }

    reviewSourceRef.current = null;
    setReviewSource(null);
  }

  function showReviewSource(source) {
    reviewSourceRef.current = source;
    setReviewSource(source);
  }

  function setDraft(value) {
    cachedDraft = value;
    setDraftState(value);
  }

  function discardDraft() {
    setDraft(null);
    releaseReviewSource();
    setReviewTab("extraction");
    setTechniqueAcceptErrors({});
    technique.clear();
  }

  const hasSavedKey = Boolean(savedKeyMask);
  const showKeyForm = isKeySectionOpen || !hasSavedKey;
  const extractBlocker = getExtractBlocker({
    mode: sourceMode,
    text: sourceText,
    photos,
    file: pickedFile,
    isExtracting,
  });
  const errorInfo = classifyExtractionError(extractionError);
  const uncertainty = draft?.preview?.uncertainty ?? [];
  const newExercises = draft?.share ? listNewExercisesOfShare(draft.share, draft.preview) : [];
  const newExerciseById = new Map(newExercises.map((exercise) => [exercise.id, exercise]));
  const notedExerciseCount = newExercises.filter((exercise) => exercise.hasNotes).length;

  function handleSaveKey() {
    const cleanKey = keyInput.trim();

    if (!cleanKey) {
      setKeyMessage("Paste a Gemini API key first.");
      return;
    }

    const result = setGeminiApiKey(cleanKey);

    if (!result.ok) {
      setKeyMessage(result.error);
      return;
    }

    setSavedKeyMask(maskKey(cleanKey));
    setKeyInput("");
    setIsKeyVisible(false);
    setKeyMessage("Key saved on this device only. It is never included in backups or shared files.");
  }

  function handleRemoveKey() {
    clearGeminiApiKey();
    setSavedKeyMask("");
    setKeyMessage("Key removed from this device.");
  }

  function handleSelectMode(mode) {
    setSourceMode(mode);
    setExtractionError("");
  }

  function handlePickPhotos(files) {
    setExtractionError("");
    const plan = planPhotoPick(
      photos.map((photo) => photo.file),
      files,
    );

    if (!plan.ok) {
      setPhotoError(plan.error);
      return;
    }

    // The URLs are created here, not inside the state updater: an updater may
    // run twice and every URL must be one this component can revoke.
    const added = files.map((file) => {
      photoIdCounter += 1;
      return {
        id: `photo-${photoIdCounter}`,
        file,
        name: file.name,
        sizeBytes: file.size,
        url: createObjectUrl(file),
      };
    });

    setPhotoError("");
    setPhotos((current) => [...current, ...added]);
  }

  function handleMovePhoto(index, delta) {
    setPhotos((current) => moveListItem(current, index, delta));
  }

  function handleRemovePhoto(index) {
    revokeObjectUrl(photos[index]?.url);
    setPhotos((current) => removeListItem(current, index));
    setPhotoError("");
  }

  async function handlePickFile(file) {
    const token = fileReadTokenRef.current + 1;
    fileReadTokenRef.current = token;
    setExtractionError("");
    const plan = planFilePick(file);
    const base = { file, name: file.name, sizeBytes: file.size };

    if (!plan.ok) {
      // A legacy format (.doc, .xls, .rtf, .odt ...) or a file over its limit:
      // the guidance of sourceFiles.js is shown and Extract stays disabled.
      setPickedFile({ ...base, file: null, kind: null, status: "error", source: null, error: plan.error });
      return;
    }

    if (!plan.readOnPick) {
      setPickedFile({ ...base, kind: plan.kind, status: "ready", source: null, error: "" });
      return;
    }

    setPickedFile({ ...base, kind: plan.kind, status: "reading", source: null, error: "" });
    // DOCX / XLSX are parsed on this device (the parser is a lazy chunk loaded
    // inside officeText.js); the text is shown before anything is sent.
    const source = await readSourceFile(file);

    if (!mountedRef.current || fileReadTokenRef.current !== token) {
      return;
    }

    setPickedFile(
      source.ok
        ? { ...base, kind: plan.kind, status: "ready", source, error: "" }
        : { ...base, file: null, kind: plan.kind, status: "error", source: null, error: source.error },
    );
  }

  function handleClearFile() {
    fileReadTokenRef.current += 1;
    setPickedFile(null);
  }

  /**
   * Reads the active source. Returns { ok, source, review } where `review` is
   * what SourceReviewPanel shows (text, or the files to make object URLs of).
   */
  async function buildSource() {
    if (sourceMode === "text") {
      const source = buildTextSource(sourceText);
      return source.ok
        ? { ok: true, source, review: { kind: "text", title: "Pasted text", note: "", text: source.text } }
        : { ok: false, error: source.error };
    }

    if (sourceMode === "photos") {
      const sources = [];

      for (const photo of photos) {
        const source = await readSourceFile(photo.file);

        if (!source.ok) {
          return { ok: false, error: `${photo.name}: ${source.error}` };
        }

        sources.push(source);
      }

      // One photo keeps the single-image request; several are ONE source of
      // pages in the order shown in the picker (H3-1).
      const source = sources.length === 1 ? sources[0] : buildImageBundle(sources);

      return source.ok
        ? { ok: true, source, review: { kind: "images", files: photos.map((photo) => photo.file) } }
        : { ok: false, error: source.error };
    }

    if (pickedFile?.source) {
      const isOffice = pickedFile.source.meta?.origin === "office";

      return {
        ok: true,
        source: pickedFile.source,
        review: {
          kind: "text",
          title: pickedFile.name,
          note: isOffice
            ? "Text read from the document on this device. The file itself was not sent."
            : "Text file, sent as text.",
          text: pickedFile.source.text,
        },
      };
    }

    if (!pickedFile?.file) {
      return { ok: false, error: "Choose a PDF, Word, Excel or text file first." };
    }

    const source = await readSourceFile(pickedFile.file);

    return source.ok
      ? { ok: true, source, review: { kind: "pdf", file: pickedFile.file } }
      : { ok: false, error: source.error };
  }

  function createReviewSource(review) {
    if (review.kind === "images") {
      return {
        kind: "images",
        items: review.files.map((file) => ({ name: file.name, sizeBytes: file.size, url: createObjectUrl(file) })),
      };
    }

    if (review.kind === "pdf") {
      return {
        kind: "pdf",
        name: review.file.name,
        sizeBytes: review.file.size,
        url: createObjectUrl(review.file),
      };
    }

    return review;
  }

  async function handleExtract() {
    setExtractionError("");
    setImportMessage("");
    // The open draft (and the technique notes accepted into it) is kept until
    // the new extraction has SUCCEEDED: a missing key, a blocked source or a
    // failed request leaves it as it was (fix round 1).

    if (!hasSavedKey) {
      setExtractionError("Save your Gemini API key first.");
      setIsKeySectionOpen(true);
      return;
    }

    if (extractBlocker) {
      setExtractionError(extractBlocker);
      return;
    }

    const extraction = extractionRef.current;
    const run = extraction.start();
    setIsExtracting(true);

    try {
      const built = await buildSource();

      if (!mountedRef.current || !extraction.isCurrent(run.id)) {
        return;
      }

      if (!built.ok) {
        setExtractionError(built.error);
        return;
      }

      const result = await extractProgramDraftWithAi(built.source, { signal: run.signal });

      // The open draft was handed to the Studio, saved or discarded while the
      // request ran: its answer is not a draft anybody asked to keep.
      if (!extraction.isCurrent(run.id)) {
        return;
      }

      if (!mountedRef.current) {
        // The page was left while the request ran: the draft is kept for the
        // next visit, the source is not.
        if (result.valid) {
          cachedDraft = result;
        }

        return;
      }

      if (!result.valid) {
        setExtractionError(result.error);
        return;
      }

      // Only now the previous draft, its source and its technique drafts go.
      discardDraft();
      showReviewSource(createReviewSource(built.review));
      setDraft(result);
    } finally {
      const wasCurrent = extraction.isCurrent(run.id);
      extraction.finish(run.id);

      if (mountedRef.current && (wasCurrent || !extraction.isRunning())) {
        setIsExtracting(false);
      }
    }
  }

  function convertDraft() {
    if (!draft?.share) {
      return null;
    }

    const converted = draftFromShare(draft.share, { origin: "ai-import" });

    if (!converted.ok) {
      setExtractionError(converted.error ?? "The draft could not be converted.");
      return null;
    }

    return converted.draft;
  }

  function handleDiscardDraft() {
    extractionRef.current.cancel();
    setIsExtracting(false);
    discardDraft();
  }

  function handleImport() {
    const programDraft = convertDraft();

    if (!programDraft) {
      return;
    }

    const validation = validateProgramDraft(programDraft);

    if (!validation.valid) {
      setExtractionError(
        `The draft needs a review before it can be saved: ${validation.errors
          .slice(0, 3)
          .map((entry) => entry.message)
          .join(" ")}${validation.errors.length > 3 ? ` (+${validation.errors.length - 3} more)` : ""} Open it in the Studio to fix these.`,
      );
      return;
    }

    const result = onSaveProgramDraft(programDraft);

    if (!result?.ok) {
      setExtractionError(result?.error ?? "The draft could not be saved.");
      return;
    }

    extractionRef.current.cancel();
    discardDraft();
    setImportMessage(
      `Added "${result.program.name}" with ${result.dayCount} ${result.dayCount === 1 ? "day" : "days"} and ${result.exerciseCount} ${result.exerciseCount === 1 ? "exercise" : "exercises"} as an inactive program. Review it in the program list and set it active when ready.`,
    );
  }

  function handleEditInStudio() {
    const programDraft = convertDraft();

    if (!programDraft) {
      return;
    }

    const review = {
      title: `AI import review${draft.model ? ` (${draft.model})` : ""}`,
      origin: "ai-import",
      uncertainty: draft.preview.uncertainty ?? [],
    };

    // Only the draft goes to the Studio (and from there to the stored review
    // draft): the source stays here and is released. A request that is still
    // running is ended, so it cannot bring a second draft back later.
    extractionRef.current.cancel();
    discardDraft();
    onReviewDraft(programDraft, review);
  }

  function requestTechniqueDrafts(exercises) {
    if (!hasSavedKey) {
      setExtractionError("Save your Gemini API key first.");
      setIsKeySectionOpen(true);
      return;
    }

    technique.request(exercises, detectLibraryLanguage(getLibraryCatalog()));
  }

  function handleAcceptTechnique(item, options) {
    const result = acceptTechniqueDraftIntoShare(draft.share, item.draft, options);

    if (!result.ok) {
      setTechniqueAcceptErrors((current) => ({ ...current, [item.id]: result.error }));
      return;
    }

    setTechniqueAcceptErrors((current) => ({ ...current, [item.id]: "" }));
    setDraft({ ...draft, share: result.share });
    technique.markAccepted(item.id);
  }

  return (
    <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        className="focus-ring flex w-full items-center justify-between gap-3 text-left"
      >
        <span>
          <span className="block text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
            AI Program Import Assistant
          </span>
          <span className="mt-1 flex items-center gap-2 text-xl font-black text-white min-[430px]:text-2xl">
            <Sparkles aria-hidden="true" size={20} className="shrink-0 text-lime-300" />
            Create Program Draft from Source
          </span>
        </span>
        {isOpen ? (
          <ChevronUp aria-hidden="true" size={20} className="shrink-0 text-zinc-400" />
        ) : (
          <ChevronDown aria-hidden="true" size={20} className="shrink-0 text-zinc-400" />
        )}
      </button>

      {!isOpen && (
        <p className="mt-2 text-sm leading-6 text-zinc-400">
          Paste or upload an existing plan (text, photos, PDF, Word, Excel) and turn it into an editable
          draft.
        </p>
      )}

      {isOpen && (
        <div className="mt-3">
          <p className="text-sm leading-6 text-zinc-400">
            Converts an existing workout plan into a program draft you review before importing. It
            does not create programs from scratch and it is not the coach - training
            recommendations still come only from the app&apos;s progression engine.
          </p>

          <div className="mt-4 rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-3">
            <button
              type="button"
              onClick={() => setIsKeySectionOpen((open) => !open)}
              aria-expanded={showKeyForm}
              className="focus-ring flex w-full items-center justify-between gap-2 text-left"
            >
              <span className="flex items-center gap-2 text-sm font-black text-white">
                <KeyRound aria-hidden="true" size={16} className="text-lime-300" />
                Gemini API key
                <span className="text-xs font-bold text-zinc-400">
                  {hasSavedKey ? `saved (${savedKeyMask})` : "required"}
                </span>
              </span>
              {showKeyForm ? (
                <ChevronUp aria-hidden="true" size={16} className="shrink-0 text-zinc-400" />
              ) : (
                <ChevronDown aria-hidden="true" size={16} className="shrink-0 text-zinc-400" />
              )}
            </button>
            {showKeyForm && (
              <div className="mt-2">
                {hasSavedKey ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-sm font-bold text-lime-100">
                      Saved on this device ({savedKeyMask})
                    </p>
                    <button
                      type="button"
                      onClick={handleRemoveKey}
                      className="focus-ring min-h-9 rounded-[8px] border border-zinc-700 px-3 text-xs font-black text-zinc-300 hover:bg-zinc-800"
                    >
                      Remove key
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm leading-6 text-zinc-400">
                      Developer mode: bring your own key. Create a free key at{" "}
                      <a
                        href="https://aistudio.google.com/apikey"
                        target="_blank"
                        rel="noreferrer"
                        className="focus-ring font-bold text-lime-300 underline"
                      >
                        aistudio.google.com/apikey
                      </a>{" "}
                      and paste it here. It is stored only in this browser and never included in
                      backups or shared files.
                    </p>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        handleSaveKey();
                      }}
                      className="mt-2 flex flex-col gap-2 sm:flex-row"
                    >
                      <div className="relative flex-1">
                        <input
                          type={isKeyVisible ? "text" : "password"}
                          value={keyInput}
                          onChange={(event) => setKeyInput(event.target.value)}
                          autoComplete="off"
                          aria-label="Gemini API key"
                          placeholder="AIza..."
                          className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-zinc-900 px-3 pr-11 text-sm font-bold text-white placeholder:text-zinc-600"
                        />
                        <button
                          type="button"
                          onClick={() => setIsKeyVisible((visible) => !visible)}
                          aria-label={isKeyVisible ? "Hide API key" : "Show API key"}
                          className="focus-ring absolute right-1 top-1/2 -translate-y-1/2 rounded-[8px] p-2 text-zinc-400 hover:text-white"
                        >
                          {isKeyVisible ? (
                            <EyeOff aria-hidden="true" size={16} />
                          ) : (
                            <Eye aria-hidden="true" size={16} />
                          )}
                        </button>
                      </div>
                      <button
                        type="submit"
                        className="focus-ring min-h-11 rounded-[8px] border border-lime-300/60 px-4 text-sm font-black text-lime-200 hover:bg-lime-300/10"
                      >
                        Save key
                      </button>
                    </form>
                  </>
                )}
                {keyMessage && (
                  <p role="status" className="mt-2 text-xs font-bold leading-5 text-zinc-400">
                    {keyMessage}
                  </p>
                )}
              </div>
            )}
          </div>

          <SourcePicker
            mode={sourceMode}
            onModeChange={handleSelectMode}
            text={sourceText}
            onTextChange={setSourceText}
            maxTextChars={MAX_SOURCE_TEXT_CHARS}
            photos={photos}
            photoError={photoError}
            onPickPhotos={handlePickPhotos}
            onMovePhoto={handleMovePhoto}
            onRemovePhoto={handleRemovePhoto}
            file={pickedFile}
            onPickFile={handlePickFile}
            onClearFile={handleClearFile}
            disabled={isExtracting}
          />

          <p className="mt-2 text-xs leading-5 text-zinc-400">
            Do not upload sensitive medical or personal documents. The assistant extracts only what is in
            the source - it does not invent warm-ups, weights or extra exercises.
          </p>

          <button
            type="button"
            onClick={handleExtract}
            disabled={Boolean(extractBlocker)}
            data-testid="extract-button"
            className="focus-ring mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isExtracting ? (
              <>
                <Loader2 aria-hidden="true" size={18} className="animate-spin" />
                Reading your program...
              </>
            ) : (
              <>
                <Sparkles aria-hidden="true" size={18} />
                Extract Draft from Source
              </>
            )}
          </button>
          {extractBlocker && !isExtracting ? (
            <p className="mt-1 text-xs font-bold text-zinc-400" data-testid="extract-blocker">
              {extractBlocker}
            </p>
          ) : null}

          {extractionError && (
            <div
              role="alert"
              data-error-kind={errorInfo.kind}
              className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2"
            >
              {errorInfo.title ? (
                <p className="text-[11px] font-black uppercase tracking-[0.12em] text-red-200">
                  {errorInfo.title}
                </p>
              ) : null}
              <p className="break-words text-sm font-bold text-red-100">{extractionError}</p>
              {errorInfo.guidance ? (
                <p className="mt-1 break-words text-xs font-bold leading-5 text-red-100/90">
                  Next step: {errorInfo.guidance}
                </p>
              ) : null}
            </div>
          )}
          {importMessage && (
            <p
              role="status"
              className="mt-3 break-words rounded-[8px] border border-lime-300/40 bg-lime-300/10 px-3 py-2 text-sm font-bold text-lime-100"
            >
              {importMessage}
            </p>
          )}

          {draft?.share && (
            <div className="mt-3" data-testid="import-review">
              <div
                role="tablist"
                aria-label="Review"
                className="grid grid-cols-2 gap-1 rounded-[8px] border border-zinc-700 bg-[#111111] p-1 lg:hidden"
              >
                {[
                  { id: "source", label: "Source" },
                  { id: "extraction", label: "Extraction" },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={reviewTab === tab.id}
                    data-review-tab={tab.id}
                    onClick={() => setReviewTab(tab.id)}
                    className={`focus-ring min-h-11 rounded-[6px] px-2 text-xs font-black ${
                      reviewTab === tab.id ? "bg-lime-300 text-zinc-950" : "text-zinc-400 hover:text-white"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="mt-2 grid gap-3 lg:grid-cols-2 lg:items-start">
                {/* Desktop: the source stays in view while the draft scrolls
                    (H3-24); taller than the screen, it scrolls by itself. */}
                <div
                  data-testid="source-review-column"
                  className={`min-w-0 lg:sticky lg:top-3 lg:max-h-[calc(100vh-7rem)] lg:self-start lg:overflow-y-auto lg:block ${reviewTab === "source" ? "" : "hidden"}`}
                >
                  <SourceReviewPanel source={reviewSource} />
                </div>

                <div
                  data-testid="extraction-preview"
                  className={`min-w-0 rounded-[8px] border border-lime-300/30 bg-lime-300/5 p-3 lg:block ${
                    reviewTab === "extraction" ? "" : "hidden"
                  }`}
                >
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-200/80">
                    Draft preview - nothing saved yet
                  </p>

                  {uncertainty.length > 0 && (
                    <div
                      data-testid="check-before-saving"
                      className="mt-2 rounded-[8px] border border-amber-400/50 bg-amber-400/10 px-3 py-2"
                    >
                      <p className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-amber-200">
                        <TriangleAlert aria-hidden="true" size={13} className="shrink-0" />
                        Check these before saving ({uncertainty.length})
                      </p>
                      <UncertaintyList lines={uncertainty} />
                    </div>
                  )}

                  <p className="mt-2 break-words text-lg font-black text-white">
                    {draft.preview.programName}
                  </p>
                  {draft.preview.goal && (
                    <p className="mt-1 break-words text-sm font-bold text-lime-100">
                      {draft.preview.goal}
                    </p>
                  )}
                  {draft.preview.description && (
                    <p className="mt-1 break-words text-sm leading-6 text-zinc-400">
                      {draft.preview.description}
                    </p>
                  )}
                  {draft.preview.structureNotes && !String(draft.preview.description ?? "").includes(draft.preview.structureNotes) && (
                    <p className="mt-1 break-words text-xs font-bold leading-5 text-zinc-400">
                      Source structure (info only): {draft.preview.structureNotes}
                    </p>
                  )}

                  <ul className="mt-3 space-y-2">
                    {draft.preview.days.map((day) => (
                      <li
                        key={day.id}
                        className="rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2"
                      >
                        <p className="break-words text-sm font-black text-white">{day.name}</p>
                        {day.block && (
                          <p className="break-words text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">
                            {day.block} · info only
                          </p>
                        )}
                        {day.focus && (
                          <p className="break-words text-xs font-bold text-zinc-400">{day.focus}</p>
                        )}

                        {day.warmup && (
                          <div className="mt-2 rounded-[6px] border border-cyan-400/30 bg-cyan-400/5 px-2 py-1.5">
                            <p className="text-[11px] font-black uppercase tracking-[0.12em] text-cyan-200/90">
                              {day.warmup.title} · info only
                            </p>
                            <ul className="mt-1 space-y-0.5">
                              {day.warmup.items.map((item) => (
                                <li key={item.id} className="break-words text-xs font-bold text-zinc-300">
                                  {item.name}
                                  {item.prescription ? (
                                    <span className="text-zinc-400"> - {item.prescription}</span>
                                  ) : null}
                                  {item.notes ? (
                                    <span className="font-normal text-zinc-400"> ({item.notes})</span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {day.exercises.length === 0 && (
                          <p className="mt-2 text-xs font-bold text-zinc-400">
                            No working exercises on this day (kept as a rest / recovery day).
                          </p>
                        )}
                        <ul className="mt-2 space-y-1.5">
                          {day.exercises.map((exercise, exerciseIndex) => {
                            const newExercise = exercise.isNewExercise
                              ? newExerciseById.get(String(exercise.exerciseId))
                              : null;

                            return (
                              <li key={`${day.id}-${exerciseIndex}`} className="text-xs">
                                {exercise.section &&
                                  (exerciseIndex === 0 || day.exercises[exerciseIndex - 1].section !== exercise.section) && (
                                    <p className="mb-1 text-[10px] font-black uppercase tracking-[0.12em] text-lime-300">
                                      {exercise.section}
                                    </p>
                                  )}
                                <p className="flex flex-wrap items-center gap-1.5">
                                  {exercise.groupLabel ? (
                                    <span className="rounded-[4px] border border-zinc-700 px-1.5 py-0.5 text-[10px] font-black text-zinc-300">
                                      {exercise.groupLabel}
                                    </span>
                                  ) : null}
                                  <span className="break-words font-black text-zinc-100">
                                    {exercise.name}
                                  </span>
                                  {exercise.matchedLibrary ? (
                                    <span className="rounded-[4px] border border-lime-300/40 bg-lime-300/10 px-1.5 py-0.5 text-[10px] font-black text-lime-200">
                                      Library
                                    </span>
                                  ) : (
                                    <span className="rounded-[4px] border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-black text-amber-200">
                                      New
                                    </span>
                                  )}
                                  {newExercise?.hasNotes ? (
                                    <span className="rounded-[4px] border border-lime-300/40 bg-lime-300/10 px-1.5 py-0.5 text-[10px] font-black text-lime-200">
                                      Technique notes added
                                    </span>
                                  ) : null}
                                </p>
                                <p className="font-bold text-zinc-400">
                                  {exercise.targetSets} × {exercise.repsLabel} · RPE {exercise.targetRPE} ·
                                  rest {exercise.restLabel ?? `${exercise.restTime}s`}
                                </p>
                                {exercise.sourceWeight && (
                                  <p className="break-words font-bold text-zinc-400">
                                    Source load: {exercise.sourceWeight} (info only, not a target)
                                  </p>
                                )}
                                {exercise.notes && (
                                  <p className="break-words font-bold text-zinc-400">{exercise.notes}</p>
                                )}
                                {exercise.missingFields.length > 0 && (
                                  <p className="font-bold text-amber-200/90">
                                    Not in source (safe defaults used): {exercise.missingFields.join(", ")}
                                  </p>
                                )}
                                {/* Decision H3-6: technique drafts exist for NEW exercises only. */}
                                {exercise.isNewExercise && newExercise ? (
                                  <button
                                    type="button"
                                    disabled={technique.busy || isExtracting}
                                    data-technique-action={newExercise.id}
                                    onClick={() => requestTechniqueDrafts([newExercise])}
                                    className="focus-ring mt-1 inline-flex min-h-10 items-center gap-1.5 rounded-[8px] border border-lime-300/50 px-2.5 text-xs font-black text-lime-200 hover:bg-lime-300/10 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    <Sparkles aria-hidden="true" size={13} />
                                    Draft technique notes with AI
                                  </button>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      </li>
                    ))}
                  </ul>

                  {newExercises.length > 0 && (
                    <div className="mt-3 rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2">
                      <p className="text-xs font-bold leading-5 text-zinc-300">
                        {newExercises.length} new {newExercises.length === 1 ? "exercise has" : "exercises have"} no
                        Library entry yet{notedExerciseCount ? ` (${notedExerciseCount} with accepted technique notes)` : ""}.
                        Optional: ask for technique-note drafts. Only the exercise names, equipment and
                        muscles are sent to Google; you accept or discard each draft.
                      </p>
                      <button
                        type="button"
                        disabled={technique.busy || isExtracting}
                        data-technique-action="all"
                        onClick={() => requestTechniqueDrafts(newExercises)}
                        className="focus-ring mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[8px] border border-lime-300/60 px-3 text-sm font-black text-lime-200 hover:bg-lime-300/10 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                      >
                        <Sparkles aria-hidden="true" size={15} />
                        Draft notes for all new exercises ({newExercises.length})
                      </button>
                    </div>
                  )}

                  <div className="mt-3">
                    <TechniqueDraftReview
                      items={technique.items}
                      busy={technique.busy}
                      progress={technique.progress}
                      error={technique.error}
                      uncertainty={technique.uncertainty}
                      model={technique.model}
                      hasNotes={(id) => Boolean(newExerciseById.get(String(id))?.hasNotes)}
                      acceptErrors={techniqueAcceptErrors}
                      onAccept={handleAcceptTechnique}
                      onDiscard={technique.discard}
                    />
                  </div>

                  {draft.preview.uncertainty?.length > 0 && (
                    <div className="mt-3 rounded-[8px] border border-amber-400/40 bg-amber-400/10 px-3 py-2">
                      <p className="text-[11px] font-black uppercase tracking-[0.12em] text-amber-200">
                        Uncertainty disclosed by the assistant ({draft.preview.uncertainty.length})
                      </p>
                      <p className="mt-1 text-xs font-bold text-amber-100">
                        Listed at the top of this preview under &quot;Check these before saving&quot;. The list
                        travels with the draft into the Studio.
                      </p>
                    </div>
                  )}

                  <p className="mt-3 text-xs font-bold leading-5 text-zinc-400">
                    {(() => {
                      const counts = countPreviewProvenance(draft.preview);
                      return `${counts.source} ${counts.source === 1 ? "value" : "values"} read from the source, ${counts.default} filled with app defaults.`;
                    })()}
                    {draft.summary.emptyDayCount > 0
                      ? ` ${draft.summary.emptyDayCount} ${draft.summary.emptyDayCount === 1 ? "day has" : "days have"} no working exercises.`
                      : ""}
                  </p>

                  <p className="mt-2 text-xs font-bold leading-5 text-zinc-400">
                    {draft.summary.reusedExerciseCount}{" "}
                    {draft.summary.reusedExerciseCount === 1 ? "exercise matches" : "exercises match"}{" "}
                    your library
                    {draft.summary.newExerciseCount > 0
                      ? `, ${draft.summary.newExerciseCount} will be added as new local ${draft.summary.newExerciseCount === 1 ? "exercise" : "exercises"} (${
                          notedExerciseCount
                            ? `${notedExerciseCount} with the technique notes you accepted`
                            : "without coaching content"
                        })`
                      : ""}
                    {draft.summary.warmupDayCount > 0
                      ? `. Warm-up kept on ${draft.summary.warmupDayCount} ${draft.summary.warmupDayCount === 1 ? "day" : "days"} as info only`
                      : ""}
                    . No starting weights are extracted - the coach establishes baselines from your
                    first logged sessions.
                  </p>

                  <div className="mt-3 flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
                    <button
                      type="button"
                      onClick={handleEditInStudio}
                      disabled={isExtracting}
                      className="focus-ring flex min-h-11 flex-1 items-center justify-center rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Edit draft in Studio
                    </button>
                    <button
                      type="button"
                      onClick={handleImport}
                      disabled={isExtracting}
                      className="focus-ring flex min-h-11 flex-1 items-center justify-center rounded-[8px] border border-lime-300/60 px-4 text-sm font-black text-lime-200 hover:bg-lime-300/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Add to my programs
                    </button>
                    <button
                      type="button"
                      onClick={handleDiscardDraft}
                      disabled={isExtracting}
                      className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 px-4 text-sm font-black text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Discard draft
                    </button>
                  </div>
                  {isExtracting ? (
                    <p className="mt-2 text-xs font-bold leading-5 text-zinc-400" data-testid="draft-actions-waiting">
                      A new extraction is running. This draft can be opened, saved or discarded once it has
                      finished.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
