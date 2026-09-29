export default function ProgressEmptyState({ title, body }) {
  return (
    <div className="rounded-[8px] border border-zinc-800 bg-[#111111] p-4">
      <p className="font-black text-white">{title}</p>
      <p className="mt-1 text-sm font-semibold leading-6 text-zinc-400">{body}</p>
    </div>
  );
}
