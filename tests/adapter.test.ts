import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownView, TFile } from "obsidian";
import KansoTodosPlugin from "../src/main";
import { readTodos } from "../src/todos/model";
import { createTodoWidgetState } from "../src/todos/widget";
import type { TodoMutation } from "../src/todos/persistence";

vi.mock("obsidian", async importOriginal => ({
  ...await importOriginal<object>(),
  Plugin: class {},
  FuzzySuggestModal: class {},
  MarkdownView: class {},
  TFile: class {},
}));

const initial = "Before\n```kanso-todos\n\n```\nAfter\n";

function setup() {
  let text = initial;
  const handlers = new Map<string, (...args: any[]) => void>();
  const cleanups: (() => void)[] = [];
  const file = Object.assign(Object.create(TFile.prototype), { path: "Smoke.md" });
  const leaves: { view: MarkdownView }[] = [];
  const vault = {
    on: vi.fn((name, callback) => { handlers.set(name, callback); return {}; }),
    getAbstractFileByPath: vi.fn(() => file),
    read: vi.fn(async () => text),
    process: vi.fn(async (_file, apply) => { text = apply(text); }),
  };
  const plugin = Object.assign(Object.create(KansoTodosPlugin.prototype), {
    app: {
      vault,
      workspace: {
        on: vi.fn((name, callback) => { handlers.set(name, callback); return {}; }),
        getLeavesOfType: () => leaves,
      },
    },
    todoBindings: new Set(),
    todoPaneStates: new WeakMap(),
    writes: new Map(),
    stopped: false,
    dirtyPaths: new Set(),
    taskNavigation: 0,
    registerMarkdownCodeBlockProcessor: vi.fn(),
    addCommand: vi.fn(),
    registerEvent: vi.fn(),
    register: vi.fn(callback => cleanups.push(callback)),
  });
  plugin.onload();
  const state = createTodoWidgetState();
  const target = { line: 1, source: "\n", id: undefined as string | undefined };
  const paneStates = new Map([["Smoke.md\0line:1", state]]);
  const binding = { path: file.path, target, state, paneStates, widget: { refresh: vi.fn() } };
  type Binding = typeof binding;
  const adapter = plugin as unknown as {
    todoBindings: Set<typeof binding>;
    readNote: (path: string) => Promise<string>;
    saveBlock: (binding: Binding, mutation: TodoMutation) => Promise<string>;
  };
  adapter.todoBindings.add(binding);

  function editor(value: string) {
    let buffer = value;
    const offset = (pos: { line: number; ch: number }) =>
      buffer.split("\n").slice(0, pos.line).reduce((sum, line) => sum + line.length + 1, 0) + pos.ch;
    const editor = {
      getValue: vi.fn(() => buffer),
      offsetToPos: (offset: number) => {
        const lines = buffer.slice(0, offset).split("\n");
        return { line: lines.length - 1, ch: lines.at(-1)!.length };
      },
      replaceRange: vi.fn((source, from, to) => {
        buffer = buffer.slice(0, offset(from)) + source + buffer.slice(offset(to));
      }),
    };
    leaves.push({
      view: Object.assign(Object.create(MarkdownView.prototype), {
        file, editor, getMode: () => "source",
      }),
    });
    return editor;
  }

  return { plugin, adapter, binding, vault, handlers, cleanups, editor, text: () => text };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("standalone Obsidian adapter", () => {
  it("registers only the todo renderer and insert command without reading preferences or notes", () => {
    const test = setup();
    expect(test.plugin.registerMarkdownCodeBlockProcessor).toHaveBeenCalledTimes(1);
    expect(test.plugin.registerMarkdownCodeBlockProcessor.mock.calls[0]![0]).toBe("kanso-todos");
    expect(test.plugin.addCommand).toHaveBeenCalledWith(expect.objectContaining({ id: "insert-todos" }));
    expect(test.vault.read).not.toHaveBeenCalled();
    expect(test.vault.process).not.toHaveBeenCalled();
  });

  it("rekeys pane-local drafts and refreshes after rename without any bookmark bindings", async () => {
    vi.useFakeTimers();
    const test = setup();
    test.binding.state.capture = true;
    test.binding.state.captureValue.title = "Keep this draft";
    test.handlers.get("rename")!({ path: "Renamed.md" }, "Smoke.md");
    expect(test.binding.path).toBe("Renamed.md");
    expect(test.binding.paneStates.has("Smoke.md\0line:1")).toBe(false);
    expect(test.binding.paneStates.get("Renamed.md\0line:1")?.captureValue.title).toBe("Keep this draft");
    await vi.runAllTimersAsync();
    expect(test.binding.widget.refresh).toHaveBeenCalledTimes(1);
  });

  it("reads unsaved editor content and changes only the widget body through the editor", async () => {
    const test = setup();
    const editor = test.editor(initial.replace("Before", "Unsaved heading"));
    expect(await test.adapter.readNote("Smoke.md")).toContain("Unsaved heading");
    await test.adapter.saveBlock(test.binding, { kind: "initialize" });
    expect(editor.getValue()).toMatch(/^Unsaved heading\n```kanso-todos\nversion: 2/);
    expect(editor.getValue()).toMatch(/```\nAfter\n$/);
    expect(editor.replaceRange).toHaveBeenCalledTimes(1);
    expect(test.vault.read).not.toHaveBeenCalled();
    expect(test.vault.process).not.toHaveBeenCalled();
    expect(test.binding.paneStates.get(`Smoke.md\0${test.binding.target.id}`)).toBe(test.binding.state);
  });

  it("refuses writes when open editors disagree", async () => {
    const test = setup();
    const first = test.editor(initial);
    const second = test.editor(initial + "Unsaved\n");
    await expect(test.adapter.saveBlock(test.binding, { kind: "initialize" }))
      .rejects.toThrow("Open editors disagree");
    expect(first.replaceRange).not.toHaveBeenCalled();
    expect(second.replaceRange).not.toHaveBeenCalled();
    expect(test.vault.process).not.toHaveBeenCalled();
  });

  it("serializes background mutations and rereads the current fence for each write", async () => {
    const test = setup();
    const value = { title: "First", status: "todo" as const, priority: "" as const, dueDate: "", sourceNote: "" };
    await Promise.all([
      test.adapter.saveBlock(test.binding, {
        kind: "add", id: "td_first", value, createdAt: "2026-10-25T10:00:00Z",
      }),
      test.adapter.saveBlock(test.binding, {
        kind: "add", id: "td_second", value: { ...value, title: "Second" }, createdAt: "2026-10-25T10:00:00Z",
      }),
    ]);
    const source = test.text().split("```kanso-todos\n")[1]!.split("```")[0]!;
    expect(readTodos(source).data.todos.map(todo => todo.id)).toEqual(["td_second", "td_first"]);
    expect(test.vault.process).toHaveBeenCalledTimes(2);
    expect(test.text()).toMatch(/^Before\n/);
    expect(test.text()).toMatch(/After\n$/);
  });

  it("cancels pending refreshes and refuses writes after unload", async () => {
    vi.useFakeTimers();
    const test = setup();
    test.handlers.get("modify")!({ path: "Smoke.md" });
    test.cleanups.forEach(cleanup => cleanup());
    await vi.runAllTimersAsync();
    expect(test.binding.widget.refresh).not.toHaveBeenCalled();
    await expect(test.adapter.saveBlock(test.binding, { kind: "initialize" })).rejects.toThrow("unloaded");
    expect(test.vault.process).not.toHaveBeenCalled();
  });
});
