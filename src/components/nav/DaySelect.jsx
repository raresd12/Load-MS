export default function DaySelect({ days, selectedDayId, onSelectDay }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
        Training day
      </span>
      <select
        value={selectedDayId}
        onChange={(event) => onSelectDay(event.target.value)}
        className="focus-ring min-h-12 w-full rounded-[8px] border border-zinc-700 bg-zinc-900 px-3 text-base font-black text-white"
      >
        {days.map((day) => (
          <option key={day.id} value={day.id}>
            {day.isOptional ? `${day.name} (Optional)` : day.name}
          </option>
        ))}
      </select>
    </label>
  );
}
