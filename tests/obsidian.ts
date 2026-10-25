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
