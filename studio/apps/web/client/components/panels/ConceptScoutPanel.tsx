import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Search } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { type Project, type ScoutResult, api, queryKeys } from "../../lib/api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export default function ConceptScoutPanel({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [niche, setNiche] = useState(project.title);
  const [audience, setAudience] = useState("");
  const [angle, setAngle] = useState("");
  const findings = useQuery({
    queryKey: queryKeys.projectScoutFindings(project.id),
    queryFn: () => api.listProjectScoutFindings(project.id),
  });
  const pull = useMutation({
    mutationFn: () =>
      api.createScoutQuery({
        niche,
        type: project.type,
        project_id: project.id,
        params: {
          source: "project-concept",
          audience,
          angle,
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projectScoutFindings(project.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.scoutQueries() }),
      ]);
    },
  });
  const latest = findings.data?.items[0] ?? null;

  return (
    <section id="concept" className="scroll-mt-6 border-b pb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Concept brief</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Attach market evidence to this book before voice, outline, and publishing work.
          </p>
        </div>
        {latest ? <Badge>Scout pulled</Badge> : <Badge variant="secondary">No Scout read</Badge>}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
        <form
          className="rounded-lg border bg-background p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (niche.trim()) pull.mutate();
          }}
        >
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Pull from Scout</h2>
            <p className="text-sm text-muted-foreground">
              Run the current concept against the market dataset and save the finding to this
              project.
            </p>
          </div>
          <div className="mt-4 grid gap-3">
            <Input
              value={niche}
              onChange={(event) => setNiche(event.target.value)}
              placeholder="Niche or reader demand"
            />
            <Input
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              placeholder="Target reader"
              aria-label="Scout target reader"
            />
            <Textarea
              value={angle}
              onChange={(event) => setAngle(event.target.value)}
              placeholder="Angle or promise Scout should evaluate"
              aria-label="Scout angle"
            />
            <Button type="submit" disabled={!niche.trim() || pull.isPending}>
              <Search className="h-4 w-4" />
              {pull.isPending ? "Pulling..." : "Pull from Scout"}
            </Button>
            {pull.error ? <p className="text-sm text-destructive">{pull.error.message}</p> : null}
          </div>
        </form>

        <ProjectScoutFinding
          result={latest}
          loading={findings.isLoading}
          error={findings.error as Error | null}
        />
      </div>
    </section>
  );
}

function ProjectScoutFinding({
  result,
  loading,
  error,
}: {
  result: ScoutResult | null;
  loading: boolean;
  error: Error | null;
}) {
  if (error) {
    return (
      <Card className="border-dashed p-4 text-sm text-destructive shadow-none">
        Failed to load Scout findings. {error.message}
      </Card>
    );
  }
  if (!result) {
    return (
      <Card className="border-dashed p-4 text-sm text-muted-foreground shadow-none">
        {loading ? "Loading Scout findings..." : "Pull a Scout read to show evidence here."}
      </Card>
    );
  }

  const evidence = result.finding.evidence_json;
  const verdict = evidence.verdict;
  const conceptBrief = evidence.concept_brief;
  return (
    <Card className="p-4 shadow-none">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{result.query.niche}</h2>
          <p className="text-sm text-muted-foreground">
            {evidence.dataset.week_iso} · {evidence.records.length} evidence rows
          </p>
        </div>
        <Badge variant="secondary">{result.query.type}</Badge>
      </div>
      <div className="prose prose-neutral prose-sm mt-4 max-w-none dark:prose-invert">
        <ReactMarkdown>{result.finding.summary_md}</ReactMarkdown>
      </div>
      {verdict || conceptBrief ? (
        <div className="mt-4 rounded-md border bg-muted/20 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              Scout brief
            </div>
            {verdict ? (
              <Badge variant={verdict.status === "ready" ? "default" : "secondary"}>
                {verdict.label}
              </Badge>
            ) : null}
          </div>
          {verdict ? <p className="mt-2 text-muted-foreground">{verdict.rationale}</p> : null}
          {conceptBrief ? (
            <div className="mt-3 grid gap-2">
              <p>
                <span className="font-medium">Promise:</span> {conceptBrief.promise}
              </p>
              <p>
                <span className="font-medium">Must prove:</span> {conceptBrief.must_prove}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-4 grid gap-3">
        {evidence.gaps.slice(0, 3).map((gap) => (
          <div key={gap} className="rounded-md bg-muted/40 p-3 text-sm">
            {gap}
          </div>
        ))}
      </div>
      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/30 text-muted-foreground">
            <tr>
              <th className="px-2 py-2">Rank</th>
              <th className="px-2 py-2">Title</th>
              <th className="px-2 py-2">Source</th>
            </tr>
          </thead>
          <tbody>
            {evidence.records.slice(0, 4).map((record) => (
              <tr key={`${record.source}-${record.rank}-${record.title}`} className="border-t">
                <td className="px-2 py-2 font-medium">{record.rank}</td>
                <td className="px-2 py-2">{record.title}</td>
                <td className="px-2 py-2 text-muted-foreground">{record.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
