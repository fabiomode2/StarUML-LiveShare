let lastTimeMMsended = 0;
let lastMPsent = { x: 0, y: 0 };
const SEND_INTERVAL = 100; //ms
let currentHandler = null;

// app.diagrams.getZoomLevel()

function addMouseMovementSharing(sendFunction) {
  const diagramArea = app.diagrams.$diagramArea[0];

  if (!diagramArea) {
    console.error("Couldnt find diagram area! aMMS");
    return;
  }

  currentHandler = (event) => {
    const now = Date.now();

    if (now - lastTimeMMsended >= SEND_INTERVAL) {
      const activeDiagram = app.diagrams.getCurrentDiagram();
      if (!activeDiagram) return;

      const editor = app.diagrams;

      if (editor) {
        // TODO
        // añadir icono al minimapa (canvas id="minimap") (diagramArea.nextElementSibling) (opcional)
        // añadir icono al workin diagrams (app.sidebar.$workingDiagrams)
        const diagramX = activeDiagram._originX;
        const diagramY = activeDiagram._originY;
        const scale = app.diagrams.getZoomLevel();
        const rect = diagramArea.getBoundingClientRect();
        let diagram = activeDiagram._id;

        const dataToSend = {
          x: (event.clientX - rect.left) / scale - diagramX,
          y: (event.clientY - rect.top) / scale - diagramY,
          diagram: diagram,
        };

        if (lastMPsent.x == dataToSend.x && lastMPsent.y == dataToSend.y)
          return; //dont send if mouse hasent moved

        sendFunction(dataToSend);

        lastTimeMMsended = now;
        lastMPsent.x = dataToSend.x;
        lastMPsent.y = dataToSend.y;
      }
    }
  };

  diagramArea.addEventListener("mousemove", currentHandler);
}

function removeMouseMovementSharing() {
  const diagramArea = app.diagrams.$diagramArea[0];
  if (diagramArea && currentHandler) {
    diagramArea.removeEventListener("mousemove", currentHandler);
    currentHandler = null;
  }
}

module.exports = {
  addMouseMovementSharing: addMouseMovementSharing,
  removeMouseMovementSharing: removeMouseMovementSharing,
};
