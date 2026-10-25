import { setIcon } from "obsidian";

export function element<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement, tag: K, className: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = parent.ownerDocument.createElement(tag);
  node.className = className;

  if (text !== undefined) node.textContent = text;

  parent.append(node);
  return node;
}

/**
 * Adds a screen-reader name without `aria-label`, which Obsidian also treats
 * as an automatic hover-tooltip trigger.
 */
export function accessibleLabel(node: HTMLElement, label: string): void {
  const id = node.getAttribute("aria-labelledby");
  let text = id ? node.ownerDocument.getElementById(id) : null;

  if (!text) {
    text = node.ownerDocument.createElement("span");
    text.id = `kanso-label-${crypto.randomUUID()}`;
    text.hidden = true;
    node.after(text);
    node.setAttribute("aria-labelledby", text.id);
  }

  text.textContent = label;
}

export function button(
  parent: HTMLElement, label: string, icon?: string | null, className = "kanso-icon-button",
): HTMLButtonElement {
  const node = element(parent, "button", className, icon === undefined ? label : undefined);
  node.type = "button";

  accessibleLabel(node, label);
  if (typeof icon === "string") setIcon(node, icon);

  return node;
}
