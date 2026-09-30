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
      className="rounded-[8px] border border-zinc-700 bg-[#111111] p-3"
    >
      <p className="text-xs font-black uppercase tracking-[0.14em] text-zinc-300">
        Source - kept in this tab only
      </p>

      {!source && (
        <p className="mt-2 text-sm font-bold leading-6 text-zinc-400">
          The source is no longer in memory (the page was left or reloaded). The draft is still here; choose the
          source again and press Extract to compare them side by side.
        </p>
      )}

      {source?.kind === "text" && (
        <>
          <p className="mt-1 break-words text-sm font-black text-white">{source.title}</p>
          {source.note ? <p className="text-xs font-bold text-zinc-400">{source.note}</p> : null}
          <div className="relative mt-2">
            <Search
              aria-hidden="true"
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search the sent text"
              aria-label="Search the sent text"
              autoComplete="off"
              className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-zinc-950 pl-9 pr-3 text-sm font-bold text-white placeholder:text-zinc-600"
            />
          </div>
          {query.trim() ? (
            <p role="status" className="mt-1 text-xs font-bold text-zinc-400">
              {matches.count} {matches.count === 1 ? "match" : "matches"}
            </p>
          ) : null}
          <pre
            tabIndex={0}
            aria-label="Text that was sent"
            className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-200 lg:max-h-[70vh]"
          >
            {matches.segments.map((segment, index) =>
              segment.match ? (
                <mark key={index} className="rounded-[2px] bg-lime-300 text-zinc-950">
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
          <p className="mt-1 text-xs font-bold text-zinc-400">
            {images.length} {images.length === 1 ? "photo" : "photos"} sent in this order. Tap one to enlarge it.
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-2 min-[430px]:grid-cols-3">
            {images.map((image, index) => (
              <li key={image.url}>
                <button
                  type="button"
                  onClick={() => setEnlargedIndex(index)}
                  aria-label={`Enlarge page ${index + 1}: ${image.name}`}
                  className="focus-ring block w-full overflow-hidden rounded-[8px] border border-zinc-700 bg-zinc-950 text-left hover:border-lime-300/60"
                >
                  <img src={image.url} alt="" className="h-28 w-full object-cover" />
                  <span className="block px-2 py-1">
                    <span className="block text-[11px] font-black uppercase tracking-[0.12em] text-lime-300">
                      Page {index + 1}
                    </span>
                    <span className="block truncate text-xs font-bold text-zinc-300">{image.name}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {source?.kind === "pdf" && (
        <>
          <p className="mt-1 break-all text-sm font-black text-white">
            {source.name} <span className="font-bold text-zinc-400">({formatFileSize(source.sizeBytes)})</span>
          </p>
          <object
            data={source.url}
            type="application/pdf"
            aria-label={`PDF source: ${source.name}`}
            className="mt-2 h-96 w-full rounded-[8px] border border-zinc-800 bg-zinc-950 lg:h-[70vh]"
          >
            <p className="p-3 text-sm font-bold leading-6 text-zinc-300">
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
          className="fixed inset-0 z-50 flex flex-col bg-black/95 p-3"
          onClick={() => setEnlargedIndex(-1)}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-sm font-black text-white">
              Page {enlargedIndex + 1} of {images.length} - {enlarged.name}
            </p>
            <button
              type="button"
              onClick={() => setEnlargedIndex(-1)}
              className="focus-ring inline-flex min-h-11 shrink-0 items-center gap-1 rounded-[8px] border border-zinc-600 px-3 text-sm font-black text-white hover:bg-zinc-800"
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
                className="focus-ring min-h-11 rounded-[8px] border border-zinc-600 px-4 text-sm font-black text-white hover:bg-zinc-800 disabled:opacity-40"
              >
                Previous page
              </button>
              <button
                type="button"
                disabled={enlargedIndex === images.length - 1}
                onClick={() => setEnlargedIndex((index) => Math.min(images.length - 1, index + 1))}
                className="focus-ring min-h-11 rounded-[8px] border border-zinc-600 px-4 text-sm font-black text-white hover:bg-zinc-800 disabled:opacity-40"
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
