import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Rocket } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { type GtmBrief, api, queryKeys } from "../../lib/api";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

export default function LaunchPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const brief = useQuery({
    queryKey: queryKeys.gtmBrief(projectId),
    queryFn: () => api.getGtmBrief(projectId),
    refetchInterval: (query) => (query.state.data?.brief ? false : 3_000),
  });
  const start = useMutation({
    mutationFn: () => api.startGtmBrief(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.gtmBrief(projectId) });
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-4 shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Go-to-market handoff</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Uses the approved publisher pack and any project Scout findings. ZIP contains
              Markdown, HTML, and handoff JSON.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={start.isPending} onClick={() => start.mutate()}>
              <Rocket className="h-4 w-4" />
              {start.isPending ? "Generating..." : "Generate brief"}
            </Button>
            {brief.data?.brief?.download_url ? (
              <Button asChild variant="outline">
                <a href={brief.data.brief.download_url}>
                  <Download className="h-4 w-4" />
                  Download ZIP
                </a>
              </Button>
            ) : null}
          </div>
        </div>
        {start.error ? (
          <p className="mt-3 text-sm text-destructive">{start.error.message}</p>
        ) : null}
        {start.isSuccess && !brief.data?.brief ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Workflow started. This page will refresh until the handoff is ready.
          </p>
        ) : null}
      </Card>

      {brief.data?.brief ? (
        <LaunchBriefPreview brief={brief.data.brief} />
      ) : (
        <Card className="border-dashed p-8 text-center text-muted-foreground shadow-none">
          {brief.isLoading ? "Loading launch handoff..." : "No launch handoff generated yet."}
        </Card>
      )}
    </div>
  );
}

function LaunchBriefPreview({ brief }: { brief: GtmBrief }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="min-w-0 rounded-lg border bg-background p-5">
        <div className="prose prose-sm max-w-none">
          <ReactMarkdown>{brief.brief_md}</ReactMarkdown>
        </div>
      </section>
      <aside className="rounded-lg border bg-background p-4">
        <h2 className="text-base font-semibold">Handoff JSON</h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Comp titles</dt>
            <dd className="font-medium">{brief.content_json.comp_titles.length}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Emails</dt>
            <dd className="font-medium">{brief.content_json.email_sequence.length}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Ad headlines</dt>
            <dd className="font-medium">{brief.content_json.ad_headlines.length}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">R2 package</dt>
            <dd className="break-all font-mono text-xs">{brief.r2_key}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}
