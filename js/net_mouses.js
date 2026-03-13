const server = require("./js/server.js");

let lastTimeMMsended = 0;
let lastMPsent = { x: 0, y: 0 };
const SEND_INTERVAL = 100; //ms

function addMouseMovementSharing() {
  const diagramArea = app.diagrams.$diagramArea[0];

  if (!diagramArea) {
    console.error("Couldnt find diagram area! aMMS");
    return;
  }

  diagramArea.addEventListener("mousemove", (event) => {
    const now = Date.now();

    if (now - lastTimeMMsended >= SEND_INTERVAL) {
      const editor = app.diagramManager.getDiagramEditor();
      if (editor) {
        const diagramPos = editor.getRelativeLogics(event);

        const dataToSend = {
          x: diagramPos.x,
          y: diagramPos.y,
          diagramId: app.diagrams.getCurrentDiagram()._id,
        };

        if (lastMPsent.x == data.x && lastMPsent.y == data.y) return; //dont send if mouse hasent moved

        sendMousePosition(dataToSend);

        lastTimeMMsended = now;
        lastMPsent.x = dataToSend.x;
        lastMPsent.y = dataToSend.y;

        console.log("Mouse pos sent:", dataToSend);
      }
    }
  });
}

function sendMousePosition(data) {
  // Tu lógica para enviar los datos a los otros usuarios
  // Ejemplo: socket.emit('mouse-move', data);
}
