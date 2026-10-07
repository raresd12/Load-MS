export default function SectionShell({ eyebrow, title, children }) {
  return (
    <section className="card p-3 min-[430px]:p-4">
      {eyebrow && <p className="label-accent mb-0">{eyebrow}</p>}
      <h2 className={eyebrow ? "mt-1 text-[17px] font-semibold text-text-1" : "text-[17px] font-semibold text-text-1"}>
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}
