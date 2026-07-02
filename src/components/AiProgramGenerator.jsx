import { useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, Sparkles } from "lucide-react";
import {
  clearGeminiApiKey,
  generateProgramWithAi,
  getGeminiApiKey,
  setGeminiApiKey,
} from "../lib/aiProgram.js";

const DAYS_PER_WEEK_OPTIONS = [2, 3, 4, 5, 6];
const SESSION_MINUTES_OPTIONS = [30, 45, 60, 75, 90];
const EXPERIENCE_OPTIONS = ["beginner", "intermediate", "advanced"];
const EQUIPMENT_OPTIONS = [
  "Full gym",
  "Dumbbells and bench only",
  "Home basics (dumbbells, bands, pull-up bar)",
  "Bodyweight only",
];

function maskKey(key) {
  if (!key) {
    return "";
  }

  return `••••${key.slice(-4)}`;
}

// Module-level cache so a generated program survives tab switches
// (ProgramPage unmounts when the user navigates away).
let cachedGenerated = null;

export default function AiProgramGenerator({ onImportProgramShare }) {
  const [savedKeyMask, setSavedKeyMask] = useState(() => maskKey(getGeminiApiKey()));
  const [keyInput, setKeyInput] = useState("");
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const [keyMessage, setKeyMessage] = useState("");
  const [goal, setGoal] = useState("");
  const [daysPerWeek, setDaysPerWeek] = useState(3);
  const [sessionMinutes, setSessionMinutes] = useState(60);
  const [experience, setExperience] = useState("intermediate");
  const [equipment, setEquipment] = useState(EQUIPMENT_OPTIONS[0]);
  const [constraints, setConstraints] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [generated, setGeneratedState] = useState(() => cachedGenerated);
  const [importMessage, setImportMessage] = useState("");

  function setGenerated(value) {
    cachedGenerated = value;
    setGeneratedState(value);
  }

  const hasSavedKey = Boolean(savedKeyMask);

  function handleSaveKey() {
    const cleanKey = keyInput.trim();

    if (!cleanKey) {
      setKeyMessage("Paste a Gemini API key first.");
      return;
    }

    const result = setGeminiApiKey(cleanKey);

    if (!result.ok) {
      setKeyMessage(result.error);
      return;
    }

    setSavedKeyMask(maskKey(cleanKey));
    setKeyInput("");
    setIsKeyVisible(false);
    setKeyMessage("Key saved on this device only. It is never included in backups or shared files.");
  }

  function handleRemoveKey() {
    clearGeminiApiKey();
    setSavedKeyMask("");
    setKeyMessage("Key removed from this device.");
  }

  async function handleGenerate() {
    setGenerationError("");
    setImportMessage("");
    setGenerated(null);

    if (!hasSavedKey) {
      setGenerationError("Save your Gemini API key first.");
      return;
    }

    setIsGenerating(true);

    try {
      const result = await generateProgramWithAi({
        goal,
        daysPerWeek,
        sessionMinutes,
        experience,
        equipment,
        constraints,
      });

      if (!result.valid) {
        setGenerationError(result.error);
        return;
      }

      setGenerated(result);
    } finally {
      setIsGenerating(false);
    }
  }

  function handleImport() {
    if (!generated?.share) {
      return;
    }

    const result = onImportProgramShare(generated.share);

    if (!result.valid) {
      setGenerationError(result.error ?? "The generated program could not be imported.");
      return;
    }

    setGenerated(null);
    setImportMessage(
      `Added "${result.program.name}" with ${result.importedDayCount} ${result.importedDayCount === 1 ? "day" : "days"} and ${result.importedExerciseCount} ${result.importedExerciseCount === 1 ? "exercise" : "exercises"}. Find it in the program list and set it active when ready.`,
    );
  }

  return (
    <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">AI Coach</p>
      <h2 className="mt-1 flex items-center gap-2 text-2xl font-black text-white">
        <Sparkles aria-hidden="true" size={22} className="text-lime-300" />
        Generate a program with AI
      </h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        Describe your goal and Gemini builds a program from this app&apos;s exercise library. You
        review it before it is added - your existing programs are never touched.
      </p>

      <div className="mt-4 rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-3">
        <p className="flex items-center gap-2 text-sm font-black text-white">
          <KeyRound aria-hidden="true" size={16} className="text-lime-300" />
          Gemini API key
        </p>
        {hasSavedKey ? (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p className="text-sm font-bold text-lime-100">Saved on this device ({savedKeyMask})</p>
            <button
              type="button"
              onClick={handleRemoveKey}
              className="focus-ring min-h-9 rounded-[8px] border border-zinc-700 px-3 text-xs font-black text-zinc-300 hover:bg-zinc-800"
            >
              Remove key
            </button>
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm leading-6 text-zinc-400">
              Create a free key at{" "}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="focus-ring font-bold text-lime-300 underline"
              >
                aistudio.google.com/apikey
              </a>{" "}
              and paste it here. It is stored only in this browser.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                handleSaveKey();
              }}
              className="mt-2 flex flex-col gap-2 sm:flex-row"
            >
              <div className="relative flex-1">
                <input
                  type={isKeyVisible ? "text" : "password"}
                  value={keyInput}
                  onChange={(event) => setKeyInput(event.target.value)}
                  autoComplete="off"
                  aria-label="Gemini API key"
                  placeholder="AIza..."
                  className="focus-ring min-h-11 w-full rounded-[8px] border border-zinc-700 bg-zinc-900 px-3 pr-11 text-sm font-bold text-white placeholder:text-zinc-600"
                />
                <button
                  type="button"
                  onClick={() => setIsKeyVisible((visible) => !visible)}
                  aria-label={isKeyVisible ? "Hide API key" : "Show API key"}
                  className="focus-ring absolute right-1 top-1/2 -translate-y-1/2 rounded-[8px] p-2 text-zinc-400 hover:text-white"
                >
                  {isKeyVisible ? (
                    <EyeOff aria-hidden="true" size={16} />
                  ) : (
                    <Eye aria-hidden="true" size={16} />
                  )}
                </button>
              </div>
              <button
                type="submit"
                className="focus-ring min-h-11 rounded-[8px] border border-lime-300/60 px-4 text-sm font-black text-lime-200 hover:bg-lime-300/10"
              >
                Save key
              </button>
            </form>
          </>
        )}
        {keyMessage && (
          <p role="status" className="mt-2 text-xs font-bold leading-5 text-zinc-400">
            {keyMessage}
          </p>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          handleGenerate();
        }}
        className="mt-4 space-y-3"
      >
        <div>
          <label
            htmlFor="ai-goal"
            className="text-xs font-black uppercase tracking-[0.14em] text-zinc-400"
          >
            Main goal
          </label>
          <input
            id="ai-goal"
            type="text"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Build muscle and stay explosive for basketball"
            className="focus-ring mt-1 min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-bold text-white placeholder:text-zinc-600"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label
              htmlFor="ai-days"
              className="text-xs font-black uppercase tracking-[0.14em] text-zinc-400"
            >
              Days / week
            </label>
            <select
              id="ai-days"
              value={daysPerWeek}
              onChange={(event) => setDaysPerWeek(Number(event.target.value))}
              className="focus-ring mt-1 min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-bold text-white"
            >
              {DAYS_PER_WEEK_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="ai-minutes"
              className="text-xs font-black uppercase tracking-[0.14em] text-zinc-400"
            >
              Minutes
            </label>
            <select
              id="ai-minutes"
              value={sessionMinutes}
              onChange={(event) => setSessionMinutes(Number(event.target.value))}
              className="focus-ring mt-1 min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-bold text-white"
            >
              {SESSION_MINUTES_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="ai-experience"
              className="text-xs font-black uppercase tracking-[0.14em] text-zinc-400"
            >
              Experience
            </label>
            <select
              id="ai-experience"
              value={experience}
              onChange={(event) => setExperience(event.target.value)}
              className="focus-ring mt-1 min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-bold text-white"
            >
              {EXPERIENCE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="ai-equipment"
              className="text-xs font-black uppercase tracking-[0.14em] text-zinc-400"
            >
              Equipment
            </label>
            <select
              id="ai-equipment"
              value={equipment}
              onChange={(event) => setEquipment(event.target.value)}
              className="focus-ring mt-1 min-h-11 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-bold text-white"
            >
              {EQUIPMENT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label
            htmlFor="ai-constraints"
            className="text-xs font-black uppercase tracking-[0.14em] text-zinc-400"
          >
            Injuries, exercises to avoid, preferences (optional)
          </label>
          <textarea
            id="ai-constraints"
            value={constraints}
            onChange={(event) => setConstraints(event.target.value)}
            placeholder="Knee pain on deep squats, prefer dumbbells for pressing"
            className="focus-ring mt-1 min-h-16 w-full resize-y rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-3 text-sm font-bold text-white placeholder:text-zinc-600"
          />
        </div>

        <p className="text-xs leading-5 text-zinc-500">
          Uses Google&apos;s free Gemini tier: Google may use what you send to improve its
          products, so keep personal details out of the text above. If the free daily quota runs
          out, generation comes back the next day.
        </p>

        <button
          type="submit"
          disabled={isGenerating}
          className="focus-ring flex min-h-12 w-full items-center justify-center gap-2 rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isGenerating ? (
            <>
              <Loader2 aria-hidden="true" size={18} className="animate-spin" />
              Building your program...
            </>
          ) : (
            <>
              <Sparkles aria-hidden="true" size={18} />
              Generate Program
            </>
          )}
        </button>

        {generationError && (
          <p
            role="alert"
            className="rounded-[8px] border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm font-bold text-red-100"
          >
            {generationError}
          </p>
        )}
        {importMessage && (
          <p
            role="status"
            className="break-words rounded-[8px] border border-lime-300/40 bg-lime-300/10 px-3 py-2 text-sm font-bold text-lime-100"
          >
            {importMessage}
          </p>
        )}

        {generated?.share && (
          <div className="rounded-[8px] border border-lime-300/30 bg-lime-300/5 p-3">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-200/80">
              Preview
            </p>
            <p className="mt-1 break-words text-lg font-black text-white">
              {generated.share.program.name}
            </p>
            {generated.share.program.goal && (
              <p className="mt-1 break-words text-sm font-bold text-lime-100">
                {generated.share.program.goal}
              </p>
            )}
            {generated.share.program.description && (
              <p className="mt-2 break-words text-sm leading-6 text-zinc-400">
                {generated.share.program.description}
              </p>
            )}
            <ul className="mt-3 space-y-2">
              {generated.share.days.map((day) => {
                const dayExerciseCount = generated.share.programExercises.filter(
                  (exercise) => exercise.dayId === day.id,
                ).length;

                return (
                  <li
                    key={day.id}
                    className="rounded-[8px] border border-zinc-700 bg-[#111111] px-3 py-2"
                  >
                    <p className="break-words text-sm font-black text-white">{day.name}</p>
                    <p className="break-words text-xs font-bold text-zinc-400">
                      {day.focus ? `${day.focus} - ` : ""}
                      {dayExerciseCount} {dayExerciseCount === 1 ? "exercise" : "exercises"}
                    </p>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs font-bold leading-5 text-zinc-500">
              {generated.summary.reusedExerciseCount} exercises reuse your library (videos and cues
              included){generated.summary.newExerciseCount > 0
                ? `, ${generated.summary.newExerciseCount} are new`
                : ""}
              . No starting weights are set - the coach establishes baselines from your first
              logged sessions.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={handleImport}
                className="focus-ring flex min-h-11 flex-1 items-center justify-center rounded-[8px] bg-lime-300 px-4 text-sm font-black text-zinc-950 hover:bg-lime-200"
              >
                Add to my programs
              </button>
              <button
                type="button"
                onClick={() => setGenerated(null)}
                className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 px-4 text-sm font-black text-zinc-300 hover:bg-zinc-800"
              >
                Discard
              </button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}
