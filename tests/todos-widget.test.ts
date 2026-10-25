import { afterEach, describe, expect, it, vi } from "vitest";
import { readTodos, type Todo, type TodoReference } from "../src/todos/model";
import { mutateTodoNote } from "../src/todos/persistence";
import {
  createTodoWidgetState,
  TodosWidget,
  type TodoWidgetHost,
} from "../src/todos/widget";
import { installDomExtensions, Menu } from "./obsidian";

const active: Todo = {
  id: "td_active",
  title: "Testing",
  status: "todo",
  priority: "P1",
  created_at: "2026-10-04T10:30:00.000Z",
  due_date: "2026-10-21",
  source_note: "Daily Note: 2 Oct",
};
const completed: Todo = {
  id: "td_complete",
  title: "Finished",
  status: "completed",
  priority: "P0",
  created_at: "2026-10-03T10:30:00.000Z",
  completed_at: "2026-10-04T09:00:00.000Z",
};
const previous: TodoReference = {
  note: "Daily/2025-12-31.md", block_id: "kt_previous", todo_id: "td_previous", date: "2025-12-31",
};
const next: TodoReference = {
  note: "Daily/2026-10-28.md", block_id: "kt_next", todo_id: "td_next", date: "2026-10-28",
};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function accessibleName(node: Element): string | null {
  const id = node.getAttribute("aria-labelledby");
  return id ? node.ownerDocument.getElementById(id)?.textContent ?? null : node.textContent;
}

function setup(
  todos: Todo[] = [],
  options: { deferReady?: boolean; initialReadError?: Error; document?: Document } = {},
) {
  let source = JSON.stringify({ version: 2, id: "kt_test", title: "Tasks", todos });
  let initialReadError = options.initialReadError;
  let ready: (() => void) | undefined;
  const state = createTodoWidgetState();
  const doc = options.document ?? document;
  const root = doc.createElement("div");
  doc.body.append(root);

  const host: TodoWidgetHost = {
    state,
    read: vi.fn(async () => {
      if (initialReadError) {
        const error = initialReadError;
        initialReadError = undefined;
        throw error;
      }
      return source;
    }),
    save: vi.fn(async mutation => {
      const result = mutateTodoNote(
        `\`\`\`kanso-todos\n${source}\n\`\`\`\n`,
        { id: "kt_test", line: 0, source },
        mutation,
      );
      source = result.source;
      return source;
    }),
    activateKeys: vi.fn(() => vi.fn()),
    whenReady: callback => {
      if (options.deferReady) ready = callback;
      else callback();
    },
    pickNote: vi.fn(async () => "Projects/Kanso"),
    openNote: vi.fn(async () => {}),
    openTask: vi.fn(async () => {}),
    mounted: vi.fn(),
    unmounted: vi.fn(),
  };

  const widget = new TodosWidget(root, source, host);
  widget.onload();

  const click = (label: string) => {
    const node = [...root.querySelectorAll("button")].find(button => accessibleName(button) === label);
    expect(node, `Missing ${label}`).not.toBeNull();
    node!.click();
  };

  const choose = (label: string) => {
    const item = Menu.latest.items.find(item => item.title === label);
    expect(item, `Missing menu item ${label}`).toBeDefined();
    item!.callback();
  };

  const menu = (label: string) => {
    click("Task actions");
    choose(label);
  };

  const type = (value: string) => {
    const title = root.querySelector<HTMLInputElement>(".kanso-todo-form-title")!;
    title.value = value;
    title.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const pickDate = (value: string) => {
    const input = root.querySelector<HTMLInputElement>(".kanso-todo-date-input")!;
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  return {
    root,
    host,
    state,
    widget,
    click,
    choose,
    menu,
    type,
    pickDate,
    ready: () => ready?.(),
    data: () => readTodos(source).data,
  };
}

afterEach(() => document.body.replaceChildren());

describe("todos widget", () => {
  function popoutDocument(): Document {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const doc = frame.contentDocument!;
    installDomExtensions(doc);
    return doc;
  }

  it("preserves a draft's focus and selection across refreshes in another window", async () => {
    const doc = popoutDocument();
    const view = setup([active], { document: doc });
    await settle();
    view.click("Add a task");
    view.type("Pop-out draft");
    const title = view.root.querySelector<HTMLInputElement>(".kanso-todo-form-title")!;
    expect(title instanceof HTMLInputElement).toBe(false);
    expect(title.ownerDocument).toBe(doc);
    expect(accessibleName(title)).toBe("Task title");
    title.focus();
    title.setSelectionRange(2, 7);

    await view.widget.refresh();

    const restored = view.root.querySelector<HTMLInputElement>(".kanso-todo-form-title")!;
    expect(doc.activeElement).toBe(restored);
    expect(restored.value).toBe("Pop-out draft");
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([2, 7]);
    expect(view.host.save).not.toHaveBeenCalled();
    view.widget.onunload();
  });

  it("anchors menus and toggles collapse once from a different window", async () => {
    const doc = popoutDocument();
    const view = setup([active], { document: doc });
    await settle();
    const trigger = view.root.querySelector<HTMLButtonElement>('[data-focus="menu-td_active"]')!;
    trigger.getBoundingClientRect = vi.fn(() => new DOMRect(100, 50, 28, 28));
    const show = vi.spyOn(Menu.prototype, "showAtPosition");
    try {
      view.click("Task actions");
      expect(show).toHaveBeenCalledWith({ x: 128, y: 82, left: true }, doc);
      view.click("Collapse Tasks");
      expect(view.state.collapsed).toBe(true);
      view.click("Expand Tasks");
      expect(view.state.collapsed).toBe(false);
    } finally {
      show.mockRestore();
      view.widget.onunload();
    }
  });

  it.each([
    [{ next }, ["Moved → 28 Oct"]],
    [{ previous, next }, ["From 31 Dec", "Moved → 28 Oct"]],
  ] as const)("renders read-only historical rows and independent exact links: %j", async (rollover, labels) => {
    const view = setup([{ ...active, rollover, due_date: "2000-01-01" }]);
    await settle();
    const row = view.root.querySelector(".kanso-todo-row")!;
    expect(row.classList.contains("is-moved")).toBe(true);
    expect(row.classList.contains("is-completed")).toBe(false);
    expect(row.querySelector("input, .kanso-todo-status, .kanso-todo-actions")).toBeNull();
    expect(row.querySelector(".kanso-todo-priority")?.tagName).toBe("SPAN");
    expect(row.querySelector(".kanso-todo-priority")?.textContent).toBe("P1");
    expect(row.querySelector(".kanso-due-chip.is-overdue")).not.toBeNull();
    expect(accessibleName(row.querySelector(".kanso-todo-moved-marker")!)).toBe("Moved to another day.");
    const links = [...row.querySelectorAll<HTMLAnchorElement>(".kanso-todo-rollover-link")];
    expect(links.map(link => link.textContent)).toEqual(labels);
    for (const link of links) link.click();
    expect(vi.mocked(view.host.openTask).mock.calls).toEqual(
      "previous" in rollover ? [[previous], [next]] : [[next]],
    );
    expect(view.host.save).not.toHaveBeenCalled();
  });

  it("keeps incoming tasks actionable, with a full-date accessible incoming link", async () => {
    const view = setup([{ ...active, status: "doing", rollover: { previous } }]);
    await settle();
    expect(view.root.querySelector(".kanso-todo-status")?.textContent).toBe("DOING");
    expect(view.root.querySelector(".is-moved")).toBeNull();
    const link = view.root.querySelector<HTMLAnchorElement>(".kanso-todo-rollover-link")!;
    expect(link.textContent).toBe("31 Dec");
    expect(link.querySelector(".kanso-todo-rollover-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(link.querySelector("svg")?.getAttribute("data-icon")).toBe("corner-down-left");
    expect(accessibleName(link)).toBe("Moved from 31 December 2025: open previous task");
    expect(link.tabIndex).toBe(0);
    expect(link.title).toContain("2025");
    const checkbox = view.root.querySelector<HTMLInputElement>(".kanso-todo-checkbox")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(view.data().todos[0]).toMatchObject({ status: "completed", rollover: { previous } });
  });

  it("reports missing targets without saving or initializing anything", async () => {
    const view = setup([{ ...active, rollover: { previous } }]);
    await settle();
    vi.mocked(view.host.openTask).mockRejectedValueOnce(new Error("The linked task no longer exists."));
    view.root.querySelector<HTMLAnchorElement>(".kanso-todo-rollover-link")!.click();
    await settle();
    expect(view.root.querySelector(".kanso-message")?.textContent).toContain("linked task no longer exists");
    expect(view.host.save).not.toHaveBeenCalled();
  });

  it("reveals the exact collapsed/completed entry and restores relationships after remount", async () => {
    const incoming = { ...completed, rollover: { previous } };
    const view = setup([active, incoming]);
    await settle();
    view.click("Collapse Tasks");
    const scroll = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      expect(view.widget.revealTodo(incoming.id!)).toBe(true);
      expect(view.state.collapsed).toBe(false);
      expect(view.state.completedExpanded).toBe(true);
      expect((document.activeElement as HTMLElement).dataset.todo).toBe(incoming.id);
      expect(scroll).toHaveBeenCalledWith({ block: "center" });
      expect(view.widget.revealTodo("missing")).toBe(false);
      view.widget.onunload();
      const restored = new TodosWidget(view.root, JSON.stringify(view.data()), view.host);
      restored.onload();
      await settle();
      expect(view.root.querySelector(".kanso-todo-rollover-link")?.textContent).toBe("31 Dec");
      expect(view.root.querySelector(".kanso-todo-rollover-icon svg")?.getAttribute("data-icon")).toBe("corner-down-left");
      expect((document.activeElement as HTMLElement).dataset.todo).toBe(incoming.id);
      expect(view.host.save).not.toHaveBeenCalled();
      restored.onunload();
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("keeps historical entries in main-list order and suppresses stale edit drafts", async () => {
    const moved = { ...active, id: "td_moved", rollover: { previous, next } };
    const view = setup([moved, completed, active]);
    await settle();
    view.state.draft = {
      key: moved.id, value: { title: "Stale", status: "todo", priority: "", dueDate: "", sourceNote: "" },
      expected: { title: "Testing", status: "todo", priority: "P1", dueDate: active.due_date!, sourceNote: active.source_note! },
    };
    await view.widget.refresh();
    expect([...view.root.querySelectorAll<HTMLElement>("[data-todo]")].map(row => row.dataset.todo))
      .toEqual(["td_moved", "td_active"]);
    expect(view.root.querySelector(".is-editing")).toBeNull();
    expect(view.root.querySelector(".kanso-completed-count")?.textContent).toBe("1");
  });

  it("waits for layout readiness and preserves its valid initial render", async () => {
    const view = setup([active], {
      deferReady: true,
      initialReadError: new Error("The source note no longer exists."),
    });

    expect(view.root.querySelector('[data-todo="td_active"]')).not.toBeNull();
    expect(view.host.read).not.toHaveBeenCalled();
    view.ready();
    await settle();
    expect(view.root.querySelector('[data-todo="td_active"]')).not.toBeNull();
    expect(view.root.querySelector(".kanso-block-error")).toBeNull();
  });

  it("collapses to a summary without mounting task content", () => {
    const view = setup([active, completed]);
    view.click("Collapse Tasks");

    expect(view.state.collapsed).toBe(true);
    expect(view.root.classList.contains("is-collapsed")).toBe(true);
    expect(view.root.querySelector(".kanso-todo-count")?.textContent).toBe("2");
    expect(view.root.querySelector(".kanso-todo-list")).toBeNull();
    expect(view.root.querySelector(".kanso-completed-toggle")).toBeNull();
    expect(view.root.querySelector(".kanso-todo-add")).toBeNull();

    view.root.querySelector(".kanso-todo-heading-label")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(view.state.collapsed).toBe(false);
    expect(view.root.querySelector(".kanso-todo-list")).not.toBeNull();
  });

  it("keeps completed rows out of the DOM until their section is revealed", () => {
    const view = setup([active, completed]);

    expect(view.root.querySelector('[data-todo="td_active"]')).not.toBeNull();
    expect(view.root.querySelector('[data-todo="td_complete"]')).toBeNull();
    expect(view.root.querySelector(".kanso-completed-count")?.textContent).toBe("1");
    expect(view.root.querySelector(".kanso-completed-toggle")?.textContent).toBe("1Completed Tasks");
    expect(view.root.querySelector(".kanso-source-chip")?.textContent).toBe("Daily Note: 2 Oct");
    expect(view.root.querySelector(".kanso-todo-status")?.textContent).toBe("TODO");
    expect(view.root.querySelector(".kanso-todo-priority")?.textContent).toBe("P1");
    expect(accessibleName(view.root.querySelector(".kanso-todo-priority")!)).toBe("Change priority from P1 to P2");

    view.click("Show completed tasks");
    const completedRow = view.root.querySelector('[data-todo="td_complete"]');
    expect(completedRow).not.toBeNull();
    expect(completedRow?.classList.contains("is-completed")).toBe(true);
    expect(completedRow?.querySelector(".kanso-todo-status")).toBeNull();
  });

  it("creates a task with optional metadata at the start of YAML order", async () => {
    const view = setup([active]);
    view.click("Add a task");
    const add = () => [...view.root.querySelectorAll<HTMLButtonElement>(".kanso-todo-primary")][0]!;
    expect(view.root.querySelector(".kanso-todo-form.is-add")).not.toBeNull();
    expect(add().disabled).toBe(true);

    view.type("New task");
    expect(add().disabled).toBe(false);
    view.click("Set priority");
    view.choose("P2");
    view.pickDate("2026-10-24");
    view.click("Link source note");
    await settle();

    expect(view.root.querySelector<HTMLInputElement>(".kanso-todo-form-title")?.value).toBe("New task");
    expect([...view.root.querySelectorAll(".kanso-todo-prop.has-value")]).toHaveLength(3);
    view.click("Priority P2");
    view.click("Source note Kanso");
    view.click("Add");
    await settle();

    expect(view.data().todos[0]).toMatchObject({
      title: "New task",
      status: "todo",
      priority: "P2",
      due_date: "2026-10-24",
      source_note: "Projects/Kanso",
    });
    expect(view.data().todos[1]?.id).toBe("td_active");
    expect(view.state.captureValue.title).toBe("");
  });

  it("closes task creation from its visible cancel action", () => {
    const view = setup([active]);
    view.click("Add a task");
    expect(view.root.querySelector(".kanso-todo-form")).not.toBeNull();

    view.click("Cancel");

    expect(view.state.capture).toBe(false);
    expect(view.root.querySelector(".kanso-todo-form")).toBeNull();
  });

  it("cycles active status, completes tasks, and reopens them as todo", async () => {
    const view = setup([active]);
    view.click("Change status from todo to doing");
    await settle();
    expect(view.data().todos[0]?.status).toBe("doing");
    expect(view.root.querySelector(".kanso-todo-status")?.textContent).toBe("DOING");

    view.click("Change priority from P1 to P2");
    await settle();
    expect(view.data().todos[0]?.priority).toBe("P2");
    expect(view.root.querySelector(".kanso-todo-priority")?.textContent).toBe("P2");

    const checkbox = view.root.querySelector<HTMLInputElement>(".kanso-todo-checkbox")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    expect(view.data().todos[0]?.status).toBe("completed");
    expect(view.data().todos[0]?.completed_at).toBeDefined();
    expect(view.root.querySelector('[data-todo="td_active"]')).toBeNull();

    view.click("Show completed tasks");
    const completedCheckbox = view.root.querySelector<HTMLInputElement>(".kanso-todo-checkbox")!;
    completedCheckbox.checked = false;
    completedCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    expect(view.data().todos[0]?.status).toBe("todo");
    expect(view.data().todos[0]?.completed_at).toBeUndefined();
    expect(view.root.querySelector('[data-todo="td_active"]')).not.toBeNull();
  });

  it("opens the task actions menu inward from the trigger's right edge", () => {
    const view = setup([active]);
    const trigger = view.root.querySelector<HTMLButtonElement>('[data-focus="menu-td_active"]')!;
    trigger.getBoundingClientRect = vi.fn(() => new DOMRect(640, 100, 28, 28));
    const show = vi.spyOn(Menu.prototype, "showAtPosition");
    view.click("Task actions");
    expect(show).toHaveBeenCalledWith({ x: 668, y: 132, left: true }, view.root.ownerDocument);
    show.mockRestore();
  });

  it("edits title, priority, due date, and source note in place of the row", async () => {
    const view = setup([active]);
    view.menu("Edit task");

    const row = view.root.querySelector('[data-todo="td_active"]')!;
    expect(row.classList.contains("is-editing")).toBe(true);
    expect(row.querySelector(".kanso-todo-main")).toBeNull();
    expect(row.querySelector(".kanso-todo-form.is-edit")).not.toBeNull();

    view.type("Updated");
    view.click("Priority P1");
    view.choose("P2");
    view.pickDate("2026-10-25");
    view.click("Source note Daily Note: 2 Oct");
    view.choose("Change note…");
    await settle();
    view.click("Save");
    await settle();

    expect(view.data().todos[0]).toMatchObject({
      title: "Updated",
      status: "todo",
      priority: "P2",
      due_date: "2026-10-25",
      source_note: "Projects/Kanso",
    });
    expect(view.root.querySelector(".kanso-todo-form")).toBeNull();
  });

  it("clears optional metadata from the edit form", async () => {
    const view = setup([active]);
    view.menu("Edit task");

    view.click("Priority P1");
    view.choose("No priority");
    view.click("Source note Daily Note: 2 Oct");
    view.choose("Remove note");
    view.click("Save");
    await settle();

    expect(view.data().todos[0]?.priority).toBeUndefined();
    expect(view.data().todos[0]?.source_note).toBeUndefined();
  });

  it.each([
    ["Projects/Kanso", "Projects/Kanso"],
    ["Projects/Kanso.md", "Projects/Kanso.md"],
    ["[[Projects/Kanso.md|Project]]", "Projects/Kanso.md|Project"],
  ])(
    "shows only the note name while opening the original source link %s",
    async (sourceNote, target) => {
      const view = setup([{ ...active, source_note: sourceNote }]);

      expect(view.root.querySelector(".kanso-source-chip")?.textContent).toBe("Kanso");
      view.click("Open Kanso");
      await settle();
      expect(view.host.openNote).toHaveBeenCalledWith(target);
      expect(view.host.save).not.toHaveBeenCalled();
    },
  );

  it("opens source-note chips and deletes only the selected task", async () => {
    const view = setup([active, completed]);
    view.click("Open Daily Note: 2 Oct");
    await settle();
    expect(view.host.openNote).toHaveBeenCalledWith("Daily Note: 2 Oct");

    view.menu("Delete");
    await settle();
    expect(view.data().todos.map(todo => todo.id)).toEqual(["td_complete"]);
  });
});
