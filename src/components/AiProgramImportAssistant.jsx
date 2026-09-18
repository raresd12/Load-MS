import { useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import {
  classifySourceFile,
  clearGeminiApiKey,
  extractProgramDraftWithAi,
  getGeminiApiKey,
  MAX_SOURCE_TEXT_CHARS,
  setGeminiApiKey,
  UNSUPPORTED_SOURCE_FALLBACK,
} from "../lib/aiProgram.js";

const SOURCE_MODES = [
  { id: "text", label: "Paste Text", icon: ClipboardList },
  { id: "image", label: "Upload Image", icon: ImageIcon },
  { id: "file", label: "Upload PDF/File", icon: FileText },
];

const IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";
const FILE_ACCEPT = ".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv";

function maskKey(key) {
  if (!key) {
    return "";
  }

  return `••••${key.slice(-4)}`;
}

function formatFileSize(bytes) {
  const size = Number(bytes) || 0;

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(new Error("file-read-failed"));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("file-read-failed"));
    reader.readAsText(file);
  });
}

// Module-level cache so an extracted draft survives tab switches
// (ProgramPage unmounts when the user navigates away). Memory only:
// uploaded files and drafts are never written to storage.
let cachedDraft = null;

export default function AiProgramImportAssistant({ onImportProgramShare }) {
  const [isOpen, setIsOpen] = useState(false);
  const [savedKeyMask, setSavedKeyMask] = useState(() => maskKey(getGeminiApiKey()));
  const [isKeySectionOpen, setIsKeySectionOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const [keyMessage, setKeyMessage] = useState("");
  const [sourceMode, setSourceMode] = useState("text");
  const [sourceText, setSourceText] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileError, setFileError] = useState("");
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionError, setExtractionError] = useState("");
  const [draft, setDraftState] = useState(() => cachedDraft);
  const [importMessage, setImportMessage] = useState("");
  const fileInputRef = useRef(null);

  function setDraft(value) {
    cachedDraft = value;
    setDraftState(value);
  }

  const hasSavedKey = Boolean(savedKeyMask);
  const showKeyForm = isKeySectionOpen || !hasSavedKey;

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
    setFileError("");
    setSelectedFile(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleFileChange(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    setFileError("");
    setExtractionError("");

    if (!file) {
      return;
    }

    const classified = classifySourceFile(file.name, file.type, file.size);

    if (!classified.ok) {
      setSelectedFile(null);
      setFileError(classified.error);
      return;
    }

    if (sourceMode === "image" && classified.kind !== "image") {
      setSelectedFile(null);
      setFileError("Choose a JPG, PNG or WebP image here, or switch to the PDF/File tab.");
      return;
    }

    setSelectedFile({ file, kind: classified.kind, mimeType: classified.mimeType });
  }

  function handleClearFile() {
    setSelectedFile(null);
    setFileError("");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function buildSource() {
    if (sourceMode === "text") {
      return { kind: "text", text: sourceText };
    }

    if (!selectedFile) {
      return null;
    }

    if (selectedFile.kind === "text") {
      const text = await readFileAsText(selectedFile.file);
      return { kind: "text", text };
    }

    const dataBase64 = await readFileAsBase64(selectedFile.file);
    return { kind: selectedFile.kind, mimeType: selectedFile.mimeType, dataBase64 };
  }

  async function handleExtract() {
    setExtractionError("");
    setImportMessage("");
    setDraft(null);

    if (!hasSavedKey) {
      setExtractionError("Save your Gemini API key first.");
      setIsKeySectionOpen(true);
      return;
    }

    if (sourceMode !== "text" && !selectedFile) {
      setExtractionError(
        sourceMode === "image" ? "Choose an image of your plan first." : "Choose a PDF or text file first.",
      );
      return;
    }

    setIsExtracting(true);

    try {
      let source;

      try {
        source = await buildSource();
      } catch {
        setExtractionError("The file could not be read. Try selecting it again.");
        return;
      }

      const result = await extractProgramDraftWithAi(source);

      if (!result.valid) {
        setExtractionError(result.error);
        return;
      }

      setDraft(result);
    } finally {
      setIsExtracting(false);
    }
  }

  function handleImport() {
    if (!draft?.share) {
      return;
    }

    const result = onImportProgramShare(draft.share);

    if (!result.valid) {
      setExtractionError(result.error ?? "The draft could not be imported.");
      return;
    }

    setDraft(null);
    setImportMessage(
      `Added "${result.program.name}" with ${result.importedDayCount} ${result.importedDayCount === 1 ? "day" : "days"} and ${result.importedExerciseCount} ${result.importedExerciseCount === 1 ? "exercise" : "exercises"} as an inactive program. Review it in the program list and set it active when ready.`,
    );
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
          Paste or upload an existing plan (text, photo, PDF) and turn it into an editable draft.
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
                <span className="text-xs font-bold text-zinc-500">
                  {hasSavedKey ? `saved (${savedKeyMask})` : "required"}
                </span>
              </span>
              {showKeyForm ? (
                <ChevronUp aria-hidden="true" size={16} className="shrink-0 text-zinc-500" />
              ) : (
                <ChevronDown aria-hidden="true" size={16} className="shrink-0 text-zinc-500" />
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

          <div role="tablist" aria-label="Program source" className="mt-4 grid grid-cols-3 gap-1 rounded-[8px] border border-zinc-700 bg-[#111111] p-1">
            {SOURCE_MODES.map((mode) => {
              const Icon = mode.icon;
              const isActive = sourceMode === mode.id;

              return (
                <button
                  key={mode.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => handleSelectMode(mode.id)}
                  className={`focus-ring flex min-h-10 flex-col items-center justify-center gap-1 rounded-[6px] px-1 py-1.5 text-[11px] font-black leading-tight min-[430px]:flex-row min-[430px]:gap-1.5 min-[430px]:text-xs ${
                    isActive ? "bg-lime-300 text-zinc-950" : "text-zinc-400 hover:text-white"
                  }`}
                >
                  <Icon aria-hidden="true" size={14} className="shrink-0" />
                  {mode.label}
                </button>
              );
            })}
          </div>

          <div className="mt-3">
            {sourceMode === "text" ? (
              <>
                <label
                  htmlFor="ai-source-text"
                  className="text-xs font-black uppercase tracking-[0.14em] text-zinc-400"
                >
                  Program text from your source
                </label>
                <textarea
                  id="ai-source-text"
                  value={sourceText}
                  onChange={(event) => setSourceText(event.target.value)}
                  maxLength={MAX_SOURCE_TEXT_CHARS}
                  placeholder={"Day 1 - Upper\nBench Press 4x6-8 RPE 8, rest 3 min\nRow 4x8-10\n..."}
                  className="focus-ring mt-1 min-h-40 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-3 text-sm font-bold text-white placeholder:text-zinc-600"
                />
              </>
            ) : (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={sourceMode === "image" ? IMAGE_ACCEPT : FILE_ACCEPT}
                  onChange={handleFileChange}
                  className="hidden"
                  aria-label={sourceMode === "image" ? "Upload workout plan image" : "Upload workout plan PDF or text file"}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="focus-ring flex min-h-11 w-full items-center justify-center gap-2 rounded-[8px] border border-dashed border-zinc-600 px-4 text-sm font-black text-zinc-200 hover:bg-zinc-800"
                >
                  {sourceMode === "image" ? (
                    <ImageIcon aria-hidden="true" size={16} />
                  ) : (
                    <FileText aria-hidden="true" size={16} />
                  )}
                  {sourceMode === "image"
                    ? "Choose image (JPG, PNG, WebP)"
                    : "Choose file (PDF, TXT, MD, CSV)"}
                </button>
                {selectedFile && (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2">
                    <p className="min-w-0 break-words text-sm font-bold text-white">
                      {selectedFile.file.name}{" "}
                      <span className="font-bold text-zinc-500">
                        ({formatFileSize(selectedFile.file.size)})
                      </span>
                    </p>
                    <button
                      type="button"
                      onClick={handleClearFile}
                      aria-label="Remove selected file"
                      className="focus-ring shrink-0 rounded-[8px] p-2 text-zinc-400 hover:text-white"
                    >
                      <X aria-hidden="true" size={16} />
                    </button>
                  </div>
                )}
                {fileError && (
                  <p
                    role="alert"
                    className="mt-2 rounded-[8px] border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-sm font-bold text-amber-100"
                  >
                    {fileError}
                  </p>
                )}
                {sourceMode === "file" && (
                  <p className="mt-2 text-xs leading-5 text-zinc-500">
                    Word/Excel files are not supported yet. {UNSUPPORTED_SOURCE_FALLBACK}
                  </p>
                )}
              </>
            )}
          </div>

          <p className="mt-3 text-xs leading-5 text-zinc-500">
            Files/text are sent to Gemini using your API key to extract a draft. Do not upload
            sensitive medical or personal documents. Uploaded files are used only for this draft
            and are never stored, backed up or shared. The assistant extracts only what is in the
            source - it does not invent warm-ups, weights or extra exercises.
          </p>

          <button
            type="button"
            onClick={handleExtract}
            disabled={isExtracting}
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
                Create Draft from Source
              </>
            )}
          </button>

          {extractionError && (
            <p
              role="alert"
              className="mt-3 rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm font-bold text-red-100"
            >
              {extractionError}
            </p>
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
            <div className="mt-3 rounded-[8px] border border-lime-300/30 bg-lime-300/5 p-3">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-200/80">
                Draft preview - nothing saved yet
              </p>
              <p className="mt-1 break-words text-lg font-black text-white">
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

              <ul className="mt-3 space-y-2">
                {draft.preview.days.map((day) => (
                  <li
                    key={day.id}
                    className="rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2"
                  >
                    <p className="break-words text-sm font-black text-white">{day.name}</p>
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
                                <span className="text-zinc-500"> - {item.prescription}</span>
                              ) : null}
                              {item.notes ? (
                                <span className="font-normal text-zinc-500"> ({item.notes})</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <ul className="mt-2 space-y-1.5">
                      {day.exercises.map((exercise, exerciseIndex) => (
                        <li key={`${day.id}-${exerciseIndex}`} className="text-xs">
                          <p className="flex flex-wrap items-center gap-1.5">
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
                          </p>
                          <p className="font-bold text-zinc-400">
                            {exercise.targetSets} × {exercise.repsLabel} · RPE {exercise.targetRPE} ·
                            rest {exercise.restTime}s
                          </p>
                          {exercise.notes && (
                            <p className="break-words font-bold text-zinc-500">{exercise.notes}</p>
                          )}
                          {exercise.missingFields.length > 0 && (
                            <p className="font-bold text-amber-200/90">
                              Not in source (safe defaults used): {exercise.missingFields.join(", ")}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>

              <p className="mt-3 text-xs font-bold leading-5 text-zinc-500">
                {draft.summary.reusedExerciseCount}{" "}
                {draft.summary.reusedExerciseCount === 1 ? "exercise matches" : "exercises match"}{" "}
                your library
                {draft.summary.newExerciseCount > 0
                  ? `, ${draft.summary.newExerciseCount} will be added as new local ${draft.summary.newExerciseCount === 1 ? "exercise" : "exercises"} (without coaching content)`
                  : ""}
                {draft.summary.warmupDayCount > 0
                  ? `. Warm-up kept on ${draft.summary.warmupDayCount} ${draft.summary.warmupDayCount === 1 ? "day" : "days"} as info only`
                  : ""}
                . No starting weights are extracted - the coach establishes baselines from your
                first logged sessions.
              </p>

              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={handleImport}
                  className="focus-ring flex min-h-11 flex-1 items-center justify-center rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
                >
                  Add to my programs
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 px-4 text-sm font-black text-zinc-300 hover:bg-zinc-800"
                >
                  Discard draft
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
