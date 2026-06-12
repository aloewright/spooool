import { Link } from "@tanstack/react-router";
import { BookOpen, Settings } from "lucide-react";
import type { Project } from "../../lib/api";
import { Badge } from "../ui/badge";
import { BudgetMeter } from "./budget-meter";

export function TopBar({ project }: { project: Project }) {
  return (
    <header className="shrink-0 border-b bg-background">
      <div className="flex items-center justify-between px-5 py-2 text-sm">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            aria-label="Books"
            title="Books"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <BookOpen className="h-4 w-4" />
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="font-semibold">{project.title}</span>
          <Badge variant="secondary">{project.status}</Badge>
        </div>
        <div className="flex items-center gap-4">
          <BudgetMeter spentCents={0} capCents={5000} />
          <Link
            to="/account"
            aria-label="Settings"
            title="Settings"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Settings className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </header>
  );
}
