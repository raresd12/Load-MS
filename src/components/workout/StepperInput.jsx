export default function StepperInput({
  label,
  value,
  onChange,
  onKeyDown,
  onFocus,
  onStep,
  stepAmount,
  type,
  inputMode,
  min,
  max,
  step,
  placeholder,
  enterKeyHint,
}) {
  return (
    <label className="grid grid-cols-[44px_44px_minmax(64px,1fr)_44px] items-center gap-1.5 sm:grid-cols-[44px_minmax(80px,130px)_32px] sm:gap-2">
      <span className="text-[11px] font-black uppercase tracking-[0.12em] text-zinc-400">
        {label}
      </span>
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        onClick={() => onStep(-stepAmount)}
        className="focus-ring min-h-11 min-w-11 rounded-[8px] border border-zinc-700 bg-[#111111] text-sm font-black text-zinc-200 sm:hidden"
      >
        -
      </button>
      <input
        aria-label={label}
        type={type}
        inputMode={inputMode}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        enterKeyHint={enterKeyHint}
        className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 bg-[#111111] px-2 text-center text-sm font-black text-white sm:min-h-10"
        placeholder={placeholder}
      />
      <button
        type="button"
        aria-label={`Increase ${label}`}
        onClick={() => onStep(stepAmount)}
        className="focus-ring min-h-11 min-w-11 rounded-[8px] border border-zinc-700 bg-[#111111] text-sm font-black text-zinc-200 sm:hidden"
      >
        +
      </button>
      <div className="hidden gap-1 sm:grid">
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => onStep(stepAmount)}
          className="focus-ring min-h-5 rounded-[6px] border border-zinc-700 bg-[#111111] text-xs font-black leading-none text-zinc-200"
        >
          +
        </button>
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => onStep(-stepAmount)}
          className="focus-ring min-h-5 rounded-[6px] border border-zinc-700 bg-[#111111] text-xs font-black leading-none text-zinc-200"
        >
          -
        </button>
      </div>
    </label>
  );
}
