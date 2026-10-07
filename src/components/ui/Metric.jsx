export default function Metric({ label, value }) {
  return (
    <div className="card-inset px-2 py-2">
      <p className="label mb-0">{label}</p>
      <p className="mt-1 break-words text-[15px] font-semibold tabular-nums text-text-1">{value}</p>
    </div>
  );
}
