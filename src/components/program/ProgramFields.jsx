export function ProgramBadge({ tone, children }) {
  const className =
    tone === "active"
      ? "bg-lime-300 text-zinc-950"
      : "bg-amber-300/20 text-amber-100";

  return (
    <span className={`rounded-[8px] px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] ${className}`}>
      {children}
    </span>
  );
}

export function ProgramTextField({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-zinc-400">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-bold text-white placeholder:text-zinc-600"
      />
    </label>
  );
}

export function ProgramTextArea({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-zinc-400">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className="focus-ring min-h-20 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2 text-sm font-bold text-white placeholder:text-zinc-600"
      />
    </label>
  );
}

export function ProgramEditorField({ label, value, onChange, placeholder = "", inputMode = "text" }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-zinc-400">
        {label}
      </span>
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-bold text-white placeholder:text-zinc-600"
      />
    </label>
  );
}
