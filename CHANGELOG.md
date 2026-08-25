# Change Log
 
All notable changes to the "photon-rest-client" extension will be documented in this file.

## [v0.2.0] - 2026-08-25

### Added

- **Multi-Tab Parallel Workspaces**: Work on multiple API requests in parallel with dedicated method badges, per-tab response state, mouse-wheel horizontal scrolling, and auto-focusing tabs.
- **Collections & Folder Grouping**: Group saved requests into named collections/folders with collapsible accordion views and VS Code sidebar explorer tree hierarchy.
- **Drag & Drop Reordering**: Reorder saved requests within collections and move requests across collections by dragging.
- **Full Request & Folder Editing**: In-depth modal to edit request names, URLs, headers JSON, formatted body JSON (with beautifier), and authentication, plus collection folder renaming.
- **Postman Collection Import & Export (v2.0 & v2.1)**: Full nested folder parsing, URL normalization, headers, request bodies (raw, urlencoded, formdata), item/collection level Bearer & Basic auth, with loading spinner and success banners.
- **Delete & Clear Safeguards**: Confirmation modals before deleting requests, deleting collections, or clearing request history.
- **Resizable Response Viewport**: Draggable split resizer allowing dynamic vertical sizing between request configurations and response views.
- **URL Validation on Save**: Required endpoint URL validation with visual alerts prior to opening the save modal.
- **Adaptive Full-Height Views**: "Saved" and "History" tabs automatically hide the response pane and occupy full available height for easier management.

### Changed

- **UI & Button Ergonomics**: Streamlined text-only buttons, enhanced touch/click targets, typography, and contrast across the entire OLED dark theme.
- **Divider Simplification**: Removed redundant stacked border lines between split resizer and response status meta.
- **Localization**: Standardized all UI messages, confirmations, and alerts to clean English.
- **Dependency Upgrades**: Updated `axios`, `eslint`, and `@types` packages.

## [v0.0.6] - 2026-02-03

### Changed

- **Pure Direct Launch**: Automatically closes the sidebar panel when Photon is launched from the activity bar icon for a cleaner, full-editor experience.
- **UI Cleanup**: Removed redundant "Launch Photon" button from the sidebar tree view.

## [v0.0.5] - 2026-02-03

### Added

- **Direct Launch**: Clicking the Photon icon in the sidebar now automatically opens the main request panel.
- **Improved Sidebar Integration**: Enhanced tree view registration for a more native feel.

## [v0.0.4] - 2026-02-03

### Added

- **Sidebar Integration**: Added a dedicated activity bar icon for Photon.
- **Improved Launcher**: New "Welcome View" in the sidebar with a quick "Launch Photon" button.
- **Saved Requests Tree**: View and manage your saved requests directly from the VS Code sidebar.
- **Better Navigation**: Clicking a saved request in the sidebar now officially launches the panel with all data pre-loaded.

## [v0.0.3] - 2026-02-03

### Changed

- **Compatibility**: Downgraded VS Code engine requirement to `1.104.0` for wider compatibility with Antigravity and older VS Code versions.

## [v0.0.2] - 2026-02-03

### Added

- **OLED Dark UI**: Pure black theme with neon accents.
- **Interactive JSON Tree**: Collapsible and syntax-highlighted response viewer.
- **Saved Requests**: Persistent local storage for favorite endpoints.
- **Postman Support**: Import/Export collections (v2.1).
- **History**: Automatic tracking of recent requests.
- **Performance**: Optimized activation for a faster VS Code experience.
- **Branding**: Added official project logo and extension icons.

## [v0.0.1] - 2026-02-03

- Initial internal version.
