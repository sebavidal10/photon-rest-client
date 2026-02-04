# Photon

<p align="center">
  <img src="resources/banner.png" alt="Photon Banner" width="100%">
</p>

A minimalist REST client for VS Code that stays out of your way. Built for developers who want a fast, dark-mode-first environment to test APIs.

## Features

- **Sidebar Launcher**: Quick-access icon to open Photon without needing the command palette.
- **Saved Requests Tree**: View and launch your favorite requests directly from the VS Code sidebar.
- **OLED Dark UI**: Pure black theme with high-contrast syntax highlighting.
- **JSON Tree View**: Collapsible, syntax-highlighted response viewer.
- **Interoperability**: Export to / Import from Postman Collection (v2.1) format.
- **History**: Automatic tracking of your latest requests.
- **Auth**: Bearer and Basic authentication support.
- **Response Meta**: Status code, response time, and line count at a glance.

## Installation

### From Marketplace (Coming Soon)

Search for `Photon` in the VS Code Extensions view.

### Manual Installation

1. Go to the [Releases](https://github.com/sebavidal10/photon-rest-client/releases) page.
2. Download the latest `.vsix` file (e.g., `photon-rest-client-0.0.4.vsix`).
3. In VS Code, open the **Extensions** view (`Cmd+Shift+X` or `Ctrl+Shift+X`).
4. Click the `...` (Views and More Actions) in the top right corner.
5. Select **Install from VSIX...** and pick the file you just downloaded.

## Usage

1. Open the Command Palette (`Cmd/Ctrl + Shift + P`).
2. Type **Open Photon**.
3. You can also find Photon in your **Activity Bar** (sidebar icon).

## Development

To run Photon locally for development:

```bash
npm install
npm run watch
```

Press `F5` to launch a new VS Code window with the extension loaded.

## License

MIT
