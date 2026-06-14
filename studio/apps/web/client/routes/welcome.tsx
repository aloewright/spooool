import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  Boxes,
  CheckCircle2,
  FileText,
  Mic2,
  PackageCheck,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "../components/ui/button";

export const Route = createFileRoute("/welcome")({ component: Landing });

function Landing() {
  const nav = useNavigate();

  return (
    <div className="bg-background text-foreground">
      <section className="relative isolate overflow-hidden border-b">
        <div className="mx-auto grid max-w-6xl gap-12 px-6 py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:py-24">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-md border bg-background/85 px-3 py-1 text-sm text-muted-foreground backdrop-blur">
              <Sparkles className="h-4 w-4" />
              From market signal to finished manuscript
            </div>
            <h1 className="text-5xl font-bold leading-[1.04] md:text-7xl">Book Cook</h1>
            <p className="mt-6 text-xl leading-8 text-muted-foreground">
              Plan, draft, edit, and package a book in one focused workspace, with Scout research,
              structured outlines, chapter drafting, full-book review, and export tools built in.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <Button size="lg" onClick={() => nav({ to: "/sign-up" })}>
                Start a book
              </Button>
              <Button size="lg" variant="outline" onClick={() => nav({ to: "/sign-in" })}>
                Sign in
              </Button>
            </div>
          </div>
          <ProductScene />
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-8 px-6 py-14 lg:grid-cols-[0.85fr_1.15fr]">
        <div>
          <p className="text-sm font-semibold uppercase text-muted-foreground">Workflow</p>
          <h2 className="mt-3 text-3xl font-semibold">
            Move chapter by chapter without losing the book.
          </h2>
          <p className="mt-4 text-muted-foreground">
            Book Cook keeps the promise, market evidence, outline decisions, manuscript, and launch
            assets connected, so each step carries useful context into the next.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="rounded-lg border bg-card p-4 text-card-foreground">
              <feature.icon className="h-5 w-5 text-muted-foreground" />
              <h3 className="mt-3 font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t bg-muted/25">
        <div className="mx-auto grid max-w-6xl gap-6 px-6 py-14 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <div key={step.title} className="rounded-lg border bg-background p-5">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                {index + 1}
              </div>
              <h3 className="mt-4 font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{step.description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const FEATURES = [
  {
    title: "Scout evidence",
    description: "Test a niche, target reader, and promise before committing to an outline.",
    icon: Search,
  },
  {
    title: "Voice library",
    description: "Create or import reusable author voices that guide outline and draft generation.",
    icon: Mic2,
  },
  {
    title: "Outline builder",
    description:
      "Use fiction, thriller, nonfiction, sci-fi, and beat-based frameworks to shape the book.",
    icon: Boxes,
  },
  {
    title: "Chapter drafting",
    description:
      "Draft sections additively, redraft with direction, and accept text into the chapter.",
    icon: FileText,
  },
  {
    title: "Full-book view",
    description:
      "Review the assembled manuscript, jump back into chapter edits, and export finished work.",
    icon: BookOpen,
  },
  {
    title: "Publisher handoff",
    description: "Generate metadata, launch assets, PDF, EPUB, and audio-ready packaging support.",
    icon: PackageCheck,
  },
] as const;

const STEPS = [
  {
    title: "Validate the promise",
    description:
      "Run Scout, sharpen the reader promise, and collect the evidence that should guide the book.",
  },
  {
    title: "Build the manuscript",
    description:
      "Choose a framework, decide chapter turns, draft sections, and keep the full book in view.",
  },
  {
    title: "Prepare to publish",
    description:
      "Review the full manuscript, export files, and build publisher-ready handoff materials.",
  },
] as const;

function ProductScene() {
  return (
    <div className="pointer-events-none w-full">
      <div className="h-[460px] overflow-hidden rounded-lg border bg-card shadow-xl md:h-[520px]">
        <div className="flex h-12 items-center gap-2 border-b px-4">
          <BookOpen className="h-5 w-5" />
          <span className="font-semibold">Book Cook</span>
          <span className="rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground">
            outline
          </span>
        </div>
        <div className="grid h-[calc(100%-3rem)] grid-cols-[140px_1fr_180px] md:grid-cols-[160px_1fr_200px]">
          <div className="border-r p-3">
            {["Concept", "Voice", "Outline", "Chapters", "Book", "Publish"].map((item, index) => (
              <div
                key={item}
                className={`mb-1.5 flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs ${
                  index === 2 ? "bg-primary text-primary-foreground" : "bg-muted/45"
                }`}
              >
                <span>{item}</span>
                {index < 3 ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
              </div>
            ))}
          </div>
          <div className="space-y-3 p-4">
            <div className="h-6 w-44 rounded-md bg-foreground/15" />
            <div className="grid gap-2 md:grid-cols-2">
              <div className="rounded-lg border bg-background p-3">
                <div className="h-3 w-20 rounded bg-foreground/15" />
                <div className="mt-3 h-16 rounded bg-muted" />
              </div>
              <div className="rounded-lg border bg-background p-3">
                <div className="h-3 w-24 rounded bg-foreground/15" />
                <div className="mt-3 space-y-1.5">
                  <div className="h-6 rounded bg-muted" />
                  <div className="h-6 rounded bg-muted" />
                  <div className="h-6 rounded bg-muted" />
                </div>
              </div>
            </div>
            <div className="grid gap-2">
              {[1, 2].map((item) => (
                <div key={item} className="rounded-lg border bg-background p-3">
                  <div className="h-3 w-32 rounded bg-foreground/15" />
                  <div className="mt-2 h-7 rounded bg-muted" />
                </div>
              ))}
            </div>
          </div>
          <div className="border-l p-3">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                EA
              </span>
              <div>
                <div className="h-2.5 w-20 rounded bg-foreground/20" />
                <div className="mt-1.5 h-2 w-14 rounded bg-muted-foreground/25" />
              </div>
            </div>
            <div className="mt-6 space-y-2">
              <div className="h-12 rounded-lg bg-muted" />
              <div className="ml-auto h-9 w-28 rounded-lg bg-primary/80" />
              <div className="h-16 rounded-lg bg-muted" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
