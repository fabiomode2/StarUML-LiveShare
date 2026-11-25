# Live Share

Collaborative editing for [StarUML](https://staruml.io/), inspired by
[VS Code Live Share](https://marketplace.visualstudio.com/items?itemName=MS-vsliveshare.vsliveshare).

## Installation

1. Open StarUML
2. Go to **Tools → Extension Manager**
3. Click **Install from URL**
4. Paste this URL:

    ```
    https://github.com/fabiomode2/StarUML-LiveShare
    ```

## Starting a session

**Live Share → Start session** offers three modes:

- **LAN**: local server, shared over the local network.
- **Remote**: connect to an existing server (see below).
- **LAN + Tunnel**: local server plus a public URL. Uses a Cloudflare quick
  tunnel, with `localhost.run` as fallback. The tunnel restarts automatically if
  it drops.

On the first tunnel run, the `cloudflared` binary (~40 MB) is downloaded to
`~/.liveshare/cloudflared`. If it cannot be downloaded, the extension falls
back to `localhost.run` (requires the `ssh` client).

Use **Copy session link** to share the session with other users.

## Hosting the server

To run a standalone server for **Remote** sessions:

    npm install --omit=dev
    npm run start_server

## Security

The session link is the credential. Anyone with the link can open the project
and edit the model. Tunnel mode exposes the server publicly, so share links
privately and prefer **LAN** mode on trusted networks.

License: GPLv3
