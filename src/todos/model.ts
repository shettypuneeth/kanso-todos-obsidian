import { readYamlDocument } from "../core/yaml";

export type TodoStatus = "todo" | "doing" | "completed";
export type TodoPriority = "P0" | "P1" | "P2";

export interface TodoReference {
  note: string;
  block_id: string;
  todo_id: string;
  date: string;
}

export interface Todo {
  id?: string;
  title: string;
  status: TodoStatus;
  priority?: TodoPriority;
  created_at: string;
  completed_at?: string;
  due_date?: string;
  source_note?: string;
  rollover?: {
    previous?: TodoReference;
    next?: TodoReference;
  };
}

export interface TodoCollection {
  version: 2;
  id?: string;
  title?: string;
  todos: Todo[];
}

export function newTodoId(prefix: "kt" | "td"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a YAML mapping.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, required = false): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new Error(`${name} must be ${required ? "a nonempty" : "a"} string.`);
  }
}

function timestamp(value: unknown, name: string, required = false): void {
  text(value, name, required);

  if (typeof value === "string" && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) {
    throw new Error(`${name} must be a quoted UTC ISO-8601 timestamp.`);
  }

  if (typeof value === "string" && !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} is not a valid timestamp.`);
  }
}

export function parseLocalDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Due date must use YYYY-MM-DD.");
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year!, month! - 1, day, 12);

  if (date.getFullYear() !== year || date.getMonth() !== month! - 1 || date.getDate() !== day) {
    throw new Error("Due date is not a valid calendar date.");
  }

  return date;
}

export function validateTodoCollection(value: unknown): asserts value is TodoCollection {
  const root = record(value, "Block");

  if (root.version !== 2) throw new Error("Unsupported schema version. Expected version: 2.");
  if (root.id !== undefined) text(root.id, "Block id", true);
  if (root.title !== undefined) text(root.title, "List title", true);
  if (!Array.isArray(root.todos)) throw new Error("todos must be a YAML list.");

  const ids = new Set<string>();

  root.todos.forEach((entry, index) => {
    const name = `Todo ${index + 1}`;
    const todo = record(entry, name);

    if (todo.id !== undefined) {
      text(todo.id, `${name} id`, true);
      const id = todo.id as string;
      if (ids.has(id)) throw new Error(`Duplicate todo id: ${id}. Fix it in Source mode.`);
      ids.add(id);
    }

    text(todo.title, `${name} title`, true);
    if (todo.status !== "todo" && todo.status !== "doing" && todo.status !== "completed") {
      throw new Error(`${name} status must be todo, doing, or completed.`);
    }
    if (todo.priority !== undefined && todo.priority !== "P0" && todo.priority !== "P1" && todo.priority !== "P2") {
      throw new Error(`${name} priority must be P0, P1, or P2.`);
    }
    timestamp(todo.created_at, `${name} created_at`, true);
    timestamp(todo.completed_at, `${name} completed_at`);
    if (todo.source_note !== undefined) text(todo.source_note, `${name} source_note`, true);

    if (todo.due_date !== undefined) {
      text(todo.due_date, `${name} due_date`, true);
      parseLocalDate(todo.due_date as string);
    }

    if (todo.rollover !== undefined) {
      const rollover = record(todo.rollover, `${name} rollover`);
      text(root.id, "Block id for rollover", true);
      text(todo.id, `${name} id for rollover`, true);
      if (rollover.previous === undefined && rollover.next === undefined) {
        throw new Error(`${name} rollover must include previous or next.`);
      }

      for (const direction of ["previous", "next"] as const) {
        if (rollover[direction] === undefined) continue;
        const reference = record(rollover[direction], `${name} rollover.${direction}`);
        for (const field of ["note", "block_id", "todo_id", "date"]) {
          text(reference[field], `${name} rollover.${direction}.${field}`, true);
        }
        const note = reference.note as string;
        if (!note.endsWith(".md") || note.includes("\\") ||
          note.split("/").some(part => !part || part === "." || part === "..")) {
          throw new Error(`${name} rollover.${direction}.note must be a vault-relative Markdown path including .md.`);
        }
        try {
          parseLocalDate(reference.date as string);
        } catch {
          throw new Error(`${name} rollover.${direction}.date must be a valid YYYY-MM-DD calendar date.`);
        }
        if (reference.todo_id === todo.id) {
          throw new Error(`${name} rollover cannot reference its own task id.`);
        }
      }

      if (rollover.next !== undefined && todo.status === "completed") {
        throw new Error(`${name} cannot be completed and moved out.`);
      }
      if (rollover.previous && rollover.next &&
        (rollover.previous as TodoReference).todo_id === (rollover.next as TodoReference).todo_id) {
        throw new Error(`${name} rollover previous and next must be different entries.`);
      }
    }
  });
}

export function readTodos(source: string) {
  const document = readYamlDocument(source);
  const data = record(source.trim()
    ? document.toJS()
    : { version: 2, title: "Tasks", todos: [] }, "Block");
  if (data.todos === undefined) data.todos = [];

  validateTodoCollection(data);
  return { document, data };
}

export function dueDateDisplay(value: string, now = new Date()): { label: string; overdue: boolean } {
  const date = parseLocalDate(value);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const difference = Math.round((date.getTime() - today.getTime()) / 86_400_000);

  if (difference === 0) return { label: "Today", overdue: false };
  if (difference === 1) return { label: "Tomorrow", overdue: false };

  return {
    label: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date),
    overdue: difference < 0,
  };
}
