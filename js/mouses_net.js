let lastTimeMMsended = 0;
let lastMPsent = { x: 0, y: 0 };
const SEND_INTERVAL = 100; //ms

// app.diagrams.getZoomLevel()

function addMouseMovementSharing(sendFunction) {
  const diagramArea = app.diagrams.$diagramArea[0];

  if (!diagramArea) {
    console.error("Couldnt find diagram area! aMMS");
    return;
  }

  diagramArea.addEventListener("mousemove", (event) => {
    const now = Date.now();

    if (now - lastTimeMMsended >= SEND_INTERVAL) {
      const editor = app.diagrams.diagramEditor;
      if (editor) {
        // TODO
        // falta añadir a la posicion la posicion DENTRO del diagrama
        const scale = app.diagrams.getZoomLevel();
        const rect = diagramArea.getBoundingClientRect();
        const dataToSend = {
          x: (event.clientX - rect.left) / scale,
          y: (event.clientY - rect.top) / scale,
          diagramId: editor.diagram._id,
        };

        if (lastMPsent.x == dataToSend.x && lastMPsent.y == dataToSend.y)
          return; //dont send if mouse hasent moved

        sendFunction(dataToSend);

        lastTimeMMsended = now;
        lastMPsent.x = dataToSend.x;
        lastMPsent.y = dataToSend.y;
      }
    }
  });
}

module.exports = {
  addMouseMovementSharing: addMouseMovementSharing,
};
