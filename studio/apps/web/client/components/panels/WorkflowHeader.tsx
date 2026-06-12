import { ArrowRight } from "lucide-react";
import type { Project, PublisherPack } from "../../lib/api";
import { PretextRevealText } from "../animation/pretext-reveal-text";
import { Card } from "../ui/card";
import type { WorkflowKey, WorkflowStatus } from "../workspace/outline-rail";
import ReadinessTile from "./ReadinessTile";
import WorkflowStatusBadge from "./WorkflowStatusBadge";
import { WORKFLOW_COPY, nextWorkflowAction } from "./_shared";

export default function WorkflowHeader({
  workflow,
  statuses,
  project,
  scoutCount,
  chapterCount,
  draftedChapterCount,
  publisherStatus,
}: {
  workflow: WorkflowKey;
  statuses: Partial<Record<WorkflowKey, WorkflowStatus>>;
  project: Project;
  scoutCount: number;
  chapterCount: number;
  draftedChapterCount: number;
  publisherStatus: PublisherPack["status"] | null;
}) {
  const copy = WORKFLOW_COPY[workflow];
  const status = statuses[workflow] ?? "not-started";
  const nextAction = nextWorkflowAction({
    project,
    scoutCount,
    chapterCount,
    draftedChapterCount,
    publisherStatus,
  });

  return (
    <header className="border-b pb-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <PretextRevealText
              as="h1"
              text={copy.title}
              className="text-2xl font-semibold"
              font="600 24px Nunito, ui-sans-serif, system-ui, sans-serif"
              lineHeight={32}
            />
            <WorkflowStatusBadge status={status} />
          </div>
          <PretextRevealText
            as="p"
            text={copy.description}
            className="mt-1 max-w-2xl text-sm text-muted-foreground"
          />
        </div>
        <Card className="w-full max-w-sm p-3 shadow-none">
          <div className="flex items-start gap-2">
            <ArrowRight className="mt-0.5 h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs font-semibold uppercase text-muted-foreground">
                Next recommended action
              </p>
              <p className="mt-1 text-sm">{nextAction}</p>
            </div>
          </div>
        </Card>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ReadinessTile
          label="Scout reads"
          value={scoutCount.toLocaleString()}
          ok={scoutCount > 0}
        />
        <ReadinessTile
          label="Voice"
          value={project.voice_id ? "Selected" : "Missing"}
          ok={Boolean(project.voice_id)}
        />
        <ReadinessTile
          label="Chapters"
          value={`${draftedChapterCount}/${chapterCount}`}
          ok={chapterCount > 0 && draftedChapterCount === chapterCount}
        />
        <ReadinessTile
          label="Publisher pack"
          value={publisherStatus ?? "Missing"}
          ok={publisherStatus === "approved"}
        />
      </div>
    </header>
  );
}
