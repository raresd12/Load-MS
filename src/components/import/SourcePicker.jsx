import { useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  ClipboardList,
  FileText,
  Image as ImageIcon,
  Loader2,
  X,
} from "lucide-react";
import {
  describeSourceMeta,
  formatFileSize,
  SOURCE_PRIVACY_NOTE,
  summarizePhotos,
} from "../../lib/importAssistant.js";
import {
  LEGACY_OFFICE_GUIDANCE,
  SOURCE_FILE_ACCEPT,
  SOURCE_IMAGE_ACCEPT,
  SOURCE_LIMITS,
} from "../../lib/sourceFiles.js";

const PICKER_MODES = [
  { id: "text", label: "Text", icon: ClipboardList },
  { id: "photos", label: "Photos", icon: ImageIcon },
  { id: "file", label: "File", icon: FileText },
];

const MIB = 1024 * 1024;
const pickButtonClassName =
  "focus-ring btn btn-secondary flex min-h-11 w-full items-center justify-center gap-2 border-dashed";
const photoButtonClassName =
  "focus-ring btn btn-secondary inline-flex min-w-11 items-center justify-center gap-1 px-2 text-xs";

function PickerAlert({ children }) {
  return (
    <p
      role="alert"
      className="mt-2 break-words rounded-block bg-warn-tint px-3 py-2 text-sm font-semibold text-warn"
    >
      {children}
    </p>
  );
}

/**
 * Source picking of the AI Import Assistant (decisions H3-1, H3-2, H3-5).
 * Presentational: the assistant owns the state, the object URLs and every
 * read. Photos are several pages of ONE program in the order shown; a file
 * is always sent alone; DOCX / XLSX / text files show the text that will be
 * sent before anything leaves the device.
 *
 * props: { mode, onModeChange, text, onTextChange, maxTextChars,
 *          photos: [{ id, name, sizeBytes, url }], photoError, onPickPhotos(files),
 *          onMovePhoto(index, delta), onRemovePhoto(index),
 *          file: { name, sizeBytes, kind, status, source, error } | null,
 *          onPickFile(file), onClearFile(), disabled }
 */
export default function SourcePicker({
  mode,
  onModeChange,
  text,
  onTextChange,
  maxTextChars,
  photos,
  photoError,
  onPickPhotos,
  onMovePhoto,
  onRemovePhoto,
  file,
  onPickFile,
  onClearFile,
  disabled = false,
}) {
  const photoInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const photoSummary = summarizePhotos(photos);
  const fileMeta = file?.source ? describeSourceMeta(file.source) : null;

  return (
    <div>
      <div
        role="tablist"
        aria-label="Program source"
        className="card-inset mt-4 grid grid-cols-3 gap-1 p-1"
      >
        {PICKER_MODES.map((entry) => {
          const Icon = entry.icon;
          const isActive = mode === entry.id;

          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-source-mode={entry.id}
              onClick={() => onModeChange(entry.id)}
              className={`focus-ring flex min-h-11 flex-col items-center justify-center gap-1 rounded-control px-1 py-1.5 text-[11px] font-semibold leading-tight min-[430px]:flex-row min-[430px]:gap-1.5 min-[430px]:text-xs ${
                isActive ? "bg-accent text-accent-fg" : "text-text-2 hover:text-text-1"
              }`}
            >
              <Icon aria-hidden="true" size={14} className="shrink-0" />
              {entry.label}
            </button>
          );
        })}
      </div>

      <div className="mt-3">
        {mode === "text" && (
          <>
            <label
              htmlFor="ai-source-text"
              className="label"
            >
              Program text from your source
            </label>
            <textarea
              id="ai-source-text"
              value={text}
              onChange={(event) => onTextChange(event.target.value)}
              maxLength={maxTextChars}
              placeholder={"Day 1 - Upper\nBench Press 4x6-8 RPE 8, rest 3 min\nRow 4x8-10\n..."}
              className="focus-ring field mt-1 min-h-40 w-full resize-y py-3"
            />
            <p className="mt-1 text-xs font-semibold text-text-2">
              {String(text ?? "").length.toLocaleString("en-US")} of {maxTextChars.toLocaleString("en-US")} characters
            </p>
          </>
        )}

        {mode === "photos" && (
          <>
            <input
              ref={photoInputRef}
              type="file"
              multiple
              accept={SOURCE_IMAGE_ACCEPT}
              data-source-input="photos"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                event.target.value = "";
                onPickPhotos(picked);
              }}
              className="hidden"
              aria-label="Upload photos of your workout plan"
            />
            <button
              type="button"
              disabled={disabled || photoSummary.remaining === 0}
              onClick={() => photoInputRef.current?.click()}
              className={pickButtonClassName}
            >
              <ImageIcon aria-hidden="true" size={16} />
              {photos.length ? "Add photos" : "Choose photos (JPG, PNG, WebP)"}
            </button>
            <p className="mt-2 text-xs leading-5 text-text-2">
              Up to {SOURCE_LIMITS.MAX_IMAGES_PER_SOURCE} photos of the same program, each up to{" "}
              {Math.round(SOURCE_LIMITS.MAX_IMAGE_FILE_BYTES / MIB)} MB. They are sent as pages in the order
              shown here.
            </p>

            {photos.length > 0 && (
              <>
                <ol className="mt-2 space-y-2" aria-label="Photos in page order">
                  {photos.map((photo, index) => (
                    <li
                      key={photo.id}
                      className="flex items-center gap-3 card-inset p-2"
                    >
                      <img
                        src={photo.url}
                        alt={`Page ${index + 1}: ${photo.name}`}
                        className="h-16 w-16 shrink-0 rounded-control border border-line bg-bg object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="label-accent">
                          Page {index + 1} of {photos.length}
                        </p>
                        <p className="break-all text-sm font-semibold text-text-1">{photo.name}</p>
                        <p className="text-xs font-semibold text-text-2">{formatFileSize(photo.sizeBytes)}</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            disabled={disabled || index === 0}
                            onClick={() => onMovePhoto(index, -1)}
                            aria-label={`Move page ${index + 1} up`}
                            className={photoButtonClassName}
                          >
                            <ArrowUp aria-hidden="true" size={13} />
                            Move up
                          </button>
                          <button
                            type="button"
                            disabled={disabled || index === photos.length - 1}
                            onClick={() => onMovePhoto(index, 1)}
                            aria-label={`Move page ${index + 1} down`}
                            className={photoButtonClassName}
                          >
                            <ArrowDown aria-hidden="true" size={13} />
                            Move down
                          </button>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => onRemovePhoto(index)}
                            aria-label={`Remove page ${index + 1}`}
                            className={photoButtonClassName}
                          >
                            <X aria-hidden="true" size={13} />
                            Remove
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-xs font-semibold text-text-2" data-testid="photo-total">
                  {photoSummary.label}
                </p>
              </>
            )}
            {photoError && <PickerAlert>{photoError}</PickerAlert>}
          </>
        )}

        {mode === "file" && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept={SOURCE_FILE_ACCEPT}
              data-source-input="file"
              onChange={(event) => {
                const picked = event.target.files?.[0] ?? null;
                event.target.value = "";

                if (picked) {
                  onPickFile(picked);
                }
              }}
              className="hidden"
              aria-label="Upload workout plan PDF, Word, Excel or text file"
            />
            <button
              type="button"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              className={pickButtonClassName}
            >
              <FileText aria-hidden="true" size={16} />
              Choose file (PDF, DOCX, XLSX, TXT, MD, CSV)
            </button>
            <p className="mt-2 text-xs leading-5 text-text-2">
              One file at a time: PDF up to {Math.round(SOURCE_LIMITS.MAX_PDF_FILE_BYTES / MIB)} MB, Word / Excel
              (.docx, .xlsx) up to {Math.round(SOURCE_LIMITS.MAX_OFFICE_FILE_BYTES / MIB)} MB, text up to{" "}
              {Math.round(SOURCE_LIMITS.MAX_TEXT_FILE_BYTES / MIB)} MB. Word and Excel files are read on this
              device and sent as text. Older formats (.doc, .xls, .rtf, .odt, .ods, .pages, .numbers):{" "}
              {LEGACY_OFFICE_GUIDANCE}
            </p>

            {file && (
              <div className="card-inset mt-2 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 break-all text-sm font-semibold text-text-1">
                    {file.name}{" "}
                    <span className="font-semibold text-text-2">({formatFileSize(file.sizeBytes)})</span>
                  </p>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={onClearFile}
                    aria-label="Remove selected file"
                    className="focus-ring shrink-0 rounded-control p-2 text-text-2 hover:text-text-1 disabled:opacity-40"
                  >
                    <X aria-hidden="true" size={16} />
                  </button>
                </div>
                {file.status === "reading" && (
                  <p role="status" className="mt-1 flex items-center gap-2 text-xs font-semibold text-text-2">
                    <Loader2 aria-hidden="true" size={14} className="animate-spin" />
                    Reading the file on this device...
                  </p>
                )}
                {file.status === "ready" && file.kind === "pdf" && (
                  <p className="mt-1 text-xs font-semibold text-text-2">
                    The PDF is sent as it is when you press Extract.
                  </p>
                )}
                {file.status === "ready" && file.source?.text && (
                  <div className="mt-2">
                    <label
                      htmlFor="ai-source-file-text"
                      className="label"
                    >
                      Text that will be sent
                    </label>
                    <textarea
                      id="ai-source-file-text"
                      readOnly
                      value={file.source.text}
                      className="focus-ring field mt-1 h-48 w-full resize-y py-2 font-mono text-xs leading-5"
                    />
                    {fileMeta?.lines.map((line) => (
                      <p
                        key={line}
                        className={`mt-1 text-xs font-semibold ${line.startsWith("Truncated") ? "text-warn" : "text-text-2"}`}
                      >
                        {line}
                      </p>
                    ))}
                    {fileMeta?.warnings.length ? (
                      <ul className="mt-1 ml-3 list-disc space-y-0.5" aria-label="What was left out of the file">
                        {fileMeta.warnings.map((warning, index) => (
                          <li key={`${index}-${warning}`} className="break-words text-xs font-semibold text-warn">
                            {warning}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                )}
              </div>
            )}
            {file?.status === "error" && <PickerAlert>{file.error}</PickerAlert>}
          </>
        )}
      </div>

      <p className="mt-3 text-xs font-semibold leading-5 text-text-2" data-testid="source-privacy-note">
        {SOURCE_PRIVACY_NOTE}
      </p>
    </div>
  );
}
