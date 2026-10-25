import { isNode, isScalar, isSeq, Scalar } from "yaml";
import {
  type BlockTarget,
  type Fence,
  fences as findFences,
  locateBlock as locateWidgetBlock,
} from "../core/block";
import {
  newTodoId,
  readTodos,
  type Todo,
  type TodoPriority,
  type TodoReference,
  type TodoStatus,
} from "./model";

export type { BlockTarget, Fence } from "../core/block";

export interface TodoEditableFields {
  title: string;
  status: TodoStatus;
  priority: TodoPriority | "";
  dueDate: string;
  sourceNote: string;
}

export type TodoMutation =
  | { kind: "initialize" }
  | { kind: "add"; id: string; value: TodoEditableFields; createdAt: string }
  | { kind: "status"; id: string; status: Exclude<TodoStatus, "completed"> }
  | { kind: "priority"; id: string; priority: TodoPriority }
  | { kind: "complete"; id: string; completed: boolean; completedAt: string }
  | { kind: "edit"; id: string; value: TodoEditableFields; expected: TodoEditableFields }
  | { kind: "delete"; id: string };

export class TodoConflictError extends Error {
  constructor(public readonly current: TodoEditableFields) {
    super("This task changed elsewhere. Your draft is kept. Save again to replace the newer values, or Cancel.");
  }
}

export function todoFields(todo: Todo): TodoEditableFields {
  return {
    title: todo.title,
    status: todo.status,
    priority: todo.priority ?? "",
    dueDate: todo.due_date ?? "",
    sourceNote: todo.source_note ?? "",
  };
}

export function fences(text: string): Fence[] {
  return findFences(text, "kanso-todos");
}

export function locateTodoBlock(text: string, target: BlockTarget): Fence {
  return locateWidgetBlock(text, target, "kanso-todos");
}

export function locateTodoEntry(text: string, reference: TodoReference) {
  const fence = locateTodoBlock(text, { id: reference.block_id, line: -1, source: "" });
  const { document, data } = readTodos(fence.source);
  const index = data.todos.findIndex(todo => todo.id === reference.todo_id);
  if (index < 0) throw new Error("The linked task no longer exists.");
  const node = document.getIn(["todos", index], true);
  const offset = isNode(node) ? node.range?.[0] ?? 0 : 0;
  const line = fence.line + 1 + fence.source.slice(0, offset).split("\n").length - 1;
  return { line, todo: data.todos[index]! };
}

function quoted(document: ReturnType<typeof readTodos>["document"], value: string) {
  const node = document.createNode(value);
  if (isScalar(node)) node.type = Scalar.QUOTE_DOUBLE;
  return node;
}

export function mutateTodoNote(text: string, target: BlockTarget, mutation: TodoMutation) {
  const fence = locateTodoBlock(text, target);
  const { document, data } = readTodos(fence.source);

  if (!fence.source.trim()) {
    document.set("version", 2);
    document.set("title", "Tasks");
  }
  if (!document.has("todos")) {
    document.set("todos", document.createNode([]));
  }

  const blockId = data.id ?? newTodoId("kt");
  document.set("id", blockId);

  data.todos.forEach((todo, index) => {
    if (!todo.id) document.setIn(["todos", index, "id"], newTodoId("td"));
  });

  if (mutation.kind === "add") {
    const title = mutation.value.title.trim();
    if (!title) throw new Error("Task title cannot be empty.");

    const list = document.get("todos", true);
    if (!isSeq(list)) throw new Error("todos must be a list.");

    const value: Record<string, string | boolean> = {
      id: mutation.id,
      title,
      status: mutation.value.status,
      created_at: mutation.createdAt,
    };
    if (mutation.value.priority) value.priority = mutation.value.priority;
    const dueDate = mutation.value.dueDate.trim();
    const sourceNote = mutation.value.sourceNote.trim();
    if (dueDate) value.due_date = dueDate;
    if (sourceNote) value.source_note = sourceNote;

    const entry = document.createNode(value);

    const createdAt = entry.get("created_at", true);
    if (isScalar(createdAt)) createdAt.type = Scalar.QUOTE_DOUBLE;
    const dueDateNode = entry.get("due_date", true);
    if (isScalar(dueDateNode)) dueDateNode.type = Scalar.QUOTE_DOUBLE;
    list.items.unshift(entry);
  } else if (mutation.kind !== "initialize") {
    const index = data.todos.findIndex(todo => todo.id === mutation.id);
    if (index < 0) throw new Error("This task no longer exists. No changes were saved.");

    const todo = data.todos[index]!;
    if (todo.rollover?.next) {
      throw new Error("Moved tasks are read-only. Open the next task to make changes.");
    }
    const path = ["todos", index];

    if (mutation.kind === "delete") document.deleteIn(path);

    if (mutation.kind === "status") {
      document.setIn([...path, "status"], mutation.status);
      document.deleteIn([...path, "completed_at"]);
    }

    if (mutation.kind === "priority") {
      document.setIn([...path, "priority"], mutation.priority);
    }

    if (mutation.kind === "complete") {
      if (mutation.completed) {
        document.setIn([...path, "status"], "completed");
        document.setIn([...path, "completed_at"], quoted(document, mutation.completedAt));
      } else {
        document.setIn([...path, "status"], "todo");
        document.deleteIn([...path, "completed_at"]);
      }
    }

    if (mutation.kind === "edit") {
      const current = todoFields(todo);
      if (JSON.stringify(current) !== JSON.stringify(mutation.expected)) {
        throw new TodoConflictError(current);
      }

      const title = mutation.value.title.trim();
      if (!title) throw new Error("Task title cannot be empty.");

      document.setIn([...path, "title"], title);
      document.setIn([...path, "status"], mutation.value.status);

      if (mutation.value.priority) document.setIn([...path, "priority"], mutation.value.priority);
      else document.deleteIn([...path, "priority"]);

      const dueDate = mutation.value.dueDate.trim();
      if (dueDate) document.setIn([...path, "due_date"], quoted(document, dueDate));
      else document.deleteIn([...path, "due_date"]);

      const sourceNote = mutation.value.sourceNote.trim();
      if (sourceNote) document.setIn([...path, "source_note"], sourceNote);
      else document.deleteIn([...path, "source_note"]);
    }
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const source = document.toString({ lineWidth: 0 }).replace(/\n/g, eol);

  readTodos(source);

  return {
    text: text.slice(0, fence.start) + source + text.slice(fence.end),
    start: fence.start,
    end: fence.end,
    source,
    blockId,
  };
}
