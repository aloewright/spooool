import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import { ClipboardList, Layers3, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Project, api, queryKeys } from "../../lib/api";
import { BookFlowPreview } from "../animation/book-flow-composition";
import { useGsapTimeline } from "../animation/use-gsap-timeline";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import ChapterSkeletonsPanel from "./ChapterSkeletonsPanel";
import DisclosureSection from "./DisclosureSection";
import OutlineGenerationProgress from "./OutlineGenerationProgress";
import {
  CHARACTER_ARC_OPTIONS,
  CHARACTER_SLOT_IDS,
  type CharacterArcDraft,
  OUTLINE_FRAMEWORKS,
  OUTLINE_TABS,
  type OutlineTab,
  characterArcLabel,
  createChapterPlanDraft,
  createChapterPlanDrafts,
  normalizeOutlineTab,
  replaceWorkspaceHash,
  updateChapterPlan,
  updateCharacter,
} from "./_shared";

export default function OutlineBuilder({
  project,
  view = "outline",
  requestedTab,
}: { project: Project; view?: "outline" | "chapters"; requestedTab?: OutlineTab }) {
  const queryClient = useQueryClient();
  const chapterListRef = useRef<HTMLDivElement | null>(null);
  const chaptersPanelRef = useRef<HTMLDivElement | null>(null);
  const reduceMotion = useReducedMotion();
  const [framework, setFramework] = useState(project.type === "fiction" ? "hero-journey" : "paas");
  const [questionnaire, setQuestionnaire] = useState("");
  const [characters, setCharacters] = useState<CharacterArcDraft[]>([
    {
      id: CHARACTER_SLOT_IDS[0],
      name: "",
      arc: "positive-change",
      position: "",
      sceneRole: "",
    },
  ]);
  const [defaultCast, setDefaultCast] = useState("");
  const [miniStructure, setMiniStructure] = useState(
    "Setup: scene goal, cast, and conflict. Turn: force a reversal, reveal, or choice. Fallout: end with a consequence that changes the next scene.",
  );
  const [chapterPlan, setChapterPlan] = useState(() =>
    createChapterPlanDrafts(project.type === "fiction" ? 12 : 10),
  );
  const [activeChapterId, setActiveChapterId] = useState(() => chapterPlan[0]?.id ?? "chapter-1");
  const [frameworkGuideOpen, setFrameworkGuideOpen] = useState(true);
  const [characterPanelOpen, setCharacterPanelOpen] = useState(project.type === "fiction");
  const [outlineTab, setOutlineTab] = useState<OutlineTab>(() =>
    normalizeOutlineTab(requestedTab, project.type),
  );
  const availableFrameworks = OUTLINE_FRAMEWORKS.filter((item) => item.type === project.type);
  const selectedFramework =
    availableFrameworks.find((item) => item.id === framework) ?? availableFrameworks[0];
  const visibleTabs = OUTLINE_TABS.filter(
    (tab) => tab.key !== "characters" || project.type === "fiction",
  );
  const outline = useQuery({
    queryKey: queryKeys.projectOutline(project.id),
    queryFn: () => api.getProjectOutline(project.id),
  });
  const generate = useMutation({
    mutationFn: () =>
      api.generateProjectOutline(project.id, {
        framework,
        questionnaire,
        chapter_plan: chapterPlan
          .map((chapter, index) => ({ chapter, index }))
          .filter(({ chapter }) => chapter.event.trim())
          .map(({ chapter, index }) => ({
            ordinal: index + 1,
            title: chapter.title.trim(),
            event: chapter.event.trim(),
            purpose: chapter.purpose.trim(),
            pov: chapter.pov.trim(),
            characters: chapter.characters.trim(),
          })),
        ...(project.type === "fiction"
          ? {
              character_arcs: characters
                .filter((character) => character.name.trim())
                .map((character) => ({
                  name: character.name.trim(),
                  arc: characterArcLabel(character.arc),
                  position: character.position.trim(),
                  sceneRole: character.sceneRole.trim(),
                })),
              scene_plan: {
                defaultCast: defaultCast.trim(),
                miniStructure: miniStructure.trim(),
              },
            }
          : {}),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projectOutline(project.id) }),
      ]);
      setOutlineTab("chapters");
      replaceWorkspaceHash("outline:chapters");
      window.setTimeout(() => {
        chaptersPanelRef.current?.scrollIntoView({
          block: "start",
          behavior: reduceMotion ? "auto" : "smooth",
        });
      }, 0);
    },
  });
  const chapterCount = outline.data?.chapters.length ?? 0;
  useGsapTimeline(
    chapterListRef,
    (timeline, node) => {
      timeline.fromTo(
        node.querySelectorAll("[data-chapter-card='true']"),
        {
          backgroundColor: "rgba(20, 184, 166, 0.16)",
          boxShadow: "0 0 0 1px rgba(20, 184, 166, 0.4)",
        },
        {
          backgroundColor: "rgba(0, 0, 0, 0)",
          boxShadow: "0 0 0 0 rgba(20, 184, 166, 0)",
          stagger: 0.035,
        },
      );
    },
    [chapterCount],
  );
  const activeChapterIndex = Math.max(
    0,
    chapterPlan.findIndex((chapter) => chapter.id === activeChapterId),
  );
  const activeChapterFallback = chapterPlan[0] ?? createChapterPlanDraft(1);
  const activeChapter = chapterPlan[activeChapterIndex] ?? activeChapterFallback;
  const decisionCount = chapterPlan.filter(
    (chapter) => chapter.title.trim() || chapter.event.trim() || chapter.purpose.trim(),
  ).length;
  const characterCount = characters.filter((character) => character.name.trim()).length;
  const activeOutlineTab = view === "chapters" ? "chapters" : outlineTab;

  useEffect(() => {
    if (view === "chapters") {
      setOutlineTab("chapters");
      return;
    }
    setOutlineTab(normalizeOutlineTab(requestedTab, project.type));
  }, [project.type, requestedTab, view]);

  function addChapterSlot() {
    setChapterPlan((current) => {
      const nextChapter = createChapterPlanDraft(current.length + 1);
      setActiveChapterId(nextChapter.id);
      return [...current, nextChapter];
    });
  }

  function selectOutlineTab(tab: OutlineTab) {
    const next = normalizeOutlineTab(tab, project.type);
    setOutlineTab(next);
    replaceWorkspaceHash(`outline:${next}`);
  }

  function removeChapterSlot() {
    setChapterPlan((current) => {
      if (current.length <= 1) return current;
      const next = current.slice(0, -1);
      if (!next.some((chapter) => chapter.id === activeChapterId)) {
        setActiveChapterId(next.at(-1)?.id ?? next[0]?.id ?? "chapter-1");
      }
      return next;
    });
  }

  return (
    <section id={view} className="scroll-mt-6">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div>
          <h2 className="text-xl font-semibold">
            {view === "chapters" ? "Chapter workspace" : "Outline builder"}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {view === "chapters"
              ? "Open the next chapter, check draft coverage, and keep manuscript work moving."
              : "Pick a framework, answer the architect prompt, and generate chapter skeletons for drafting."}
          </p>
          <div className="mt-3">
            {outline.data?.outline ? (
              <Badge>Outline v{outline.data.outline.version}</Badge>
            ) : (
              <Badge variant="secondary">No outline</Badge>
            )}
          </div>
        </div>
        <BookFlowPreview />
      </div>

      <div className="mt-6 grid gap-6">
        {view === "outline" ? (
          <form
            id="outline-generation-form"
            className="overflow-hidden rounded-xl border bg-background/75 shadow-sm backdrop-blur"
            onSubmit={(event) => {
              event.preventDefault();
              generate.mutate();
            }}
          >
            <div className="border-b bg-background/70 p-2">
              <div
                role="tablist"
                aria-label="Outline workspace sections"
                className="grid gap-2 md:grid-cols-4"
              >
                {visibleTabs.map((tab) => {
                  const selected = activeOutlineTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls={`outline-tab-${tab.key}`}
                      className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary bg-primary/10 text-foreground"
                          : "bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                      onClick={() => selectOutlineTab(tab.key)}
                    >
                      <span className="block text-sm font-semibold">{tab.label}</span>
                      <span className="mt-0.5 block text-xs">{tab.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid gap-5 p-4">
              {activeOutlineTab === "setup" ? (
                <div
                  id="outline-tab-setup"
                  role="tabpanel"
                  className="grid gap-4 2xl:grid-cols-[minmax(22rem,0.8fr)_minmax(0,1.2fr)]"
                >
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <div className="flex items-center gap-2">
                      <Layers3 className="h-4 w-4 text-muted-foreground" />
                      <h2 className="text-sm font-semibold">Outline setup</h2>
                    </div>
                    <div className="mt-4 space-y-3">
                      <Select value={framework} onValueChange={setFramework}>
                        <SelectTrigger aria-label="Outline framework">
                          <SelectValue placeholder="Framework" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableFrameworks.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selectedFramework ? (
                        <DisclosureSection
                          title={selectedFramework.label}
                          description={selectedFramework.description}
                          open={frameworkGuideOpen}
                          onOpenChange={setFrameworkGuideOpen}
                          meta={`${selectedFramework.questions.length} prompts`}
                        >
                          <ul className="grid gap-2 text-sm text-muted-foreground">
                            {selectedFramework.questions.map((question) => (
                              <li
                                key={question}
                                className="flex gap-2 rounded-md bg-background/60 p-2"
                              >
                                <span aria-hidden className="text-muted-foreground/60">
                                  •
                                </span>
                                <span className="min-w-0 flex-1">{question}</span>
                              </li>
                            ))}
                          </ul>
                        </DisclosureSection>
                      ) : null}
                    </div>
                  </div>

                  <div className="rounded-lg border bg-muted/20 p-4">
                    <div className="flex items-center gap-2">
                      <ClipboardList className="h-4 w-4 text-muted-foreground" />
                      <h2 className="text-sm font-semibold">Story brief</h2>
                    </div>
                    <Textarea
                      value={questionnaire}
                      onChange={(event) => setQuestionnaire(event.target.value)}
                      placeholder={
                        project.type === "fiction"
                          ? "Protagonist, want, weakness, opponent, world, stakes, ending choice..."
                          : "Reader, promise, proof, constraints, must-include stories..."
                      }
                      className="mt-4 min-h-36 resize-y bg-background/80"
                      required
                    />
                  </div>
                </div>
              ) : null}

              {activeOutlineTab === "decisions" ? (
                <div
                  id="outline-tab-decisions"
                  role="tabpanel"
                  className="overflow-hidden rounded-xl border bg-muted/20"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b bg-background/70 p-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <ClipboardList className="h-4 w-4 text-muted-foreground" />
                        <h2 className="text-sm font-semibold">Chapter decision board</h2>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Pick a chapter slot, decide the visible turn, then generate the full
                        skeleton.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">{chapterPlan.length} slots</Badge>
                      <Badge>{decisionCount} decided</Badge>
                    </div>
                  </div>

                  <div className="grid gap-0 lg:grid-cols-[260px_minmax(0,1fr)]">
                    <div className="border-b bg-background/40 p-3 lg:border-r lg:border-b-0">
                      <div className="grid max-h-[30rem] gap-2 overflow-y-auto pr-1">
                        {chapterPlan.map((chapter, index) => {
                          const active = chapter.id === activeChapter.id;
                          const decided = Boolean(chapter.event.trim());
                          return (
                            <button
                              key={chapter.id}
                              type="button"
                              aria-pressed={active}
                              className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                                active
                                  ? "border-primary bg-primary/10 text-foreground"
                                  : "bg-background/70 text-muted-foreground hover:bg-accent hover:text-foreground"
                              }`}
                              onClick={() => setActiveChapterId(chapter.id)}
                            >
                              <span className="flex items-center justify-between gap-2">
                                <span className="font-medium text-foreground">
                                  {index + 1}. {chapter.title.trim() || `Chapter ${index + 1}`}
                                </span>
                                <span
                                  className={`h-2 w-2 rounded-full ${
                                    decided ? "bg-emerald-500" : "bg-muted-foreground/40"
                                  }`}
                                  aria-hidden
                                />
                              </span>
                              <span className="mt-1 block truncate text-xs">
                                {chapter.event.trim() || "No decision yet"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={chapterPlan.length >= 40}
                          onClick={addChapterSlot}
                        >
                          Add slot
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={chapterPlan.length <= 1}
                          onClick={removeChapterSlot}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>

                    <div className="min-w-0 p-4">
                      {activeChapter ? (
                        <motion.div
                          key={activeChapter.id}
                          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                          className="rounded-lg border bg-background/80 p-4"
                        >
                          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <h3 className="text-base font-semibold">
                                Chapter {activeChapterIndex + 1}
                              </h3>
                              <p className="text-sm text-muted-foreground">
                                Fill only what you know. Empty fields let the architect infer.
                              </p>
                            </div>
                            {activeChapter.event.trim() ? (
                              <Badge>Decision set</Badge>
                            ) : (
                              <Badge variant="secondary">Open</Badge>
                            )}
                          </div>
                          <div className="grid gap-3">
                            <Input
                              aria-label={`Chapter ${activeChapterIndex + 1} working title`}
                              value={activeChapter.title}
                              onChange={(event) =>
                                updateChapterPlan(setChapterPlan, activeChapter.id, {
                                  title: event.target.value,
                                })
                              }
                              placeholder="Working title"
                            />
                            <Textarea
                              aria-label={`Chapter ${activeChapterIndex + 1} what happens`}
                              value={activeChapter.event}
                              onChange={(event) =>
                                updateChapterPlan(setChapterPlan, activeChapter.id, {
                                  event: event.target.value,
                                })
                              }
                              placeholder={
                                project.type === "fiction"
                                  ? "What visibly happens in this chapter?"
                                  : "What claim, lesson, story, or exercise happens in this chapter?"
                              }
                              className="min-h-24 resize-y"
                            />
                            <div className="grid gap-3 sm:grid-cols-2">
                              <Input
                                aria-label={`Chapter ${activeChapterIndex + 1} purpose`}
                                value={activeChapter.purpose}
                                onChange={(event) =>
                                  updateChapterPlan(setChapterPlan, activeChapter.id, {
                                    purpose: event.target.value,
                                  })
                                }
                                placeholder="Purpose or turn"
                              />
                              <Input
                                aria-label={`Chapter ${activeChapterIndex + 1} POV`}
                                value={activeChapter.pov}
                                onChange={(event) =>
                                  updateChapterPlan(setChapterPlan, activeChapter.id, {
                                    pov: event.target.value,
                                  })
                                }
                                placeholder={project.type === "fiction" ? "POV" : "Reader state"}
                              />
                            </div>
                            <Input
                              aria-label={`Chapter ${activeChapterIndex + 1} characters`}
                              value={activeChapter.characters}
                              onChange={(event) =>
                                updateChapterPlan(setChapterPlan, activeChapter.id, {
                                  characters: event.target.value,
                                })
                              }
                              placeholder={
                                project.type === "fiction"
                                  ? "Characters in play"
                                  : "Examples, experts, or case studies in play"
                              }
                            />
                          </div>
                        </motion.div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}

              {project.type === "fiction" && activeOutlineTab === "characters" ? (
                <div id="outline-tab-characters" role="tabpanel">
                  <DisclosureSection
                    title="Character arcs and scene context"
                    description="Optional arc guidance for recurring characters and scene structure."
                    open={characterPanelOpen}
                    onOpenChange={setCharacterPanelOpen}
                    icon={<Settings2 className="h-4 w-4 text-muted-foreground" />}
                    meta={`${characterCount} characters`}
                  >
                    <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
                      <div className="space-y-3">
                        {characters.map((character, index) => (
                          <div
                            key={character.id}
                            className="rounded-lg border bg-background/80 p-3"
                          >
                            <div className="mb-3 flex items-center justify-between gap-3">
                              <h3 className="text-sm font-semibold">Character {index + 1}</h3>
                              {character.name.trim() ? (
                                <Badge>{characterArcLabel(character.arc)}</Badge>
                              ) : (
                                <Badge variant="secondary">Open</Badge>
                              )}
                            </div>
                            <div className="grid gap-3">
                              <Input
                                aria-label={`Character ${index + 1} name`}
                                value={character.name}
                                onChange={(event) =>
                                  updateCharacter(setCharacters, character.id, {
                                    name: event.target.value,
                                  })
                                }
                                placeholder="Character name"
                              />
                              <Select
                                value={character.arc}
                                onValueChange={(value) =>
                                  updateCharacter(setCharacters, character.id, { arc: value })
                                }
                              >
                                <SelectTrigger aria-label={`Character ${index + 1} arc`}>
                                  <SelectValue placeholder="Arc" />
                                </SelectTrigger>
                                <SelectContent>
                                  {CHARACTER_ARC_OPTIONS.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Textarea
                                aria-label={`Character ${index + 1} arc position`}
                                value={character.position}
                                onChange={(event) =>
                                  updateCharacter(setCharacters, character.id, {
                                    position: event.target.value,
                                  })
                                }
                                placeholder="Where this character is in the arc at this point in the story..."
                                className="min-h-20 resize-y"
                              />
                              <Input
                                aria-label={`Character ${index + 1} scene role`}
                                value={character.sceneRole}
                                onChange={(event) =>
                                  updateCharacter(setCharacters, character.id, {
                                    sceneRole: event.target.value,
                                  })
                                }
                                placeholder="Scene role, relationship pressure, or conflict function"
                              />
                            </div>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={characters.length >= CHARACTER_SLOT_IDS.length}
                          onClick={() =>
                            setCharacters((current) => [
                              ...current,
                              {
                                id: CHARACTER_SLOT_IDS[current.length],
                                name: "",
                                arc: "positive-change",
                                position: "",
                                sceneRole: "",
                              },
                            ])
                          }
                        >
                          Add character
                        </Button>
                      </div>
                      <div className="space-y-3">
                        <Textarea
                          value={defaultCast}
                          onChange={(event) => setDefaultCast(event.target.value)}
                          placeholder="Default scene cast: Mara + Ivo in discovery scenes; Mara + Venn in conflict scenes..."
                          className="min-h-28 resize-y bg-background/80"
                        />
                        <Textarea
                          value={miniStructure}
                          onChange={(event) => setMiniStructure(event.target.value)}
                          placeholder="Three-act mini scene structure..."
                          className="min-h-32 resize-y bg-background/80"
                        />
                      </div>
                    </div>
                  </DisclosureSection>
                </div>
              ) : null}

              {activeOutlineTab === "chapters" ? (
                <div id="outline-tab-chapters" role="tabpanel">
                  <ChapterSkeletonsPanel
                    project={project}
                    chapters={outline.data?.chapters ?? []}
                    panelRef={chaptersPanelRef}
                    listRef={chapterListRef}
                  />
                </div>
              ) : null}
            </div>

            <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background/90 p-4 backdrop-blur">
              <div className="text-sm text-muted-foreground">
                {decisionCount
                  ? `${decisionCount} chapter decisions ready`
                  : "Add chapter decisions when useful"}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {generate.isPending ? <OutlineGenerationProgress /> : null}
                {generate.error ? (
                  <p className="text-sm text-destructive">{generate.error.message}</p>
                ) : null}
                <Button type="submit" disabled={!questionnaire.trim() || generate.isPending}>
                  {generate.isPending ? "Generating..." : "Generate outline"}
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <ChapterSkeletonsPanel
            project={project}
            chapters={outline.data?.chapters ?? []}
            panelRef={chaptersPanelRef}
            listRef={chapterListRef}
          />
        )}
      </div>
    </section>
  );
}
