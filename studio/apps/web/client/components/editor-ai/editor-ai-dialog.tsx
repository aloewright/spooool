import type { EditorAiCommand } from "@/shared/editor-ai";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import type { EditorAiUiState } from "./blocknote-ai-commands";
import { EDITOR_AI_MENU_ITEMS } from "./commands";

export type EditorAiDialogProps = {
  state: EditorAiUiState;
  onChoose: (command: EditorAiCommand) => void;
  onSubmitInstructions: (instructions?: string) => void;
  onApply: () => void;
  onReject: () => void;
  onRetry: () => void;
};

function commandTitle(command: EditorAiCommand): string {
  return EDITOR_AI_MENU_ITEMS.find((item) => item.command === command)?.title ?? command;
}

export function EditorAiDialog({
  state,
  onChoose,
  onSubmitInstructions,
  onApply,
  onReject,
  onRetry,
}: EditorAiDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const firstCommandRef = useRef<HTMLButtonElement>(null);
  const [instructions, setInstructions] = useState("");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    setApplying(false);
    if (state.stage === "instructions") setInstructions(state.run.instructions ?? "");

    const frame = window.requestAnimationFrame(() => {
      if (state.stage === "choose") firstCommandRef.current?.focus();
      else if (state.stage === "instructions") instructionsRef.current?.focus();
      else dialogRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [state]);

  if (state.stage === "idle") return null;

  const title =
    state.stage === "choose"
      ? "AI commands"
      : state.stage === "instructions"
        ? `${commandTitle(state.run.command)} with AI`
        : state.stage === "loading"
          ? "Working"
          : state.stage === "review"
            ? "Ready to review"
            : state.stage === "saving"
              ? "Saving replacement"
              : state.retryAction === "save"
                ? "Replacement not saved"
                : "AI command failed";

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape" && !applying && state.stage !== "saving") {
      event.preventDefault();
      event.stopPropagation();
      onReject();
      return;
    }

    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable.at(-1);
    const activeElement = document.activeElement as HTMLElement | null;
    if (!activeElement || !focusable.includes(activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    } else if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function submitInstructions() {
    const trimmed = instructions.trim();
    if (state.stage !== "instructions") return;
    if (state.requirement === "required" && !trimmed) return;
    onSubmitInstructions(trimmed || undefined);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <dialog
        ref={dialogRef}
        aria-busy={state.stage === "loading" || state.stage === "saving" || applying}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative max-h-[min(48rem,calc(100vh-2rem))] w-full max-w-4xl overflow-y-auto rounded-xl border border-border bg-background p-5 text-foreground shadow-2xl"
        onCancel={(event) => {
          event.preventDefault();
          if (!applying && state.stage !== "saving") onReject();
        }}
        onKeyDown={handleKeyDown}
        open
        tabIndex={-1}
      >
        <h2 className="font-serif text-xl tracking-tight" id={titleId}>
          {title}
        </h2>

        {state.stage === "choose" && (
          <div className="mt-4 grid gap-2" id={descriptionId}>
            <p className="mb-1 text-muted-foreground text-sm">
              Choose how AI should work with the selected text.
            </p>
            {EDITOR_AI_MENU_ITEMS.map((item, index) => (
              <Button
                key={item.command}
                ref={index === 0 ? firstCommandRef : undefined}
                aria-label={item.title}
                className="h-auto justify-start whitespace-normal px-4 py-3 text-left"
                onClick={() => onChoose(item.command)}
                type="button"
                variant="outline"
              >
                {item.icon}
                <span>
                  <span className="block font-medium">{item.title}</span>
                  <span className="block text-muted-foreground text-xs">{item.subtext}</span>
                </span>
              </Button>
            ))}
            <div className="mt-2 flex justify-end">
              <Button onClick={onReject} type="button" variant="ghost">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {state.stage === "instructions" && (
          <form
            className="mt-4 space-y-4"
            id={descriptionId}
            onSubmit={(event) => {
              event.preventDefault();
              submitInstructions();
            }}
          >
            <div className="space-y-2">
              <label className="font-medium text-sm" htmlFor="editor-ai-instructions">
                Instructions
              </label>
              <Textarea
                ref={instructionsRef}
                aria-describedby="editor-ai-instructions-help"
                id="editor-ai-instructions"
                onChange={(event) => setInstructions(event.target.value)}
                placeholder={
                  state.requirement === "required"
                    ? "Describe how the text should be rewritten"
                    : "Add any details the draft should cover"
                }
                required={state.requirement === "required"}
                rows={5}
                value={instructions}
              />
              <p className="text-muted-foreground text-xs" id="editor-ai-instructions-help">
                {state.requirement === "required"
                  ? "Instructions are required for Rewrite."
                  : "Instructions are optional for Write."}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button onClick={onReject} type="button" variant="outline">
                Cancel
              </Button>
              <Button
                disabled={state.requirement === "required" && !instructions.trim()}
                type="submit"
              >
                Generate
              </Button>
            </div>
          </form>
        )}

        {state.stage === "loading" && (
          <div className="mt-4 space-y-4" id={descriptionId}>
            <Alert aria-live="polite">
              <AlertTitle>Working</AlertTitle>
              <AlertDescription>
                {commandTitle(state.run.command)} is preparing a replacement for review.
              </AlertDescription>
            </Alert>
            <div className="flex justify-end">
              <Button onClick={onReject} type="button" variant="outline">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {state.stage === "review" && (
          <div className="mt-4 space-y-4" id={descriptionId}>
            {state.run.command === "cite" && (
              <Alert>
                <AlertTitle>Review suggested sources</AlertTitle>
                <AlertDescription>
                  Sources are AI-generated suggestions. Confirm that each source supports its
                  associated claim before applying this revision.
                </AlertDescription>
              </Alert>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <section aria-labelledby={`${titleId}-before`}>
                <h3 className="mb-2 font-medium text-sm" id={`${titleId}-before`}>
                  Before
                </h3>
                <pre className="max-h-80 min-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted p-3 font-mono text-sm">
                  {state.revision.before_md}
                </pre>
              </section>
              <section aria-labelledby={`${titleId}-after`}>
                <h3 className="mb-2 font-medium text-sm" id={`${titleId}-after`}>
                  After
                </h3>
                <pre className="max-h-80 min-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted p-3 font-mono text-sm">
                  {state.revision.after_md}
                </pre>
              </section>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={applying} onClick={onRetry} type="button" variant="outline">
                Retry
              </Button>
              <Button disabled={applying} onClick={onReject} type="button" variant="secondary">
                Reject
              </Button>
              <Button
                disabled={applying}
                onClick={() => {
                  setApplying(true);
                  onApply();
                }}
                type="button"
              >
                {applying ? "Saving…" : "Apply"}
              </Button>
            </div>
          </div>
        )}

        {state.stage === "saving" && (
          <div className="mt-4 space-y-4" id={descriptionId}>
            <Alert aria-live="polite">
              <AlertTitle>Saving replacement</AlertTitle>
              <AlertDescription>
                The accepted replacement is being saved without running the AI command again.
              </AlertDescription>
            </Alert>
          </div>
        )}

        {state.stage === "error" && (
          <div className="mt-4 space-y-4" id={descriptionId}>
            <Alert variant="destructive">
              <AlertTitle>
                {state.retryAction === "save"
                  ? "Replacement is not saved yet"
                  : "AI command could not finish"}
              </AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
            <div className="flex justify-end gap-2">
              <Button onClick={onRetry} type="button" variant="outline">
                {state.retryAction === "save" ? "Retry save" : "Retry"}
              </Button>
              <Button onClick={onReject} type="button">
                Close
              </Button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}
