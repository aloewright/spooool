import type {
  EditorAiCommand,
  EditorAiResourceKind,
  EditorAiRevision,
  EditorAiScope,
} from "@/shared/editor-ai";
import type { BlockNoteEditor } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import {
  type DefaultReactSuggestionItem,
  FormattingToolbar,
  FormattingToolbarController,
  type FormattingToolbarProps,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  useComponentsContext,
  useEditorState,
} from "@blocknote/react";
import { Sparkles } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../../lib/api";
import { EDITOR_AI_MENU_ITEMS, flattenReplacementBlocks, needsInstructions } from "./commands";
import { EditorAiDialog } from "./editor-ai-dialog";

type ProseMirrorSelection = BlockNoteEditor["prosemirrorState"]["selection"];
type SelectionBookmark = ReturnType<ProseMirrorSelection["getBookmark"]>;
type MarkdownBlocks = NonNullable<Parameters<BlockNoteEditor["blocksToMarkdownLossy"]>[0]>;

export type CapturedRun = {
  command: EditorAiCommand;
  scope: EditorAiScope;
  targetMd: string;
  contextMd: string;
  instructions?: string;
};

export type EditorAiUiState =
  | { stage: "idle" }
  | { stage: "choose"; scope: "selection" }
  | {
      stage: "instructions";
      run: CapturedRun;
      requirement: "optional" | "required";
    }
  | { stage: "loading"; run: CapturedRun }
  | { stage: "review"; run: CapturedRun; revision: EditorAiRevision }
  | { stage: "saving"; run: CapturedRun }
  | {
      stage: "error";
      run: CapturedRun;
      message: string;
      retryAction: "command" | "save";
    };

export type BlockNoteAiCommandsProps = {
  editor: BlockNoteEditor;
  resourceKind: EditorAiResourceKind;
  resourceId: string;
  saveNow: () => Promise<unknown>;
};

type SelectionCapture = Pick<CapturedRun, "targetMd" | "contextMd">;

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "The AI command could not be completed";
}

function AiCommandsToolbarButton({
  editor,
  onStartSelection,
}: {
  editor: BlockNoteEditor;
  onStartSelection: () => void;
}) {
  const Components = useComponentsContext();
  const hasSelection = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => !currentEditor.prosemirrorState.selection.empty,
  });

  if (!Components || !hasSelection) return null;

  function handleMouseDown(event: ReactMouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    onStartSelection();
  }

  return (
    <span className="inline-flex" onMouseDownCapture={handleMouseDown}>
      <Components.FormattingToolbar.Button
        icon={<Sparkles aria-hidden="true" size={16} />}
        label="AI commands"
        mainTooltip="AI commands"
        onClick={onStartSelection}
      />
    </span>
  );
}

function AiFormattingToolbar({
  editor,
  onStartSelection,
  ...props
}: FormattingToolbarProps & {
  editor: BlockNoteEditor;
  onStartSelection: () => void;
}) {
  return (
    <FormattingToolbar {...props}>
      {getFormattingToolbarItems(props.blockTypeSelectItems)}
      <AiCommandsToolbarButton
        key="editorAiCommands"
        editor={editor}
        onStartSelection={onStartSelection}
      />
    </FormattingToolbar>
  );
}

export function BlockNoteAiCommands({
  editor,
  resourceKind,
  resourceId,
  saveNow,
}: BlockNoteAiCommandsProps) {
  const [state, setState] = useState<EditorAiUiState>({ stage: "idle" });
  const stateRef = useRef<EditorAiUiState>(state);
  const bookmarkRef = useRef<SelectionBookmark | null>(null);
  const selectionCaptureRef = useRef<SelectionCapture | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestVersionRef = useRef(0);
  const commandOpenRef = useRef(false);
  const applyStartedRef = useRef(false);
  const mountedRef = useRef(true);

  const transition = useCallback((next: EditorAiUiState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const focusEditor = useCallback(() => {
    window.requestAnimationFrame(() => editor.focus());
  }, [editor]);

  const abortPendingRequest = useCallback(() => {
    requestVersionRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const releaseEditor = useCallback(
    (focus: boolean) => {
      editor.isEditable = true;
      bookmarkRef.current = null;
      selectionCaptureRef.current = null;
      commandOpenRef.current = false;
      applyStartedRef.current = false;
      if (focus) focusEditor();
    },
    [editor, focusEditor],
  );

  const closeDialog = useCallback(() => {
    abortPendingRequest();
    releaseEditor(true);
    transition({ stage: "idle" });
  }, [abortPendingRequest, releaseEditor, transition]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestVersionRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      editor.isEditable = true;
      bookmarkRef.current = null;
      selectionCaptureRef.current = null;
      commandOpenRef.current = false;
      applyStartedRef.current = false;
    };
  }, [editor]);

  const runRequest = useCallback(
    async (run: CapturedRun) => {
      abortPendingRequest();
      const controller = new AbortController();
      abortRef.current = controller;
      const requestVersion = requestVersionRef.current;
      editor.isEditable = false;
      transition({ stage: "loading", run });

      try {
        if (!(run.command === "write" && run.scope === "document") && !run.targetMd.trim()) {
          throw new Error("Select or write some text before running this command");
        }

        const { revision } = await api.runEditorAiCommand(
          {
            resource_kind: resourceKind,
            resource_id: resourceId,
            command: run.command,
            scope: run.scope,
            target_md: run.targetMd,
            context_md: run.contextMd,
            instructions: run.instructions,
          },
          { signal: controller.signal },
        );

        if (
          controller.signal.aborted ||
          requestVersion !== requestVersionRef.current ||
          !mountedRef.current
        ) {
          return;
        }
        if (!revision.after_md.trim()) throw new Error("AI returned no usable replacement");

        transition({ stage: "review", run, revision });
      } catch (error) {
        if (
          controller.signal.aborted ||
          requestVersion !== requestVersionRef.current ||
          !mountedRef.current
        ) {
          return;
        }

        editor.isEditable = true;
        transition({
          stage: "error",
          run,
          message: messageFromError(error),
          retryAction: "command",
        });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [abortPendingRequest, editor, resourceId, resourceKind, transition],
  );

  const beginSelectionChooser = useCallback(() => {
    if (commandOpenRef.current || applyStartedRef.current) return;

    const selection = editor.prosemirrorState.selection;
    if (selection.empty) return;

    const bookmark = selection.getBookmark();
    const cut = editor.getSelectionCutBlocks();
    const capture: SelectionCapture = {
      // BlockNote 0.49 declares cut blocks against its broad base schema even
      // when the editor uses the default schema. The runtime blocks are from
      // this editor and are valid input to its serializer.
      targetMd: editor.blocksToMarkdownLossy(cut.blocks as MarkdownBlocks),
      contextMd: editor.blocksToMarkdownLossy(editor.document),
    };

    bookmarkRef.current = bookmark;
    selectionCaptureRef.current = capture;
    commandOpenRef.current = true;
    editor.isEditable = false;
    transition({ stage: "choose", scope: "selection" });
  }, [editor, transition]);

  const beginDocumentCommand = useCallback(
    (command: EditorAiCommand) => {
      if (commandOpenRef.current || applyStartedRef.current) return;

      const contextMd = editor.blocksToMarkdownLossy(editor.document);
      const run: CapturedRun = {
        command,
        scope: "document",
        targetMd: contextMd,
        contextMd,
      };
      const requirement = needsInstructions(command);

      commandOpenRef.current = true;
      editor.isEditable = false;
      if (requirement === "none") void runRequest(run);
      else transition({ stage: "instructions", run, requirement });
    },
    [editor, runRequest, transition],
  );

  const chooseSelectionCommand = useCallback(
    (command: EditorAiCommand) => {
      const capture = selectionCaptureRef.current;
      if (stateRef.current.stage !== "choose" || !capture) return;

      const run: CapturedRun = { command, scope: "selection", ...capture };
      const requirement = needsInstructions(command);
      if (requirement === "none") void runRequest(run);
      else transition({ stage: "instructions", run, requirement });
    },
    [runRequest, transition],
  );

  const submitInstructions = useCallback(
    (instructions?: string) => {
      const current = stateRef.current;
      if (current.stage !== "instructions") return;

      const trimmed = instructions?.trim();
      if (current.requirement === "required" && !trimmed) return;
      void runRequest({ ...current.run, instructions: trimmed || undefined });
    },
    [runRequest],
  );

  const retry = useCallback(() => {
    const current = stateRef.current;
    if (current.stage !== "review" && current.stage !== "error") return;

    if (current.stage === "error" && current.retryAction === "save") {
      if (applyStartedRef.current) return;
      applyStartedRef.current = true;
      editor.isEditable = false;
      transition({ stage: "saving", run: current.run });

      void (async () => {
        try {
          await saveNow();
          if (!mountedRef.current) return;
          releaseEditor(true);
          transition({ stage: "idle" });
        } catch (error) {
          if (!mountedRef.current) return;
          editor.isEditable = true;
          applyStartedRef.current = false;
          transition({
            stage: "error",
            run: current.run,
            message: `The replacement is still not saved: ${messageFromError(error)}`,
            retryAction: "save",
          });
        }
      })();
      return;
    }

    const currentContext = editor.blocksToMarkdownLossy(editor.document);
    if (currentContext !== current.run.contextMd) {
      editor.isEditable = true;
      transition({
        stage: "error",
        run: current.run,
        message:
          "The document changed after this command started. Close this dialog and try again.",
        retryAction: "command",
      });
      return;
    }
    if (current.run.scope === "selection" && !bookmarkRef.current) {
      editor.isEditable = true;
      transition({
        stage: "error",
        run: current.run,
        message: "The selected text is no longer available. Close this dialog and select it again.",
        retryAction: "command",
      });
      return;
    }

    editor.isEditable = false;
    void runRequest(current.run);
  }, [editor, releaseEditor, runRequest, saveNow, transition]);

  const applyRevision = useCallback(async () => {
    const current = stateRef.current;
    if (current.stage !== "review" || applyStartedRef.current) return;
    applyStartedRef.current = true;
    let mutated = false;

    try {
      if (editor.blocksToMarkdownLossy(editor.document) !== current.run.contextMd) {
        throw new Error("The document changed after this command started. Run the command again.");
      }

      const blocks = editor.tryParseMarkdownToBlocks(current.revision.after_md);
      if (blocks.length === 0) throw new Error("AI returned no usable blocks");

      if (current.run.scope === "selection") {
        const bookmark = bookmarkRef.current;
        if (!bookmark) throw new Error("Selected text is no longer available");
        const inlineContent = flattenReplacementBlocks(blocks);
        if (inlineContent.length === 0) throw new Error("AI returned no usable inline content");

        editor.transact((transaction) => {
          transaction.setSelection(bookmark.resolve(transaction.doc));
        });
        editor.insertInlineContent(inlineContent, { updateSelection: true });
      } else {
        editor.replaceBlocks(editor.document, blocks);
      }
      mutated = true;

      editor.isEditable = true;
      bookmarkRef.current = null;
      selectionCaptureRef.current = null;
      await saveNow();

      if (!mountedRef.current) return;
      releaseEditor(true);
      transition({ stage: "idle" });
    } catch (error) {
      if (!mountedRef.current) return;
      editor.isEditable = true;
      applyStartedRef.current = false;
      if (mutated) {
        bookmarkRef.current = null;
        selectionCaptureRef.current = null;
      }
      transition({
        stage: "error",
        run: current.run,
        message: mutated
          ? `The replacement was applied but could not be saved: ${messageFromError(error)}`
          : messageFromError(error),
        retryAction: mutated ? "save" : "command",
      });
    }
  }, [editor, releaseEditor, saveNow, transition]);

  const slashItems = useMemo<DefaultReactSuggestionItem[]>(
    () => [
      ...EDITOR_AI_MENU_ITEMS.map((item) => ({
        title: item.title,
        subtext: item.subtext,
        aliases: [...item.aliases],
        group: "AI",
        icon: item.icon,
        onItemClick: () => beginDocumentCommand(item.command),
      })),
      ...getDefaultReactSlashMenuItems(editor),
    ],
    [beginDocumentCommand, editor],
  );

  const getSlashItems = useCallback(
    async (query: string) => filterSuggestionItems(slashItems, query),
    [slashItems],
  );

  const formattingToolbar = useCallback(
    (props: FormattingToolbarProps) => (
      <AiFormattingToolbar {...props} editor={editor} onStartSelection={beginSelectionChooser} />
    ),
    [beginSelectionChooser, editor],
  );

  return (
    <>
      <SuggestionMenuController
        getItems={getSlashItems}
        shouldOpen={(suggestionState) =>
          !suggestionState.selection.$from.parent.type.isInGroup("tableContent")
        }
        triggerCharacter="/"
      />
      <FormattingToolbarController formattingToolbar={formattingToolbar} />
      <EditorAiDialog
        onApply={() => {
          void applyRevision();
        }}
        onChoose={chooseSelectionCommand}
        onReject={closeDialog}
        onRetry={retry}
        onSubmitInstructions={submitInstructions}
        state={state}
      />
    </>
  );
}
