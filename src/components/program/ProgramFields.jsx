// Decision HV-11: "Active" is the accent pill; any other badge ("Default")
// is a neutral pill, because warn carries meaning only (HV-1).
export function ProgramBadge({ tone, children }) {
  return (
    <span className={tone === "active" ? "pill pill-accent" : "pill"}>
      {children}
    </span>
  );
}

export function ProgramTextField({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="label mb-2">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="focus-ring min-h-11 field w-full"
      />
    </label>
  );
}

export function ProgramTextArea({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="label mb-2">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className="focus-ring min-h-20 field w-full resize-y py-2"
      />
    </label>
  );
}

export function ProgramEditorField({ label, value, onChange, placeholder = "", inputMode = "text" }) {
  return (
    <label className="block">
      <span className="label mb-2">
        {label}
      </span>
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="focus-ring min-h-11 field w-full"
      />
    </label>
  );
}
