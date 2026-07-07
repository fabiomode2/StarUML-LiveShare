const fs = require('fs');
const path = require('path');

function INFO(mensaje) {
  console.log(`[LS] ${mensaje}`);
  app.toast.info(mensaje);
}

function WARN(mensaje) {
  console.warn(`[LS] ${mensaje}`);
  app.toast.warning(mensaje);
}

function ERR(mensaje) {
  console.error(`[LS] ${mensaje}`);
  app.toast.error(mensaje);
}

function _createDialog(templateName) {
  const dialogHTML = fs.readFileSync(
    path.join(__dirname, templateName),
    'utf8',
  );
  return app.dialogs.showModalDialogUsingTemplate(dialogHTML);
}

const MODES = [
  { id: 'lan', label: 'LAN', desc: 'Start a local server for LAN' },
  {
    id: 'remote',
    label: 'Remote',
    desc: 'Connect to an existing remote server',
  },
  {
    id: 'tunnel',
    label: 'LAN+Tunnel',
    desc: 'Local server with public tunnel',
  },
];

async function showSSDialog() {
  return new Promise((resolve) => {
    const htmlPath = path.join('html', 'ss_dialog.html');
    let dialog;
    try {
      dialog = _createDialog(htmlPath);
    } catch (e) {
      ERR('Error creating dialog: ' + e.message);
      resolve(null);
      return;
    }

    const $el = dialog.getElement();
    let currentModeIndex = 2;

    function updateMode(index) {
      const mode = MODES[index];
      $el.find('#mode-label').text(mode.label).attr('data-mode', mode.id);
      $el.find('#mode-desc').text(mode.desc);
      if (mode.id === 'remote') {
        $el.find('#server-group').removeClass('hidden');
      } else {
        $el.find('#server-group').addClass('hidden');
      }
    }

    updateMode(currentModeIndex);

    $el.on('click', '#mode-prev', () => {
      currentModeIndex = (currentModeIndex - 1 + MODES.length) % MODES.length;
      updateMode(currentModeIndex);
    });

    $el.on('click', '#mode-next', () => {
      currentModeIndex = (currentModeIndex + 1) % MODES.length;
      updateMode(currentModeIndex);
    });

    $el.on('click', '#ok-btn', () => {
      const name = $el.find('#name').val().trim();
      const mode = $el.find('#mode-label').attr('data-mode');
      const server = $el.find('#server').val().trim();

      if (!name) {
        ERR('Username cannot be empty.');
        return;
      }

      if (mode === 'remote' && !server) {
        ERR('Server address cannot be empty.');
        return;
      }

      dialog.close();
      resolve({ name, mode, server });
    });

    $el.on('click', '#cancel-btn', () => {
      dialog.close();
      resolve(null);
    });

    $el.on('dialog:close', () => {
      resolve(null);
    });
  });
}

async function showJSDialog() {
  return new Promise((resolve) => {
    const htmlPath = path.join('html', 'js_dialog.html');
    let dialog;
    try {
      dialog = _createDialog(htmlPath);
    } catch (e) {
      ERR('Error creating dialog: ' + e.message);
      resolve(null);
      return;
    }

    const $el = dialog.getElement();

    $el.on('click', '#ok-btn', () => {
      const name = $el.find('#name').val().trim();
      let address = $el.find('#address').val().trim();

      if (!name) {
        ERR('Username cannot be empty.');
        return;
      }

      if (!address) {
        ERR('Address cannot be empty.');
        return;
      }

      if (!address.startsWith('http')) {
        address = 'http://' + address;
      }

      dialog.close();
      resolve({ name, address });
    });

    $el.on('click', '#cancel-btn', () => {
      dialog.close();
      resolve(null);
    });

    $el.on('dialog:close', () => {
      resolve(null);
    });
  });
}

let originalHandlers = {};

function changeKeyBindings(host) {
  const forbidden = [
    'project:new',
    'project:open',
    'project:import-fragment',
    'project:close',
    'project:open-recent',
  ];

  forbidden.forEach((cmdId) => {
    if (!app.commands.commands[cmdId]) return;

    if (host) {
      if (originalHandlers[cmdId]) {
        app.commands.commands[cmdId] = originalHandlers[cmdId];
        delete originalHandlers[cmdId];
      }
    } else {
      if (!originalHandlers[cmdId]) {
        originalHandlers[cmdId] = app.commands.commands[cmdId];
      }
      app.commands.commands[cmdId] = () => {
        WARN('Only host can manage files.');
        console.log(`[LS] Blocking: ${cmdId}`);
      };
    }
  });
}

function changeHostOptions(state) {
  const menuStates = {
    'file.new': state,
    'file.open': state,
    'file.import': state,
    'file.export-diagram-to-png': state,
    'file.export-diagram-to-svg': state,
    'file.export-diagram-to-pdf': state,
    'file.close': state,
    'file.open-recent': state,
    'file.new-from-template': state,
  };

  try {
    app.menu.updateStates(null, menuStates, null);
  } catch (e) {
    console.error('[LiveShare] Error updating menu states:', e);
  }
}

function disableHostOptions() {
  changeHostOptions(false);
  changeKeyBindings(false);
}

function enableHostOptions() {
  changeHostOptions(true);
  changeKeyBindings(true);
}

function showLoadingOverlay() {
  let overlay = document.createElement('div');
  overlay.id = 'my-extension-loading';

  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.background = 'rgba(0,0,0,0.4)';
  overlay.style.zIndex = '99999';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';

  overlay.innerHTML = `
    <div style="
      background:white;
      padding:20px;
      border-radius:8px;
      font-size:18px;
    ">
      Loading...
    </div>
  `;

  document.body.appendChild(overlay);
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('my-extension-loading');
  if (overlay) {
    overlay.remove();
  }
}

module.exports = {
  showSS: showSSDialog,
  showJS: showJSDialog,
  disableHostOptions: disableHostOptions,
  enableHostOptions: enableHostOptions,
  showLoadingOverlay: showLoadingOverlay,
  hideLoadingOverlay: hideLoadingOverlay,
  INFO: INFO,
  WARN: WARN,
  ERR: ERR,
};
