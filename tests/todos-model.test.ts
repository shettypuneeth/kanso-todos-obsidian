import { describe, expect, it } from "vitest";
import { dueDateDisplay, readTodos, type Todo, type TodoReference } from "../src/todos/model";
import {
  fences,
  locateTodoBlock,
  locateTodoEntry,
  mutateTodoNote,
  TodoConflictError,
  todoFields,
  type TodoMutation,
} from "../src/todos/persistence";

const source = `# keep root comment
version: 2
id: kt_test
title: Tasks
extra: preserve
todos:
  - id: td_first
    title: Testing
    status: todo
    priority: P1
    created_at: "2026-10-04T10:30:00.000Z"
    due_date: "2026-10-21"
    custom: keep task field
`;
const wrap = (body: string) => `Before\n\n\`\`\`kanso-todos\n${body}\`\`\`\n\nAfter\n`;
const target = { id: "kt_test", line: 2, source };
const next: TodoReference = {
  note: "Daily/2026-10-28.md", block_id: "kt_next", todo_id: "td_next", date: "2026-10-28",
};
const previous: TodoReference = {
  note: "Daily/2025-12-31.md", block_id: "kt_previous", todo_id: "td_previous", date: "2025-12-31",
};
const rolloverSource = (rollover: unknown, changes = {}) => JSON.stringify({
  version: 2,
  id: "kt_test",
  todos: [{ ...readTodos(source).data.todos[0], rollover, ...changes }],
});

describe("agent-authored rollover metadata", () => {
  it("reads outgoing, incoming and middle entries without changing status or dates", () => {
    for (const rollover of [{ previous }, { next }, { previous, next }]) {
      const todo = readTodos(rolloverSource(rollover, { status: "doing" })).data.todos[0]!;
      expect(todo).toMatchObject({
        rollover, status: "doing", priority: "P1", due_date: "2026-10-21",
        created_at: "2026-10-04T10:30:00.000Z",
      });
    }
  });

  it.each([
    null,
    {},
    { next: null },
    { next: { ...next, todo_id: "" } },
    { next: { ...next, block_id: 42 } },
    { next: { ...next, note: "../Daily/2026-10-28.md" } },
    { next: { ...next, note: "/Daily/2026-10-28.md" } },
    { next: { ...next, note: "[[Daily/2026-10-28]]" } },
    { next: { ...next, date: "2026-02-30" } },
    { next: { ...next, todo_id: "td_first" } },
    { previous: next, next },
  ])("rejects malformed or locally contradictory relationships: %j", rollover => {
    expect(() => readTodos(rolloverSource(rollover))).toThrow();
  });

  it("requires stable entry/block IDs and refuses completed outgoing entries", () => {
    expect(() => readTodos(rolloverSource({ next }, { id: undefined }))).toThrow("id for rollover");
    const withoutBlock = JSON.parse(rolloverSource({ next }));
    delete withoutBlock.id;
    expect(() => readTodos(JSON.stringify(withoutBlock))).toThrow("Block id for rollover");
    expect(() => readTodos(rolloverSource({ next }, { status: "completed" }))).toThrow("completed and moved out");
  });

  it("blocks all historical mutations, including stale edits", () => {
    const body = rolloverSource({ previous, next });
    const original = readTodos(source).data.todos[0]!;
    const fields = todoFields(original);
    const mutations: TodoMutation[] = [
      { kind: "complete", id: "td_first", completed: true, completedAt: "2026-10-28T12:00:00Z" },
      { kind: "complete", id: "td_first", completed: false, completedAt: "2026-10-28T12:00:00Z" },
      { kind: "status", id: "td_first", status: "doing" },
      { kind: "priority", id: "td_first", priority: "P0" },
      { kind: "edit", id: "td_first", expected: fields, value: { ...fields, title: "Changed" } },
      { kind: "delete", id: "td_first" },
    ];
    for (const mutation of mutations) {
      expect(() => mutateTodoNote(wrap(`${body}\n`), target, mutation)).toThrow("Moved tasks are read-only");
    }
  });

  it("preserves incoming metadata on edit/completion and allows latest-entry deletion", () => {
    const body = `${source}    rollover:\n      previous:\n        note: ${previous.note}\n        block_id: ${previous.block_id}\n        todo_id: ${previous.todo_id}\n        date: "${previous.date}" # retain relationship comment\n`;
    const todo = readTodos(body).data.todos[0] as Todo;
    const edited = mutateTodoNote(wrap(body), target, {
      kind: "edit", id: "td_first", expected: todoFields(todo),
      value: { ...todoFields(todo), title: "Edited incoming task" },
    });
    const completed = mutateTodoNote(edited.text, target, {
      kind: "complete", id: "td_first", completed: true, completedAt: "2026-10-28T12:00:00Z",
    });
    expect(readTodos(completed.source).data.todos[0]).toMatchObject({
      status: "completed", rollover: { previous }, due_date: "2026-10-21",
    });
    expect(completed.source).toContain("# retain relationship comment");
    expect(completed.source).toContain("custom: keep task field");
    const deleted = mutateTodoNote(completed.text, target, { kind: "delete", id: "td_first" });
    expect(readTodos(deleted.source).data.todos).toEqual([]);
  });

  it("locates exact entries across multiple blocks and duplicate titles, including CRLF", () => {
    const other = source.replace("kt_test", "kt_other").replace("td_first", "td_other");
    const text = `${wrap(other)}${wrap(source)}`.replace(/\n/g, "\r\n");
    const reference = { ...next, block_id: "kt_test", todo_id: "td_first" };
    const entry = locateTodoEntry(text, reference);
    expect(entry.todo.id).toBe("td_first");
    expect(text.split("\r\n")[entry.line]).toContain("id: td_first");
    expect(() => locateTodoEntry(text, { ...reference, todo_id: "missing" })).toThrow("linked task no longer exists");
    expect(() => locateTodoEntry(text, { ...reference, block_id: "missing" })).toThrow("removed");
    expect(() => locateTodoEntry(`${text}${wrap(source)}`, reference)).toThrow("Duplicate widget block id");
    const duplicateTask = source + source.slice(source.indexOf("  - id:"));
    expect(() => locateTodoEntry(wrap(duplicateTask), reference)).toThrow("Duplicate todo id");
  });
});

describe("todo YAML schema and safe mutation", () => {
  it("reads a named empty list without modifying its YAML document", () => {
    const { data, document } = readTodos("version: 2\ntitle: My tasks\n");
    expect(data).toEqual({ version: 2, title: "My tasks", todos: [] });
    expect(document.has("todos")).toBe(false);
    expect(document.toString()).toBe("version: 2\ntitle: My tasks\n");
  });

  it("creates the missing list on first add while preserving its title, comments and unknown fields", () => {
    const body = "# Named template\nversion: 2\nid: kt_named\ntitle: My tasks\ncustom: keep\n";
    const result = mutateTodoNote(wrap(body), { id: "kt_named", line: 2, source: body }, {
      kind: "add", id: "td_new",
      value: { title: "First task", status: "todo", priority: "", dueDate: "", sourceNote: "" },
      createdAt: "2026-10-25T10:00:00Z",
    });
    expect(readTodos(result.source).data).toMatchObject({
      id: "kt_named", title: "My tasks", todos: [{ id: "td_new", title: "First task" }],
    });
    expect(result.source).toContain("# Named template");
    expect(result.source).toContain("custom: keep");
    expect(result.text).toMatch(/^Before\n\n```kanso-todos\n/);
    expect(result.text).toMatch(/```\n\nAfter\n$/);
  });

  it.each(["", "null", "text", "{}", "false"])("still rejects an explicit non-list todos value: %j", value => {
    expect(() => readTodos(`version: 2\ntitle: My tasks\ntodos: ${value}\n`)).toThrow("todos must be a YAML list");
  });

  it("reads a blank template and initializes it on first add", () => {
    expect(readTodos("").data).toEqual({ version: 2, title: "Tasks", todos: [] });

    const result = mutateTodoNote(wrap(""), { line: 2, source: "" }, {
      kind: "add",
      id: "td_new",
      value: { title: "First task", status: "todo", priority: "", dueDate: "", sourceNote: "" },
      createdAt: "2026-10-04T10:30:00.000Z",
    });

    const data = readTodos(result.source).data;
    expect(data.id).toMatch(/^kt_/);
    expect(data.title).toBe("Tasks");
    expect(data.todos[0]).toMatchObject({ id: "td_new", title: "First task", status: "todo" });
    expect(data.todos[0]?.priority).toBeUndefined();
  });

  it("preserves comments, unknown fields, YAML order and unrelated note text", () => {
    const added = mutateTodoNote(wrap(source), target, {
      kind: "add",
      id: "td_new",
      value: {
        title: "Newest",
        status: "doing",
        priority: "P0",
        dueDate: "2026-10-24",
        sourceNote: "Projects/Kanso",
      },
      createdAt: "2026-10-04T11:00:00.000Z",
    });

    expect(readTodos(added.source).data.todos.map(todo => todo.id)).toEqual(["td_new", "td_first"]);
    expect(readTodos(added.source).data.todos[0]).toMatchObject({
      due_date: "2026-10-24",
      status: "doing",
      priority: "P0",
      source_note: "Projects/Kanso",
    });
    expect(added.source).toContain("# keep root comment");
    expect(added.source).toContain("extra: preserve");
    expect(added.source).toContain("custom: keep task field");
    expect(added.text.startsWith("Before\n\n```kanso-todos\n")).toBe(true);
    expect(added.text.endsWith("```\n\nAfter\n")).toBe(true);
  });

  it("sets and clears completion timestamps without reordering YAML", () => {
    const completed = mutateTodoNote(wrap(source), target, {
      kind: "complete",
      id: "td_first",
      completed: true,
      completedAt: "2026-10-04T12:00:00.000Z",
    });
    expect(readTodos(completed.source).data.todos[0]).toMatchObject({
      status: "completed",
      completed_at: "2026-10-04T12:00:00.000Z",
    });

    const reopened = mutateTodoNote(completed.text, target, {
      kind: "complete",
      id: "td_first",
      completed: false,
      completedAt: "2026-10-04T13:00:00.000Z",
    });
    expect(readTodos(reopened.source).data.todos[0]?.status).toBe("todo");
    expect(readTodos(reopened.source).data.todos[0]?.completed_at).toBeUndefined();
  });

  it("updates active status and edits supported fields narrowly with conflict detection", () => {
    const doing = mutateTodoNote(wrap(source), target, {
      kind: "status",
      id: "td_first",
      status: "doing",
    });
    expect(readTodos(doing.source).data.todos[0]).toMatchObject({ status: "doing", priority: "P1" });

    const reprioritized = mutateTodoNote(doing.text, target, {
      kind: "priority",
      id: "td_first",
      priority: "P2",
    });
    expect(readTodos(reprioritized.source).data.todos[0]?.priority).toBe("P2");

    const expected = {
      title: "Testing",
      status: "doing" as const,
      priority: "P2" as const,
      dueDate: "2026-10-21",
      sourceNote: "",
    };
    const edited = mutateTodoNote(reprioritized.text, target, {
      kind: "edit",
      id: "td_first",
      expected,
      value: {
        title: "Updated",
        status: "todo",
        priority: "",
        dueDate: "",
        sourceNote: "Daily Notes/2026-10-04",
      },
    });
    const todo = readTodos(edited.source).data.todos[0]!;

    expect(todo).toMatchObject({
      title: "Updated",
      status: "todo",
      source_note: "Daily Notes/2026-10-04",
    });
    expect(todo.priority).toBeUndefined();
    expect(todo.due_date).toBeUndefined();
    expect(edited.source).toContain("custom: keep task field");
    expect(() => mutateTodoNote(edited.text, target, {
      kind: "edit",
      id: "td_first",
      expected,
      value: expected,
    })).toThrow(TodoConflictError);
  });

  it("deletes only the selected task and safely locates todo fences", () => {
    const deleted = mutateTodoNote(wrap(source), target, { kind: "delete", id: "td_first" });
    expect(readTodos(deleted.source).data.todos).toEqual([]);
    expect(fences(`~~~kanso-todos\n${source}~~~\n`)).toHaveLength(1);
    expect(fences(`\`\`\`kanso-bookmarks\n${source}\`\`\`\n`)).toEqual([]);
    expect(() => locateTodoBlock(`${wrap(source)}\n${wrap(source)}`, target)).toThrow("Duplicate widget block id");
  });

  it.each([
    "version: 1\ntodos: []",
    "version: 2\ntodos: nope",
    "version: 2\ntodos:\n  - title: Test\n    status: pending\n    created_at: \"2026-10-04T10:30:00Z\"",
    "version: 2\ntodos:\n  - title: Test\n    status: todo\n    priority: urgent\n    created_at: \"2026-10-04T10:30:00Z\"",
    "version: 2\ntodos:\n  - title: Test\n    status: todo\n    created_at: nope",
    "version: 2\ntodos:\n  - title: Test\n    status: todo\n    created_at: \"2026-10-04T10:30:00Z\"\n    due_date: \"2026-02-30\"",
    "version: 1\ntodos:\n  - title: Test\n    completed: false\n    created_at: \"2026-10-04T10:30:00Z\"",
  ])("rejects invalid todo data: %s", value => {
    expect(() => readTodos(value)).toThrow();
  });

  it("formats due dates using local calendar semantics", () => {
    const now = new Date(2026, 9, 4, 18);
    expect(dueDateDisplay("2026-10-04", now)).toEqual({ label: "Today", overdue: false });
    expect(dueDateDisplay("2026-10-05", now)).toEqual({ label: "Tomorrow", overdue: false });
    expect(dueDateDisplay("2026-10-21", now)).toEqual({ label: "21 Oct", overdue: false });
    expect(dueDateDisplay("2026-10-03", now)).toEqual({ label: "3 Oct", overdue: true });
  });
});
