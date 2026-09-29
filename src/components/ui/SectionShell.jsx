export default function SectionShell({ eyebrow, title, children }) {
  return (
    <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
      {eyebrow && (
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          {eyebrow}
        </p>
      )}
      <h2 className={eyebrow ? "mt-1 text-xl font-black text-white" : "text-xl font-black text-white"}>
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
