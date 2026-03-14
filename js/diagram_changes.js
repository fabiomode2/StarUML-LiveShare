function highlightElement(viewId, color) {
  const view = app.repository.get(viewId);
  const diagramArea = app.diagrams.$diagramArea[0];

  if (view && view instanceof type.View) {
    const rect = {
      left: view.left,
      top: view.top,
      width: view.width,
      height: view.height,
    };

    const hl = document.createElement("div");
    hl.className = "element-lock-highlight";
    hl.style.cssText = `
      position: absolute;
      border: 3px solid ${color};
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      pointer-events: none;
      z-index: 5;
    `;
    diagramArea.appendChild(hl);
  }
}
