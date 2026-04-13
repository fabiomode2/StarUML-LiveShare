const io = require("socket.io-client"); //socket.io
const fachada = require("./fachada.js");
const flatted = require("flatted"); //stringify json
const cursors_js = require("./cursors.js");

let cursors = new cursors_js.CursorsHandler();
let socket = null;
let current_room = null;
let address = ""; // for copy-session-link
let users = {}; // for logging when users leave
let am_i_host = false;
let isRemoteChange = false;
let isLocalUndo = false;
let activeHighlights = {};

async function connectToServer(url, name, roomid) {
  removeChangesHook();

  return new Promise((resolve, reject) => {
    socket = io(url, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
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
      console.log("[LS] Room assigned: " + current_room);

      current_room = id;
      addChangesHook();
      fachada.hideLoadingOverlay();
      resolve(true);
    });

    socket.on("update-mouse-pos", (data) => {
      if (data.id == socket.id) return;
      cursors.updateMousePosition(data);
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
        fachada.ERR("Error sending whole document.");
      }
    });

    socket.on("load-whole-document", (data) => {
      try {
        const projectObj = flatted.parse(data.json);

        // --- Save workspace state (defensive) ---
        let openDiagramIds = [];
        let activeDiagramId = null;
        try {
          if (app.diagrams.getWorkingDiagrams) {
            openDiagramIds = app.diagrams.getWorkingDiagrams().map((d) => d._id);
          }
          if (app.diagrams.getCurrentDiagram()) {
            activeDiagramId = app.diagrams.getCurrentDiagram()._id;
          }
        } catch (e) {
          console.warn("[LS] Could not save workspace state", e);
        }

        app.repository.bypassConfirmation = true;
        app.project.loadFromJson(projectObj);
        app.repository.bypassConfirmation = false;

        // --- Restore workspace state ---
        try {
          openDiagramIds.forEach((id) => {
            const diag = app.repository.get(id);
            if (diag && diag instanceof type.Diagram) {
              app.diagrams.openDiagram(diag);
            }
          });
          if (activeDiagramId) {
            const diag = app.repository.get(activeDiagramId);
            if (diag && diag instanceof type.Diagram) {
              app.diagrams.setCurrentDiagram(diag);
            }
          }
        } catch (e) {
          console.warn("[LS] Could not restore workspace state", e);
        }

        fachada.INFO("Document synchronized.");
      } catch (err) {
        fachada.ERR("Error loading remote document:", err);
        console.error(err);
      } finally {
        fachada.hideLoadingOverlay();
      }
    });

    socket.on("remote-operation", (opData) => {
      isRemoteChange = true;
      try {
        const operation = flatted.parse(opData);
        app.repository.doOperation(operation);
        app.diagrams.repaint();

        updateAllHighlights();
      } catch (err) {
        console.error("[LS] Operation Error:", err);
      } finally {
        isRemoteChange = false;
      }
    });

    socket.on("remote-undo", async () => {
      isRemoteChange = true;
      try {
        await app.commands.execute("edit:undo");
        app.diagrams.repaint();
        updateAllHighlights();
      } catch (e) {
        console.error(e);
      } finally {
        isRemoteChange = false;
      }
    });

    socket.on("remote-redo", async () => {
      isRemoteChange = true;
      try {
        await app.commands.execute("edit:redo");
        app.diagrams.repaint();
        updateAllHighlights();
      } catch (e) {
        console.error(e);
      } finally {
        isRemoteChange = false;
      }
    });

    // Handle Undo/Redo synchronization to prevent double-syncing
    const originalExecute = app.commands.execute;
    app.commands.execute = function (id, ...args) {
      if (id === "edit:undo" || id === "edit:redo") {
        isLocalUndo = true;
        try {
          return originalExecute.apply(app.commands, [id, ...args]);
        } finally {
          isLocalUndo = false;
        }
      }
      return originalExecute.apply(app.commands, [id, ...args]);
    };

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
      cursors.removeCursor(id);
    });

    socket.on("connect", () => {
      address = url;
      cursors.addMouseMovementSharing(sendMousePosition);
      fachada.showLoadingOverlay();
      if (socket.recovered) {
        fachada.INFO("Connection recovered!");
      }
    });

    socket.on("disconnect", (reason) => {
      fachada.WARN("Disconnected: " + reason);
      if (reason === "io server disconnect") {
        // the disconnection was initiated by the server, you need to reconnect manually
        socket.connect();
      }
      // highlights and cursors will clear on final disconnect, but for transient ones we keep them?
      // better clear them to avoid ghosting
      removeAllHighlights();
      cursors.removeAllCursors();
    });

    socket.on("reconnect", (attempt) => {
      fachada.INFO("Reconnected after " + attempt + " attempts.");
    });

    socket.on("connect_error", (err) => {
      console.error("Connect Error:", err);
      resolve(false);
    });

    // Handle visibility change to prevent throttling issues
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && socket && socket.connected) {
        socket.emit("client-ping", { timestamp: Date.now() });
      }
    });
  });
}

const handleOperation = (operation) => {
  if (isRemoteChange || isLocalUndo || app.repository.bypassConfirmation)
    return;
  if (socket && socket.connected && current_room) {
    const str = flatted.stringify(operation);
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
  // If it's a remote change, don't re-emit.
  // We DO allow emission if it's isLocalUndo because we blocked its individual operations in handleOperation.
  if (isRemoteChange || !socket || !socket.connected) return;
  if (commandId === "edit:undo") socket.emit("sync-undo");
  else if (commandId === "edit:redo") socket.emit("sync-redo");
};

function addChangesHook() {
  removeChangesHook();

  app.repository.on("operationExecuted", handleOperation);
  app.commands.on("afterExecute", handleCommands);
  app.selections.on("selectionChanged", handleSelection);
  app.diagrams.on("currentDiagramChanged", updateAllHighlights);

  // For zoom/scroll updates
  const diagramArea = app.diagrams.$diagramArea[0];
  if (diagramArea) {
    diagramArea.addEventListener("wheel", updateAllHighlights, { passive: true });
    diagramArea.addEventListener("mousedown", onDiagramMouseDown);
  }
}

function removeChangesHook() {
  app.repository.off("operationExecuted", handleOperation);
  app.commands.off("afterExecute", handleCommands);
  app.selections.off("selectionChanged", handleSelection);
  app.diagrams.off("currentDiagramChanged", updateAllHighlights);

  const diagramArea = app.diagrams.$diagramArea[0];
  if (diagramArea) {
    diagramArea.removeEventListener("wheel", updateAllHighlights);
    diagramArea.removeEventListener("mousedown", onDiagramMouseDown);
  }
}

let isPanning = false;
function onDiagramMouseDown() {
  isPanning = true;
  const onMouseMove = () => {
    if (isPanning) updateAllHighlights();
  };
  const onMouseUp = () => {
    isPanning = false;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  };
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}

// Highlights
function highlightElement(viewId, color) {
  const view = app.repository.get(viewId);
  const diagramArea = app.diagrams.$diagramArea[0];

  if (view && view instanceof type.View) {
    removeHighlight(viewId);

    const hl = document.createElement("div");
    hl.className = "element-lock-highlight";
    hl.style.cssText = `
      position: absolute;
      border: 3px solid ${color};
      pointer-events: none;
      z-index: 5;
      box-sizing: border-box;
      display: none;
    `;
    diagramArea.appendChild(hl);
    activeHighlights[viewId] = { element: hl, color: color };
    updateAllHighlights();
  }
}

function removeHighlight(viewId) {
  if (activeHighlights[viewId]) {
    activeHighlights[viewId].element.remove();
    delete activeHighlights[viewId];
  }
}

function removeAllHighlights() {
  for (let viewId in activeHighlights) {
    activeHighlights[viewId].element.remove();
  }
  activeHighlights = {};
}

function updateAllHighlights() {
  const currentDiagram = app.diagrams.getCurrentDiagram();
  if (!currentDiagram) {
    for (let viewId in activeHighlights) {
      activeHighlights[viewId].element.style.display = "none";
    }
    return;
  }

  const zoom = app.diagrams.getZoomLevel();
  const originX = currentDiagram._originX;
  const originY = currentDiagram._originY;

  for (let viewId in activeHighlights) {
    const view = app.repository.get(viewId);
    if (view && view instanceof type.View && view._parent === currentDiagram) {
      const hlObj = activeHighlights[viewId];
      const hl = hlObj.element;

      const physicalX = (view.left + originX) * zoom;
      const physicalY = (view.top + originY) * zoom;
      const physicalW = view.width * zoom;
      const physicalH = view.height * zoom;

      hl.style.left = `${physicalX}px`;
      hl.style.top = `${physicalY}px`;
      hl.style.width = `${physicalW}px`;
      hl.style.height = `${physicalH}px`;
      hl.style.display = "block";
    } else {
      activeHighlights[viewId].element.style.display = "none";
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

function requestDocument() {
  if (!(socket && socket.connected)) return;
  fachada.showLoadingOverlay();
  socket.emit("request-doc");
}

function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  address = "";
  removeAllHighlights();
  cursors.removeMouseMovementSharing();
  cursors.removeAllCursors();
  fachada.enableHostOptions();
  removeChangesHook();
}

// getters
function getConnectedAddress() {
  return address;
}

function getCurrentRoom() {
  return current_room;
}

module.exports = {
  connectToServer,
  sendMousePosition,
  disconnect,
  getConnectedAddress,
  requestDocument,
  getCurrentRoom,
};
