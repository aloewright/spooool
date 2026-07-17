import { ApiError } from "../../lib/api";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

export const DRAFT_CONFLICT_MESSAGE =
  "This draft changed in another tab, so your local unsaved changes cannot be saved. Reload the latest draft before continuing.";

export class DraftConflictError extends Error {
  constructor() {
    super(DRAFT_CONFLICT_MESSAGE);
    this.name = "DraftConflictError";
  }
}

export function getDraftConflictError(error: unknown): DraftConflictError | null {
  if (error instanceof DraftConflictError) return error;
  if (error instanceof ApiError && error.status === 409) return new DraftConflictError();
  return null;
}

export function DraftConflictNotice({ onReload }: { onReload: () => void }) {
  return (
    <Alert aria-live="assertive" data-testid="draft-conflict-notice" variant="destructive">
      <AlertTitle>Draft changed in another tab</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{DRAFT_CONFLICT_MESSAGE}</p>
        <Button type="button" variant="outline" size="sm" onClick={onReload}>
          Reload latest draft
        </Button>
      </AlertDescription>
    </Alert>
  );
}
