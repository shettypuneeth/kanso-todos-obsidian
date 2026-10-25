import {
  type App,
  FuzzySuggestModal,
  MarkdownView,
  Plugin,
  Scope,
  TFile,
  type MarkdownPostProcessorContext,
} from "obsidian";
import type { BlockTarget } from "./core/block";
import type { InputKeys } from "./core/keys";
import { readTodos, type TodoReference } from "./todos/model";
import { locateTodoBlock, locateTodoEntry, mutateTodoNote, type TodoMutation } from "./todos/persistence";
import {
  createTodoWidgetState,
  TodosWidget,
  type TodoWidgetHost,
  type TodoWidgetState,
} from "./todos/widget";

interface TodoBinding {
  path: string;
  target: BlockTarget;
  state: TodoWidgetState;
  paneStates: Map<string, TodoWidgetState>;
  widget?: TodosWidget;
}

export default class KansoTodosPlugin extends Plugin {
  private todoBindings = new Set<TodoBinding>();
  private todoPaneStates = new WeakMap<HTMLElement, Map<string, TodoWidgetState>>();
  private writes = new Map<string, Promise<unknown>>();
  private stopped = false;
  private refreshTimer?: number;
  private dirtyPaths = new Set<string>();
  private taskNavigation = 0;

  onload(): void {
    this.registerMarkdownCodeBlockProcessor("kanso-todos", (source, element, context) => {
      if (!this.stopped) this.attachTodos(source, element, context);
    });

    this.addCommand({
      id: "insert-todos",
      name: "Insert todos widget",
      editorCallback: editor => {
        const cursor = editor.getCursor();
        const before = editor.getLine(cursor.line).slice(0, cursor.ch);
        const after = editor.getLine(cursor.line).slice(cursor.ch);
        const prefix = before.length ? "\n\n" : "";
        const suffix = after.length ? "\n\n" : "\n";

        editor.replaceRange(`${prefix}\`\`\`kanso-todos\n\`\`\`${suffix}`, cursor);
        editor.setCursor({ line: cursor.line + (prefix ? 2 : 0), ch: 0 });
      },
    });

    this.registerEvent(this.app.vault.on("modify", file => this.scheduleRefresh(file.path)));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info.file) this.scheduleRefresh(info.file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      for (const binding of this.todoBindings) {
        if (binding.path !== oldPath) continue;

        const oldKey = this.stateKey(binding.path, binding.target);
        binding.path = file.path;
        const newKey = this.stateKey(binding.path, binding.target);
        binding.paneStates.set(newKey, binding.state);
        if (oldKey !== newKey) binding.paneStates.delete(oldKey);
      }
      this.scheduleRefresh(file.path);
    }));
    this.registerEvent(this.app.vault.on("delete", file => this.scheduleRefresh(file.path)));

    this.register(() => {
      this.stopped = true;
      if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
      this.dirtyPaths.clear();
      this.todoBindings.clear();
    });
  }

  private attachTodos(source: string, element: HTMLElement, context: MarkdownPostProcessorContext): void {
    const info = context.getSectionInfo(element);
    let id: string | undefined;
    try {
      id = readTodos(source).data.id;
    } catch {
      // The widget renders the schema diagnostic without attempting a write.
    }

    const target: BlockTarget = { id, line: info?.lineStart ?? -1, source };
    const pane = element.closest<HTMLElement>(".workspace-leaf") ?? element.ownerDocument.body;
    let states = this.todoPaneStates.get(pane);
    if (!states) {
      states = new Map();
      this.todoPaneStates.set(pane, states);
    }
    const key = this.stateKey(context.sourcePath, target);
    let state = states.get(key);
    if (!state) {
      state = createTodoWidgetState();
      states.set(key, state);
    }

    const binding: TodoBinding = { path: context.sourcePath, target, state, paneStates: states };
    const host: TodoWidgetHost = {
      state,
      read: async () => {
        const text = await this.readNote(binding.path);
        const fence = locateTodoBlock(text, target);
        target.line = fence.line;
        target.source = fence.source;
        return fence.source;
      },
      save: mutation => this.saveBlock(binding, mutation),
      activateKeys: actions => this.activateInputKeys(actions),
      whenReady: callback => this.app.workspace.onLayoutReady(callback),
      pickNote: () => new Promise(resolve => new NoteSuggestModal(this.app, resolve).open()),
      openNote: async link => {
        const file = this.app.metadataCache.getFirstLinkpathDest(link, binding.path);
        if (!file) throw new Error(`Could not find the source note: ${link}`);
        await this.app.workspace.getLeaf(false).openFile(file);
      },
      openTask: reference => this.openTodoReference(reference),
      mounted: widget => {
        binding.widget = widget;
        this.todoBindings.add(binding);
      },
      unmounted: () => {
        this.todoBindings.delete(binding);
        binding.widget = undefined;
        window.setTimeout(() => {
          if (![...this.todoBindings].some(item => item.state === state)) {
            for (const [stateKey, value] of states) {
              if (value === state) states.delete(stateKey);
            }
          }
        }, 1000);
      },
    };
    context.addChild(new TodosWidget(element, source, host));
  }

  private async openTodoReference(reference: TodoReference): Promise<void> {
    const navigation = ++this.taskNavigation;
    const file = this.app.vault.getAbstractFileByPath(reference.note);
    if (!(file instanceof TFile)) throw new Error(`Could not find the linked note: ${reference.note}`);
    const target = locateTodoEntry(await this.readNote(file.path), reference);
    if (this.stopped || navigation !== this.taskNavigation) return;

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { eState: { line: target.line } });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (this.stopped || navigation !== this.taskNavigation) return;
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== file.path) return;
      const binding = [...this.todoBindings].find(binding =>
        binding.path === file.path && binding.target.id === reference.block_id &&
        binding.widget && view.containerEl.contains(binding.widget.containerEl) &&
        binding.widget.containerEl.getClientRects().length > 0);
      const widget = binding?.widget;
      if (widget) {
        await widget.refresh();
        if (this.stopped || navigation !== this.taskNavigation || leaf.view !== view ||
          view.file?.path !== file.path) return;
        if (widget.revealTodo(reference.todo_id)) return;
      }
      if (view.getMode() === "source" && (view.getState().source || attempt === 39)) {
        view.editor.setCursor({ line: target.line, ch: 0 });
        view.editor.scrollIntoView({
          from: { line: target.line, ch: 0 },
          to: { line: target.line, ch: 0 },
        }, true);
        return;
      }
      await new Promise(resolve => window.setTimeout(resolve, 50));
    }
    throw new Error("Could not reveal the linked task. Reopen the note and try again.");
  }

  private activateInputKeys(actions: InputKeys): () => void {
    const scope = new Scope(this.app.scope);
    const save = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      actions.save();
      return false;
    };
    scope.register(actions.modified ? ["Mod"] : [], "Enter", save);
    if (actions.modified) scope.register(["Ctrl"], "Enter", save);
    scope.register([], "Escape", event => {
      if (event.isComposing) return;
      actions.cancel();
      return false;
    });
    this.app.keymap.pushScope(scope);
    let released = false;
    return () => {
      if (!released) this.app.keymap.popScope(scope);
      released = true;
    };
  }

  private stateKey(path: string, target: BlockTarget): string {
    return `${path}\0${target.id ?? `line:${target.line}`}`;
  }

  private editors(path: string) {
    const views = this.app.workspace.getLeavesOfType("markdown")
      .map(leaf => leaf.view)
      .filter((view): view is MarkdownView =>
        view instanceof MarkdownView && view.file?.path === path && view.getMode() === "source");
    const editors = views.map(view => view.editor);
    const value = editors[0]?.getValue();
    if (editors.some(editor => editor.getValue() !== value)) {
      throw new Error("Open editors disagree about this note. Save or reconcile them before changing a widget.");
    }
    return editors;
  }

  private file(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("The source note no longer exists.");
    return file;
  }

  private async readNote(path: string): Promise<string> {
    const editor = this.editors(path)[0];
    return editor ? editor.getValue() : this.app.vault.read(this.file(path));
  }

  private saveBlock(binding: TodoBinding, mutation: TodoMutation): Promise<string> {
    const previous = this.writes.get(binding.path) ?? Promise.resolve();
    const run = async () => {
      if (this.stopped) throw new Error("Kanso Todos was unloaded. The change was not saved.");
      let result: ReturnType<typeof mutateTodoNote> | undefined;
      const apply = (text: string) => {
        result = mutateTodoNote(text, binding.target, mutation);
        return result.text;
      };
      const editors = this.editors(binding.path);
      if (editors.length) {
        apply(editors[0]!.getValue());
        const update = result!;
        this.promote(binding, update.blockId);
        for (const editor of editors) {
          // Some panes share an editor buffer; apply the patch only once.
          if (editor.getValue() === update.text) continue;
          editor.replaceRange(update.source, editor.offsetToPos(update.start), editor.offsetToPos(update.end));
        }
      } else {
        await this.app.vault.process(this.file(binding.path), apply);
        this.promote(binding, result!.blockId);
      }
      binding.target.source = result!.source;
      this.scheduleRefresh(binding.path);
      return result!.source;
    };
    const next = previous.then(run, run);
    this.writes.set(binding.path, next);
    const release = () => {
      if (this.writes.get(binding.path) === next) this.writes.delete(binding.path);
    };
    void next.then(release, release);
    return next;
  }

  private promote(binding: TodoBinding, id: string): void {
    const oldKey = this.stateKey(binding.path, binding.target);
    binding.target.id = id;
    const newKey = this.stateKey(binding.path, binding.target);
    binding.paneStates.set(newKey, binding.state);
    if (oldKey !== newKey) binding.paneStates.delete(oldKey);
  }

  private scheduleRefresh(path: string): void {
    if (this.stopped) return;
    this.dirtyPaths.add(path);
    if (this.refreshTimer !== undefined) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      const paths = new Set(this.dirtyPaths);
      this.dirtyPaths.clear();
      for (const binding of this.todoBindings) {
        if (paths.has(binding.path)) void binding.widget?.refresh();
      }
    }, 40);
  }
}

class NoteSuggestModal extends FuzzySuggestModal<TFile> {
  private chosen = false;

  constructor(app: App, private readonly resolve: (note: string | null) => void) {
    super(app);
    this.setPlaceholder("Link a source note…");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path.replace(/\.md$/i, "");
  }

  onChooseItem(file: TFile): void {
    this.chosen = true;
    this.resolve(this.getItemText(file));
  }

  onClose(): void {
    window.setTimeout(() => {
      if (!this.chosen) this.resolve(null);
    }, 0);
  }
}
