import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { findTextMatches, formatFileSize } from "../../lib/importAssistant.js";

/**
 * The source next to its extraction (decision H3-5). Everything shown here
 * lives in the assistant's component memory: text as a string, photos and
 * PDF as object URLs the assistant revokes on discard / unmount. Nothing is
 * written to storage and nothing is sent from here.
 *
 * props: { source } where source is
 *   { kind: "text", title, note, text }
 *   { kind: "images", items: [{ name, sizeBytes, url }] }
 *   { kind: "pdf", name, sizeBytes, url }
 *   null (the source is no longer in memory)
 */
export default function SourceReviewPanel({ source }) {
  const [query, setQuery] = useState("");
  const [enlargedIndex, setEnlargedIndex] = useState(-1);
  const text = source?.kind === "text" ? source.text : "";
  const matches = useMemo(() => findTextMatches(text, query), [text, query]);
  const images = source?.kind === "images" ? source.items : [];
  const enlarged = enlargedIndex >= 0 ? images[enlargedIndex] : null;

  useEffect(() => {
    if (!enlarged) {
      return undefined;
    }

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setEnlargedIndex(-1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enlarged]);

  return (
    <section
      aria-label="Source"
      data-testid="source-review-panel"
      className="card-inset"
    >
      <p className="label">
        Source - kept in this tab only
      </p>

      {!source && (
        <p className="mt-2 text-sm font-semibold leading-6 text-text-2">
          The source is no longer in memory (the page was left or reloaded). The draft is still here; choose the
          source again and press Extract to compare them side by side.
        </p>
      )}

      {source?.kind === "text" && (
        <>
          <p className="mt-1 break-words text-sm font-semibold text-text-1">{source.title}</p>
          {source.note ? <p className="text-xs font-semibold text-text-2">{source.note}</p> : null}
          <div className="relative mt-2">
            <Search
              aria-hidden="true"
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-2"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the sent text"
              aria-label="Search the sent text"
              autoComplete="off"
              className="focus-ring min-h-11 field w-full pl-9 pr-3"
            />
          </div>
          {query.trim() ? (
            <p role="status" className="mt-1 text-xs font-semibold text-text-2">
              {matches.count} {matches.count === 1 ? "match" : "matches"}
            </p>
          ) : null}
          <pre
            tabIndex={0}
            aria-label="Text that was sent"
            className="card-inset mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-text-1 lg:max-h-[70vh]"
          >
            {matches.segments.map((segment, index) =>
              segment.match ? (
                <mark key={index} className="bg-accent text-accent-fg">
                  {segment.text}
                </mark>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
          </pre>
        </>
      )}

      {source?.kind === "images" && (
        <>
          <p className="mt-1 text-xs font-semibold text-text-2">
            {images.length} {images.length === 1 ? "photo" : "photos"} sent in this order. Tap one to enlarge it.
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-2 min-[430px]:grid-cols-3">
            {images.map((image, index) => (
              <li key={image.url}>
                <button
                  type="button"
                  onClick={() => setEnlargedIndex(index)}
                  aria-label={`Enlarge page ${index + 1}: ${image.name}`}
                  className="focus-ring block w-full overflow-hidden rounded-control border border-line bg-bg text-left hover:border-line-accent"
                >
                  <img src={image.url} alt="" className="h-28 w-full object-cover" />
                  <span className="block px-2 py-1">
                    <span className="label-accent">
                      Page {index + 1}
                    </span>
                    <span className="block truncate text-xs font-semibold text-text-2">{image.name}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {source?.kind === "pdf" && (
        <>
          <p className="mt-1 break-all text-sm font-semibold text-text-1">
            {source.name} <span className="font-semibold text-text-2">({formatFileSize(source.sizeBytes)})</span>
          </p>
          <object
            data={source.url}
            type="application/pdf"
            aria-label={`PDF source: ${source.name}`}
            className="card-inset mt-2 h-96 w-full lg:h-[70vh]"
          >
            <p className="p-3 text-sm font-semibold leading-6 text-text-2">
              This browser cannot show the PDF inside the page. Open {source.name} in your PDF viewer to compare
              it with the extraction.
            </p>
          </object>
        </>
      )}

      {enlarged && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Page ${enlargedIndex + 1}: ${enlarged.name}`}
          className="fixed inset-0 z-50 flex flex-col bg-bg/95 p-3"
          onClick={() => setEnlargedIndex(-1)}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm font-semibold text-text-1">
              Page {enlargedIndex + 1} of {images.length} - {enlarged.name}
            </p>
            <button
              type="button"
              onClick={() => setEnlargedIndex(-1)}
              className="focus-ring btn btn-secondary inline-flex min-h-11 shrink-0 items-center gap-1 px-3"
            >
              <X aria-hidden="true" size={16} />
              Close
            </button>
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-auto" onClick={(event) => event.stopPropagation()}>
            <img src={enlarged.url} alt={`Page ${enlargedIndex + 1}: ${enlarged.name}`} className="mx-auto max-w-none" style={{ minWidth: "100%" }} />
          </div>
          {images.length > 1 && (
            <div className="mt-3 flex justify-center gap-2" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                disabled={enlargedIndex === 0}
                onClick={() => setEnlargedIndex((index) => Math.max(0, index - 1))}
                className="focus-ring min-h-11 btn btn-secondary"
              >
                Previous page
              </button>
              <button
                type="button"
                disabled={enlargedIndex === images.length - 1}
                onClick={() => setEnlargedIndex((index) => Math.min(images.length - 1, index + 1))}
                className="focus-ring min-h-11 btn btn-secondary"
              >
                Next page
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
