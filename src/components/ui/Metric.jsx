export default function Metric({ label, value }) {
  return (
    <div className="rounded-[8px] border border-zinc-800 bg-[#171717] px-2 py-2">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-400">
        {label}
      </p>
      <p className="mt-1 break-words text-sm font-black text-white">{value}</p>
    </div>
  );
}
