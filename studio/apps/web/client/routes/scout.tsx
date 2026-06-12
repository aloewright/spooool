import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ClipboardList, ListChecks, Search, Sparkles } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { type ScoutResult, api, queryKeys } from "../lib/api";

export const Route = createFileRoute("/scout")({ component: ScoutPage });

function ScoutPage() {
  const queryClient = useQueryClient();
  const [niche, setNiche] = useState("productivity systems for neurodivergent founders");
  const [type, setType] = useState<"nonfiction" | "fiction">("nonfiction");
  const [audience, setAudience] = useState("");
  const [angle, setAngle] = useState("");
  const [active, setActive] = useState<ScoutResult | null>(null);
  const queries = useQuery({ queryKey: queryKeys.scoutQueries(), queryFn: api.listScoutQueries });
  const create = useMutation({
    mutationFn: () =>
      api.createScoutQuery({
        niche,
        type,
        params: {
          audience,
          angle,
        },
      }),
    onSuccess: async (result) => {
      setActive(result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.scoutQueries() });
    },
  });
  const result = active ?? queries.data?.items[0] ?? null;

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b pb-6">
        <div>
          <h1 className="text-3xl font-semibold">Scout</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Run a market read before committing a concept. Scout stores the query, dataset evidence,
            and gap analysis for later project use.
          </p>
        </div>
        <Badge variant="secondary">Market dataset</Badge>
      </div>

      <form
        className="grid gap-4 rounded-lg border bg-background p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (niche.trim()) create.mutate();
        }}
      >
        <div className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
          <Input
            value={niche}
            onChange={(event) => setNiche(event.target.value)}
            placeholder="Niche or reader demand"
          />
          <Select value={type} onValueChange={(value) => setType(value as typeof type)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="nonfiction">Nonfiction</SelectItem>
              <SelectItem value="fiction">Fiction</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={!niche.trim() || create.isPending}>
            <Search className="h-4 w-4" />
            {create.isPending ? "Scouting..." : "Run Scout"}
          </Button>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Input
            value={audience}
            onChange={(event) => setAudience(event.target.value)}
            placeholder="Target reader, e.g. burned-out solo founders"
            aria-label="Target reader"
          />
          <Textarea
            value={angle}
            onChange={(event) => setAngle(event.target.value)}
            placeholder="Angle or promise, e.g. a calmer weekly operating system"
            aria-label="Scout angle"
            className="min-h-[44px]"
          />
        </div>
        {create.error ? <p className="text-sm text-destructive">{create.error.message}</p> : null}
      </form>

      {result ? (
        <ScoutResultView result={result} />
      ) : (
        <EmptyScoutState loading={queries.isLoading} />
      )}

      {(queries.data?.items.length ?? 0) > 1 ? (
        <section className="border-t pt-6">
          <h2 className="text-lg font-semibold">Recent reads</h2>
          <div className="mt-3 grid gap-2">
            {queries.data?.items.map((item) => (
              <button
                type="button"
                key={item.query.id}
                className="rounded-lg border bg-background px-4 py-3 text-left transition-colors hover:bg-accent"
                onClick={() => setActive(item)}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{item.query.niche}</span>
                  <Badge variant="secondary">{item.query.type}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDate(item.query.created_at)} ·{" "}
                  {item.finding.evidence_json.dataset.week_iso}
                </p>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}

export function ScoutResultView({ result }: { result: ScoutResult }) {
  const [tab, setTab] = useState<"summary" | "risks" | "comps" | "actions">("summary");
  const evidence = result.finding.evidence_json;
  const sourceMix = evidence.source_mix ?? countSources(evidence.records);
  const keywordCounts = evidence.keyword_counts ?? inferKeywordCounts(evidence.records);
  const opportunityScore = evidence.opportunity_score ?? inferOpportunityScore(evidence.records);
  const confidence = evidence.confidence ?? inferConfidence(evidence.records, sourceMix);
  const verdict =
    evidence.verdict ??
    fallbackVerdict(opportunityScore, confidence, coveredSourceCount(sourceMix));
  const conceptBrief =
    evidence.concept_brief ?? fallbackConceptBrief(result.query.niche, result.query.type);
  const nextQuestions = evidence.next_questions ?? [
    "What reader promise is most visible from this evidence?",
    "Which comparable title is closest, and how is this book different?",
  ];
  const validationSteps = evidence.validation_steps ?? [
    "Validate the strongest hook with readers before moving into outline.",
    "Compare the promise against comparable titles before drafting.",
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="min-w-0 p-5 shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{result.query.niche}</h2>
            <p className="text-sm text-muted-foreground">
              {evidence.dataset.week_iso} · {evidence.records.length} evidence rows
            </p>
          </div>
          <Badge>{result.query.type}</Badge>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <InsightMetric label="Opportunity" value={`${opportunityScore}/100`} />
          <InsightMetric label="Confidence" value={confidence} />
          <InsightMetric label="Sources" value={`${coveredSourceCount(sourceMix)}/3 covered`} />
        </div>
        <ScoutVerdictCard verdict={verdict} conceptBrief={conceptBrief} />
        <div className="mt-4 grid gap-3 rounded-lg border bg-muted/20 p-4">
          <div>
            <h3 className="text-sm font-semibold">Audience read</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {evidence.audience_brief ??
                `${result.query.niche}: current records show usable reader demand, but the hook needs sharper differentiation.`}
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Positioning brief</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {evidence.positioning_brief ??
                "Position around the strongest recurring keywords while explicitly resolving one visible market gap."}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 border-b pb-3">
          {[
            ["summary", "Summary"],
            ["risks", "Risks"],
            ["comps", "Comparable titles"],
            ["actions", "Action items"],
          ].map(([value, label]) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={tab === value ? "default" : "ghost"}
              onClick={() => setTab(value as typeof tab)}
            >
              {label}
            </Button>
          ))}
        </div>
        {tab === "summary" ? (
          <div className="prose prose-neutral prose-sm mt-4 max-w-none dark:prose-invert">
            <ReactMarkdown>{result.finding.summary_md}</ReactMarkdown>
          </div>
        ) : null}
        {tab === "risks" ? (
          <ScoutList
            items={evidence.gaps}
            empty="No gaps were found in this Scout read."
            label="Market and positioning risks"
          />
        ) : null}
        {tab === "comps" ? <ComparableTitleList result={result} /> : null}
        {tab === "actions" ? (
          <div className="grid gap-4">
            <ScoutList
              items={evidence.recommendations}
              empty="No action items were generated for this Scout read."
              label="Recommended next moves"
            />
            <ScoutList
              items={validationSteps}
              empty="No validation steps were generated for this Scout read."
              label="Validation steps"
            />
            <ScoutList
              items={nextQuestions}
              empty="No next questions were generated for this Scout read."
              label="Questions before outline"
            />
          </div>
        ) : null}
      </Card>

      <aside>
        <Card className="p-4 shadow-none">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Gap analysis</h2>
          </div>
          <ul className="mt-4 space-y-3 text-sm">
            {evidence.gaps.slice(0, 4).map((gap) => (
              <li key={gap} className="rounded-md bg-muted/40 p-3">
                {gap}
              </li>
            ))}
          </ul>
          <div className="mt-4 border-t pt-4">
            <h3 className="text-sm font-semibold">Source mix</h3>
            <div className="mt-3 grid gap-2 text-sm">
              {[
                ["KDP", sourceMix.kdp],
                ["Trends", sourceMix.trends],
                ["Library", sourceMix.library],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between">
                  <span className="text-muted-foreground">{label}</span>
                  <Badge variant={Number(value) > 0 ? "secondary" : "outline"}>{value}</Badge>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-4 border-t pt-4">
            <div className="flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Action items</h3>
            </div>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              {evidence.recommendations.slice(0, 3).map((recommendation) => (
                <li key={recommendation}>{recommendation}</li>
              ))}
            </ul>
          </div>
          {keywordCounts.length ? (
            <div className="mt-4 border-t pt-4">
              <h3 className="text-sm font-semibold">Keyword clusters</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {keywordCounts.slice(0, 8).map((item) => (
                  <Badge key={item.keyword} variant="secondary">
                    {item.keyword} · {item.count}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      </aside>

      <section className="lg:col-span-2">
        <div className="overflow-x-auto rounded-lg border bg-background">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b bg-muted/30 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Rank</th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Signal</th>
                <th className="px-3 py-2">Keywords</th>
              </tr>
            </thead>
            <tbody>
              {evidence.records.map((record) => (
                <tr key={`${record.source}-${record.rank}-${record.title}`} className="border-b">
                  <td className="px-3 py-3 font-medium">{record.rank}</td>
                  <td className="px-3 py-3">
                    <div className="font-medium">{record.title}</div>
                    <div className="text-xs text-muted-foreground">{record.author}</div>
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant="secondary">{record.source}</Badge>
                  </td>
                  <td className="max-w-sm px-3 py-3 text-muted-foreground">{record.signal}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {record.keywords.map((keyword) => (
                        <Badge key={keyword} variant="secondary">
                          {keyword}
                        </Badge>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ScoutVerdictCard({
  verdict,
  conceptBrief,
}: {
  verdict: NonNullable<ScoutResult["finding"]["evidence_json"]["verdict"]>;
  conceptBrief: NonNullable<ScoutResult["finding"]["evidence_json"]["concept_brief"]>;
}) {
  return (
    <div className="mt-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Scout verdict</h3>
        </div>
        <Badge variant={verdict.status === "ready" ? "default" : "secondary"}>
          {verdict.label}
        </Badge>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{verdict.rationale}</p>
      <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
        <BriefRow label="Audience" value={conceptBrief.audience} />
        <BriefRow label="Must prove" value={conceptBrief.must_prove} />
        <BriefRow label="Promise" value={conceptBrief.promise} />
        <BriefRow label="Differentiator" value={conceptBrief.differentiator} />
      </div>
    </div>
  );
}

function BriefRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/30 p-3">
      <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
      <p className="mt-1 text-sm">{value}</p>
    </div>
  );
}

function InsightMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold capitalize">{value}</div>
    </div>
  );
}

function countSources(records: ScoutResult["finding"]["evidence_json"]["records"]) {
  return records.reduce(
    (mix, record) => {
      mix[record.source] += 1;
      return mix;
    },
    { kdp: 0, trends: 0, library: 0 },
  );
}

function inferKeywordCounts(records: ScoutResult["finding"]["evidence_json"]["records"]) {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const keyword of record.keywords) {
      const normalized = keyword.trim().toLowerCase();
      if (normalized.length < 3) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([keyword, count]) => ({ keyword, count }));
}

function inferOpportunityScore(records: ScoutResult["finding"]["evidence_json"]["records"]) {
  return Math.max(20, Math.min(80, records.length * 5));
}

function inferConfidence(
  records: ScoutResult["finding"]["evidence_json"]["records"],
  sourceMix: { kdp: number; trends: number; library: number },
) {
  const sourceCount = coveredSourceCount(sourceMix);
  if (records.length >= 9 && sourceCount >= 3) return "high";
  if (records.length >= 5 && sourceCount >= 2) return "medium";
  return "low";
}

function coveredSourceCount(sourceMix: { kdp: number; trends: number; library: number }) {
  return [sourceMix.kdp, sourceMix.trends, sourceMix.library].filter(Boolean).length;
}

function fallbackVerdict(
  opportunityScore: number,
  confidence: "low" | "medium" | "high",
  sourceCount: number,
): NonNullable<ScoutResult["finding"]["evidence_json"]["verdict"]> {
  if (opportunityScore >= 72 && confidence !== "low") {
    return {
      status: "ready",
      label: "Ready to shape",
      rationale: "Demand is broad enough to move into concept shaping.",
    };
  }
  if (opportunityScore >= 55 || sourceCount >= 2) {
    return {
      status: "validate",
      label: "Validate the hook",
      rationale: "Signals are usable, but the hook needs a sharper proof point.",
    };
  }
  return {
    status: "reframe",
    label: "Reframe before outlining",
    rationale: "Evidence is thin, so broaden or clarify the reader promise.",
  };
}

function fallbackConceptBrief(
  niche: string,
  type: ScoutResult["query"]["type"],
): NonNullable<ScoutResult["finding"]["evidence_json"]["concept_brief"]> {
  return {
    audience: type === "fiction" ? `readers looking for ${niche}` : `readers solving ${niche}`,
    promise:
      type === "fiction"
        ? `A distinct ${niche} story promise.`
        : `A practical method for ${niche}.`,
    differentiator: "Make the promise more specific than the comparable titles.",
    must_prove: "Show why this hook deserves reader attention now.",
  };
}

function ScoutList({
  items,
  empty,
  label,
}: {
  items: string[];
  empty: string;
  label: string;
}) {
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold">{label}</h3>
      {items.length ? (
        <div className="mt-3 grid gap-3">
          {items.map((item) => (
            <div key={item} className="rounded-md border bg-muted/20 p-3 text-sm">
              {item}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

function ComparableTitleList({ result }: { result: ScoutResult }) {
  const records = result.finding.evidence_json.records.slice(0, 6);
  return (
    <div className="mt-4 grid gap-3">
      {records.map((record) => (
        <div
          key={`${record.source}-${record.rank}-${record.title}`}
          className="rounded-md border p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">{record.title}</h3>
            <Badge variant="secondary">{record.source}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{record.author}</p>
          <p className="mt-3 text-sm">{record.signal}</p>
        </div>
      ))}
    </div>
  );
}

function EmptyScoutState({ loading }: { loading: boolean }) {
  return (
    <Card className="border-dashed p-8 text-center text-muted-foreground shadow-none">
      {loading ? "Loading market reads..." : "Run Scout to see title signals and gap analysis."}
    </Card>
  );
}

function formatDate(value: string | number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
