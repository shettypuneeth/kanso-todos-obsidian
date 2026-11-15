import { afterEach, describe, expect, it, vi } from "vitest";
import { readTodos, type Todo, type TodoReference } from "../src/todos/model";
import * as model from "../src/todos/model";
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
const widgets: TodosWidget[] = [];

function mockAnimations(reducedMotion = false, view = window) {
  const originalMatchMedia = Object.getOwnPropertyDescriptor(view, "matchMedia");
  Object.defineProperty(view, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: reducedMotion })),
  });
  const animations: { node: HTMLElement; animation: Animation }[] = [];
  const animate = vi.fn(function (this: HTMLElement) {
    const animation = { currentTime: 0, onfinish: null, oncancel: null, cancel: vi.fn() } as unknown as Animation;
    animations.push({ node: this, animation });
    return animation;
  });
  const original = Object.getOwnPropertyDescriptor(view.HTMLElement.prototype, "animate");
  Object.defineProperty(view.HTMLElement.prototype, "animate", { configurable: true, value: animate });
  animationRestorers.push(() => {
    if (originalMatchMedia) Object.defineProperty(view, "matchMedia", originalMatchMedia);
    else Reflect.deleteProperty(view, "matchMedia");
    if (original) Object.defineProperty(view.HTMLElement.prototype, "animate", original);
    else Reflect.deleteProperty(view.HTMLElement.prototype, "animate");
  });
  return {
    animate,
    animations,
    finish: (id: string) => {
      const animation = [...animations].reverse().find(entry => entry.node.dataset.todo === id && entry.animation.onfinish)?.animation;
      expect(animation).toBeDefined();
      animation!.onfinish!.call(animation!, new Event("finish") as AnimationPlaybackEvent);
    },
  };
}

const animationRestorers: (() => void)[] = [];

function pointerComplete(root: HTMLElement, id = "td_active"): void {
  const checkbox = root.querySelector<HTMLInputElement>(`[data-todo="${id}"] .kanso-todo-checkbox`)!;
  const MouseEvent = root.ownerDocument.defaultView!.MouseEvent;
  checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
}

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
  widgets.push(widget);
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

afterEach(() => {
  for (const widget of widgets.splice(0)) widget.onunload();
  for (const restore of animationRestorers.splice(0)) restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("todos widget", () => {
  function popoutDocument(): Document {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const doc = frame.contentDocument!;
    installDomExtensions(doc);
    return doc;
  }

  it("keeps total counts visible and header controls ordered when expanded or collapsed", async () => {
    const view = setup([active, completed]);
    await settle();
    expect(view.root.querySelector(".kanso-todo-count")?.textContent).toBe("2");
    const actions = view.root.querySelector(".kanso-todo-header-actions")!;
    expect([...actions.querySelectorAll<HTMLButtonElement>("button")].map(node => node.dataset.focus)).toEqual(["add", "collapse"]);
    view.click("Collapse Tasks");
    expect(view.root.querySelector(".kanso-todo-count")?.textContent).toBe("2");
    expect(view.root.querySelector(".kanso-todo-add, .kanso-todo-row")).toBeNull();
    view.click("Expand Tasks");
    expect(view.root.querySelector(".kanso-todo-count")?.textContent).toBe("2");
  });

  it("reconciles startup without rebuilding unchanged rows or reparsing UI-only changes", async () => {
    const parse = vi.spyOn(model, "readTodos");
    const view = setup([active], { deferReady: true });
    const row = view.root.querySelector(".kanso-todo-row");
    expect(parse).toHaveBeenCalledTimes(1);
    view.ready();
    await settle();
    expect(view.host.read).toHaveBeenCalledTimes(1);
    expect(view.root.querySelector(".kanso-todo-row")).toBe(row);
    view.click("Collapse Tasks");
    view.click("Expand Tasks");
    expect(parse).toHaveBeenCalledTimes(1);
    vi.mocked(view.host.read).mockResolvedValueOnce(JSON.stringify({
      version: 2, id: "kt_test", todos: [{ ...active, title: "Changed task" }],
    }));
    await view.widget.refresh();
    expect(parse).toHaveBeenCalledTimes(2);
    expect(view.root.textContent).toContain("Changed task");
  });

  it("reuses validated initial data without skipping the authoritative read", async () => {
    const view = setup([active], { deferReady: true });
    view.widget.onunload();
    const source = JSON.stringify(view.data());
    const data = readTodos(source).data;
    const parse = vi.spyOn(model, "readTodos");
    const widget = new TodosWidget(view.root, source, view.host, data);
    widgets.push(widget);
    widget.onload();
    const row = view.root.querySelector(".kanso-todo-row");
    view.ready();
    await settle();
    expect(view.host.read).toHaveBeenCalledTimes(1);
    expect(view.root.querySelector(".kanso-todo-row")).toBe(row);
    expect(parse).not.toHaveBeenCalled();
  });

  it("saves pointer completion immediately and retains the row until its exit finishes", async () => {
    const motion = mockAnimations();
    const view = setup([active]);
    await settle();
    pointerComplete(view.root);
    expect(view.host.save).toHaveBeenCalledWith(expect.objectContaining({ kind: "complete", completed: true }));
    expect(view.root.querySelector(".is-completing.is-completed")).not.toBeNull();
    await settle();
    expect(view.data().todos[0]?.status).toBe("completed");
    expect(view.state.busy).toBe(false);
    expect(view.root.querySelector(".is-completing")?.hasAttribute("inert")).toBe(true);
    expect(view.root.querySelector(".is-completing .kanso-todo-status")?.textContent).toBe("TODO");
    expect(view.root.querySelector(".kanso-todo-all-done")).toBeNull();
    expect(motion.animate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ opacity: 0, transform: "translateY(-6px)" }),
        expect.objectContaining({ height: "0px", paddingTop: "0px", paddingBottom: "0px" })]),
      expect.objectContaining({ duration: 480 }),
    );
    motion.finish("td_active");
    expect(view.root.querySelector(".kanso-todo-row")).toBeNull();
    expect(view.root.querySelector(".kanso-todo-all-done")?.textContent).toBe("All done");
    expect(view.root.querySelector(".kanso-completed-count")?.textContent).toBe("1");
    expect(view.state.completing.size).toBe(0);
  });

  it("allows overlapping exits and keeps focus on a surviving row in a pop-out", async () => {
    const doc = popoutDocument();
    const motion = mockAnimations(false, doc.defaultView!);
    const view = setup([active, { ...active, id: "td_second", title: "Next task" }], { document: doc });
    await settle();
    view.root.querySelector<HTMLInputElement>(".kanso-todo-checkbox")!.focus();
    pointerComplete(view.root);
    await settle();
    expect(doc.activeElement?.closest("[data-todo]")?.getAttribute("data-todo")).toBe("td_second");
    pointerComplete(view.root, "td_second");
    await settle();
    expect(view.host.save).toHaveBeenCalledTimes(2);
    expect(view.root.querySelectorAll(".is-completing")).toHaveLength(2);
    motion.finish("td_active");
    motion.finish("td_second");
    expect(view.root.querySelectorAll(".kanso-todo-row")).toHaveLength(0);
    expect(view.root.querySelector(".kanso-completed-count")?.textContent).toBe("2");
  });

  it("moves focus to an enabled header control when the final active row exits", async () => {
    const motion = mockAnimations();
    const view = setup([active]);
    await settle();
    view.root.querySelector<HTMLInputElement>(".kanso-todo-checkbox")!.focus();
    pointerComplete(view.root);
    await settle();
    const focused = document.activeElement as HTMLButtonElement;
    expect(view.root.querySelector(".kanso-todo-header")?.contains(focused)).toBe(true);
    expect(focused.disabled).toBe(false);
    motion.finish("td_active");
    expect((document.activeElement as HTMLElement).dataset.focus).toBe(focused.dataset.focus);
  });

  it.each(["keyboard", "reduced motion", "no animation API"])("completes instantly for %s", async mode => {
    const motion = mockAnimations(mode === "reduced motion");
    if (mode === "no animation API") Reflect.deleteProperty(HTMLElement.prototype, "animate");
    const view = setup([active]);
    await settle();
    if (mode === "keyboard") view.root.querySelector<HTMLInputElement>(".kanso-todo-checkbox")!.click();
    else pointerComplete(view.root);
    await settle();
    expect(view.data().todos[0]?.status).toBe("completed");
    expect(view.root.querySelector(".kanso-todo-row")).toBeNull();
    expect(view.state.completing.size).toBe(0);
    expect(motion.animations).toHaveLength(0);
  });

  it.each([false, true])("settles a completion save after remount (failed: %s)", async fails => {
    const motion = mockAnimations();
    const view = setup([active]);
    await settle();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const save = vi.mocked(view.host.save).getMockImplementation()!;
    vi.mocked(view.host.save).mockImplementationOnce(async mutation => {
      await pending;
      if (fails) throw new Error("Save failed after remount");
      return save(mutation);
    });
    pointerComplete(view.root);
    expect(motion.animations).toHaveLength(0);
    view.widget.onunload();
    const restored = new TodosWidget(view.root, JSON.stringify(view.data()), view.host);
    widgets.push(restored);
    restored.onload();
    await settle();
    release();
    await settle();
    if (fails) {
      expect(view.root.querySelector(".is-completing")).toBeNull();
      expect(view.root.querySelector(".kanso-message")?.textContent).toBe("Save failed after remount");
      expect(view.root.querySelector<HTMLInputElement>(".kanso-todo-checkbox")?.checked).toBe(false);
      expect(motion.animations).toHaveLength(0);
    } else {
      expect(view.root.querySelector(".is-completing")).not.toBeNull();
      motion.finish("td_active");
      expect(view.root.querySelector(".kanso-todo-row")).toBeNull();
    }
  });

  it("continues an exit across refresh and remount without restarting its clock", async () => {
    const motion = mockAnimations();
    const view = setup([active]);
    await settle();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    pointerComplete(view.root);
    await settle();
    vi.mocked(Date.now).mockReturnValue(now + 80);
    await view.widget.refresh();
    expect(motion.animations.at(-1)?.animation.currentTime).toBe(80);
    const oldAnimation = motion.animations.at(-1)!.animation;
    view.widget.onunload();
    expect(oldAnimation.cancel).toHaveBeenCalled();
    expect(oldAnimation.onfinish).toBeNull();
    const restored = new TodosWidget(view.root, JSON.stringify(view.data()), view.host);
    widgets.push(restored);
    restored.onload();
    await settle();
    expect(motion.animations.at(-1)?.animation.currentTime).toBe(80);
    motion.finish("td_active");
    expect(view.root.querySelector(".is-completing")).toBeNull();
  });

  it("removes retained rows even if the browser never delivers an animation event", async () => {
    mockAnimations();
    vi.useFakeTimers();
    const view = setup([active], { deferReady: true });
    pointerComplete(view.root);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.root.querySelector(".is-completing")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(531);
    expect(view.root.querySelector(".kanso-todo-row")).toBeNull();
    expect(view.state.completing.size).toBe(0);
  });

  it("initializes legacy IDs without duplicating exiting rows in an open completed section", async () => {
    const motion = mockAnimations();
    const view = setup([{ ...active, id: undefined }, completed]);
    await settle();
    view.click("Show completed tasks");
    pointerComplete(view.root, "index-0");
    await settle();
    const id = view.data().todos[0]!.id!;
    expect(view.state.completing.has(id)).toBe(true);
    expect(view.root.querySelectorAll(`[data-todo="${id}"]`)).toHaveLength(1);
    expect(view.root.querySelector(`.kanso-completed-list [data-todo="${id}"]`)).toBeNull();
    motion.finish(id);
    expect(view.root.querySelectorAll(`[data-todo="${id}"]`)).toHaveLength(1);
    expect(view.root.querySelector(`.kanso-completed-list [data-todo="${id}"]`)).not.toBeNull();
  });

  it.each(["reopened", "deleted"])("cancels an exit when the task is externally %s", async change => {
    const motion = mockAnimations();
    const view = setup([active]);
    await settle();
    pointerComplete(view.root);
    await settle();
    const animation = motion.animations.at(-1)!.animation;
    vi.mocked(view.host.read).mockResolvedValueOnce(JSON.stringify({
      version: 2, todos: change === "deleted" ? [] : [active],
    }));
    await view.widget.refresh();
    expect(view.state.completing.size).toBe(0);
    expect(view.root.querySelector(".is-completing")).toBeNull();
    expect(animation.cancel).toHaveBeenCalled();
    expect(view.root.querySelectorAll(".kanso-todo-row")).toHaveLength(change === "deleted" ? 0 : 1);
  });

  it("does not animate reopening or externally completed tasks", async () => {
    const motion = mockAnimations();
    const view = setup([completed]);
    await settle();
    view.click("Show completed tasks");
    pointerComplete(view.root, completed.id);
    await settle();
    expect(view.data().todos[0]?.status).toBe("todo");
    vi.mocked(view.host.read).mockResolvedValueOnce(JSON.stringify({
      version: 2, id: "kt_test", todos: [completed],
    }));
    await view.widget.refresh();
    expect(view.root.querySelector(".kanso-completed-count")?.textContent).toBe("1");
    expect(view.state.completing.size).toBe(0);
    expect(motion.animations).toHaveLength(0);
  });

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
