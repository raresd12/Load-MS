export default function MorePage({ tabs: morePageTabs, onSelectTab, onPreloadTab }) {
  return (
    <section className="space-y-4">
      <div className="card p-3 min-[430px]:p-4">
        <p className="label-accent">
          More
        </p>
        <h2 className="mt-1 text-[22px] font-semibold text-text-1">Navigation</h2>
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
              className="focus-ring card flex min-h-16 items-center gap-3 p-3 text-left text-text-1 transition hover:bg-surface-2"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-block bg-accent-tint text-accent-soft">
                <Icon aria-hidden="true" size={20} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-text-1">{tab.label}</span>
                <span className="block text-xs font-semibold text-text-2">
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
