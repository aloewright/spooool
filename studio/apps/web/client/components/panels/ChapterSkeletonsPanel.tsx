import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import type { RefObject } from "react";
import type { Chapter, Project } from "../../lib/api";
import { MotionItem, MotionList } from "../animation/motion";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export default function ChapterSkeletonsPanel({
  project,
  chapters,
  panelRef,
  listRef,
}: {
  project: Project;
  chapters: Chapter[];
  panelRef: RefObject<HTMLDivElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div id="chapters" ref={panelRef} className="scroll-mt-6 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Chapter skeletons</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {chapters.length.toLocaleString()} chapters
          </p>
        </div>
        {chapters.length ? (
          <Button asChild size="sm" variant="secondary">
            <Link to="/$projectId/book" params={{ projectId: project.id }}>
              Full book
            </Link>
          </Button>
        ) : null}
      </div>
      <div ref={listRef} className="mt-4">
        {chapters.length ? (
          <MotionList className="grid gap-3 lg:grid-cols-2">
            {chapters.map((chapter) => {
              const drafted = chapter.draft_md.trim().length > 0;
              return (
                <MotionItem key={chapter.id}>
                  <motion.div
                    whileHover={{ y: -2 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                  >
                    <Link
                      to="/$projectId/chapters/$chapterId"
                      params={{ projectId: project.id, chapterId: chapter.id }}
                      className="block h-full rounded-lg border bg-muted/20 p-4 text-foreground transition-colors visited:text-foreground hover:bg-accent"
                      data-chapter-card="true"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="font-medium">
                          {chapter.ordinal}. {chapter.title}
                        </h3>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <Badge variant={drafted ? "default" : "secondary"}>
                            {drafted ? "Drafted" : "Planned"}
                          </Badge>
                          <Badge variant="outline">
                            {chapter.target_words.toLocaleString()} words
                          </Badge>
                        </div>
                      </div>
                      <p className="mt-3 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                        {chapter.summary}
                      </p>
                      <span className="mt-4 inline-flex text-sm font-medium text-primary">
                        Open chapter
                      </span>
                    </Link>
                  </motion.div>
                </MotionItem>
              );
            })}
          </MotionList>
        ) : (
          <p className="text-sm text-muted-foreground">
            Generated chapters will appear here after the first outline run.
          </p>
        )}
      </div>
    </div>
  );
}
