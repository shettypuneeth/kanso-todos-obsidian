import { MarkdownRenderChild, Menu, setIcon } from "obsidian";
import { accessibleLabel, button, element } from "../core/dom";
import { errorMessage } from "../core/errors";
import type { InputKeys } from "../core/keys";
import {
  dueDateDisplay,
  newTodoId,
  parseLocalDate,
  readTodos,
  type Todo,
  type TodoCollection,
  type TodoPriority,
  type TodoReference,
} from "./model";
import {
  type TodoEditableFields,
  TodoConflictError,
  type TodoMutation,
  todoFields,
} from "./persistence";

const nextPriority: Record<TodoPriority, TodoPriority> = {
  P0: "P1",
  P1: "P2",
  P2: "P0",
};

const completionFadeDuration = 220;
const completionDuration = completionFadeDuration + 260;

interface TodoCompletion {
  status: Todo["status"];
  startedAt?: number;
}

export interface TodoDraft {
  key: string;
  value: TodoEditableFields;
  expected: TodoEditableFields;
  error?: string;
}

export interface TodoWidgetState {
  collapsed: boolean;
  completedExpanded: boolean;
  capture: boolean;
  captureValue: TodoEditableFields;
  captureError?: string;
  draft?: TodoDraft;
  error?: string;
  busy: boolean;
  completing: Map<string, TodoCompletion>;
  completionListeners: Set<() => void>;
  focus?: { key: string; start: number | null; end: number | null };
}

export function createTodoWidgetState(): TodoWidgetState {
  return {
    collapsed: false,
    completedExpanded: false,
    capture: false,
    captureValue: emptyTodo(),
    busy: false,
    completing: new Map(),
    completionListeners: new Set(),
  };
}

function emptyTodo(): TodoEditableFields {
  return { title: "", status: "todo", priority: "", dueDate: "", sourceNote: "" };
}

function localDate(offsetDays: number, now = new Date()): string {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function noteName(link: string): string {
  const path = link.replace(/^\[\[|\]\]$/g, "").replace(/\|.*$/, "");
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

interface TodoFormOptions {
  value: TodoEditableFields;
  mode: "add" | "edit";
  focus: (part: "title" | "priority" | "due" | "note") => string;
  error?: string;
  onEdit: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export interface TodoWidgetHost {
  state: TodoWidgetState;
  read: () => Promise<string>;
  save: (mutation: TodoMutation) => Promise<string>;
  activateKeys: (actions: InputKeys) => () => void;
  whenReady: (callback: () => void) => void;
  pickNote: () => Promise<string | null>;
  openNote: (link: string) => Promise<void>;
  openTask: (reference: TodoReference) => Promise<void>;
  mounted: (widget: TodosWidget) => void;
  unmounted: (widget: TodosWidget) => void;
}

export class TodosWidget extends MarkdownRenderChild {
  private source: string;
  private data?: TodoCollection;
  private parsedSource?: string;
  private validRender = false;
  private alive = false;
  private revision = 0;
  private root: HTMLElement;
  private menu?: Menu;
  private rendering = false;
  private releaseKeys?: () => void;
  private captureSubmitting = false;
  private completionAnimations = new Map<Animation, number>();
  private readonly completionSettled = () => { void this.refresh(); };

  constructor(container: HTMLElement, source: string, private readonly host: TodoWidgetHost, initialData?: TodoCollection) {
    super(container);
    this.source = source;
    this.root = container;
    this.data = initialData;
    if (initialData) this.parsedSource = source;
  }

  onload(): void {
    this.alive = true;
    this.root.classList.add("kanso-widget", "kanso-todos");
    this.root.setAttribute("role", "group");
    this.host.mounted(this);
    this.host.state.completionListeners.add(this.completionSettled);

    this.registerDomEvent(this.root, "focusin", event => {
      const node = event.target as HTMLElement | null;
      if (node?.instanceOf(HTMLElement) && node.dataset.focus) {
        this.host.state.focus = { key: node.dataset.focus, start: null, end: null };
      }
    });

    this.registerDomEvent(this.root, "focusout", event => {
      const next = event.relatedTarget as HTMLElement | null;
      if (next?.instanceOf(HTMLElement) && !this.root.contains(next)) this.host.state.focus = undefined;
    });

    this.render();
    this.host.whenReady(() => {
      if (!this.alive) return;
      void this.refresh(true);
    });
  }

  onunload(): void {
    this.rememberFocus();
    this.menu?.hide();
    this.releaseKeys?.();
    this.alive = false;
    this.host.state.completionListeners.delete(this.completionSettled);
    this.stopCompletionAnimations();
    this.host.unmounted(this);
  }

  async refresh(preserveValidRender = false): Promise<void> {
    const revision = ++this.revision;

    try {
      const source = await this.host.read();
      if (!this.alive || revision !== this.revision) return;
      if (preserveValidRender && this.validRender && source === this.source) return;
      this.source = source;
      this.render();
    } catch (error) {
      if (!this.alive || revision !== this.revision || preserveValidRender) return;
      this.renderError(errorMessage(error));
    }
  }

  revealTodo(id: string): boolean {
    const todo = this.data?.todos.find(todo => todo.id === id);
    if (!this.alive || !todo) return false;
    const state = this.host.state;
    state.collapsed = false;
    if (todo.status === "completed") state.completedExpanded = true;
    this.render();
    const row = [...this.root.querySelectorAll<HTMLElement>("[data-todo]")]
      .find(row => row.dataset.todo === id);
    if (!row) return false;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "center" });
    return true;
  }

  private rememberFocus(): boolean {
    const active = this.root.ownerDocument.activeElement;
    if (!active?.instanceOf(HTMLElement) || !this.root.contains(active) || !active.dataset.focus) return false;

    const input = active.instanceOf(HTMLInputElement) || active.instanceOf(HTMLTextAreaElement);
    this.host.state.focus = {
      key: active.dataset.focus,
      start: input ? active.selectionStart : null,
      end: input ? active.selectionEnd : null,
    };
    return true;
  }

  private focus(key: string, start: number | null = null, end: number | null = null): void {
    let target = [...this.root.querySelectorAll<HTMLElement>("[data-focus]")]
      .find(node => node.dataset.focus === key);
    const exiting = target?.closest(".is-completing");
    if (exiting) {
      const rows = [...this.root.querySelectorAll<HTMLElement>(".kanso-todo-row")];
      const index = rows.indexOf(exiting as HTMLElement);
      const next = [...rows.slice(index + 1), ...rows.slice(0, index).reverse()]
        .find(row => !row.classList.contains("is-completing"));
      target = next?.querySelector<HTMLElement>(".kanso-todo-checkbox")
        ?? this.root.querySelector<HTMLElement>('[data-focus="completed-toggle"], [data-focus="add"]')
        ?? undefined;
      if (target?.instanceOf(HTMLInputElement) && target.disabled) target = next;
      if (target?.instanceOf(HTMLButtonElement) && target.disabled) {
        target = this.root.querySelector<HTMLElement>('[data-focus="collapse"]') ?? undefined;
      }
    }
    target?.focus({ preventScroll: true });

    if ((target?.instanceOf(HTMLInputElement) || target?.instanceOf(HTMLTextAreaElement)) && start !== null) {
      target.setSelectionRange(start, end ?? start);
    }
  }

  private renderError(message: string): void {
    this.validRender = false;
    this.stopCompletionAnimations();
    this.rendering = true;
    this.releaseKeys?.();
    this.root.replaceChildren();
    const error = element(this.root, "div", "kanso-block-error", `${message} Open Source mode to inspect the block.`);
    error.setAttribute("role", "alert");
    this.rendering = false;
  }

  private message(parent: HTMLElement, text: string): HTMLElement {
    const message = element(parent, "div", "kanso-message", text);
    message.setAttribute("role", "status");
    return message;
  }

  private render(revealMain = false, revealCompleted = false): void {
    if (!this.alive) return;

    const hadFocus = this.rememberFocus();
    this.stopCompletionAnimations();

    try {
      if (!this.data || this.parsedSource !== this.source) {
        this.data = readTodos(this.source).data;
        this.parsedSource = this.source;
      }
    } catch (error) {
      this.renderError(errorMessage(error));
      return;
    }
    this.validRender = true;

    const state = this.host.state;
    for (const [id, completion] of state.completing) {
      const todo = this.data.todos.find(todo => todo.id === id);
      if (!todo || todo.rollover?.next
        || (completion.startedAt !== undefined && (todo.status !== "completed"
          || Date.now() - completion.startedAt >= completionDuration))
        || !this.canAnimateCompletion()) {
        state.completing.delete(id);
      }
    }
    const active = this.data.todos.filter(todo => todo.status !== "completed" || state.completing.has(todo.id!));
    const completed = this.data.todos.filter(todo => todo.status === "completed" && !state.completing.has(todo.id!));
    const title = this.data.title?.trim() || "Tasks";

    this.rendering = true;
    this.releaseKeys?.();
    this.root.replaceChildren();
    this.root.classList.toggle("is-collapsed", state.collapsed);

    const header = element(this.root, "div", "kanso-todo-header");
    const heading = element(header, "div", "kanso-todo-heading");
    const actions = element(header, "div", "kanso-todo-header-actions");
    const collapse = button(
      actions,
      state.collapsed ? `Expand ${title}` : `Collapse ${title}`,
      state.collapsed ? "chevron-right" : "chevron-down",
      "kanso-todo-collapse",
    );

    collapse.dataset.focus = "collapse";
    collapse.setAttribute("aria-expanded", String(!state.collapsed));
    const toggleCollapsed = () => {
      const reveal = state.collapsed;
      state.collapsed = !state.collapsed;
      this.render(reveal);
      this.focus("collapse");
    };
    collapse.addEventListener("click", toggleCollapsed);

    header.addEventListener("click", event => {
      if (!state.collapsed || collapse.contains(event.target as Node | null)) return;
      toggleCollapsed();
    });

    const headingCopy = element(heading, "span", "kanso-todo-heading-copy");
    const headingLabel = element(headingCopy, "span", "kanso-todo-heading-label", title);
    headingLabel.id = `kanso-todo-heading-${crypto.randomUUID()}`;
    this.root.setAttribute("aria-labelledby", headingLabel.id);
    element(headingCopy, "span", "kanso-todo-count", String(this.data.todos.filter(todo => todo.status !== "completed").length));

    if (state.collapsed) {
      if (hadFocus && state.focus) this.focus(state.focus.key, state.focus.start, state.focus.end);
      this.rendering = false;
      return;
    }

    const add = button(
      actions,
      state.capture ? "Close task creator" : "Add a task",
      state.capture ? "x" : "plus",
      "kanso-icon-button kanso-todo-add",
    );
    actions.insertBefore(add, collapse);
    add.dataset.focus = "add";
    add.disabled = state.busy;
    add.addEventListener("click", () => {
      if (state.capture) {
        this.closeCapture();
        return;
      }

      state.capture = true;
      state.captureError = undefined;
      this.render();
      this.focus("capture");
    });

    if (state.error) this.message(this.root, state.error);
    if (state.capture) this.renderCapture();

    if (!active.length && !state.capture) {
      if (completed.length) {
        element(this.root, "div", "kanso-todo-all-done", "All done");
      } else {
        const empty = button(this.root, "Add your first task", undefined, "kanso-empty");
        empty.addEventListener("click", () => add.click());
      }
    }

    const list = element(this.root, "div", `kanso-todo-list${revealMain ? " kanso-todo-list-reveal" : ""}`);
    active.forEach((todo, index) => this.renderTodo(list, todo, index));

    if (completed.length) {
      const completedToggle = button(
        this.root,
        state.completedExpanded ? "Hide completed tasks" : "Show completed tasks",
        null,
        "kanso-completed-toggle",
      );
      completedToggle.dataset.focus = "completed-toggle";
      completedToggle.setAttribute("aria-expanded", String(state.completedExpanded));
      element(completedToggle, "span", "kanso-completed-count", String(completed.length));
      element(completedToggle, "span", "kanso-completed-label", "Completed Tasks");
      setIcon(element(completedToggle, "span", "kanso-completed-chevron"), state.completedExpanded ? "chevron-down" : "chevron-right");

      completedToggle.addEventListener("click", () => {
        state.completedExpanded = !state.completedExpanded;
        this.render(false, state.completedExpanded);
        this.focus("completed-toggle");
      });

      if (state.completedExpanded) {
        const completedList = element(
          this.root,
          "div",
          `kanso-todo-list kanso-completed-list${revealCompleted ? " kanso-todo-list-reveal" : ""}`,
        );
        completed.forEach((todo, index) => this.renderTodo(completedList, todo, index));
      }
    }

    if (hadFocus && state.focus) this.focus(state.focus.key, state.focus.start, state.focus.end);
    this.rendering = false;
    this.animateCompletions();
  }

  private canAnimateCompletion(): boolean {
    return typeof this.root.animate === "function"
      && !this.root.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  private stopCompletionAnimations(): void {
    for (const [animation, timer] of this.completionAnimations) {
      window.clearTimeout(timer);
      animation.onfinish = animation.oncancel = null;
      animation.cancel();
    }
    this.completionAnimations.clear();
  }

  private animateCompletions(): void {
    for (const row of this.root.querySelectorAll<HTMLElement>(".is-completing")) {
      const id = row.dataset.todo!;
      const completion = this.host.state.completing.get(id);
      if (completion?.startedAt === undefined) continue;

      const elapsed = Math.max(0, Date.now() - completion.startedAt);
      const view = this.root.ownerDocument.defaultView!;
      const css = view.getComputedStyle(row);
      const gap = row.parentElement!.children.length > 1
        ? parseFloat(view.getComputedStyle(row.parentElement!).rowGap) || 0 : 0;
      const size = { height: `${row.getBoundingClientRect().height}px`, paddingTop: css.paddingTop, paddingBottom: css.paddingBottom, marginBottom: "0px" };
      const animation = row.animate([
        { ...size, opacity: css.opacity, transform: "translateY(0)", offset: 0, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        { ...size, opacity: 0, transform: "translateY(-6px)", offset: completionFadeDuration / completionDuration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        { height: "0px", paddingTop: "0px", paddingBottom: "0px", marginBottom: `${-gap}px`, opacity: 0, transform: "translateY(-6px)", offset: 1 },
      ], { duration: completionDuration, fill: "both", easing: "linear" });
      animation.currentTime = elapsed;
      const finish = () => {
        if (!this.alive) return;
        if (this.host.state.completing.get(id) === completion) this.host.state.completing.delete(id);
        this.render();
      };
      // A hidden pane may not deliver animation events.
      const timer = window.setTimeout(finish, Math.max(0, completionDuration - elapsed) + 50);
      this.completionAnimations.set(animation, timer);
      animation.onfinish = animation.oncancel = finish;
    }
  }

  private async completeTodo(todo: Todo, completed: boolean, animate: boolean): Promise<void> {
    await this.withTodo(todo, async item => {
      const completion: TodoCompletion | undefined = animate ? { status: item.status } : undefined;
      if (completion) {
        this.host.state.completing.set(item.id!, completion);
        this.render();
      }
      try {
        await this.save({ kind: "complete", id: item.id!, completed, completedAt: new Date().toISOString() });
        if (completion) completion.startedAt = Date.now();
      } catch (error) {
        this.host.state.completing.delete(item.id!);
        throw error;
      }
    });
    // Saving can replace the render child; wake the current owner of pane state.
    for (const listener of this.host.state.completionListeners) listener();
  }

  private renderCapture(): void {
    const state = this.host.state;
    this.renderForm(this.root, {
      value: state.captureValue,
      mode: "add",
      focus: part => (part === "title" ? "capture" : `capture-${part}`),
      error: state.captureError,
      onEdit: () => {
        state.captureError = undefined;
      },
      onSubmit: () => void this.submitCapture(),
      onCancel: () => this.closeCapture(),
    });
  }

  private renderForm(parent: HTMLElement, options: TodoFormOptions): void {
    const { value } = options;
    const busy = this.host.state.busy;
    const form = element(parent, "div", `kanso-todo-form is-${options.mode}`);
    const title = element(form, "input", "kanso-todo-form-title");

    title.type = "text";
    title.placeholder = "What needs doing?";
    title.autocomplete = "off";
    title.spellcheck = true;
    title.value = value.title;
    title.disabled = busy;
    title.dataset.focus = options.focus("title");
    accessibleLabel(title, "Task title");

    if (options.error) {
      title.setAttribute("aria-invalid", "true");
      this.message(form, options.error);
    }

    const props = element(form, "div", "kanso-todo-props");
    const chip = (part: "priority" | "due" | "note", icon: string, label: string, text: string | null) => {
      const node = button(props, label, null, `kanso-todo-prop${text ? " has-value" : ""}`);
      node.dataset.focus = options.focus(part);
      node.disabled = busy;
      setIcon(element(node, "span", "kanso-todo-prop-icon"), icon);
      element(node, "span", "kanso-todo-prop-label", text ?? label.replace(/^(Set|Link) /, "").replace(/^\w/, c => c.toUpperCase()));
      return node;
    };
    const choose = (part: "priority" | "due" | "note", update: () => void) => {
      update();
      options.onEdit();
      this.render();
      this.focus(options.focus(part));
    };

    const priority = chip(
      "priority",
      "flag",
      value.priority ? `Priority ${value.priority}` : "Set priority",
      value.priority || null,
    );
    priority.addEventListener("click", event => this.showChoices(event, [
      ...(["P0", "P1", "P2"] as const).map(level => ({
        title: level,
        checked: value.priority === level,
        run: () => choose("priority", () => { value.priority = level; }),
      })),
      ...(value.priority
        ? [{ title: "No priority", run: () => choose("priority", () => { value.priority = ""; }) }]
        : []),
    ]));

    const dueText = value.dueDate ? dueDateDisplay(value.dueDate) : null;
    const due = chip(
      "due",
      "calendar",
      dueText ? `Due ${dueText.label}` : "Set due date",
      dueText?.label ?? null,
    );
    due.classList.add("kanso-todo-due-prop");
    if (dueText?.overdue) due.classList.add("is-overdue");
    const picker = element(due, "input", "kanso-todo-date-input");
    picker.type = "date";
    picker.tabIndex = -1;
    picker.value = value.dueDate;
    picker.setAttribute("aria-hidden", "true");
    picker.addEventListener("click", event => event.stopPropagation());
    picker.addEventListener("change", () => {
      if (picker.value) choose("due", () => { value.dueDate = picker.value; });
    });
    due.addEventListener("click", event => this.showChoices(event, [
      { title: "Today", run: () => choose("due", () => { value.dueDate = localDate(0); }) },
      { title: "Tomorrow", run: () => choose("due", () => { value.dueDate = localDate(1); }) },
      { title: "Next week", run: () => choose("due", () => { value.dueDate = localDate(7); }) },
      {
        title: "Pick a date…",
        run: () => {
          try {
            picker.showPicker();
          } catch {
            picker.focus();
          }
        },
      },
      ...(value.dueDate
        ? [{ title: "Remove due date", run: () => choose("due", () => { value.dueDate = ""; }) }]
        : []),
    ]));

    const note = chip(
      "note",
      "file-text",
      value.sourceNote ? `Source note ${noteName(value.sourceNote)}` : "Link source note",
      value.sourceNote ? noteName(value.sourceNote) : null,
    );
    const pick = async () => {
      const picked = await this.host.pickNote();
      if (picked && this.alive) choose("note", () => { value.sourceNote = picked; });
      else this.focus(options.focus("note"));
    };
    note.addEventListener("click", event => {
      if (!value.sourceNote) {
        void pick();
        return;
      }

      this.showChoices(event, [
        { title: "Change note…", run: () => void pick() },
        { title: "Remove note", run: () => choose("note", () => { value.sourceNote = ""; }) },
      ]);
    });

    const footer = element(form, "div", "kanso-todo-form-footer");
    const hint = element(footer, "div", "kanso-todo-form-hint");
    hint.setAttribute("aria-hidden", "true");
    element(hint, "kbd", "", "↵");
    hint.append(` to ${options.mode === "add" ? "add" : "save"} · `);
    element(hint, "kbd", "", "Esc");
    hint.append(" to cancel");

    const actions = element(footer, "div", "kanso-todo-form-actions");
    const cancel = button(actions, "Cancel", undefined, "kanso-todo-secondary");
    cancel.addEventListener("click", options.onCancel);
    const submit = button(actions, options.mode === "add" ? "Add" : "Save", undefined, "kanso-todo-primary");
    const updateSubmit = () => {
      submit.disabled = busy || !value.title.trim();
    };
    updateSubmit();
    submit.addEventListener("click", options.onSubmit);

    title.addEventListener("input", () => {
      value.title = title.value;
      options.onEdit();
      updateSubmit();
      this.rememberFocus();
    });
    this.bindInputKeys(title, { save: options.onSubmit, cancel: options.onCancel, modified: false });

    form.addEventListener("keydown", event => {
      if (event.isComposing || event.target === picker) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        options.onCancel();
      } else if (event.key === "Enter" && (event.target === title || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        options.onSubmit();
      }
    });
  }

  private showChoices(
    event: MouseEvent,
    choices: { title: string; checked?: boolean; run: () => void }[],
  ): void {
    this.menu?.hide();
    const menu = new Menu().setUseNativeMenu(false);
    this.menu = menu;

    for (const choice of choices) {
      menu.addItem(item => {
        item.setTitle(choice.title).onClick(choice.run);
        if (choice.checked) item.setChecked(true);
      });
    }

    const anchor = event.currentTarget as HTMLElement | null;
    if (anchor?.instanceOf(HTMLElement)) {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 }, this.root.ownerDocument);
    } else {
      menu.showAtMouseEvent(event);
    }
  }

  private closeCapture(): void {
    const state = this.host.state;
    state.capture = false;
    state.captureValue = emptyTodo();
    state.captureError = undefined;
    this.render();
    this.focus("add");
  }

  private renderTodo(parent: HTMLElement, todo: Todo, index: number): void {
    const state = this.host.state;
    const key = todo.id ?? `index-${this.data?.todos.indexOf(todo) ?? index}`;
    const completion = state.completing.get(key);
    const completing = !!completion;
    const completed = todo.status === "completed" || completing;
    const moved = !!todo.rollover?.next;
    const row = element(parent, "article", `kanso-todo-row${completed ? " is-completed" : ""}${moved ? " is-moved" : ""}`);
    row.dataset.todo = key;
    row.dataset.focus = `row-${key}`;
    row.tabIndex = -1;
    row.style.setProperty("--kanso-todo-index", String(Math.min(index, 6)));
    if (completing) {
      row.classList.add("is-completing");
      row.setAttribute("inert", "");
    }

    const draft = state.draft;
    if (draft?.key === key && !moved) {
      row.classList.add("is-editing");
      this.renderForm(row, {
        value: draft.value,
        mode: "edit",
        focus: part => `edit-${part}-${key}`,
        error: draft.error,
        onEdit: () => {
          draft.error = undefined;
        },
        onSubmit: () => {
          if (draft.value.title.trim()) void this.saveDraft(todo, key, draft);
        },
        onCancel: () => {
          state.draft = undefined;
          this.render();
          this.focus(`menu-${key}`);
        },
      });
      return;
    }

    const main = element(row, "div", "kanso-todo-main");
    if (moved) {
      const marker = element(main, "span", "kanso-todo-moved-marker", "↦");
      marker.setAttribute("role", "img");
      accessibleLabel(marker, "Moved to another day.");
    } else {
      const checkbox = element(main, "input", "kanso-todo-checkbox");
      checkbox.type = "checkbox";
      checkbox.checked = completed;
      checkbox.disabled = state.busy;
      checkbox.dataset.focus = `complete-${key}`;
      accessibleLabel(checkbox, completed ? `Reopen ${todo.title}` : `Complete ${todo.title}`);
      let pointerActivated = false;
      checkbox.addEventListener("click", event => { pointerActivated = event.detail > 0; });
      checkbox.addEventListener("change", () => void this.completeTodo(
        todo, checkbox.checked, checkbox.checked && pointerActivated && this.canAnimateCompletion(),
      ));
    }

    if ((!completed || completing) && !moved) {
      const statusValue = completion?.status ?? todo.status;
      const status = button(
        main,
        `Change status from ${statusValue} to ${statusValue === "todo" ? "doing" : "todo"}`,
        undefined,
        `kanso-todo-status is-${statusValue}`,
      );
      status.textContent = statusValue.toUpperCase();
      status.dataset.focus = `status-${key}`;
      status.disabled = state.busy;
      status.addEventListener("click", () => void this.withTodo(todo, item =>
        this.save({ kind: "status", id: item.id!, status: item.status === "todo" ? "doing" : "todo" })));
    }

    if (todo.priority && moved) {
      element(main, "span", "kanso-todo-priority", todo.priority);
    } else if (todo.priority) {
      const priority = button(
        main,
        `Change priority from ${todo.priority} to ${nextPriority[todo.priority]}`,
        undefined,
        "kanso-todo-priority",
      );
      priority.textContent = todo.priority;
      priority.dataset.focus = `priority-${key}`;
      priority.disabled = state.busy;
      priority.addEventListener("click", () => void this.withTodo(todo, item => {
        if (!item.priority) throw new Error("This task no longer has a priority.");
        return this.save({ kind: "priority", id: item.id!, priority: nextPriority[item.priority] });
      }));
    }

    const content = element(main, "div", "kanso-todo-content");
    element(content, "div", "kanso-todo-title", todo.title);

    if (todo.due_date || todo.source_note || todo.rollover) {
      const meta = element(content, "div", "kanso-todo-meta");

      if (todo.rollover) this.renderRollover(meta, todo, key);

      if (todo.source_note) {
        const name = noteName(todo.source_note);
        const source = button(meta, `Open ${name}`, null, "kanso-todo-chip kanso-source-chip");
        source.dataset.focus = `source-${key}`;
        setIcon(element(source, "span", "kanso-todo-chip-icon"), "file-text");
        element(source, "span", "kanso-todo-chip-label", name);
        source.addEventListener("click", () => void this.openNote(todo.source_note!));
      }

      if (todo.due_date) {
        const due = dueDateDisplay(todo.due_date);
        const chip = element(meta, "span", `kanso-todo-chip kanso-due-chip${due.overdue ? " is-overdue" : ""}`);
        setIcon(element(chip, "span", "kanso-todo-chip-icon"), "flag");
        element(chip, "span", "kanso-todo-chip-label", due.label);
      }
    }

    if (moved) return;
    const actions = element(main, "div", "kanso-todo-actions");
    const menu = button(actions, "Task actions", "ellipsis", "kanso-icon-button");
    menu.dataset.focus = `menu-${key}`;
    menu.disabled = state.busy;
    menu.addEventListener("click", event => this.showMenu(event, todo, key));
  }

  private renderRollover(parent: HTMLElement, todo: Todo, key: string): void {
    const pill = element(parent, "span", "kanso-todo-rollover");
    const { previous, next } = todo.rollover!;
    const link = (reference: TodoReference, incoming: boolean) => {
      const date = parseLocalDate(reference.date);
      const short = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);
      const full = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(date);
      const label = incoming ? (next ? `From ${short}` : short) : `Moved → ${short}`;
      const node = element(pill, "a", `kanso-todo-rollover-link is-${incoming ? "incoming" : "outgoing"}`);
      if (incoming && !next) {
        const icon = element(node, "span", "kanso-todo-rollover-icon");
        icon.setAttribute("aria-hidden", "true");
        setIcon(icon, "corner-down-left");
      }
      node.append(label);
      node.href = `obsidian://open?file=${encodeURIComponent(reference.note)}`;
      node.dataset.focus = `rollover-${incoming ? "previous" : "next"}-${key}`;
      const name = `Moved ${incoming ? "from" : "to"} ${full}: open ${incoming ? "previous" : "next"} task`;
      accessibleLabel(node, name);
      node.title = name;
      node.addEventListener("click", event => {
        event.preventDefault();
        void this.host.openTask(reference).catch(error => {
          if (!this.alive) return;
          this.host.state.error = errorMessage(error);
          this.render();
        });
      });
    };
    if (previous) link(previous, true);
    if (next) link(next, false);
  }

  private showMenu(event: MouseEvent, todo: Todo, key: string): void {
    this.menu?.hide();
    const menu = new Menu().setUseNativeMenu(false);
    this.menu = menu;

    menu.addItem(item => item.setTitle("Edit task").setIcon("pencil").onClick(() => {
      const fields = todoFields(todo);
      this.host.state.draft = {
        key,
        value: { ...fields },
        expected: { ...fields },
      };
      this.render();
      this.focus(`edit-title-${key}`);
    }));

    menu.addSeparator();
    menu.addItem(item => {
      item.setTitle("Delete").setIcon("trash-2").setWarning(true).onClick(() =>
        void this.withTodo(todo, async item => {
          await this.save({ kind: "delete", id: item.id! });
          if (this.host.state.draft?.key === key || this.host.state.draft?.key === item.id) {
            this.host.state.draft = undefined;
          }
        }));
    });

    const anchor = event.currentTarget as HTMLElement | null;
    if (anchor?.instanceOf(HTMLElement)) {
      const rect = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: rect.right, y: rect.bottom + 4, left: true }, this.root.ownerDocument);
    } else {
      menu.showAtMouseEvent(event);
    }
  }

  private bindInputKeys(
    input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    actions: InputKeys,
  ): void {
    input.addEventListener("focus", () => {
      this.releaseKeys?.();
      this.releaseKeys = this.host.activateKeys(actions);
    });
    input.addEventListener("blur", () => {
      this.releaseKeys?.();
      this.releaseKeys = undefined;
    });
    input.addEventListener("select", () => this.rememberFocus());
  }

  private async submitCapture(): Promise<void> {
    const state = this.host.state;
    if (this.captureSubmitting || state.busy || !state.capture) return;

    const title = state.captureValue.title.trim();
    if (!title) {
      state.captureError = "Task title cannot be empty.";
      this.render();
      this.focus("capture");
      return;
    }

    this.captureSubmitting = true;
    state.busy = true;
    state.captureError = undefined;
    this.render();

    try {
      this.source = await this.host.save({
        kind: "add",
        id: newTodoId("td"),
        value: { ...state.captureValue, title, status: "todo" },
        createdAt: new Date().toISOString(),
      });
      state.capture = false;
      state.captureValue = emptyTodo();
      state.error = undefined;
    } catch (error) {
      state.captureError = errorMessage(error);
      console.error("Kanso Todos: could not add task", error);
    } finally {
      state.busy = false;
      this.captureSubmitting = false;
      this.render();
    }
  }

  private async saveDraft(todo: Todo, key: string, draft: TodoDraft): Promise<void> {
    await this.withTodo(todo, async item => {
      try {
        await this.save({ kind: "edit", id: item.id!, value: draft.value, expected: draft.expected });
        this.host.state.draft = undefined;
      } catch (error) {
        if (error instanceof TodoConflictError) {
          draft.expected = error.current;
          draft.error = error.message;
        } else {
          throw error;
        }
      }
    });

  }

  private async openNote(link: string): Promise<void> {
    try {
      await this.host.openNote(link.replace(/^\[\[|\]\]$/g, ""));
    } catch (error) {
      this.host.state.error = errorMessage(error);
      this.render();
    }
  }

  private async save(mutation: TodoMutation): Promise<void> {
    this.source = await this.host.save(mutation);
  }

  private async withTodo(original: Todo, operation: (todo: Todo) => void | Promise<void>): Promise<void> {
    const state = this.host.state;
    if (state.busy) return;

    state.busy = true;
    state.error = undefined;

    try {
      let item = original;

      if (!item.id) {
        const index = this.data?.todos.indexOf(original) ?? -1;
        if (index < 0) throw new Error("The todo list changed. Please try again.");

        this.source = await this.host.save({ kind: "initialize" });
        const initialized = readTodos(this.source).data.todos[index];
        if (!initialized || initialized.title !== item.title || initialized.created_at !== item.created_at) {
          throw new Error("The todo list changed. Please try again.");
        }

        const oldKey = `index-${index}`;
        if (state.draft?.key === oldKey) state.draft.key = initialized.id!;
        item = initialized;
      }

      await operation(item);
    } catch (error) {
      console.error("Kanso Todos: task update failed", error);
      state.error = errorMessage(error);
    } finally {
      state.busy = false;
      this.render();
    }
  }
}
