export default function ProgressEmptyState({ title, body }) {
  return (
    <div className="card-inset p-4">
      <p className="text-[15px] font-semibold text-text-1">{title}</p>
      <p className="mt-1 text-sm leading-6 text-text-2">{body}</p>
    </div>
  );
}
