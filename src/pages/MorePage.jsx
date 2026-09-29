export default function MorePage({ tabs: morePageTabs, onSelectTab, onPreloadTab }) {
  return (
    <section className="space-y-4">
      <div className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          More
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">Navigation</h2>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {morePageTabs.map((tab) => {
          const Icon = tab.icon;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              onMouseEnter={() => onPreloadTab?.(tab.id)}
              onFocus={() => onPreloadTab?.(tab.id)}
              onTouchStart={() => onPreloadTab?.(tab.id)}
              className="focus-ring flex min-h-16 items-center gap-3 rounded-[8px] border border-zinc-800 bg-zinc-900 px-3 text-left text-zinc-100 transition hover:border-lime-300/60 hover:bg-zinc-800"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-lime-300/10 text-lime-300">
                <Icon aria-hidden="true" size={20} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-black text-white">{tab.label}</span>
                <span className="block text-xs font-semibold text-zinc-400">
                  Open {tab.label}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
