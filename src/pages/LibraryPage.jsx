import { useMemo, useState } from "react";
import { Info } from "lucide-react";
import ExerciseInfoPanel, { AiTechniqueBadge } from "../components/workout/ExerciseInfoPanel.jsx";
import {
  getVisibleGoalTags,
  isAiTechniqueDraftEntry,
  markLibraryTechniqueReviewed,
  TECHNIQUE_REVIEW_HINT,
} from "../lib/libraryReview.js";
import { formatTechnicalValue } from "../lib/prescriptionView.js";
import { getStoredSetupCue } from "../lib/sessionNormalize.js";

export default function LibraryPage({ exercises, setupCues, onLibraryChange }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState({
    category: "",
    muscle: "",
    equipment: "",
    difficulty: "",
    goalTag: "",
  });
  const [openExerciseId, setOpenExerciseId] = useState(null);
  const [reviewError, setReviewError] = useState(null);

  const filterOptions = useMemo(() => buildLibraryFilterOptions(exercises), [exercises]);
  const filteredExercises = useMemo(
    () => filterLibraryExercises(exercises, searchQuery, filters),
    [exercises, searchQuery, filters],
  );

  function updateFilter(filterId, value) {
    setFilters((currentFilters) => ({ ...currentFilters, [filterId]: value }));
  }

  // The owner's review of AI technique notes (H3-9). The badge goes only
  // after the write succeeded: it is read from the stored entry.
  function handleMarkReviewed(exerciseId) {
    const result = markLibraryTechniqueReviewed(exerciseId);

    if (!result.ok) {
      setReviewError({ exerciseId, message: result.error });
      return;
    }

    setReviewError(null);
    onLibraryChange?.();
  }

  function clearFilters() {
    setSearchQuery("");
    setFilters({
      category: "",
      muscle: "",
      equipment: "",
      difficulty: "",
      goalTag: "",
    });
  }

  return (
    <div className="space-y-4">
      <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-lime-300">
          Exercise Library
        </p>
        <h2 className="mt-1 text-2xl font-black text-white">Library</h2>
        <p className="mt-2 text-sm font-semibold leading-6 text-zinc-400">
          Technique reference only. Program sets, reps, kg, RPE and rest stay in ProgramExercise records.
        </p>

        <label className="mt-4 block">
          <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-zinc-400">
            Search exercises
          </span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="focus-ring min-h-12 w-full rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-base font-bold text-white placeholder:text-zinc-600"
            placeholder="Search by name, muscle, equipment, cue"
          />
        </label>

        <div className="relative -mx-3 mt-3 overflow-x-auto px-3 pb-1 min-[430px]:-mx-4 min-[430px]:px-4">
          <div className="flex min-w-max gap-2">
            <LibraryFilterSelect
              label="Category"
              value={filters.category}
              options={filterOptions.categories}
              onChange={(value) => updateFilter("category", value)}
            />
            <LibraryFilterSelect
              label="Muscle"
              value={filters.muscle}
              options={filterOptions.muscles}
              onChange={(value) => updateFilter("muscle", value)}
            />
            <LibraryFilterSelect
              label="Equipment"
              value={filters.equipment}
              options={filterOptions.equipment}
              onChange={(value) => updateFilter("equipment", value)}
            />
            <LibraryFilterSelect
              label="Difficulty"
              value={filters.difficulty}
              options={filterOptions.difficulties}
              onChange={(value) => updateFilter("difficulty", value)}
            />
            <LibraryFilterSelect
              label="Goal"
              value={filters.goalTag}
              options={filterOptions.goalTags}
              onChange={(value) => updateFilter("goalTag", value)}
            />
            <button
              type="button"
              onClick={clearFilters}
              className="focus-ring min-h-11 rounded-[8px] border border-zinc-700 px-3 text-sm font-black text-zinc-200 hover:bg-zinc-800"
            >
              Clear
            </button>
          </div>
        </div>
      </section>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-lime-300">
          {filteredExercises.length} exercises
        </p>
      </div>

      {filteredExercises.length ? (
        <section className="grid gap-3 md:grid-cols-2">
          {filteredExercises.map((exercise) => {
            const setupCue = getStoredSetupCue(setupCues, exercise);
            const isOpen = openExerciseId === exercise.id;

            return (
              <article
                key={exercise.id}
                className={`rounded-[8px] border border-zinc-800 bg-zinc-900 p-3 min-[430px]:p-4 ${
                  isOpen ? "md:col-span-2" : ""
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="text-lg font-black text-white">{exercise.name}</h3>
                    {isAiTechniqueDraftEntry(exercise) && <AiTechniqueBadge className="mt-1" />}
                    <p className="mt-1 text-sm font-semibold text-zinc-400">
                      {formatLibraryList(exercise.mainMuscles, "No main muscle")}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-[8px] bg-zinc-800 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
                      {exercise.category || "category"}
                    </span>
                    <span className="rounded-[8px] bg-zinc-800 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
                      {exercise.equipment || "equipment"}
                    </span>
                    <span className="rounded-[8px] bg-zinc-800 px-2 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-zinc-300">
                      {exercise.difficulty || "difficulty"}
                    </span>
                  </div>
                </div>

                {formatTechnicalValue(exercise.mainCue) && (
                  <p className="mt-3 rounded-[8px] bg-lime-300/10 px-3 py-2 text-sm font-semibold text-lime-100">
                    Main cue: {exercise.mainCue}
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => setOpenExerciseId(isOpen ? null : exercise.id)}
                  className="focus-ring mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-[8px] border border-lime-300/60 px-3 text-sm font-black text-lime-100 hover:bg-lime-300/10"
                >
                  <Info aria-hidden="true" size={16} />
                  {isOpen ? "Close Details" : "View Details"}
                </button>

                {isOpen && isAiTechniqueDraftEntry(exercise) && (
                  <div
                    data-testid="ai-technique-review"
                    className="mt-3 rounded-[8px] border border-amber-400/40 bg-amber-400/10 px-3 py-2"
                  >
                    <p className="text-sm font-semibold leading-5 text-amber-100">{TECHNIQUE_REVIEW_HINT}</p>
                    <button
                      type="button"
                      onClick={() => handleMarkReviewed(exercise.id)}
                      className="focus-ring mt-2 min-h-11 rounded-[8px] border border-amber-300/60 px-3 text-sm font-black text-amber-100 hover:bg-amber-300/10"
                    >
                      Mark notes as reviewed
                    </button>
                    {reviewError?.exerciseId === exercise.id && (
                      <p role="alert" className="mt-2 break-words text-sm font-bold text-red-200">
                        {reviewError.message}
                      </p>
                    )}
                  </div>
                )}

                {isOpen && (
                  <ExerciseInfoPanel
                    exercise={exercise}
                    setupCue={setupCue}
                    className="mt-3"
                    onClose={() => setOpenExerciseId(null)}
                  />
                )}
              </article>
            );
          })}
        </section>
      ) : (
        <section className="rounded-[8px] border border-zinc-800 bg-zinc-900 p-4">
          <p className="font-black text-white">No exercises match those filters.</p>
          <p className="mt-1 text-sm font-semibold text-zinc-400">
            Clear filters or search a broader term.
          </p>
        </section>
      )}
    </div>
  );
}

function LibraryFilterSelect({ label, value, options, onChange }) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="focus-ring min-h-11 min-w-[150px] rounded-[8px] border border-zinc-700 bg-[#111111] px-3 text-sm font-black text-white"
      >
        <option value="">{label}: All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function buildLibraryFilterOptions(exercises) {
  return {
    categories: uniqueSorted(exercises.map((exercise) => exercise.category)),
    muscles: uniqueSorted(
      exercises.flatMap((exercise) => [
        ...(exercise.mainMuscles ?? []),
        ...(exercise.secondaryMuscles ?? []),
      ]),
    ),
    equipment: uniqueSorted(exercises.map((exercise) => exercise.equipment)),
    difficulties: uniqueSorted(exercises.map((exercise) => exercise.difficulty)),
    goalTags: uniqueSorted(exercises.flatMap((exercise) => getVisibleGoalTags(exercise.goalTags))),
  };
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => formatTechnicalValue(value)).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function formatLibraryList(value, fallback = "Not added yet.") {
  const text = formatTechnicalValue(value);
  return text || fallback;
}

function filterLibraryExercises(exercises, searchQuery, filters) {
  const cleanQuery = searchQuery.trim().toLowerCase();

  return exercises.filter((exercise) => {
    const searchableText = [
      exercise.name,
      exercise.category,
      exercise.equipment,
      exercise.difficulty,
      exercise.mainCue,
      exercise.setup,
      exercise.howToDoIt,
      exercise.whatYouShouldFeel,
      ...(exercise.mainMuscles ?? []),
      ...(exercise.secondaryMuscles ?? []),
      ...(exercise.goalTags ?? []),
    ]
      .map((value) => formatTechnicalValue(value).toLowerCase())
      .join(" ");

    if (cleanQuery && !searchableText.includes(cleanQuery)) {
      return false;
    }

    if (filters.category && exercise.category !== filters.category) {
      return false;
    }

    const muscles = [...(exercise.mainMuscles ?? []), ...(exercise.secondaryMuscles ?? [])];
    if (filters.muscle && !muscles.includes(filters.muscle)) {
      return false;
    }

    if (filters.equipment && exercise.equipment !== filters.equipment) {
      return false;
    }

    if (filters.difficulty && exercise.difficulty !== filters.difficulty) {
      return false;
    }

    if (filters.goalTag && !(exercise.goalTags ?? []).includes(filters.goalTag)) {
      return false;
    }

    return true;
  });
}
