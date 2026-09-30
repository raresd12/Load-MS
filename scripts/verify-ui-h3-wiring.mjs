// Phase H3 / UI track (decisions H3-5, H3-6): source-level wiring checks that
// cannot run without a browser. The behaviour behind them is covered by
// verify-ui-h3-helpers.mjs (pure helpers, mocked Gemini, in-memory storage),
// verify-source-files.mjs and verify-ai-technique.mjs.
// - the photo input takes several files, the accept lists are the ones of
//   sourceFiles.js and match its kinds
// - the privacy note is rendered, and says the source IS sent to Google
// - the assistant and its import components never touch storage
// - object URLs are revoked on remove / discard / unmount
// - legacy formats show sourceFiles.js guidance and keep Extract disabled
// - technique actions are rendered for NEW exercises only, applied only
//   through the approval helpers, in the preview and in the Studio
// - the error box and the "Check these before saving" block are wired
// - the program file import stays JSON-only
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8").replace(/\r\n?/g, "\n");
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

const assistant = read("src/components/AiProgramImportAssistant.jsx");
const picker = read("src/components/import/SourcePicker.jsx");
const reviewPanel = read("src/components/import/SourceReviewPanel.jsx");
const techniqueReview = read("src/components/import/TechniqueDraftReview.jsx");
const techniqueSection = read("src/components/import/TechniqueNotesSection.jsx");
const techniqueHook = read("src/components/import/useTechniqueDrafts.js");
const studio = read("src/components/ProgramStudio.jsx");
const programPage = read("src/pages/ProgramPage.jsx");
const helpers = read("src/lib/importAssistant.js");

const { SOURCE_FILE_ACCEPT, SOURCE_IMAGE_ACCEPT, classifySourceFile, LEGACY_OFFICE_GUIDANCE } = await import(
  "../src/lib/sourceFiles.js"
);

const importFiles = readdirSync(path.join(root, "src/components/import")).filter((name) => /\.(js|jsx)$/.test(name));
const importSources = importFiles.map((name) => ({ name, code: read(`src/components/import/${name}`) }));
const assistantSide = [{ name: "AiProgramImportAssistant.jsx", code: assistant }, ...importSources];

function importsOf(code) {
  return [...code.matchAll(/import\s+(?:[\s\S]*?)\s+from\s+"([^"]+)";/g)].map((match) => ({
    statement: match[0],
    from: match[1],
  }));
}

// ------------------------------------------------------------------
// 1. Source picking
// ------------------------------------------------------------------
{
  const inputs = [...picker.matchAll(/<input\b[^>]*type="file"[\s\S]*?\/>/g)].map((match) => match[0]);
  assert.equal(inputs.length, 2, "one file input for photos, one for files");
  const photoInput = inputs.find((input) => input.includes('data-source-input="photos"'));
  const fileInput = inputs.find((input) => input.includes('data-source-input="file"'));
  assert.ok(photoInput && fileInput);
  assert.ok(/\n\s+multiple\n/.test(photoInput), "the photo input has the multiple attribute");
  assert.ok(photoInput.includes("accept={SOURCE_IMAGE_ACCEPT}"), "photo accept list comes from sourceFiles.js");
  assert.ok(!/\bmultiple\b/.test(fileInput), "a file is always sent alone (H3-1)");
  assert.ok(fileInput.includes("accept={SOURCE_FILE_ACCEPT}"), "file accept list comes from sourceFiles.js");
  assert.ok(!/accept="/.test(picker), "no hand-written accept list");
  assert.ok(!/IMAGE_ACCEPT\s*=|FILE_ACCEPT\s*=/.test(assistant + picker), "the H2 accept constants are gone");

  // The accept lists match the kinds sourceFiles.js classifies.
  const extensions = (accept) => accept.split(",").filter((entry) => entry.startsWith("."));
  assert.deepEqual(extensions(SOURCE_IMAGE_ACCEPT), [".jpg", ".jpeg", ".png", ".webp"]);
  assert.deepEqual(extensions(SOURCE_FILE_ACCEPT), [".pdf", ".txt", ".md", ".csv", ".docx", ".xlsx"]);
  extensions(SOURCE_IMAGE_ACCEPT).forEach((extension) => {
    assert.equal(classifySourceFile(`plan${extension}`, "", 100).kind, "image", extension);
  });
  const fileKinds = { ".pdf": "pdf", ".txt": "text", ".md": "text", ".csv": "text", ".docx": "docx", ".xlsx": "xlsx" };
  extensions(SOURCE_FILE_ACCEPT).forEach((extension) => {
    assert.equal(classifySourceFile(`plan${extension}`, "", 100).kind, fileKinds[extension], extension);
  });
  for (const mime of [...SOURCE_IMAGE_ACCEPT.split(","), ...SOURCE_FILE_ACCEPT.split(",")].filter((entry) => entry.includes("/"))) {
    assert.equal(classifySourceFile("", mime, 100).ok, true, `${mime} in an accept list is a supported kind`);
  }

  assert.deepEqual(
    [...picker.matchAll(/\{ id: "(\w+)", label: "(\w+)"/g)].map((match) => `${match[1]}:${match[2]}`),
    ["text:Text", "photos:Photos", "file:File"],
    "modes Text / Photos / File",
  );
  assert.ok(picker.includes("Move up") && picker.includes("Move down") && picker.includes("Remove"), "photo order controls");
  assert.ok(picker.includes("onMovePhoto(index, -1)") && picker.includes("onMovePhoto(index, 1)"));
  assert.ok(picker.includes("Page {index + 1} of {photos.length}"), "page numbers on the thumbnails");
  assert.ok(picker.includes("src={photo.url}"), "thumbnails are object URLs");
  assert.ok(picker.includes("summarizePhotos(photos)") && picker.includes("{photoSummary.label}"), "running total size");
  assert.ok(picker.includes("Text that will be sent") && /<textarea[^>]*\n\s+id="ai-source-file-text"\n\s+readOnly/.test(picker), "read-only text box");
  assert.ok(picker.includes("describeSourceMeta(file.source)") && picker.includes("fileMeta.warnings.map"), "meta warnings are listed");
  assert.ok(picker.includes("{LEGACY_OFFICE_GUIDANCE}"), "legacy formats are named with the guidance before a pick");
  assert.ok(picker.includes('file?.status === "error"') && picker.includes("{file.error}"), "a refused file shows its message inline");
  assert.ok(!/Word\/Excel files are not supported yet/.test(assistant + picker), "the outdated H2 copy is gone");

  // The assistant reads through sourceFiles.js and never parses by itself.
  assert.ok(assistant.includes("planPhotoPick(") && assistant.includes("planFilePick(file)"), "picks go through the helpers");
  assert.ok(assistant.includes("await readSourceFile(file)"), "DOCX / XLSX / text are read on selection through readSourceFile");
  assert.ok(assistant.includes("buildImageBundle(sources)"), "several photos are one bundle in the shown order");
  assert.ok(assistant.includes("buildTextSource(sourceText)"));
  assert.ok(!/FileReader|readAsDataURL|readAsText|fflate|DOMParser/.test(stripComments(assistantSide.map((file) => file.code).join("\n"))), "no parsing or reading reimplemented in the UI");
  assert.ok(
    !assistantSide.some((file) => importsOf(file.code).some((entry) => /officeText\.js$/.test(entry.from))),
    "the office parser is reached only through sourceFiles.js",
  );
  assert.ok(!/buildProgramExtractionPrompt|buildTechniqueDraftPrompt|generateContent/.test(assistantSide.map((file) => file.code).join("\n")), "no prompt or request built in the UI");

  // Legacy guidance wired: the pick error is kept as the file state and blocks Extract.
  const pickFile = assistant.slice(assistant.indexOf("async function handlePickFile("), assistant.indexOf("function handleClearFile("));
  assert.ok(/if \(!plan\.ok\) \{[\s\S]*?status: "error"[\s\S]*?error: plan\.error[\s\S]*?return;/.test(pickFile), "a refused pick becomes an error state");
  assert.ok(assistant.includes("disabled={Boolean(extractBlocker)}"), "Extract is disabled while the source is not usable");
  assert.ok(/getExtractBlocker\(\{\s*mode: sourceMode,\s*text: sourceText,\s*photos,\s*file: pickedFile,\s*isExtracting,\s*\}\)/.test(assistant));
  assert.ok(helpers.includes('if (file.status === "error")'), "an error state blocks Extract");
  assert.ok(classifySourceFile("plan.doc", "", 10).error.includes(LEGACY_OFFICE_GUIDANCE));
}

// ------------------------------------------------------------------
// Privacy note
// ------------------------------------------------------------------
{
  assert.ok(
    helpers.includes(
      '"Files stay in this browser tab and are sent to Google only when you press Extract. They are never saved to the app or its backups."',
    ),
    "privacy note text",
  );
  assert.ok(picker.includes("{SOURCE_PRIVACY_NOTE}"), "the note is rendered under the picker");
  assert.ok(picker.indexOf("{SOURCE_PRIVACY_NOTE}") > picker.indexOf('data-source-input="file"'), "under the picker, for every mode");
  assert.ok(!/mode === "\w+" && \([\s\S]{0,200}SOURCE_PRIVACY_NOTE/.test(picker), "not tied to one mode");
  assert.ok(/>\s*Extract Draft from Source\s*</.test(assistant), 'the button the note calls "Extract"');
  assert.ok(!/never sent|not sent anywhere|stays on (?:this|your) device only/i.test(assistant + picker + reviewPanel), '"not saved" is never told as "never sent"');
}

// ------------------------------------------------------------------
// 2. Nothing from the source reaches storage
// ------------------------------------------------------------------
{
  for (const { name, code } of assistantSide) {
    const clean = stripComments(code);
    assert.ok(!/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/.test(clean), `${name}: no browser storage`);
    assert.ok(!/saveDraftToStorage|writeStorage|writeStorageBatch|writeSecret|writeCollection/.test(clean), `${name}: no storage writer`);

    for (const { statement, from } of importsOf(code)) {
      assert.ok(!/lib\/storage\.js$/.test(from), `${name}: no import from storage.js (${statement})`);
      assert.ok(!/lib\/programStorage\.js$/.test(from), `${name}: no import from programStorage.js (${statement})`);
      assert.ok(!/lib\/repository\.js$/.test(from), `${name}: no import from repository.js`);
    }
  }

  // The lib helper writes nothing either.
  assert.ok(!/storage\.js|programStorage\.js|repository\.js/.test(importsOf(helpers).map((entry) => entry.from).join(" ")), "importAssistant.js imports no storage module");
  assert.ok(!/\blocalStorage\b/.test(stripComments(helpers)));

  // The draft cache holds the draft only.
  assert.ok(/let cachedDraft = null;/.test(assistant));
  assert.deepEqual(
    [...assistant.matchAll(/^let (\w+)/gm)].map((match) => match[1]),
    ["cachedDraft", "photoIdCounter"],
    "no module-level variable holds a source",
  );
  assert.ok(!/cachedDraft = \{[^}]*(?:source|photos|file)/.test(assistant));

  // Only the draft leaves the assistant.
  const editInStudio = assistant.slice(assistant.indexOf("function handleEditInStudio()"), assistant.indexOf("function requestTechniqueDrafts("));
  assert.ok(editInStudio.includes("onReviewDraft(programDraft, review)"));
  assert.ok(!/reviewSource|sourceText|photos|pickedFile/.test(editInStudio.replace(/\/\/.*$/gm, "")), "no source is passed to the Studio");
  assert.ok(editInStudio.indexOf("discardDraft()") < editInStudio.indexOf("onReviewDraft("), "the source is released before the Studio opens");
  assert.ok(/uncertainty: draft\.preview\.uncertainty \?\? \[\]/.test(editInStudio), "the uncertainty list travels to the Studio review");

  // Object URLs: created in one place, revoked on remove / discard / unmount.
  assert.equal((assistant.match(/URL\.createObjectURL\(/g) ?? []).length, 1, "object URLs are created by createObjectUrl only");
  assert.ok(!/createObjectURL|revokeObjectURL/.test(importSources.map((file) => file.code).join("\n")), "the import components never create or revoke URLs");
  const unmount = assistant.slice(assistant.indexOf("useEffect(() => {"), assistant.indexOf("function createObjectUrl("));
  assert.ok(/return \(\) => \{[\s\S]*urls\.forEach\(\(url\) => URL\.revokeObjectURL\(url\)\);[\s\S]*urls\.clear\(\);[\s\S]*\}, \[\]\);/.test(unmount), "every live URL is revoked on unmount");
  const removePhoto = assistant.slice(assistant.indexOf("function handleRemovePhoto("), assistant.indexOf("async function handlePickFile("));
  assert.ok(removePhoto.includes("revokeObjectUrl(photos[index]?.url)"), "removing a photo revokes its URL");
  const release = assistant.slice(assistant.indexOf("function releaseReviewSource()"), assistant.indexOf("function setDraft("));
  assert.ok(release.includes("current.items.forEach((item) => revokeObjectUrl(item.url))") && release.includes("revokeObjectUrl(current.url)"), "the review's URLs are revoked");
  const pickPhotos = assistant.slice(assistant.indexOf("function handlePickPhotos("), assistant.indexOf("function handleMovePhoto("));
  assert.ok(pickPhotos.indexOf("createObjectUrl(file)") < pickPhotos.indexOf("setPhotos("), "URLs are created outside the state updater (an updater may run twice)");
  assert.ok(!/set\w+\(\((?:current|previous)\) => [^;]*?(?:createObjectUrl|revokeObjectUrl)/.test(assistant), "no URL is created or revoked inside a state updater");
  const discard = assistant.slice(assistant.indexOf("function discardDraft()"), assistant.indexOf("const hasSavedKey"));
  assert.ok(discard.includes("releaseReviewSource()") && discard.includes("technique.clear()"), "discard releases the source and the technique drafts");
  const discardButton = assistant.slice(assistant.indexOf("function handleDiscardDraft()"), assistant.indexOf("function handleImport()"));
  assert.ok(
    assistant.includes("onClick={handleDiscardDraft}") && discardButton.includes("discardDraft();"),
    "Discard draft goes through discardDraft",
  );
  const extract = assistant.slice(assistant.indexOf("async function handleExtract()"), assistant.indexOf("function convertDraft()"));
  // H3 fix round 1: the open draft (with the technique notes accepted into it)
  // survives a refused or failed extraction; it is replaced, and the previous
  // source released, only once the new result is valid.
  const extractCode = stripComments(extract);
  assert.equal((extractCode.match(/discardDraft\(\)/g) ?? []).length, 1, "handleExtract discards in one place only");
  assert.ok(
    extractCode.indexOf("discardDraft()") > extractCode.indexOf("extractProgramDraftWithAi("),
    "nothing is discarded before the request has answered",
  );
  assert.ok(
    /if \(!result\.valid\) \{\s*setExtractionError\(result\.error\);\s*return;\s*\}\s*discardDraft\(\);\s*showReviewSource\(createReviewSource\(built\.review\)\);\s*setDraft\(result\);/.test(
      extractCode,
    ),
    "a failed extraction returns before the discard; a valid one releases the previous source, then shows the new draft",
  );
  ["if (!hasSavedKey)", "if (extractBlocker)", "if (!built.ok)"].forEach((guard) => {
    assert.ok(extractCode.indexOf(guard) >= 0 && extractCode.indexOf(guard) < extractCode.indexOf("discardDraft()"), `${guard} returns with the draft kept`);
  });
}

// ------------------------------------------------------------------
// 2. Source alongside the extraction
// ------------------------------------------------------------------
{
  assert.ok(assistant.includes("<SourceReviewPanel source={reviewSource} />"));
  assert.ok(/\{ id: "source", label: "Source" \},\s*\{ id: "extraction", label: "Extraction" \}/.test(assistant), "Source / Extraction toggle");
  assert.ok(/role="tablist"\s+aria-label="Review"\s+className="[^"]*lg:hidden/.test(assistant), "the toggle is for narrow screens only");
  assert.ok(assistant.includes("lg:grid-cols-2"), "side by side on desktop");
  assert.ok(assistant.includes('lg:block ${reviewTab === "source" ? "" : "hidden"}'), "one panel at a time on a phone");
  // H3-24: on desktop the source column stays in view; the shell clips without becoming a scroll container.
  {
    const column = /data-testid="source-review-column"\s+className=\{`([^`]*)`\}/.exec(assistant)?.[1] ?? "";
    ["lg:sticky", "lg:top-3", "lg:self-start", "lg:max-h-[calc(100vh-7rem)]", "lg:overflow-y-auto"].forEach((name) => {
      assert.ok(column.split(/\s+/).includes(name), `source column has ${name}`);
    });
    assert.ok(!/(?<![\w:-])sticky(?![\w-])/.test(column.replace(/lg:sticky/g, "")), "sticky is for the desktop layout only");
    const appShell = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    assert.ok(!/overflow-x-hidden|overflow-hidden/.test(appShell), "no ancestor of the pages is a scroll container");
    assert.equal((appShell.match(/className="app-clip-x /g) ?? []).length, 2, "the shell and main clip the x axis");
    assert.match(css, /\.app-clip-x \{\s*overflow-x: hidden;\s*\}/, "fallback for engines without clip");
    assert.match(css, /@supports \(overflow: clip\) \{\s*body,\s*#root,\s*\.app-clip-x \{\s*overflow-x: clip;\s*\}\s*\}/);
  }
  assert.ok(reviewPanel.includes("font-mono") && reviewPanel.includes("overflow-auto") && reviewPanel.includes('type="search"'), "text: scrollable, monospace, searchable");
  assert.ok(reviewPanel.includes("findTextMatches(text, query)"));
  assert.ok(reviewPanel.includes('role="dialog"') && reviewPanel.includes("setEnlargedIndex(index)"), "photos: tap to enlarge");
  assert.ok(/<object\s+data=\{source\.url\}\s+type="application\/pdf"/.test(reviewPanel), "PDF: rendered from the object URL where the browser can");
  assert.ok(reviewPanel.includes("formatFileSize(source.sizeBytes)"), "else the file name and size");
  assert.ok(!/dataBase64|data:/.test(stripComments(reviewPanel + picker)), "no base64 copy of a file in the UI");
}

// ------------------------------------------------------------------
// 3. Technique drafts: new exercises only, separately approved
// ------------------------------------------------------------------
{
  // Preview: the single action sits behind isNewExercise, the batch action behind the list of new exercises.
  const singleIndex = assistant.indexOf("Draft technique notes with AI");
  assert.ok(singleIndex > 0);
  const singleGuard = assistant.lastIndexOf("{exercise.isNewExercise && newExercise ? (", singleIndex);
  assert.ok(singleGuard > 0 && singleIndex - singleGuard < 900, "the single action is rendered for a new exercise only");
  assert.ok(!assistant.slice(singleGuard, singleIndex).includes(") : null}"), "nothing closes the guard before the button");
  assert.ok(/const newExercise = exercise\.isNewExercise\s*\? newExerciseById\.get\(String\(exercise\.exerciseId\)\)\s*: null;/.test(assistant));
  assert.equal((assistant.match(/Draft technique notes with AI/g) ?? []).length, 1);

  const batchIndex = assistant.indexOf("Draft notes for all new exercises");
  const batchGuard = assistant.lastIndexOf("{newExercises.length > 0 && (", batchIndex);
  assert.ok(batchIndex > 0 && batchGuard > 0 && batchIndex - batchGuard < 1600, "the batch action exists only when there are new exercises");
  assert.ok(assistant.includes("listNewExercisesOfShare(draft.share, draft.preview)"), "the list holds new entries only (fixture: verify-ui-h3-helpers)");
  assert.ok(assistant.includes("onClick={() => requestTechniqueDrafts(newExercises)}"));
  assert.ok(assistant.includes("onClick={() => requestTechniqueDrafts([newExercise])}"));

  // Studio: the section is rendered for libraryStatus "new" only.
  const sectionIndex = studio.indexOf("<TechniqueNotesSection");
  assert.ok(sectionIndex > 0);
  assert.equal((studio.match(/<TechniqueNotesSection/g) ?? []).length, 1);
  const studioGuard = studio.lastIndexOf('{exercise.libraryStatus === "new" ? (', sectionIndex);
  assert.ok(studioGuard > 0 && sectionIndex - studioGuard < 80, 'rendered only when exercise.libraryStatus === "new"');
  assert.ok(studio.includes("acceptTechniqueDraftIntoDraft(working, currentExercise.id, techniqueDraft, options)"), "Studio accept goes through the approval helper");
  assert.ok(studio.includes("apply(setNewLibraryEntryInDraft(working, entry))"), "manual note edits go through the draft (autosave, dirty, validation)");
  assert.ok(techniqueSection.includes("Draft technique notes with AI") && techniqueSection.includes("Edit notes"));
  assert.ok(techniqueSection.includes('data-testid="technique-notes-readonly"') && techniqueSection.includes("<TechniqueRows entry={entry} />"), "accepted notes are shown read-only");
  assert.ok(techniqueSection.includes("TECHNIQUE_LIST_FIELDS.map(") && techniqueSection.includes('changeField("mainCue"'), "the editable fields are the spec's fields");

  // Requests: explicit action only, through Track B's module, batches through the helper.
  assert.ok(techniqueHook.includes("request: draftTechniqueNotesWithAi") && techniqueHook.includes("runTechniqueBatches({"));
  assert.ok(helpers.includes("splitIntoBatches(") && helpers.includes("size = MAX_TECHNIQUE_EXERCISES"));
  assert.ok(!/useEffect\([^)]*request\(/.test(assistant + techniqueSection), "never requested automatically");
  const hookEffect = techniqueHook.slice(techniqueHook.indexOf("useEffect("), techniqueHook.indexOf("async function request("));
  assert.ok(!hookEffect.includes("runTechniqueBatches") && !hookEffect.includes("draftTechniqueNotesWithAi"), "the hook's effect only aborts on unmount");
  const extract = assistant.slice(assistant.indexOf("async function handleExtract()"), assistant.indexOf("function convertDraft()"));
  assert.ok(!/technique\.request|requestTechniqueDrafts/.test(extract), "an extraction never asks for technique drafts");
  assert.ok(/detectLibraryLanguage\(getLibraryCatalog\(\)\)/.test(assistant) && /detectLibraryLanguage\(getLibraryCatalog\(\)\)/.test(techniqueSection), "the language is the Library's");
  assert.ok(/if \(!hasSavedKey\) \{[\s\S]{0,160}setIsKeySectionOpen\(true\)/.test(assistant.slice(assistant.indexOf("function requestTechniqueDrafts("))), "the same key field as the extraction");
  assert.ok(!/<input[^>]*API key/i.test(techniqueSection + techniqueReview), "no second key field");

  // Approval: per exercise, only through the helpers, badge and errors shown.
  assert.ok(assistant.includes("acceptTechniqueDraftIntoShare(draft.share, item.draft, options)"));
  assert.ok(!/applyTechniqueDraft\(/.test(assistantSide.map((file) => file.code).join("\n") + studio), "the UI applies drafts only through the approval helpers");
  assert.ok(helpers.includes("applyTechniqueDraft(base, techniqueDraft") && /try \{[\s\S]*applyTechniqueDraft\([\s\S]*\} catch \(error\)/.test(helpers), "applyTechniqueDraft is called inside try / catch");
  assert.ok(techniqueReview.includes("onAccept(item, { replace: replaces })") && techniqueReview.includes("onDiscard(item.id)"), "Accept / Discard per exercise");
  assert.ok(techniqueReview.includes("validateTechniqueDraft(item.draft)"), "validation errors are computed for display");
  assert.ok(techniqueReview.includes("disabled={!canAccept || busy}") && techniqueReview.includes('const canAccept = item.status === "draft" && validation.valid;'), "an invalid draft cannot be accepted");
  assert.ok(techniqueReview.includes("This draft cannot be accepted") && techniqueReview.includes("errors.map("));
  // H3 fix round 1: the badge text has one definition (libraryReview.js),
  // because the Library and the workout info panel show it too.
  const libraryReview = read("src/lib/libraryReview.js");
  assert.ok(
    techniqueReview.includes("{TECHNIQUE_DRAFT_BADGE}") &&
      libraryReview.includes('export const TECHNIQUE_DRAFT_BADGE = "AI draft, review before relying on it"') &&
      helpers.includes("export { TECHNIQUE_DRAFT_BADGE }") &&
      !helpers.includes('"AI draft, review before relying on it"'),
    "badge",
  );

  // The badge in the Library and in the workout info panel, and the review (H3-6, H3-9).
  const libraryPage = read("src/pages/LibraryPage.jsx");
  const infoPanel = read("src/components/workout/ExerciseInfoPanel.jsx");
  const app = read("src/App.jsx");
  assert.ok(infoPanel.includes("{isAiTechniqueDraftEntry(exercise) && <AiTechniqueBadge"), "the info panel (Library detail and workout) shows the badge");
  assert.ok(infoPanel.includes("{TECHNIQUE_DRAFT_BADGE}"), "same badge text as the draft review");
  assert.ok(libraryPage.includes("{isAiTechniqueDraftEntry(exercise) && <AiTechniqueBadge"), "the Library card shows the badge");
  assert.ok(libraryPage.includes("Mark notes as reviewed") && libraryPage.includes("onClick={() => handleMarkReviewed(exercise.id)}"));
  const markReviewed = libraryPage.slice(libraryPage.indexOf("function handleMarkReviewed("), libraryPage.indexOf("function clearFilters()"));
  assert.ok(
    /const result = markLibraryTechniqueReviewed\(exerciseId\);\s*if \(!result\.ok\) \{\s*setReviewError\(\{ exerciseId, message: result\.error \}\);\s*return;\s*\}\s*setReviewError\(null\);\s*onLibraryChange\?\.\(\);/.test(
      markReviewed,
    ),
    "the write result is checked; the Library is re-read only after it succeeded",
  );
  assert.ok(libraryPage.includes('role="alert"') && libraryPage.includes("{reviewError.message}"), "a failed review is shown");
  assert.ok(!/writeStorage|localStorage/.test(libraryPage), "the page writes through libraryReview.js only");
  assert.ok(libraryPage.includes("getVisibleGoalTags(exercise.goalTags)"), "the review marker is not a Goal filter option");
  assert.ok(/<LibraryPage[\s\S]{0,200}onLibraryChange=\{refreshProgramData\}/.test(app), "App re-reads the Library after a review");
  // Technique text: a list and "- bullet" text are rendered by the same code.
  assert.ok(infoPanel.includes("const items = getTechniqueBullets(value);") && !/Array\.isArray\(value\)/.test(infoPanel), "one bullet renderer for both shapes");
  assert.ok(/<p className="[^"]*whitespace-pre-line/.test(infoPanel), "plain text keeps its line breaks");
  for (const file of [libraryPage, infoPanel]) {
    assert.ok(!/importAssistant\.js|aiTechnique\.js|aiProgram\.js/.test(file), "the Library and the info panel do not import the assistant");
  }
  assert.deepEqual(
    importsOf(libraryReview).map((entry) => entry.from),
    ["./storage.js"],
    "libraryReview.js stays a leaf module",
  );
  assert.ok(techniqueReview.includes("getTechniqueRows(entry)"), "every field of a draft is rendered");
}

// ------------------------------------------------------------------
// 4. Errors and uncertainty
// ------------------------------------------------------------------
{
  assert.ok(assistant.includes("classifyExtractionError(extractionError)"));
  assert.ok(assistant.includes("data-error-kind={errorInfo.kind}") && assistant.includes("{errorInfo.title}") && assistant.includes("Next step: {errorInfo.guidance}"));
  for (const kind of ["key", "quota", "network", "blocked", "unsupported", "empty"]) {
    assert.ok(helpers.includes(`kind: "${kind}"`), `error kind ${kind}`);
  }
  assert.ok(helpers.includes('title: "The model returned no program"'));

  const previewStart = assistant.indexOf('data-testid="extraction-preview"');
  const checkIndex = assistant.indexOf("Check these before saving (", previewStart);
  const nameIndex = assistant.indexOf("{draft.preview.programName}", previewStart);
  const daysIndex = assistant.indexOf("draft.preview.days.map(", previewStart);
  assert.ok(previewStart > 0 && checkIndex > previewStart, "the block is inside the preview");
  assert.ok(checkIndex < nameIndex && checkIndex < daysIndex, "at the top of the preview, before the program and its days");
  assert.ok(/const uncertainty = draft\?\.preview\?\.uncertainty \?\? \[\];/.test(assistant) && assistant.includes("{uncertainty.length > 0 && ("));
  assert.ok(assistant.includes("<UncertaintyList lines={uncertainty} />"), "every line is listed");

  // The Studio keeps showing the review notes (H2-8).
  assert.ok(studio.includes("const uncertainty = review?.uncertainty ?? [];") && studio.includes("Uncertainty disclosed"));
  assert.ok(studio.includes("{review ? <ReviewNotesPanel review={review} draft={draft} /> : null}"));
  assert.ok(programPage.includes("uncertainty: notes.uncertainty ?? []"), "a resumed review draft shows them too");
}

// Fix round 2: while an extraction runs the open draft cannot be handed on,
// and a draft that is handed on ends the request.
{
  const extract = assistant.slice(assistant.indexOf("async function handleExtract()"), assistant.indexOf("function handleDiscardDraft()"));
  assert.ok(extract.includes("const run = extraction.start();"));
  assert.ok(extract.includes("extractProgramDraftWithAi(built.source, { signal: run.signal })"), "the request can be aborted");
  const staleCheck = extract.indexOf("if (!extraction.isCurrent(run.id)) {", extract.indexOf("extractProgramDraftWithAi("));
  const cacheWrite = extract.indexOf("cachedDraft = result;");
  assert.ok(staleCheck > 0 && cacheWrite > staleCheck, "a cancelled run never writes the draft cache");

  for (const name of ["handleEditInStudio", "handleImport", "handleDiscardDraft"]) {
    const start = assistant.indexOf(`function ${name}()`);
    assert.ok(start > 0, name);
    const body = assistant.slice(start, assistant.indexOf("\n  }\n", start));
    const cancel = body.indexOf("extractionRef.current.cancel();");
    assert.ok(cancel > 0 && cancel < body.indexOf("discardDraft();"), `${name} ends the open request before the draft goes`);
  }

  for (const handler of ["handleEditInStudio", "handleImport", "handleDiscardDraft"]) {
    const at = assistant.indexOf(`onClick={${handler}}`);
    assert.ok(at > 0, handler);
    assert.ok(
      assistant.slice(at, at + 120).includes("disabled={isExtracting}"),
      `the ${handler} button is disabled while an extraction runs`,
    );
  }

  assert.equal((assistant.match(/disabled=\{technique\.busy \|\| isExtracting\}/g) ?? []).length, 2, "technique requests wait as well");
  assert.ok(!assistant.includes("onClick={discardDraft}"));
  assert.ok(helpers.includes("export function createExtractionTracker()"));
}

// Fix round 2: the Studio's copy follows the accepted notes and the Library as it is (H3-9).
{
  assert.ok(studio.includes("const newExercises = useMemo(() => describeNewExercises(draft), [draft]);"));
  assert.ok(studio.includes("{newExercises ? ` - ${newExercises}` : \"\"}"));
  assert.ok(!/summary\.newCount \? `[^`]*no technique content yet/.test(studio), "no unconditional 'no technique content yet'");
  assert.ok(!studio.includes("can be added later in the Library"), "the Library has no editor for technique text");
  assert.ok(studio.includes("the Library shows them but cannot edit them yet"));
}

// ------------------------------------------------------------------
// 5. Program file import stays JSON-only
// ------------------------------------------------------------------
{
  assert.ok(programPage.includes('accept="application/json,.json"'), "the program file input still takes JSON only");
  const importFn = programPage.slice(programPage.indexOf("function handleImportFile("), programPage.indexOf("function importPendingAsIs("));
  assert.ok(importFn.includes("getProgramFileRejection(file.name, file.type)"));
  assert.ok(importFn.indexOf("getProgramFileRejection(") < importFn.indexOf("new FileReader()"), "a document is refused before it is read");
  assert.ok(importFn.includes("validateProgramShareStrict(share)"));
  assert.ok(helpers.includes('"Use the AI Import Assistant for documents"'));
  assert.ok(!/readSourceFile|extractDocxText|extractXlsxText/.test(programPage), "the program import never parses documents");
}

console.log("verify-ui-h3-wiring: ok");
