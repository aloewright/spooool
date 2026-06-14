import { Badge } from "../ui/badge";
import type { WorkflowStatus } from "../workspace/outline-rail";

export default function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  const labels: Record<WorkflowStatus, string> = {
    "not-started": "Not started",
    "in-progress": "In progress",
    "needs-review": "Needs review",
    approved: "Approved",
  };
  const variant =
    status === "approved" ? "default" : status === "not-started" ? "secondary" : "outline";
  return <Badge variant={variant}>{labels[status]}</Badge>;
}
