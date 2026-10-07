export default function DaySelect({ days, selectedDayId, onSelectDay }) {
  return (
    <label className="block">
      <span className="label">Training day</span>
      <select
        value={selectedDayId}
        onChange={(event) => onSelectDay(event.target.value)}
        className="field w-full font-semibold"
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
