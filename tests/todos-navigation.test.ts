import { describe, expect, it, vi } from "vitest";
import { MarkdownView, TFile } from "obsidian";
import KansoTodosPlugin from "../src/main";
import type { TodoReference } from "../src/todos/model";

vi.mock("obsidian", async importOriginal => ({
  ...await importOriginal<object>(),
  Plugin: class {},
  FuzzySuggestModal: class {},
  MarkdownView: class {},
  TFile: class {},
}));

const reference: TodoReference = {
  note: "Daily/2026-10-28.md", block_id: "kt_target", todo_id: "td_target", date: "2026-10-28",
};
const text = `Before
\`\`\`kanso-todos
version: 2
id: kt_target
todos:
  - id: td_other
    title: Same title
    status: todo
    created_at: "2026-10-25T12:00:00Z"
  - id: td_target
    title: Same title
    status: completed
    created_at: "2026-10-25T12:00:00Z"
\`\`\`
`;

function setup() {
  const file = Object.assign(Object.create(TFile.prototype), { path: reference.note });
  const containerEl = document.createElement("div");
  const widgetElement = containerEl.appendChild(document.createElement("div"));
  widgetElement.getClientRects = vi.fn(() => [{ width: 500, height: 100 }] as unknown as DOMRectList);
  const view = Object.assign(Object.create(MarkdownView.prototype), {
    file, containerEl,
    getMode: vi.fn(() => "preview"),
    getState: vi.fn(() => ({ source: false })),
    editor: { setCursor: vi.fn(), scrollIntoView: vi.fn() },
  });
  const leaf = { view, openFile: vi.fn(async () => {}) };
  const widget = {
    containerEl: widgetElement,
    refresh: vi.fn(async () => {}),
    revealTodo: vi.fn(() => true),
  };
  const bindings = new Set([{
    path: reference.note, target: { id: reference.block_id }, widget,
  }]);
  const readNote = vi.fn(async () => text);
  const vault = { getAbstractFileByPath: vi.fn(() => file), process: vi.fn() };
  const plugin = Object.assign(Object.create(KansoTodosPlugin.prototype), {
    app: { vault, workspace: { getLeaf: () => leaf } },
    readNote, todoBindings: bindings, stopped: false, taskNavigation: 0,
  }) as KansoTodosPlugin;
  const open = (target = reference) =>
    (plugin as unknown as { openTodoReference: (target: TodoReference) => Promise<void> }).openTodoReference(target);
  return { open, view, leaf, widget, bindings, readNote, vault, file };
}

describe("rollover navigation adapter", () => {
  it("opens the exact stored path and reveals the task in the selected pane without writing", async () => {
    const test = setup();
    const otherPaneWidget = { ...test.widget, containerEl: document.createElement("div"), revealTodo: vi.fn() };
    const hiddenWidget = {
      ...test.widget,
      containerEl: test.view.containerEl.appendChild(document.createElement("div")),
      revealTodo: vi.fn(),
    };
    test.bindings.clear();
    test.bindings.add({ path: reference.note, target: { id: reference.block_id }, widget: otherPaneWidget });
    test.bindings.add({ path: reference.note, target: { id: reference.block_id }, widget: hiddenWidget });
    test.bindings.add({ path: reference.note, target: { id: reference.block_id }, widget: test.widget });
    await test.open();
    expect(test.vault.getAbstractFileByPath).toHaveBeenCalledWith(reference.note);
    expect(test.readNote).toHaveBeenCalledWith(reference.note);
    expect(test.leaf.openFile).toHaveBeenCalledWith(test.file, { eState: { line: 9 } });
    expect(test.widget.refresh).toHaveBeenCalled();
    expect(test.widget.revealTodo).toHaveBeenCalledWith("td_target");
    expect(otherPaneWidget.revealTodo).not.toHaveBeenCalled();
    expect(hiddenWidget.revealTodo).not.toHaveBeenCalled();
    expect(test.vault.process).not.toHaveBeenCalled();
  });

  it("navigates to the exact YAML entry in source mode without requiring a rendered widget", async () => {
    const test = setup();
    test.bindings.clear();
    test.view.getMode.mockReturnValue("source");
    test.view.getState.mockReturnValue({ source: true });
    await test.open();
    expect(test.view.editor.setCursor).toHaveBeenCalledWith({ line: 9, ch: 0 });
    expect(test.view.editor.scrollIntoView).toHaveBeenCalledWith({
      from: { line: 9, ch: 0 }, to: { line: 9, ch: 0 },
    }, true);
    expect(test.vault.process).not.toHaveBeenCalled();
  });

  it("rejects missing notes and entries before opening a leaf", async () => {
    const missing = setup();
    missing.vault.getAbstractFileByPath.mockReturnValue(null);
    await expect(missing.open()).rejects.toThrow("Could not find the linked note");
    expect(missing.leaf.openFile).not.toHaveBeenCalled();
    const wrongTask = setup();
    await expect(wrongTask.open({ ...reference, todo_id: "missing" })).rejects.toThrow("linked task no longer exists");
    expect(wrongTask.leaf.openFile).not.toHaveBeenCalled();
  });
});
