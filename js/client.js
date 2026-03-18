const io = require("socket.io-client");
const mm_view = require("./mouses_view.js");
const mm_net = require("./mouses_net.js");
const fachada = require("./fachada.js");
const flatted = require("flatted");

let socket = null;
let current_room = null;
let address = "";
let users = {};
let am_i_host = false;
let isRemoteChange = false;

let activeHighlights = {};

async function connectToServer(url, name, roomid) {
  removeChangesHook();

  return new Promise((resolve, reject) => {
    socket = io(url, {
      transports: ["websocket"],
      reconnectionAttempts: 3,
      timeout: 5000,
      auth: { username: name, room: roomid },
    });

    if (roomid && roomid !== -1) current_room = roomid;

    socket.on("user-joined", (data) => {
      if (!users[data.id]) users[data.id] = data.name;
      fachada.INFO(`${data.name} joined`);
    });

    socket.on("is-host", (is_host) => {
      am_i_host = is_host;
      if (!am_i_host) fachada.disableHostOptions();
      if (am_i_host) fachada.hideLoadingOverlay();
      if (am_i_host) fachada.INFO("You're the host");
    });

    socket.on("room-assigned", async (id) => {
      current_room = id;
      console.log("Room asignada y lista: " + current_room);

      addChangesHook();
      fachada.hideLoadingOverlay();

      resolve(true);
    });

    socket.on("update-mouse-pos", (data) => {
      if (data.id == socket.id) return;
      mm_view.updateMousePosition(data);
    });

    socket.on("get-whole-document", (data) => {
      try {
        const projectObj = app.project.getProject();
        const cleanObject = app.repository.writeObject(projectObj);
        const str = flatted.stringify(cleanObject);
        socket.emit("host-delivers-document", {
          to: data.requesterId,
          json: str,
        });
      } catch (err) {
        app.toast.error("Error al enviar el proyecto al invitado.");
      }
    });

    socket.on("load-whole-document", (data) => {
      try {
        const projectObj = flatted.parse(data.json);
        app.repository.bypassConfirmation = true;
        app.project.loadFromJson(projectObj);
        app.repository.bypassConfirmation = false;
      } catch (err) {
        console.error("Error loading remote project:", err);
      }
      fachada.hideLoadingOverlay();
    });

    socket.on("remote-operation", (opData) => {
      isRemoteChange = true;
      console.log(`Recibida operacion de ${socket.id}`);
      try {
        const operation = flatted.parse(opData);
        app.repository.doOperation(operation);
        app.diagrams.repaint();

        updateAllHighlights();
      } catch (err) {
        console.error("[LiveShare] Operation Error:", err);
      } finally {
        // Un pequeño delay garantiza que todos los eventos síncronos de StarUML terminen
        setTimeout(() => {
          isRemoteChange = false;
        }, 50);
      }
    });

    // CORRECCIÓN VITAL: El execute es Asíncrono
    socket.on("remote-undo", async () => {
      isRemoteChange = true;
      try {
        await app.commands.execute("edit:undo");
      } catch (e) {
        console.error(e);
      } finally {
        setTimeout(() => {
          isRemoteChange = false;
        }, 50);
      }
    });

    socket.on("remote-redo", async () => {
      isRemoteChange = true;
      try {
        await app.commands.execute("edit:redo");
      } catch (e) {
        console.error(e);
      } finally {
        setTimeout(() => {
          isRemoteChange = false;
        }, 50);
      }
    });

    // --- OUTLINE VISUAL ---
    socket.on("element-locked", ({ viewId, ownerId, color }) => {
      if (ownerId !== socket.id) {
        highlightElement(viewId, color);
      }
    });

    socket.on("element-unlocked", ({ viewId }) => {
      removeHighlight(viewId);
    });

    socket.on("user-left", (id) => {
      fachada.INFO(`${users[id]} left`);
      delete users[id];
      mm_view.removeCursor(id);
    });

    socket.on("connect", () => {
      address = url;
      mm_net.addMouseMovementSharing(sendMousePosition);
      fachada.showLoadingOverlay();
      // addChangesHook();
      // resolve(true);
    });

    socket.on("connect_error", (err) => resolve(false));
  });
}

const handleOperation = (operation) => {
  if (isRemoteChange || app.repository.bypassConfirmation) return;
  if (socket && socket.connected && current_room) {
    const str = flatted.stringify(operation);
    //console.log(`Enviando operacion a sala ${current_room}`);
    socket.emit("sync-operation", str);
  }
};

const handleSelection = (models, views) => {
  if (!socket || !socket.connected) return;
  if (views && views.length > 0) {
    socket.emit(
      "lock-element",
      views.map((v) => v._id),
    );
  } else {
    socket.emit("unlock-elements");
  }
};

const handleCommands = (commandId) => {
  if (isRemoteChange || !socket || !socket.connected) return;
  if (commandId === "edit:undo") socket.emit("sync-undo");
  else if (commandId === "edit:redo") socket.emit("sync-redo");
};

function addChangesHook() {
  removeChangesHook();

  app.repository.on("operationExecuted", handleOperation);
  app.commands.on("afterExecute", handleCommands);
  app.selections.on("selectionChanged", handleSelection);
}

function removeChangesHook() {
  app.repository.off("operationExecuted", handleOperation);
  app.commands.off("afterExecute", handleCommands);
  app.selections.off("selectionChanged", handleSelection);
}

// --- FUNCIONES DE HIGHLIGHT ---
function highlightElement(viewId, color) {
  const view = app.repository.get(viewId);
  const diagramArea = app.diagrams.$diagramArea[0];

  if (view && view instanceof type.View) {
    // Evitar duplicados si ya estaba resaltado
    removeHighlight(viewId);

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

    // Lo guardamos para poder borrarlo después
    activeHighlights[viewId] = hl;
  }
}

function removeHighlight(viewId) {
  if (activeHighlights[viewId]) {
    activeHighlights[viewId].remove();
    delete activeHighlights[viewId];
  }
}

function removeAllHighlights() {
  for (let viewId in activeHighlights) {
    activeHighlights[viewId].remove();
  }
  activeHighlights = {};
}

function updateAllHighlights() {
  for (let viewId in activeHighlights) {
    const view = app.repository.get(viewId);
    if (view && view instanceof type.View) {
      const hl = activeHighlights[viewId];
      // Actualizamos las coordenadas en tiempo real
      hl.style.left = `${view.left}px`;
      hl.style.top = `${view.top}px`;
      hl.style.width = `${view.width}px`;
      hl.style.height = `${view.height}px`;
    } else {
      // Si el elemento fue borrado, quitamos el aura
      removeHighlight(viewId);
    }
  }
}

function sendMousePosition({ x, y, diagram }) {
  if (!(socket && socket.connected)) return;
  socket.emit("client-mouse-moved", {
    id: socket.id,
    x: x,
    y: y,
    diagram: diagram,
  });
}

function getConnectedAddress() {
  return address;
}

function requestDocument() {
  if (!(socket && socket.connected)) return;
  fachada.showLoadingOverlay();
  socket.emit("request-doc");
}

function getCurrentRoom() {
  return current_room;
}

function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  address = "";
  removeAllHighlights();
  mm_net.removeMouseMovementSharing();
  mm_view.removeAllCursors();
  fachada.enableHostOptions();
  removeChangesHook();
}

module.exports = {
  connectToServer,
  sendMousePosition,
  disconnect,
  getConnectedAddress,
  requestDocument,
  getCurrentRoom,
};
