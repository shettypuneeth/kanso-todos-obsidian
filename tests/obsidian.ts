export function installDomExtensions(doc: Document): void {
  const { Node } = doc.defaultView as Window & typeof globalThis;
  Node.prototype.createEl = function (tag, options = {}) {
    const node = (this.ownerDocument ?? doc).createElement(tag);
    const info = typeof options === "string" ? { cls: options } : options;
    if (info.cls) node.className = Array.isArray(info.cls) ? info.cls.join(" ") : info.cls;
    if (info.text !== undefined) {
      if (typeof info.text === "string") node.textContent = info.text;
      else node.append(info.text);
    }
    this.appendChild(node);
    return node;
  };
  Object.defineProperty(Node.prototype, "instanceOf", {
    configurable: true,
    value(this: unknown, type: typeof Node) {
      if (this instanceof type) return true;
      const win = (this as Node).ownerDocument?.defaultView;
      const constructor = win && Reflect.get(win, type.name);
      return typeof constructor === "function" && this instanceof constructor;
    },
  });
}

installDomExtensions(document);
globalThis.createSpan = options => document.createDocumentFragment().createEl("span", options);

export class MarkdownRenderChild {
  constructor(public containerEl: HTMLElement) {}
  registerDomEvent(element: HTMLElement, event: string, callback: EventListener) {
    element.addEventListener(event, callback);
  }
}

export class Notice {
  constructor(public message: string) {}
}

export class Menu {
  static latest: Menu;
  items: { title: string; callback: () => void }[] = [];
  constructor() { Menu.latest = this; }
  addItem(build: (item: MenuItem) => void) {
    const item = new MenuItem();
    build(item);
    this.items.push(item);
    return this;
  }
  addSeparator() { return this; }
  setUseNativeMenu() { return this; }
  showAtPosition() {}
  hide() {}
  showAtMouseEvent() {}
}

class MenuItem {
  title = "";
  callback = () => {};
  setTitle(title: string) { this.title = title; return this; }
  setIcon() { return this; }
  setWarning() { return this; }
  setChecked() { return this; }
  onClick(callback: () => void) { this.callback = callback; return this; }
}

export function setIcon(element: HTMLElement, icon: string) {
  const svg = element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("data-icon", icon);
  element.append(svg);
}
