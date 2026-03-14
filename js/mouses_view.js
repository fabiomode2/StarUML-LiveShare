let cursors = {};
const LERP_SPEED = 0.25;

function LERP(start, dest, speed) {
  return start + speed * (dest - start);
}

function updateMousePosition({ id, x, y, diagram, name }) {
  if (!cursors[id]) {
    addCursor(id, name || "Anonymous");
  }

  // Guardamos el destino. El LERP se encargará de moverlo en el loop
  cursors[id].targetX = x;
  cursors[id].targetY = y;
  cursors[id].diagram = diagram;

  // Solo mostrar si está en el mismo diagrama que nosotros
  const currentDiagram = app.diagrams.getCurrentDiagram();
  if (currentDiagram && currentDiagram._id === diagram) {
    cursors[id].element.style.display = "block";
  } else {
    cursors[id].element.style.display = "none";
  }
}

function addCursor(id, name) {
  const container = app.diagrams.$diagramArea[0];
  const colors = [
    "#FF5733", // rojo-naranja
    "#33FF57", // verde
    "#3357FF", // azul
    "#F333FF", // magenta
    "#FFB833", // naranja
    "#33FFF3", // cian
    "#8E44AD", // púrpura
    "#2ECC71", // verde oscuro
    "#1ABC9C", // turquesa
  ];

  const foregroundColors = [
    "#000000", // para #FF5733
    "#000000", // para #33FF57
    "#FFFFFF", // para #3357FF
    "#000000", // para #F333FF
    "#000000", // para #FFB833
    "#000000", // para #33FFF3
    "#FFFFFF", // para #8E44AD
    "#000000", // para #2ECC71
    "#000000", // para #1ABC9C
  ];

  const i = Math.floor(Math.random() * colors.length);

  const color = colors[i];
  const fg = foregroundColors[i];

  const el = document.createElement("div");
  el.id = `cursor-${id}`;
  el.className = "live-share-cursor";

  el.innerHTML = `
    <svg style="fill: ${color}; width: 20px; filter: drop-shadow(1px 1px 1px rgba(0,0,0,0.4));" viewBox="0 0 24 24">
      <path d="M7,2l12,11.2l-5.8,0.5l3.3,7.3l-2.2,1l-3.2-7.4L7,19V2z"/>
    </svg>
    <div class="cursor-label" style="background: ${color}; color: ${fg};">${name}</div>
  `;
  container.appendChild(el);

  cursors[id] = {
    id: id,
    name: name,
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
    element: el,
  };
}

function removeCursor(id) {
  if (cursors[id]) {
    if (cursors[id].element) {
      cursors[id].element.style.display = "none";
      cursors[id].element.remove();
    }
    delete cursors[id];
  }
}

function animate() {
  const scale = app.diagrams.getZoomLevel();

  for (let id in cursors) {
    const c = cursors[id];

    // Aplicamos el LERP para suavizar el movimiento
    c.x = LERP(c.x, c.targetX, LERP_SPEED);
    c.y = LERP(c.y, c.targetY, LERP_SPEED);

    // Actualizamos la posición física (multiplicamos por escala para que encaje)
    if (c.element) {
      c.element.style.transform = `translate(${c.x * scale}px, ${c.y * scale}px)`;
    }
  }
  requestAnimationFrame(animate);
}

function removeAllCursors() {
  for (const [key, value] of Object.entries(cursors)) {
    removeCursor(key);
  }
}

animate();

module.exports = {
  updateMousePosition,
  addCursor,
  removeCursor,
  removeAllCursors,
};
