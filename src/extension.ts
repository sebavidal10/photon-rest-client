import * as vscode from 'vscode';
import axios from 'axios';

let activePanel: vscode.WebviewPanel | undefined = undefined;

interface SavedRequest {
  id: string;
  name: string;
  collection?: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  auth: any;
  timestamp: string;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'photon.open',
      (savedReq?: SavedRequest) => {
        openWebview(context, savedReq);
      },
    ),
  );

  // Sidebar Provider
  const sidebarProvider = new PhotonSidebarProvider(context);
  const treeView = vscode.window.createTreeView('photon-launcher', {
    treeDataProvider: sidebarProvider,
  });

  // Auto-open main panel when sidebar is focused and then close sidebar
  treeView.onDidChangeVisibility((e) => {
    if (e.visible) {
      vscode.commands.executeCommand('photon.open');
      setTimeout(() => {
        vscode.commands.executeCommand('workbench.action.closeSidebar');
      }, 100);
    }
  });

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('photon.refreshSidebar', () => {
      sidebarProvider.refresh();
    }),
  );
}

class PhotonSidebarProvider implements vscode.TreeDataProvider<PhotonTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    PhotonTreeItem | undefined | void
  > = new vscode.EventEmitter<PhotonTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<
    PhotonTreeItem | undefined | void
  > = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PhotonTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PhotonTreeItem): Thenable<PhotonTreeItem[]> {
    const saved: SavedRequest[] =
      this.context.globalState.get('savedRequests') || [];

    if (saved.length === 0) {
      return Promise.resolve([]);
    }

    if (!element) {
      // Top level: Group by collection / folder
      const collectionsMap: Map<string, number> = new Map();
      saved.forEach((req) => {
        const col = (req.collection || 'General').trim() || 'General';
        collectionsMap.set(col, (collectionsMap.get(col) || 0) + 1);
      });

      const items: PhotonTreeItem[] = [];
      Array.from(collectionsMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .forEach(([colName, count]) => {
          items.push(
            new PhotonTreeItem(
              colName,
              vscode.TreeItemCollapsibleState.Expanded,
              undefined,
              new vscode.ThemeIcon('folder'),
              `(${count})`,
              colName,
            ),
          );
        });

      return Promise.resolve(items);
    }

    // Children of a collection
    if (element.collectionName) {
      const targetCol = element.collectionName;
      const colRequests = saved.filter(
        (r) => ((r.collection || 'General').trim() || 'General') === targetCol,
      );

      const items: PhotonTreeItem[] = colRequests.map((req) => {
        return new PhotonTreeItem(
          req.name,
          vscode.TreeItemCollapsibleState.None,
          {
            command: 'photon.open',
            title: 'Open Request',
            arguments: [req],
          },
          new vscode.ThemeIcon('link'),
          req.method,
        );
      });

      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }
}

class PhotonTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly iconPath?: vscode.ThemeIcon,
    public readonly description?: string,
    public readonly collectionName?: string,
  ) {
    super(label, collapsibleState);
    this.tooltip = `${this.label}`;
    this.description = description;
    if (collectionName) {
      this.contextValue = 'collection';
    }
  }
}

function openWebview(
  context: vscode.ExtensionContext,
  initialRequest?: SavedRequest,
): vscode.WebviewPanel {
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Beside);
    if (initialRequest) {
      activePanel.webview.postMessage({
        command: 'loadRequest',
        request: initialRequest,
      });
    }
    return activePanel;
  }

  const panel = vscode.window.createWebviewPanel(
    'restClient',
    'Photon',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  activePanel = panel;
  panel.onDidDispose(
    () => {
      activePanel = undefined;
    },
    null,
    context.subscriptions,
  );

  panel.webview.html = getWebviewContent();

  if (initialRequest) {
    setTimeout(() => {
      panel.webview.postMessage({
        command: 'loadRequest',
        request: initialRequest,
      });
    }, 600);
  }

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === 'sendRequest') {
      const startTime = Date.now();
      try {
        let headers = {};
        if (message.headers && message.headers.trim()) {
          try {
            headers = JSON.parse(message.headers);
          } catch (e) {
            throw new Error('Invalid Headers JSON format');
          }
        }

        if (message.authType === 'basic' && message.username) {
          const credentials = Buffer.from(
            `${message.username}:${message.password || ''}`,
          ).toString('base64');
          headers = { ...headers, Authorization: `Basic ${credentials}` };
        } else if (message.authType === 'bearer' && message.token) {
          headers = {
            ...headers,
            Authorization: `Bearer ${message.token}`,
          };
        }

        let body = undefined;
        if (message.method !== 'GET' && message.body && message.body.trim()) {
          try {
            body = JSON.parse(message.body);
          } catch (e) {
            body = message.body;
          }
        }

        let url = message.url.trim();
        if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'http://' + url;
        }

        const history: any[] = context.globalState.get('requestHistory') || [];
        const newEntry = {
          id: Date.now(),
          method: message.method,
          url: url,
          headers: message.headers,
          body: message.body,
          auth: {
            type: message.authType,
            token: message.token,
            username: message.username,
            password: message.password,
          },
          timestamp: new Date().toLocaleTimeString(),
        };
        history.unshift(newEntry);
        if (history.length > 30) {
          history.pop();
        }
        await context.globalState.update('requestHistory', history);

        const res = await axios({
          method: message.method,
          url: url,
          headers: headers,
          data: body,
          timeout: 30000,
        });

        const duration = Date.now() - startTime;

        panel.webview.postMessage({
          command: 'response',
          status: res.status,
          statusText: res.statusText,
          data: res.data,
          time: duration,
          contentType: res.headers['content-type'],
          history: history,
        });
      } catch (error: any) {
        const duration = Date.now() - startTime;
        let errorData = error.message;
        let errorStatus: string | number = 'Error';
        let errorStatusText = error.message;

        if (error.response) {
          errorStatus = error.response.status;
          errorStatusText = error.response.statusText;
          errorData = error.response.data;
        } else if (error.code === 'ECONNABORTED') {
          errorStatusText = 'Request Timeout';
        } else if (error.code === 'ENOTFOUND') {
          errorStatusText = 'Address Not Found';
        }

        panel.webview.postMessage({
          command: 'response',
          status: errorStatus,
          statusText: errorStatusText,
          data: errorData,
          time: duration,
          contentType: error.response?.headers?.['content-type'],
          history: context.globalState.get('requestHistory') || [],
        });
      }
    } else if (message.command === 'loadHistory') {
      const history = context.globalState.get('requestHistory') || [];
      panel.webview.postMessage({
        command: 'historyData',
        history: history,
      });
    } else if (message.command === 'clearHistory') {
      await context.globalState.update('requestHistory', []);
      panel.webview.postMessage({ command: 'historyData', history: [] });
      vscode.window.setStatusBarMessage('Photon: History cleared', 3000);
    } else if (message.command === 'saveRequest') {
      const saved: SavedRequest[] =
        context.globalState.get('savedRequests') || [];
      const colName = (message.collection || '').trim() || 'General';
      const newSaved: SavedRequest = {
        id: Date.now().toString(),
        name: (message.name || '').trim() || 'Untitled Request',
        collection: colName,
        method: message.req.method,
        url: message.req.url,
        headers: message.req.headers,
        body: message.req.body,
        auth: message.req.auth,
        timestamp: new Date().toLocaleDateString(),
      };
      saved.push(newSaved);
      await context.globalState.update('savedRequests', saved);
      panel.webview.postMessage({ command: 'savedRequestsData', saved: saved });
      vscode.commands.executeCommand('photon.refreshSidebar');
      vscode.window.showInformationMessage(
        `Request "${newSaved.name}" saved in collection "${colName}"!`,
      );
    } else if (message.command === 'getSavedRequests') {
      const saved = context.globalState.get('savedRequests') || [];
      panel.webview.postMessage({ command: 'savedRequestsData', saved: saved });
    } else if (message.command === 'deleteSavedRequest') {
      let saved: SavedRequest[] =
        context.globalState.get('savedRequests') || [];
      saved = saved.filter((r) => r.id !== message.id);
      await context.globalState.update('savedRequests', saved);
      panel.webview.postMessage({ command: 'savedRequestsData', saved: saved });
      vscode.commands.executeCommand('photon.refreshSidebar');
    } else if (message.command === 'deleteCollection') {
      let saved: SavedRequest[] =
        context.globalState.get('savedRequests') || [];
      const targetCol = message.collection;
      saved = saved.filter(
        (r) => ((r.collection || 'General').trim() || 'General') !== targetCol,
      );
      await context.globalState.update('savedRequests', saved);
      panel.webview.postMessage({ command: 'savedRequestsData', saved: saved });
      vscode.commands.executeCommand('photon.refreshSidebar');
      vscode.window.showInformationMessage(`Collection "${targetCol}" deleted.`);
    } else if (message.command === 'renameCollection') {
      let saved: SavedRequest[] =
        context.globalState.get('savedRequests') || [];
      const oldName = (message.oldName || '').trim();
      const newName = (message.newName || '').trim();
      if (oldName && newName && oldName !== newName) {
        saved = saved.map((r) => {
          if (((r.collection || 'General').trim() || 'General') === oldName) {
            return { ...r, collection: newName };
          }
          return r;
        });
        await context.globalState.update('savedRequests', saved);
        panel.webview.postMessage({ command: 'savedRequestsData', saved: saved });
        vscode.commands.executeCommand('photon.refreshSidebar');
        vscode.window.showInformationMessage(`Collection renamed to "${newName}"`);
      }
    } else if (message.command === 'updateSavedRequest') {
      let saved: SavedRequest[] =
        context.globalState.get('savedRequests') || [];
      const { id, name, url, method, collection, headers, body, auth } = message;
      saved = saved.map((r) => {
        if (r.id === id) {
          return {
            ...r,
            name: (name || '').trim() || r.name,
            url: (url || '').trim() || r.url,
            method: method || r.method,
            collection: (collection || '').trim() || (r.collection || 'General'),
            headers: headers !== undefined ? headers : r.headers,
            body: body !== undefined ? body : r.body,
            auth: auth !== undefined ? auth : r.auth,
          };
        }
        return r;
      });
      await context.globalState.update('savedRequests', saved);
      panel.webview.postMessage({ command: 'savedRequestsData', saved: saved });
      vscode.commands.executeCommand('photon.refreshSidebar');
      vscode.window.showInformationMessage(`Request updated successfully!`);
    } else if (message.command === 'reorderSavedRequests') {
      if (Array.isArray(message.saved)) {
        await context.globalState.update('savedRequests', message.saved);
        panel.webview.postMessage({ command: 'savedRequestsData', saved: message.saved });
        vscode.commands.executeCommand('photon.refreshSidebar');
      }
    } else if (message.command === 'exportSaved') {
      const saved: SavedRequest[] =
        context.globalState.get('savedRequests') || [];
      
      const grouped: Record<string, SavedRequest[]> = {};
      saved.forEach((req) => {
        const col = (req.collection || 'General').trim() || 'General';
        if (!grouped[col]) {
          grouped[col] = [];
        }
        grouped[col].push(req);
      });

      const postmanItems = Object.entries(grouped).map(([colName, reqList]) => ({
        name: colName,
        item: reqList.map((req) => {
          let headers: any[] = [];
          try {
            const parsed = JSON.parse(req.headers || '{}');
            headers = Object.keys(parsed).map((k) => ({
              key: k,
              value: parsed[k],
            }));
          } catch (e) {}

          return {
            name: req.name,
            request: {
              method: req.method,
              url: { raw: req.url },
              header: headers,
              body: req.body ? { mode: 'raw', raw: req.body } : undefined,
            },
          };
        }),
      }));

      const postmanCollection = {
        info: {
          name: 'Photon Export ' + new Date().toLocaleDateString(),
          schema:
            'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: postmanItems,
      };

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('photon_requests.json'),
        filters: { JSON: ['json'] },
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(
          uri,
          Buffer.from(JSON.stringify(postmanCollection, null, 2)),
        );
        vscode.window.showInformationMessage('Requests exported successfully!');
      }
    } else if (message.command === 'importSaved') {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ['json'] },
      });

      if (uris && uris[0]) {
        try {
          const content = await vscode.workspace.fs.readFile(uris[0]);
          const data = JSON.parse(content.toString());
          
          let importedCount = 0;
          const currentSaved: SavedRequest[] =
            context.globalState.get('savedRequests') || [];

          const rootCollectionName = (data.info?.name || 'Imported Collection').trim();

          function extractUrl(urlObj: any): string {
            if (!urlObj) {
              return '';
            }
            if (typeof urlObj === 'string') {
              return urlObj;
            }
            if (urlObj.raw) {
              return urlObj.raw;
            }
            if (urlObj.host) {
              const protocol = urlObj.protocol || 'https';
              const host = Array.isArray(urlObj.host) ? urlObj.host.join('.') : urlObj.host;
              const path = Array.isArray(urlObj.path) ? urlObj.path.join('/') : (urlObj.path || '');
              let fullUrl = `${protocol}://${host}${path ? '/' + path : ''}`;
              if (Array.isArray(urlObj.query) && urlObj.query.length > 0) {
                const queryStr = urlObj.query
                  .filter((q: any) => !q.disabled && q.key)
                  .map((q: any) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value || '')}`)
                  .join('&');
                if (queryStr) {
                  fullUrl += (fullUrl.includes('?') ? '&' : '?') + queryStr;
                }
              }
              return fullUrl;
            }
            return '';
          }

          function extractHeaders(headerObj: any): string {
            if (!headerObj) {
              return '{}';
            }
            if (Array.isArray(headerObj)) {
              const activeHeaders = headerObj.filter((h: any) => !h.disabled && h.key);
              const headersMap: Record<string, string> = {};
              activeHeaders.forEach((h: any) => {
                headersMap[h.key] = h.value || '';
              });
              return JSON.stringify(headersMap, null, 2);
            }
            if (typeof headerObj === 'object') {
              return JSON.stringify(headerObj, null, 2);
            }
            return String(headerObj);
          }

          function extractBody(bodyObj: any): string {
            if (!bodyObj) {
              return '';
            }
            if (typeof bodyObj === 'string') {
              return bodyObj;
            }
            if (bodyObj.mode === 'raw') {
              return bodyObj.raw || '';
            }
            if (bodyObj.mode === 'urlencoded' && Array.isArray(bodyObj.urlencoded)) {
              const obj: Record<string, string> = {};
              bodyObj.urlencoded.forEach((param: any) => {
                if (!param.disabled && param.key) {
                  obj[param.key] = param.value || '';
                }
              });
              return JSON.stringify(obj, null, 2);
            }
            if (bodyObj.mode === 'formdata' && Array.isArray(bodyObj.formdata)) {
              const obj: Record<string, string> = {};
              bodyObj.formdata.forEach((param: any) => {
                if (!param.disabled && param.key) {
                  obj[param.key] = param.value || '';
                }
              });
              return JSON.stringify(obj, null, 2);
            }
            if (bodyObj.raw) {
              return bodyObj.raw;
            }
            return '';
          }

          function extractAuth(authObj: any, rootAuth?: any): any {
            const targetAuth = authObj || rootAuth;
            if (!targetAuth) {
              return { type: 'none' };
            }
            if (targetAuth.type === 'bearer') {
              let token = '';
              if (Array.isArray(targetAuth.bearer)) {
                const tokenEntry = targetAuth.bearer.find((b: any) => b.key === 'token');
                token = tokenEntry ? tokenEntry.value : '';
              } else if (typeof targetAuth.bearer === 'string') {
                token = targetAuth.bearer;
              }
              return { type: 'bearer', token };
            }
            if (targetAuth.type === 'basic') {
              let username = '';
              let password = '';
              if (Array.isArray(targetAuth.basic)) {
                const userEntry = targetAuth.basic.find((b: any) => b.key === 'username');
                const passEntry = targetAuth.basic.find((b: any) => b.key === 'password');
                username = userEntry ? userEntry.value : '';
                password = passEntry ? passEntry.value : '';
              }
              return { type: 'basic', username, password };
            }
            return { type: 'none' };
          }

          function parsePostmanItems(items: any[], currentFolderName: string) {
            if (!Array.isArray(items)) {
              return;
            }

            items.forEach((item: any) => {
              if (item.item && Array.isArray(item.item)) {
                // Folder / Subcollection
                const folderName = item.name ? item.name.trim() : currentFolderName;
                parsePostmanItems(item.item, folderName);
              } else if (item.request) {
                // Request Item
                const reqData = typeof item.request === 'string' 
                  ? { method: 'GET', url: item.request } 
                  : item.request;

                const url = extractUrl(reqData.url);
                const method = (reqData.method || 'GET').toUpperCase();
                const headers = extractHeaders(reqData.header);
                const body = extractBody(reqData.body);
                const auth = extractAuth(reqData.auth, data.auth);

                currentSaved.push({
                  id: Date.now().toString() + Math.random().toString(36).substring(2, 7),
                  name: item.name ? item.name.trim() : (url || 'Untitled Request'),
                  collection: currentFolderName,
                  method: method,
                  url: url,
                  headers: headers,
                  body: body,
                  auth: auth,
                  timestamp: new Date().toLocaleDateString(),
                });
                importedCount++;
              }
            });
          }

          const topLevelItems = data.item || (Array.isArray(data) ? data : []);
          parsePostmanItems(topLevelItems, rootCollectionName);

          if (importedCount === 0) {
            panel.webview.postMessage({ command: 'importError', error: 'No valid requests found in the selected file.' });
            vscode.window.showWarningMessage('No valid requests found in the selected file.');
            return;
          }

          await context.globalState.update('savedRequests', currentSaved);
          panel.webview.postMessage({
            command: 'savedRequestsData',
            saved: currentSaved,
          });
          panel.webview.postMessage({
            command: 'importSuccess',
            count: importedCount,
          });
          vscode.commands.executeCommand('photon.refreshSidebar');
          vscode.window.showInformationMessage(
            `Successfully imported ${importedCount} request(s) into Saved!`,
          );
        } catch (e: any) {
          panel.webview.postMessage({ command: 'importError', error: e.message });
          vscode.window.showErrorMessage('Failed to parse Postman collection file: ' + e.message);
        }
      } else {
        panel.webview.postMessage({ command: 'importCancelled' });
      }
    }
  });

  return panel;
}

function getWebviewContent(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Photon</title>
    <style>
        :root {
            --bg: #000000;
            --surface: #0a0a0a;
            --surface-hover: #141414;
            --surface-card: #0d0d0d;
            --border: #1f1f1f;
            --border-focus: #383838;
            --accent: #00f2ff;
            --accent-glow: rgba(0, 242, 255, 0.25);
            --error: #ff0055;
            --error-bg: rgba(255, 0, 85, 0.15);
            --success: #00ffaa;
            --warning: #ffaa00;
            --text: #e6e6e6;
            --text-dim: #8a8a8a;
            --neon-pink: #ff00ff;
        }

        * {
            box-sizing: border-box;
        }

        body {
            background-color: var(--bg);
            color: var(--text);
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 12px;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
            font-size: 13px;
            user-select: none;
        }

        /* Top Input Bar */
        .minimal-input-group {
            display: flex;
            align-items: center;
            gap: 6px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 4px 6px;
            margin-bottom: 10px;
            transition: border-color 0.2s, box-shadow 0.2s;
            flex-shrink: 0;
        }

        .minimal-input-group:focus-within {
            border-color: var(--border-focus);
            box-shadow: 0 0 10px rgba(0, 242, 255, 0.08);
        }

        .minimal-input-group.has-error {
            border-color: var(--error) !important;
            box-shadow: 0 0 12px var(--error-bg) !important;
        }

        select, input {
            background: transparent;
            color: var(--text);
            border: none;
            outline: none;
            font-family: inherit;
            font-size: 13px;
        }

        select#method { 
            width: 105px; 
            font-weight: 800; 
            cursor: pointer;
            border-right: 1px solid var(--border);
            padding: 6px 8px;
            transition: all 0.2s;
            font-size: 12px;
            letter-spacing: 0.05em;
        }

        select#method option {
            background: #111;
            color: var(--text);
        }

        .m-GET { color: var(--accent) !important; text-shadow: 0 0 6px var(--accent-glow); }
        .m-POST { color: var(--success) !important; text-shadow: 0 0 6px rgba(0, 255, 170, 0.25); }
        .m-PUT { color: #ffcc00 !important; text-shadow: 0 0 6px rgba(255, 204, 0, 0.25); }
        .m-PATCH { color: #ff8800 !important; text-shadow: 0 0 6px rgba(255, 136, 0, 0.25); }
        .m-DELETE { color: var(--neon-pink) !important; text-shadow: 0 0 6px rgba(255, 0, 255, 0.25); }

        input.url { 
            flex: 1; 
            font-family: 'JetBrains Mono', 'Fira Code', monospace; 
            font-size: 13px;
            padding: 6px 10px;
            user-select: text;
        }

        /* Buttons */
        button.action-btn {
            background: rgba(255, 255, 255, 0.03);
            color: var(--text);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 6px 14px;
            font-weight: 700;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 32px;
        }

        button.action-btn:hover {
            color: #ffffff;
            border-color: var(--text-dim);
            background: var(--surface-hover);
        }

        button.send-btn {
            background: transparent;
            color: var(--accent);
            border: 1px solid var(--accent);
            border-radius: 6px;
            padding: 6px 18px;
            font-weight: 800;
            text-transform: uppercase;
            font-size: 12px;
            letter-spacing: 0.08em;
            cursor: pointer;
            transition: all 0.2s;
            min-height: 32px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        button.send-btn:hover, button.send-btn:active {
            background: var(--accent);
            color: #000000;
            box-shadow: 0 0 14px var(--accent-glow);
        }

        /* Tabs Header */
        .tabs {
            display: flex;
            gap: 16px;
            margin-bottom: 8px;
            border-bottom: 1px solid var(--border);
            padding-bottom: 2px;
            flex-shrink: 0;
        }

        .tab {
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: var(--text-dim);
            cursor: pointer;
            padding: 6px 10px;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
        }

        .tab:hover {
            color: var(--text);
        }

        .tab.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
            text-shadow: 0 0 8px var(--accent-glow);
        }

        /* Validation Alert Banner */
        .alert-banner {
            display: none;
            background: var(--error-bg);
            border: 1px solid var(--error);
            color: #ff88a3;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            margin-bottom: 8px;
            animation: fadeIn 0.2s ease-out;
            align-items: center;
            justify-content: space-between;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* Main Area Layout */
        .main-container {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            position: relative;
        }

        .request-panel {
            display: flex;
            flex-direction: column;
            height: 180px;
            min-height: 90px;
            flex-shrink: 0;
        }

        .tab-content { 
            display: none; 
            flex: 1; 
            min-height: 0;
            overflow: hidden;
        }
        .tab-content.active { 
            display: flex; 
            flex-direction: column; 
        }

        /* Full View Mode (Saved & History) */
        .main-container.full-view .request-panel {
            height: 100% !important;
            flex: 1 !important;
        }

        .main-container.full-view .split-resizer,
        .main-container.full-view .response-panel {
            display: none !important;
        }

        textarea {
            width: 100%;
            flex: 1;
            background: var(--surface);
            color: var(--text);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 10px;
            font-family: 'JetBrains Mono', 'Fira Code', monospace;
            font-size: 12px;
            line-height: 1.45;
            resize: none;
            outline: none;
            user-select: text;
        }
        textarea:focus {
            border-color: var(--border-focus);
        }

        .action-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 6px;
            gap: 8px;
            flex-shrink: 0;
        }

        .sec-btn {
            font-size: 11px;
            font-weight: 600;
            background: var(--surface);
            color: var(--text-dim);
            border: 1px solid var(--border);
            padding: 5px 12px;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 28px;
        }
        .sec-btn:hover { 
            color: var(--text); 
            border-color: var(--border-focus); 
            background: var(--surface-hover);
        }
        .sec-btn.accent {
            color: var(--accent);
            border-color: rgba(0, 242, 255, 0.35);
        }
        .sec-btn.accent:hover {
            border-color: var(--accent);
            box-shadow: 0 0 8px var(--accent-glow);
        }
        .sec-btn.danger:hover {
            color: var(--error);
            border-color: var(--error);
        }

        /* Split Resizer */
        .split-resizer {
            height: 10px;
            margin: 2px 0;
            cursor: ns-resize;
            display: flex;
            align-items: center;
            justify-content: center;
            user-select: none;
            flex-shrink: 0;
            position: relative;
            z-index: 10;
        }

        .split-resizer::before {
            content: '';
            width: 100%;
            height: 1px;
            background: var(--border);
            transition: background 0.2s, height 0.2s;
        }

        .resizer-handle {
            position: absolute;
            width: 38px;
            height: 4px;
            border-radius: 2px;
            background: var(--border-focus);
            transition: background 0.2s, box-shadow 0.2s;
        }

        .split-resizer:hover::before,
        .split-resizer.dragging::before {
            height: 2px;
            background: var(--accent);
            box-shadow: 0 0 8px var(--accent-glow);
        }

        .split-resizer:hover .resizer-handle,
        .split-resizer.dragging .resizer-handle {
            background: var(--accent);
            box-shadow: 0 0 8px var(--accent-glow);
        }

        /* Top Request Tabs Bar */
        .request-tabs-bar {
            display: flex;
            align-items: center;
            gap: 4px;
            margin-bottom: 8px;
            padding-bottom: 2px;
            position: relative;
            flex-shrink: 0;
            overflow: hidden;
        }

        .request-tabs-list {
            display: flex;
            align-items: center;
            gap: 4px;
            flex: 1;
            overflow-x: auto;
            overflow-y: hidden;
            scrollbar-width: none;
            -ms-overflow-style: none;
            scroll-behavior: smooth;
        }

        .request-tabs-list::-webkit-scrollbar {
            display: none !important;
            width: 0 !important;
            height: 0 !important;
        }

        .req-tab {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 4px 8px;
            font-size: 11px;
            font-weight: 600;
            color: var(--text-dim);
            cursor: pointer;
            user-select: none;
            transition: all 0.15s;
            max-width: 170px;
            min-width: 80px;
            flex-shrink: 0;
        }

        .req-tab:hover {
            background: var(--surface-hover);
            color: var(--text);
            border-color: var(--border-focus);
        }

        .req-tab.active {
            background: #111111;
            color: var(--accent);
            border-color: var(--accent);
            box-shadow: 0 0 10px rgba(0, 242, 255, 0.12);
        }

        .req-tab .req-tab-method {
            font-size: 9px;
            font-weight: 800;
            letter-spacing: 0.04em;
            flex-shrink: 0;
        }

        .req-tab .req-tab-title {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 1;
        }

        .req-tab .req-tab-close {
            font-size: 10px;
            padding: 0 2px;
            border-radius: 3px;
            color: var(--text-dim);
            opacity: 0.6;
            transition: all 0.2s;
            flex-shrink: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .req-tab .req-tab-close:hover {
            opacity: 1;
            color: var(--error);
            background: rgba(255, 0, 85, 0.2);
        }

        .tab-nav-btn {
            font-size: 13px;
            font-weight: 700;
            padding: 2px 6px;
            min-height: 24px;
            color: var(--text-dim);
            border-radius: 4px;
            flex-shrink: 0;
            user-select: none;
            cursor: pointer;
        }

        .tab-nav-btn:hover {
            color: var(--text);
            background: rgba(255, 255, 255, 0.08);
        }

        .new-tab-btn {
            font-size: 14px;
            font-weight: 700;
            padding: 2px 8px;
            min-height: 24px;
            border-radius: 6px;
            border: 1px dashed var(--border);
            color: var(--text-dim);
            flex-shrink: 0;
            cursor: pointer;
            background: transparent;
            transition: all 0.2s;
        }

        .new-tab-btn:hover {
            border-color: var(--accent);
            color: var(--accent);
            background: rgba(0, 242, 255, 0.08);
        }

        /* Response Panel */
        .response-panel {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 80px;
            overflow: hidden;
        }

        .response-meta {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            flex-shrink: 0;
        }

        .status-info { 
            display: flex; 
            align-items: center; 
            gap: 12px; 
            font-size: 12px; 
            font-weight: 800; 
        }
        .status-txt { color: var(--success); }
        .status-err { color: var(--error); }
        .time-txt { color: var(--text-dim); font-family: monospace; font-size: 11px; }
        .line-txt { color: var(--text-dim); font-family: monospace; font-size: 11px; border-left: 1px solid var(--border); padding-left: 12px; }

        .view-btns { display: flex; gap: 6px; }
        .v-btn {
            font-size: 11px;
            color: var(--text-dim);
            cursor: pointer;
            font-weight: 700;
            text-transform: uppercase;
            padding: 3px 8px;
            border-radius: 4px;
            border: 1px solid transparent;
            transition: all 0.2s;
        }
        .v-btn:hover { color: var(--text); }
        .v-btn.active { 
            color: var(--accent); 
            background: rgba(0, 242, 255, 0.08); 
            border-color: rgba(0, 242, 255, 0.25);
        }

        .response-viewport {
            flex: 1;
            overflow: auto;
            padding-top: 4px;
            user-select: text;
        }

        pre {
            margin: 0;
            font-family: 'JetBrains Mono', 'Fira Code', monospace;
            font-size: 12px;
            line-height: 1.45;
            color: #dcdcdc;
            white-space: pre-wrap;
        }

        /* Collections & Lists */
        .list-container {
            overflow-y: auto;
            overflow-x: hidden;
            display: flex;
            flex-direction: column;
            gap: 8px;
            flex: 1;
            min-height: 0;
            padding-right: 6px;
            padding-bottom: 24px;
        }

        .list-container::-webkit-scrollbar,
        .response-viewport::-webkit-scrollbar,
        textarea::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }
        .list-container::-webkit-scrollbar-track,
        .response-viewport::-webkit-scrollbar-track,
        textarea::-webkit-scrollbar-track {
            background: transparent;
        }
        .list-container::-webkit-scrollbar-thumb,
        .response-viewport::-webkit-scrollbar-thumb,
        textarea::-webkit-scrollbar-thumb {
            background: #252525;
            border-radius: 3px;
        }
        .list-container::-webkit-scrollbar-thumb:hover,
        .response-viewport::-webkit-scrollbar-thumb:hover,
        textarea::-webkit-scrollbar-thumb:hover {
            background: var(--accent);
        }

        /* Collection Folder Card */
        .collection-folder {
            background: var(--surface-card);
            border: 1px solid var(--border);
            border-radius: 8px;
            flex-shrink: 0;
            transition: border-color 0.2s;
        }

        .collection-folder:hover {
            border-color: var(--border-focus);
        }

        .collection-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background: rgba(255, 255, 255, 0.02);
            cursor: pointer;
            border-bottom: 1px solid transparent;
            border-radius: 7px;
            transition: background 0.2s;
            flex-shrink: 0;
            user-select: none;
        }

        .collection-header:hover {
            background: rgba(255, 255, 255, 0.04);
        }

        .collection-folder.open .collection-header {
            border-bottom-color: var(--border);
            border-bottom-left-radius: 0;
            border-bottom-right-radius: 0;
        }

        .collection-title-group {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            font-weight: 700;
        }

        .collection-icon {
            font-size: 11px;
            color: var(--accent);
            transition: transform 0.2s;
            display: inline-block;
        }

        .collection-folder.open .collection-icon {
            transform: rotate(90deg);
        }

        .collection-count-badge {
            font-size: 10px;
            font-weight: 700;
            padding: 2px 6px;
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.06);
            color: var(--text-dim);
        }

        .collection-actions {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .collection-body {
            display: none;
            flex-direction: column;
            gap: 4px;
            padding: 6px 8px;
            background: #000000;
            border-bottom-left-radius: 7px;
            border-bottom-right-radius: 7px;
            flex-shrink: 0;
        }

        .collection-folder.open .collection-body {
            display: flex;
        }

        .list-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 10px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
            position: relative;
            flex-shrink: 0;
            min-height: 38px;
        }

        .list-item:hover { 
            border-color: var(--accent); 
            background: var(--surface-hover);
            transform: translateX(2px);
        }

        .list-item .method { 
            font-size: 10px; 
            font-weight: 800; 
            width: 48px; 
            letter-spacing: 0.04em;
            flex-shrink: 0;
        }

        .list-item .info { 
            flex: 1; 
            overflow: hidden; 
            display: flex; 
            flex-direction: column; 
            gap: 2px;
            min-width: 0;
        }

        .list-item .name { 
            font-size: 12px; 
            font-weight: 600; 
            color: var(--text); 
            white-space: nowrap; 
            overflow: hidden; 
            text-overflow: ellipsis;
        }

        .list-item .url { 
            font-size: 11px; 
            color: var(--text-dim); 
            overflow: hidden; 
            text-overflow: ellipsis; 
            white-space: nowrap; 
            font-family: monospace;
        }

        .list-item .meta { 
            font-size: 10px; 
            color: var(--text-dim); 
        }

        .drag-handle {
            cursor: grab;
            color: var(--text-dim);
            font-size: 13px;
            letter-spacing: -2px;
            padding-right: 4px;
            user-select: none;
            opacity: 0.35;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            flex-shrink: 0;
        }

        .list-item:hover .drag-handle {
            opacity: 0.9;
            color: var(--accent);
        }

        .drag-handle:active {
            cursor: grabbing;
        }

        .list-item.dragging {
            opacity: 0.35;
            border-style: dashed;
            border-color: var(--accent);
        }

        .list-item.drag-over-top {
            border-top: 2px solid var(--accent) !important;
            transform: translateY(2px);
        }

        .list-item.drag-over-bottom {
            border-bottom: 2px solid var(--accent) !important;
            transform: translateY(-2px);
        }

        .collection-folder.drag-over-folder {
            border-color: var(--accent) !important;
            box-shadow: 0 0 12px var(--accent-glow) !important;
        }

        .list-item .actions { 
            display: none; 
            margin-left: auto; 
            gap: 4px;
            flex-shrink: 0;
        }

        .list-item:hover .actions { 
            display: flex; 
            align-items: center;
        }
        
        .icon-btn { 
            background: transparent; 
            border: 1px solid transparent; 
            color: var(--text-dim); 
            cursor: pointer; 
            font-size: 11px; 
            font-weight: 600;
            padding: 2px 6px;
            border-radius: 4px;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .icon-btn:hover { 
            color: var(--text); 
            background: rgba(255, 255, 255, 0.08);
            border-color: var(--border);
        }

        .icon-btn.danger:hover {
            color: var(--error);
            background: var(--error-bg);
            border-color: rgba(255, 0, 85, 0.3);
        }

        .empty-state {
            padding: 24px;
            text-align: center;
            color: var(--text-dim);
            font-size: 12px;
        }

        .loader {
            display: none;
            height: 2px;
            background: var(--accent);
            box-shadow: 0 0 10px var(--accent);
            width: 0;
            transition: width 0.3s;
            margin-bottom: 6px;
            flex-shrink: 0;
        }

        /* JSON Syntax Highlighting & Collapsible */
        .string { color: var(--success); }
        .number { color: var(--neon-pink); }
        .boolean { color: var(--neon-pink); }
        .null { color: var(--neon-pink); }
        .key { color: var(--accent); }
        
        .json-tree { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.5; }
        .collapsible { cursor: pointer; user-select: none; display: inline-flex; align-items: center; }
        .collapsible::before { 
            content: '▼'; 
            display: inline-block; 
            font-size: 9px; 
            margin-right: 5px; 
            color: var(--text-dim); 
            transition: transform 0.2s; 
            vertical-align: middle;
        }
        .collapsible.collapsed::before { transform: rotate(-90deg); }
        .collapsible.collapsed + .json-content { display: none; }
        .collapsible.collapsed::after { content: '...'; color: var(--text-dim); margin-left: 4px; font-size: 11px; }
        
        .json-content { margin-left: 18px; border-left: 1px solid rgba(255,255,255,0.06); padding-left: 6px; }
        .json-item { display: flex; }
        .json-val { margin-left: 4px; }
        .bracket { color: #dcdcdc; }

        /* Save Modal */
        .modal-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.85);
            display: none; justify-content: center; align-items: center;
            z-index: 100;
            backdrop-filter: blur(4px);
        }

        .modal {
            background: #0d0d0d;
            border: 1px solid var(--border-focus);
            padding: 22px;
            border-radius: 10px;
            width: 360px;
            display: flex; flex-direction: column; gap: 14px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.8);
            animation: modalPop 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes modalPop {
            from { opacity: 0; transform: scale(0.95); }
            to { opacity: 1; transform: scale(1); }
        }

        .modal h3 { margin: 0; font-size: 14px; font-weight: 700; color: var(--text); }
        
        .modal-url-preview {
            font-size: 11px;
            font-family: monospace;
            background: #000;
            border: 1px solid var(--border);
            padding: 6px 8px;
            border-radius: 6px;
            color: var(--text-dim);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .modal label {
            font-size: 11px;
            font-weight: 600;
            color: var(--text-dim);
            margin-bottom: -8px;
        }

        .modal input, .modal select { 
            border: 1px solid var(--border); 
            background: var(--surface);
            padding: 8px 10px; 
            border-radius: 6px;
            color: var(--text);
            font-size: 12px;
        }
        .modal input:focus, .modal select:focus { 
            border-color: var(--accent); 
        }

        .modal-btns { 
            display: flex; 
            justify-content: flex-end; 
            gap: 10px; 
            margin-top: 6px;
        }

        .modal-tabs {
            display: flex;
            gap: 6px;
            border-bottom: 1px solid var(--border);
            padding-bottom: 4px;
            margin-bottom: 6px;
        }

        .modal-tab {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            color: var(--text-dim);
            cursor: pointer;
            padding: 4px 10px;
            border-radius: 4px;
            transition: all 0.2s;
        }

        .modal-tab:hover {
            color: var(--text);
            background: rgba(255, 255, 255, 0.05);
        }

        .modal-tab.active {
            color: var(--accent);
            background: rgba(0, 242, 255, 0.1);
        }

        .modal-tab-content {
            display: none;
            flex-direction: column;
            gap: 12px;
        }

        .modal-tab-content.active {
            display: flex;
        }

        /* Loading Spinner */
        .loading-spinner {
            width: 32px;
            height: 32px;
            border: 3px solid rgba(0, 242, 255, 0.15);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        button.send-btn.danger {
            background: rgba(255, 0, 85, 0.1);
            border-color: var(--error);
            color: var(--error);
        }

        button.send-btn.danger:hover {
            background: var(--error) !important;
            color: #000000 !important;
            box-shadow: 0 0 14px rgba(255, 0, 85, 0.4) !important;
        }

        /* Success Banner */
        .success-banner {
            display: none;
            background: rgba(0, 255, 170, 0.08);
            border: 1px solid var(--success);
            color: #00ffaa;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 8px;
            animation: fadeIn 0.2s ease-out;
            align-items: center;
            justify-content: space-between;
        }
    </style>
</head>
<body>
    <div class="request-tabs-bar" id="request-tabs-bar">
        <button class="tab-nav-btn" id="tab-prev-btn" title="Scroll Left" onclick="scrollTabs(-140)">‹</button>
        <div class="request-tabs-list" id="request-tabs-list"></div>
        <button class="tab-nav-btn" id="tab-next-btn" title="Scroll Right" onclick="scrollTabs(140)">›</button>
        <button class="new-tab-btn" id="new-tab-btn" title="New Request Tab" onclick="createNewTab()">+</button>
    </div>

    <div class="minimal-input-group" id="input-bar">
        <select id="method">
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
        </select>
        <input type="text" id="url" class="url" placeholder="https://api.endpoint.com/v1/resource">
        <button class="action-btn" id="save-btn" onclick="openSaveModal()">SAVE</button>
        <button id="send" class="send-btn">SEND</button>
    </div>

    <div class="alert-banner" id="alert-banner">
        <span id="alert-text">Please enter an endpoint URL before saving.</span>
        <button class="icon-btn" onclick="hideAlert()">✕</button>
    </div>

    <div class="success-banner" id="success-banner">
        <span id="success-text">Operation completed successfully.</span>
        <button class="icon-btn" onclick="hideSuccess()">✕</button>
    </div>

    <div class="loader" id="loader"></div>

    <div class="tabs">
        <div class="tab active" data-tab="headers">Headers</div>
        <div class="tab" data-tab="body">Body</div>
        <div class="tab" data-tab="auth">Auth</div>
        <div class="tab" data-tab="saved" onclick="loadSaved()">Saved</div>
        <div class="tab" data-tab="history" onclick="requestHistory()">History</div>
    </div>

    <div class="main-container" id="main-container">
        <!-- Request Configuration / Saved / History Area -->
        <div class="request-panel" id="request-panel">
            <div id="headers" class="tab-content active">
                <textarea id="headers-input" placeholder='{\n  "Content-Type": "application/json"\n}'></textarea>
            </div>

            <div id="body" class="tab-content">
                <textarea id="body-input" placeholder='{\n  "name": "example",\n  "status": "active"\n}'></textarea>
                <div class="action-bar">
                    <div></div>
                    <button class="sec-btn accent" onclick="beautifyBody()">Format JSON</button>
                </div>
            </div>

            <div id="auth" class="tab-content">
                <select id="auth-type" style="width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; margin-bottom: 8px;">
                    <option value="none">NO AUTH</option>
                    <option value="bearer">BEARER TOKEN</option>
                    <option value="basic">BASIC AUTH</option>
                </select>
                <div id="auth-bearer" style="display: none;">
                    <input type="text" id="token" placeholder="Bearer Token..." style="width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px;">
                </div>
                <div id="auth-basic" style="display: none; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                    <input type="text" id="username" placeholder="Username" style="background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px;">
                    <input type="password" id="password" placeholder="Password" style="background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px;">
                </div>
            </div>

            <div id="saved" class="tab-content">
                <div class="action-bar" style="margin-top: 0; margin-bottom: 8px;">
                    <div style="display: flex; gap: 6px;">
                        <button class="sec-btn" onclick="expandAllCollections()">Expand All</button>
                        <button class="sec-btn" onclick="collapseAllCollections()">Collapse All</button>
                    </div>
                    <div style="display: flex; gap: 6px;">
                        <button class="sec-btn" onclick="importSaved()">Import</button>
                        <button class="sec-btn accent" onclick="exportSaved()">Export</button>
                    </div>
                </div>
                <div class="list-container" id="saved-container"></div>
            </div>

            <div id="history" class="tab-content">
                <div class="action-bar" style="margin-top: 0; margin-bottom: 8px;">
                    <div></div>
                    <button class="sec-btn danger" onclick="clearHistory()">Clear History</button>
                </div>
                <div class="list-container" id="history-container"></div>
            </div>
        </div>

        <!-- Draggable Resizer Divider -->
        <div class="split-resizer" id="split-resizer">
            <div class="resizer-handle"></div>
        </div>

        <!-- Response Panel -->
        <div class="response-panel" id="response-panel">
            <div class="response-meta">
                <div class="status-info">
                    <span id="status-val"></span>
                    <span id="time-val" class="time-txt"></span>
                    <span id="line-val" class="line-txt"></span>
                </div>
                <div class="view-btns" id="v-control" style="display: none;">
                    <span class="v-btn active" data-view="pretty">Pretty</span>
                    <span class="v-btn" data-view="raw">Raw</span>
                </div>
            </div>

            <div class="response-viewport">
                <pre id="response-content">Ready. Send a request to see the response.</pre>
            </div>
        </div>
    </div>

    <!-- SAVE MODAL -->
    <div class="modal-overlay" id="save-modal">
        <div class="modal">
            <h3>Save Request</h3>
            <div class="modal-url-preview" id="modal-url-preview"></div>
            
            <label for="req-name">Request Name</label>
            <input type="text" id="req-name" placeholder="e.g., Get All Users">

            <label for="modal-collection-select">Collection / Group</label>
            <select id="modal-collection-select" onchange="onCollectionSelectChange()">
                <option value="General">General</option>
                <option value="__new__">+ New Collection...</option>
            </select>
            <input type="text" id="modal-new-collection" placeholder="Enter new collection name" style="display: none;">

            <div class="modal-btns">
                <button class="sec-btn" onclick="closeSaveModal()">Cancel</button>
                <button class="send-btn" onclick="confirmSave()">SAVE</button>
            </div>
        </div>
    </div>

    <!-- RENAME COLLECTION MODAL -->
    <div class="modal-overlay" id="rename-collection-modal">
        <div class="modal">
            <h3>Rename Collection</h3>
            <input type="hidden" id="rename-col-old-name">
            
            <label for="rename-col-input">New Collection Name</label>
            <input type="text" id="rename-col-input" placeholder="e.g., Auth V2">

            <div class="modal-btns">
                <button class="sec-btn" onclick="closeRenameCollectionModal()">Cancel</button>
                <button class="send-btn" onclick="confirmRenameCollection()">RENAME</button>
            </div>
        </div>
    </div>

    <!-- EDIT REQUEST MODAL -->
    <div class="modal-overlay" id="edit-request-modal">
        <div class="modal" style="width: 480px; max-height: 85vh; overflow-y: auto;">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
                <h3 style="margin: 0;">Edit Request</h3>
                <button class="icon-btn" onclick="closeEditRequestModal()">✕</button>
            </div>
            <input type="hidden" id="edit-req-id">

            <div class="modal-tabs">
                <div class="modal-tab active" data-modaltab="edit-tab-general">General</div>
                <div class="modal-tab" data-modaltab="edit-tab-headers">Headers</div>
                <div class="modal-tab" data-modaltab="edit-tab-body">Body</div>
                <div class="modal-tab" data-modaltab="edit-tab-auth">Auth</div>
            </div>

            <!-- GENERAL TAB -->
            <div id="edit-tab-general" class="modal-tab-content active">
                <label for="edit-req-name">Request Name</label>
                <input type="text" id="edit-req-name" placeholder="e.g., User Login">

                <label for="edit-req-method">Method</label>
                <select id="edit-req-method" style="width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px; color: var(--text);">
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                    <option value="DELETE">DELETE</option>
                </select>

                <label for="edit-req-url">Endpoint URL</label>
                <input type="text" id="edit-req-url" placeholder="https://api.endpoint.com/v1/resource">

                <label for="edit-req-collection-select">Collection / Group</label>
                <select id="edit-req-collection-select" onchange="onEditReqCollectionSelectChange()" style="width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px; color: var(--text);">
                    <option value="General">General</option>
                    <option value="__new__">+ New Collection...</option>
                </select>
                <input type="text" id="edit-req-new-collection" placeholder="Enter new collection name" style="display: none;">
            </div>

            <!-- HEADERS TAB -->
            <div id="edit-tab-headers" class="modal-tab-content">
                <label for="edit-req-headers">Headers (JSON)</label>
                <textarea id="edit-req-headers" style="height: 140px; font-family: monospace; font-size: 12px;" placeholder='{\n  "Content-Type": "application/json"\n}'></textarea>
            </div>

            <!-- BODY TAB -->
            <div id="edit-tab-body" class="modal-tab-content">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <label for="edit-req-body">Request Body</label>
                    <button class="sec-btn accent" type="button" style="font-size: 10px; padding: 2px 8px; min-height: 22px;" onclick="beautifyEditReqBody()">Format JSON</button>
                </div>
                <textarea id="edit-req-body" style="height: 140px; font-family: monospace; font-size: 12px;" placeholder='{\n  "key": "value"\n}'></textarea>
            </div>

            <!-- AUTH TAB -->
            <div id="edit-tab-auth" class="modal-tab-content">
                <label for="edit-req-auth-type">Auth Type</label>
                <select id="edit-req-auth-type" onchange="onEditReqAuthTypeChange()" style="width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px; color: var(--text);">
                    <option value="none">NO AUTH</option>
                    <option value="bearer">BEARER TOKEN</option>
                    <option value="basic">BASIC AUTH</option>
                </select>
                <div id="edit-auth-bearer" style="display: none; margin-top: 8px;">
                    <label for="edit-req-token">Bearer Token</label>
                    <input type="text" id="edit-req-token" placeholder="Bearer Token..." style="width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px;">
                </div>
                <div id="edit-auth-basic" style="display: none; margin-top: 8px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                    <div>
                        <label for="edit-req-username">Username</label>
                        <input type="text" id="edit-req-username" placeholder="Username" style="width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px;">
                    </div>
                    <div>
                        <label for="edit-req-password">Password</label>
                        <input type="password" id="edit-req-password" placeholder="Password" style="width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px;">
                    </div>
                </div>
            </div>

            <div class="modal-btns" style="margin-top: 8px; border-top: 1px solid var(--border); padding-top: 12px;">
                <button class="sec-btn" onclick="closeEditRequestModal()">Cancel</button>
                <button class="send-btn" onclick="confirmEditRequest()">SAVE CHANGES</button>
            </div>
        </div>
    </div>

    <!-- CONFIRMATION MODAL -->
    <div class="modal-overlay" id="confirm-modal">
        <div class="modal" style="width: 380px;">
            <h3 id="confirm-title" style="margin: 0; color: var(--error);">Delete Request</h3>
            <p id="confirm-message" style="margin: 6px 0 12px 0; font-size: 12px; color: var(--text-dim); line-height: 1.45;"></p>
            <div class="modal-btns">
                <button class="sec-btn" onclick="closeConfirmModal()">Cancel</button>
                <button class="send-btn danger" id="confirm-action-btn">DELETE</button>
            </div>
        </div>
    </div>

    <!-- IMPORT LOADING OVERLAY -->
    <div class="modal-overlay" id="import-loading-modal" style="backdrop-filter: blur(6px);">
        <div class="modal" style="width: 300px; text-align: center; align-items: center; gap: 14px;">
            <div class="loading-spinner"></div>
            <h3 style="margin: 0;">Importing Collection</h3>
            <p style="margin: 0; font-size: 12px; color: var(--text-dim);">Parsing and loading requests...</p>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let lastResponse = null;
        let currentView = 'pretty';
        let existingCollections = ['General'];

        const methodEl = document.getElementById('method');
        const mainContainer = document.getElementById('main-container');
        const requestPanel = document.getElementById('request-panel');
        const splitResizer = document.getElementById('split-resizer');
        const alertBanner = document.getElementById('alert-banner');
        const alertText = document.getElementById('alert-text');

        // Multi-Tab Parallel Requests System
        let requestTabs = [
            {
                id: 'tab_' + Date.now(),
                title: 'New Request',
                method: 'GET',
                url: '',
                headers: '',
                body: '',
                auth: { type: 'none', token: '', username: '', password: '' },
                activeSubTab: 'headers',
                lastResponse: null,
                currentView: 'pretty'
            }
        ];
        let activeTabId = requestTabs[0].id;

        function getActiveTab() {
            return requestTabs.find(t => t.id === activeTabId) || requestTabs[0];
        }

        function saveActiveTabState() {
            const tab = getActiveTab();
            if (!tab) return;
            tab.method = methodEl.value;
            tab.url = document.getElementById('url').value;
            tab.headers = document.getElementById('headers-input').value;
            tab.body = document.getElementById('body-input').value;
            tab.auth = {
                type: document.getElementById('auth-type').value,
                token: document.getElementById('token').value,
                username: document.getElementById('username').value,
                password: document.getElementById('password').value
            };
            const activeTabElem = document.querySelector('.tabs .tab.active');
            tab.activeSubTab = activeTabElem ? activeTabElem.dataset.tab : 'headers';
            tab.lastResponse = lastResponse;
            tab.currentView = currentView;
            
            if (!tab.customName) {
                const trimmedUrl = tab.url.trim();
                if (trimmedUrl) {
                    try {
                        const parsed = new URL(trimmedUrl);
                        tab.title = parsed.pathname || parsed.hostname || trimmedUrl;
                    } catch(e) {
                        tab.title = trimmedUrl;
                    }
                } else {
                    tab.title = 'New Request';
                }
            }
        }

        function loadTabState(tabId) {
            const tab = requestTabs.find(t => t.id === tabId);
            if (!tab) return;
            activeTabId = tabId;

            methodEl.value = tab.method || 'GET';
            updateMethodColor();
            document.getElementById('url').value = tab.url || '';
            document.getElementById('headers-input').value = tab.headers || '';
            document.getElementById('body-input').value = tab.body || '';

            const auth = tab.auth || { type: 'none' };
            document.getElementById('auth-type').value = auth.type || 'none';
            document.getElementById('token').value = auth.token || '';
            document.getElementById('username').value = auth.username || '';
            document.getElementById('password').value = auth.password || '';
            document.getElementById('auth-type').dispatchEvent(new Event('change'));

            const targetSubTab = tab.activeSubTab || 'headers';
            const subTabEl = document.querySelector('.tab[data-tab="' + targetSubTab + '"]');
            if (subTabEl) {
                subTabEl.click();
            }

            lastResponse = tab.lastResponse || null;
            currentView = tab.currentView || 'pretty';
            document.querySelectorAll('.v-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.view === currentView);
            });

            if (lastResponse) {
                const statusVal = document.getElementById('status-val');
                statusVal.textContent = lastResponse.status + ' ' + (lastResponse.statusText || '');
                statusVal.className = (typeof lastResponse.status === 'number' && lastResponse.status >= 200 && lastResponse.status < 300)
                    ? 'status-txt'
                    : 'status-err';
                document.getElementById('time-val').textContent = (lastResponse.time || 0) + 'ms';
                document.getElementById('v-control').style.display = 'flex';
                renderResponse();
            } else {
                document.getElementById('status-val').textContent = '200 OK';
                document.getElementById('status-val').className = 'status-txt';
                document.getElementById('time-val').textContent = '0ms';
                document.getElementById('line-val').textContent = '0 lines';
                document.getElementById('v-control').style.display = 'none';
                document.getElementById('response-content').textContent = 'Ready. Send a request to see the response.';
            }

            renderRequestTabs();
        }

        function scrollTabs(delta) {
            const list = document.getElementById('request-tabs-list');
            if (list) {
                list.scrollBy({ left: delta, behavior: 'smooth' });
                setTimeout(updateTabNavButtons, 200);
            }
        }

        function updateTabNavButtons() {
            const list = document.getElementById('request-tabs-list');
            const prevBtn = document.getElementById('tab-prev-btn');
            const nextBtn = document.getElementById('tab-next-btn');
            if (!list || !prevBtn || !nextBtn) return;
            
            const isOverflowing = list.scrollWidth > list.clientWidth + 2;
            if (!isOverflowing) {
                prevBtn.style.display = 'none';
                nextBtn.style.display = 'none';
            } else {
                prevBtn.style.display = 'inline-flex';
                nextBtn.style.display = 'inline-flex';
                prevBtn.style.opacity = list.scrollLeft <= 2 ? '0.3' : '1';
                prevBtn.style.pointerEvents = list.scrollLeft <= 2 ? 'none' : 'auto';
                const maxScroll = list.scrollWidth - list.clientWidth - 2;
                nextBtn.style.opacity = list.scrollLeft >= maxScroll ? '0.3' : '1';
                nextBtn.style.pointerEvents = list.scrollLeft >= maxScroll ? 'none' : 'auto';
            }
        }

        function renderRequestTabs() {
            const container = document.getElementById('request-tabs-list');
            if (!container) return;
            container.innerHTML = '';

            requestTabs.forEach(tab => {
                const tabEl = document.createElement('div');
                tabEl.className = 'req-tab' + (tab.id === activeTabId ? ' active' : '');
                
                const methodSpan = document.createElement('span');
                methodSpan.className = 'req-tab-method m-' + tab.method;
                methodSpan.textContent = tab.method;

                const titleSpan = document.createElement('span');
                titleSpan.className = 'req-tab-title';
                titleSpan.textContent = tab.title || 'New Request';
                titleSpan.title = tab.url ? (tab.method + ' ' + tab.url) : tab.title;

                const closeBtn = document.createElement('span');
                closeBtn.className = 'req-tab-close';
                closeBtn.textContent = '✕';
                closeBtn.title = 'Close tab';
                closeBtn.onclick = (e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                };

                tabEl.appendChild(methodSpan);
                tabEl.appendChild(titleSpan);
                if (requestTabs.length > 1) {
                    tabEl.appendChild(closeBtn);
                }

                tabEl.onclick = () => {
                    if (tab.id === activeTabId) return;
                    saveActiveTabState();
                    loadTabState(tab.id);
                };

                container.appendChild(tabEl);
            });

            updateTabNavButtons();
            setTimeout(() => {
                const activeEl = container.querySelector('.req-tab.active');
                if (activeEl) {
                    activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
                }
                updateTabNavButtons();
            }, 30);
        }

        function createNewTab(initialData) {
            saveActiveTabState();
            const newTab = {
                id: 'tab_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
                title: initialData && initialData.name ? initialData.name : 'New Request',
                customName: initialData && initialData.name ? initialData.name : undefined,
                method: initialData && initialData.method ? initialData.method : 'GET',
                url: initialData && initialData.url ? initialData.url : '',
                headers: initialData && initialData.headers ? initialData.headers : '',
                body: initialData && initialData.body ? initialData.body : '',
                auth: initialData && initialData.auth ? initialData.auth : { type: 'none', token: '', username: '', password: '' },
                activeSubTab: 'headers',
                lastResponse: null,
                currentView: 'pretty'
            };
            requestTabs.push(newTab);
            loadTabState(newTab.id);
        }

        function closeTab(tabId) {
            if (requestTabs.length <= 1) return;
            const index = requestTabs.findIndex(t => t.id === tabId);
            if (index === -1) return;

            requestTabs.splice(index, 1);
            if (activeTabId === tabId) {
                const nextIndex = Math.min(index, requestTabs.length - 1);
                loadTabState(requestTabs[nextIndex].id);
            } else {
                renderRequestTabs();
            }
        }

        const tabsList = document.getElementById('request-tabs-list');
        if (tabsList) {
            tabsList.addEventListener('wheel', (e) => {
                if (e.deltaY !== 0) {
                    tabsList.scrollLeft += e.deltaY;
                    e.preventDefault();
                    updateTabNavButtons();
                }
            }, { passive: false });
            tabsList.addEventListener('scroll', updateTabNavButtons);
        }
        window.addEventListener('resize', updateTabNavButtons);

        function updateMethodColor() {
            const method = methodEl.value;
            methodEl.className = 'm-' + method;
        }

        methodEl.addEventListener('change', () => {
            updateMethodColor();
            saveActiveTabState();
            renderRequestTabs();
        });
        updateMethodColor();

        document.getElementById('url').addEventListener('input', () => {
            const tab = getActiveTab();
            if (tab && !tab.customName) {
                const val = document.getElementById('url').value.trim();
                tab.title = val || 'New Request';
            }
            saveActiveTabState();
            renderRequestTabs();
        });

        document.getElementById('headers-input').addEventListener('input', saveActiveTabState);
        document.getElementById('body-input').addEventListener('input', saveActiveTabState);
        document.getElementById('token').addEventListener('input', saveActiveTabState);
        document.getElementById('username').addEventListener('input', saveActiveTabState);
        document.getElementById('password').addEventListener('input', saveActiveTabState);

        const successBanner = document.getElementById('success-banner');
        const successText = document.getElementById('success-text');

        function showAlert(msg) {
            alertText.textContent = msg;
            alertBanner.style.display = 'flex';
            document.getElementById('input-bar').classList.add('has-error');
            setTimeout(() => {
                hideAlert();
            }, 4000);
        }

        function hideAlert() {
            alertBanner.style.display = 'none';
            document.getElementById('input-bar').classList.remove('has-error');
        }

        function showSuccess(msg) {
            successText.textContent = msg;
            successBanner.style.display = 'flex';
            setTimeout(() => {
                hideSuccess();
            }, 4000);
        }

        function hideSuccess() {
            successBanner.style.display = 'none';
        }

        // Tab Switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const targetTab = tab.dataset.tab;
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                
                tab.classList.add('active');
                document.getElementById(targetTab).classList.add('active');

                // Full-view mode for Saved & History (hide response pane and resizer)
                if (targetTab === 'saved' || targetTab === 'history') {
                    mainContainer.classList.add('full-view');
                } else {
                    mainContainer.classList.remove('full-view');
                }
                saveActiveTabState();
            });
        });

        // Auth Selector
        document.getElementById('auth-type').addEventListener('change', (e) => {
            document.getElementById('auth-bearer').style.display = e.target.value === 'bearer' ? 'block' : 'none';
            document.getElementById('auth-basic').style.display = e.target.value === 'basic' ? 'grid' : 'none';
            saveActiveTabState();
        });

        // View Mode (Pretty vs Raw)
        document.querySelectorAll('.v-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.v-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentView = btn.dataset.view;
                saveActiveTabState();
                renderResponse();
            });
        });

        // Format Body JSON
        function beautifyBody() {
            const el = document.getElementById('body-input');
            try {
                const obj = JSON.parse(el.value);
                el.value = JSON.stringify(obj, null, 2);
                saveActiveTabState();
            } catch (e) {}
        }

        function requestHistory() {
            vscode.postMessage({ command: 'loadHistory' });
        }

        function clearHistory() {
            showConfirmDialog(
                'Clear History',
                'Are you sure you want to clear all request history?',
                'CLEAR HISTORY',
                () => {
                    vscode.postMessage({ command: 'clearHistory' });
                    updateHistoryList([]);
                }
            );
        }

        function loadSaved() {
            vscode.postMessage({ command: 'getSavedRequests' });
        }

        function exportSaved() {
            vscode.postMessage({ command: 'exportSaved' });
        }

        function importSaved() {
            document.getElementById('import-loading-modal').style.display = 'flex';
            vscode.postMessage({ command: 'importSaved' });
        }

        // Resizable Split Logic
        let isDragging = false;
        let startY = 0;
        let startHeight = 0;

        splitResizer.addEventListener('mousedown', (e) => {
            isDragging = true;
            startY = e.clientY;
            startHeight = requestPanel.offsetHeight;
            splitResizer.classList.add('dragging');
            document.body.style.cursor = 'ns-resize';
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dy = e.clientY - startY;
            const newHeight = Math.max(90, Math.min(mainContainer.offsetHeight - 90, startHeight + dy));
            requestPanel.style.height = newHeight + 'px';
            try {
                vscode.setState({ panelHeight: newHeight });
            } catch(e) {}
        });

        window.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                splitResizer.classList.remove('dragging');
                document.body.style.cursor = '';
            }
        });

        // Restore saved panel height if present
        try {
            const state = vscode.getState();
            if (state && state.panelHeight) {
                requestPanel.style.height = state.panelHeight + 'px';
            }
        } catch(e) {}

        // Save Modal & Validation
        function openSaveModal() {
            const url = document.getElementById('url').value.trim();
            if (!url) {
                showAlert('Please enter an endpoint URL before saving.');
                document.getElementById('url').focus();
                return;
            }

            hideAlert();
            const method = document.getElementById('method').value;
            document.getElementById('modal-url-preview').textContent = method + '  ' + url;

            // Populate collection dropdown
            const selectEl = document.getElementById('modal-collection-select');
            selectEl.innerHTML = '';
            existingCollections.forEach(col => {
                const opt = document.createElement('option');
                opt.value = col;
                opt.textContent = col;
                selectEl.appendChild(opt);
            });
            const newOpt = document.createElement('option');
            newOpt.value = '__new__';
            newOpt.textContent = '+ New Collection...';
            selectEl.appendChild(newOpt);

            document.getElementById('modal-new-collection').style.display = 'none';
            document.getElementById('modal-new-collection').value = '';
            document.getElementById('req-name').value = '';

            document.getElementById('save-modal').style.display = 'flex';
            document.getElementById('req-name').focus();
        }

        function onCollectionSelectChange() {
            const val = document.getElementById('modal-collection-select').value;
            const newColInput = document.getElementById('modal-new-collection');
            if (val === '__new__') {
                newColInput.style.display = 'block';
                newColInput.focus();
            } else {
                newColInput.style.display = 'none';
            }
        }

        function closeSaveModal() {
            document.getElementById('save-modal').style.display = 'none';
            document.getElementById('req-name').value = '';
        }

        function confirmSave() {
            const nameInput = document.getElementById('req-name').value.trim();
            const name = nameInput || 'Untitled Request';

            let collection = document.getElementById('modal-collection-select').value;
            if (collection === '__new__') {
                collection = document.getElementById('modal-new-collection').value.trim() || 'General';
            }

            const url = document.getElementById('url').value.trim();
            if (!url) {
                showAlert('URL cannot be empty.');
                return;
            }

            const req = {
                method: document.getElementById('method').value,
                url: url,
                headers: document.getElementById('headers-input').value,
                body: document.getElementById('body-input').value,
                auth: {
                    type: document.getElementById('auth-type').value,
                    token: document.getElementById('token').value,
                    username: document.getElementById('username').value,
                    password: document.getElementById('password').value
                }
            };
            
            vscode.postMessage({ command: 'saveRequest', name, collection, req });
            closeSaveModal();
        }

        let rawSavedRequests = [];
        let draggedId = null;
        let onConfirmCallback = null;

        function showConfirmDialog(title, message, btnText, callback) {
            document.getElementById('confirm-title').textContent = title;
            document.getElementById('confirm-message').textContent = message;
            const actionBtn = document.getElementById('confirm-action-btn');
            actionBtn.textContent = btnText || 'DELETE';
            onConfirmCallback = callback;
            document.getElementById('confirm-modal').style.display = 'flex';
        }

        function closeConfirmModal() {
            document.getElementById('confirm-modal').style.display = 'none';
            onConfirmCallback = null;
        }

        document.getElementById('confirm-action-btn').addEventListener('click', () => {
            if (typeof onConfirmCallback === 'function') {
                const cb = onConfirmCallback;
                closeConfirmModal();
                cb();
            } else {
                closeConfirmModal();
            }
        });

        function deleteSaved(id, event) {
            if (event) event.stopPropagation();
            showConfirmDialog(
                'Delete Request',
                'Are you sure you want to delete this saved request?',
                'DELETE',
                () => {
                    vscode.postMessage({ command: 'deleteSavedRequest', id });
                    rawSavedRequests = rawSavedRequests.filter(r => r.id !== id);
                    updateSavedList(rawSavedRequests);
                }
            );
        }

        function deleteCollection(colName, event) {
            if (event) event.stopPropagation();
            const count = rawSavedRequests.filter(r => ((r.collection || 'General').trim() || 'General') === colName).length;
            showConfirmDialog(
                'Delete Collection',
                'Are you sure you want to delete collection "' + colName + '" and all its ' + count + ' request(s)?',
                'DELETE COLLECTION',
                () => {
                    vscode.postMessage({ command: 'deleteCollection', collection: colName });
                    rawSavedRequests = rawSavedRequests.filter(r => ((r.collection || 'General').trim() || 'General') !== colName);
                    updateSavedList(rawSavedRequests);
                }
            );
        }

        function expandAllCollections() {
            document.querySelectorAll('.collection-folder').forEach(folder => {
                folder.classList.add('open');
            });
        }

        function collapseAllCollections() {
            document.querySelectorAll('.collection-folder').forEach(folder => {
                folder.classList.remove('open');
            });
        }

        // Rename Collection Modal
        function openRenameCollectionModal(colName, event) {
            if (event) event.stopPropagation();
            document.getElementById('rename-col-old-name').value = colName;
            const input = document.getElementById('rename-col-input');
            input.value = colName;
            document.getElementById('rename-collection-modal').style.display = 'flex';
            input.focus();
            input.select();
        }

        function closeRenameCollectionModal() {
            document.getElementById('rename-collection-modal').style.display = 'none';
        }

        function confirmRenameCollection() {
            const oldName = document.getElementById('rename-col-old-name').value.trim();
            const newName = document.getElementById('rename-col-input').value.trim();
            if (!newName) {
                showAlert('Collection name cannot be empty.');
                return;
            }
            if (oldName && newName && oldName !== newName) {
                vscode.postMessage({ command: 'renameCollection', oldName, newName });
                rawSavedRequests = rawSavedRequests.map(r => {
                    if (((r.collection || 'General').trim() || 'General') === oldName) {
                        return { ...r, collection: newName };
                    }
                    return r;
                });
                updateSavedList(rawSavedRequests);
            }
            closeRenameCollectionModal();
        }

        // Edit Request Modal
        function openEditRequestModal(id, event) {
            if (event) event.stopPropagation();
            const req = rawSavedRequests.find(r => r.id === id);
            if (!req) return;

            document.getElementById('edit-req-id').value = id;
            document.getElementById('edit-req-name').value = req.name || '';
            document.getElementById('edit-req-method').value = req.method || 'GET';
            document.getElementById('edit-req-url').value = req.url || '';
            document.getElementById('edit-req-headers').value = req.headers || '';
            document.getElementById('edit-req-body').value = req.body || '';

            const auth = req.auth || { type: 'none' };
            document.getElementById('edit-req-auth-type').value = auth.type || 'none';
            document.getElementById('edit-req-token').value = auth.token || '';
            document.getElementById('edit-req-username').value = auth.username || '';
            document.getElementById('edit-req-password').value = auth.password || '';
            onEditReqAuthTypeChange();

            // Populate collection select
            const selectEl = document.getElementById('edit-req-collection-select');
            selectEl.innerHTML = '';
            existingCollections.forEach(col => {
                const opt = document.createElement('option');
                opt.value = col;
                opt.textContent = col;
                selectEl.appendChild(opt);
            });
            const newOpt = document.createElement('option');
            newOpt.value = '__new__';
            newOpt.textContent = '+ New Collection...';
            selectEl.appendChild(newOpt);

            selectEl.value = (req.collection || 'General').trim() || 'General';
            document.getElementById('edit-req-new-collection').style.display = 'none';
            document.getElementById('edit-req-new-collection').value = '';

            // Reset modal tabs to General
            document.querySelectorAll('#edit-request-modal .modal-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('#edit-request-modal .modal-tab-content').forEach(c => c.classList.remove('active'));
            const defaultTab = document.querySelector('#edit-request-modal .modal-tab[data-modaltab="edit-tab-general"]');
            if (defaultTab) defaultTab.classList.add('active');
            const defaultContent = document.getElementById('edit-tab-general');
            if (defaultContent) defaultContent.classList.add('active');

            document.getElementById('edit-request-modal').style.display = 'flex';
            document.getElementById('edit-req-name').focus();
        }

        function onEditReqCollectionSelectChange() {
            const val = document.getElementById('edit-req-collection-select').value;
            const newColInput = document.getElementById('edit-req-new-collection');
            if (val === '__new__') {
                newColInput.style.display = 'block';
                newColInput.focus();
            } else {
                newColInput.style.display = 'none';
            }
        }

        function onEditReqAuthTypeChange() {
            const val = document.getElementById('edit-req-auth-type').value;
            document.getElementById('edit-auth-bearer').style.display = val === 'bearer' ? 'block' : 'none';
            document.getElementById('edit-auth-basic').style.display = val === 'basic' ? 'grid' : 'none';
        }

        function beautifyEditReqBody() {
            const el = document.getElementById('edit-req-body');
            try {
                const obj = JSON.parse(el.value);
                el.value = JSON.stringify(obj, null, 2);
            } catch(e) {}
        }

        function closeEditRequestModal() {
            document.getElementById('edit-request-modal').style.display = 'none';
        }

        function confirmEditRequest() {
            const id = document.getElementById('edit-req-id').value;
            const name = document.getElementById('edit-req-name').value.trim() || 'Untitled Request';
            const method = document.getElementById('edit-req-method').value;
            const url = document.getElementById('edit-req-url').value.trim();
            const headers = document.getElementById('edit-req-headers').value;
            const body = document.getElementById('edit-req-body').value;
            const authType = document.getElementById('edit-req-auth-type').value;
            const token = document.getElementById('edit-req-token').value;
            const username = document.getElementById('edit-req-username').value;
            const password = document.getElementById('edit-req-password').value;

            const auth = {
                type: authType,
                token: token,
                username: username,
                password: password
            };

            if (!url) {
                showAlert('Endpoint URL cannot be empty.');
                return;
            }

            let collection = document.getElementById('edit-req-collection-select').value;
            if (collection === '__new__') {
                collection = document.getElementById('edit-req-new-collection').value.trim() || 'General';
            }

            vscode.postMessage({
                command: 'updateSavedRequest',
                id,
                name,
                url,
                method,
                collection,
                headers,
                body,
                auth
            });

            rawSavedRequests = rawSavedRequests.map(r => {
                if (r.id === id) {
                    return { ...r, name, url, method, collection, headers, body, auth };
                }
                return r;
            });
            updateSavedList(rawSavedRequests);
            closeEditRequestModal();
        }

        // Modal Tab Switching Handler
        document.querySelectorAll('.modal-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const modal = tab.closest('.modal');
                if (!modal) return;
                modal.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
                modal.querySelectorAll('.modal-tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                const target = document.getElementById(tab.dataset.modaltab);
                if (target) target.classList.add('active');
            });
        });

        // Drag and Drop Handlers
        function cleanDragStyles() {
            document.querySelectorAll('.list-item').forEach(el => {
                el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
            });
            document.querySelectorAll('.collection-folder').forEach(el => {
                el.classList.remove('drag-over-folder');
            });
        }

        function onItemDragStart(e, id) {
            draggedId = id;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', id);
            setTimeout(() => {
                const el = document.querySelector('[data-id="' + id + '"]');
                if (el) el.classList.add('dragging');
            }, 0);
        }

        function onItemDragEnd(e) {
            draggedId = null;
            cleanDragStyles();
        }

        function onItemDragOver(e, targetId) {
            e.preventDefault();
            e.stopPropagation();
            if (!draggedId || draggedId === targetId) return;

            const targetEl = document.querySelector('[data-id="' + targetId + '"]');
            if (!targetEl) return;

            const rect = targetEl.getBoundingClientRect();
            const isAfter = e.clientY > rect.top + rect.height / 2;

            targetEl.classList.toggle('drag-over-top', !isAfter);
            targetEl.classList.toggle('drag-over-bottom', isAfter);
        }

        function onItemDragLeave(e) {
            const el = e.currentTarget;
            if (el) {
                el.classList.remove('drag-over-top', 'drag-over-bottom');
            }
        }

        function onItemDrop(e, targetId) {
            e.preventDefault();
            e.stopPropagation();
            cleanDragStyles();

            if (!draggedId || draggedId === targetId) return;

            const draggedIndex = rawSavedRequests.findIndex(r => r.id === draggedId);
            const targetIndex = rawSavedRequests.findIndex(r => r.id === targetId);
            if (draggedIndex === -1 || targetIndex === -1) return;

            const [draggedItem] = rawSavedRequests.splice(draggedIndex, 1);
            const targetItem = rawSavedRequests.find(r => r.id === targetId);
            if (targetItem) {
                draggedItem.collection = targetItem.collection || 'General';
            }

            const newTargetIndex = rawSavedRequests.findIndex(r => r.id === targetId);
            const targetEl = document.querySelector('[data-id="' + targetId + '"]');
            let insertAfter = false;
            if (targetEl) {
                const rect = targetEl.getBoundingClientRect();
                insertAfter = (e.clientY > rect.top + rect.height / 2);
            }

            const insertIndex = insertAfter ? newTargetIndex + 1 : newTargetIndex;
            rawSavedRequests.splice(insertIndex, 0, draggedItem);

            vscode.postMessage({ command: 'reorderSavedRequests', saved: rawSavedRequests });
            updateSavedList(rawSavedRequests);
        }

        function onFolderDragOver(e, colName) {
            e.preventDefault();
            e.stopPropagation();
            const folder = e.currentTarget.closest('.collection-folder');
            if (folder) folder.classList.add('drag-over-folder');
        }

        function onFolderDragLeave(e) {
            const folder = e.currentTarget.closest('.collection-folder');
            if (folder) folder.classList.remove('drag-over-folder');
        }

        function onFolderDrop(e, targetColName) {
            e.preventDefault();
            e.stopPropagation();
            cleanDragStyles();

            if (!draggedId) return;
            const draggedIndex = rawSavedRequests.findIndex(r => r.id === draggedId);
            if (draggedIndex === -1) return;

            const [draggedItem] = rawSavedRequests.splice(draggedIndex, 1);
            draggedItem.collection = targetColName;

            let lastColIndex = -1;
            for (let i = rawSavedRequests.length - 1; i >= 0; i--) {
                const c = (rawSavedRequests[i].collection || 'General').trim() || 'General';
                if (c === targetColName) {
                    lastColIndex = i;
                    break;
                }
            }

            if (lastColIndex !== -1) {
                rawSavedRequests.splice(lastColIndex + 1, 0, draggedItem);
            } else {
                rawSavedRequests.push(draggedItem);
            }

            vscode.postMessage({ command: 'reorderSavedRequests', saved: rawSavedRequests });
            updateSavedList(rawSavedRequests);
        }

        // Send Request
        const sendBtn = document.getElementById('send');
        const loader = document.getElementById('loader');

        sendBtn.addEventListener('click', () => {
            const url = document.getElementById('url').value.trim();
            if (!url) {
                showAlert('Please enter an endpoint URL.');
                document.getElementById('url').focus();
                return;
            }

            hideAlert();
            sendBtn.textContent = '...';
            sendBtn.disabled = true;
            loader.style.display = 'block';
            loader.style.width = '100%';
            
            vscode.postMessage({
                command: 'sendRequest',
                method: document.getElementById('method').value,
                url: url,
                headers: document.getElementById('headers-input').value,
                body: document.getElementById('body-input').value,
                authType: document.getElementById('auth-type').value,
                token: document.getElementById('token').value,
                username: document.getElementById('username').value,
                password: document.getElementById('password').value
            });
        });

        // Response Rendering
        function renderResponse() {
            if (!lastResponse) return;
            const contentEl = document.getElementById('response-content');
            const lineVal = document.getElementById('line-val');
            contentEl.innerHTML = '';
            
            let dataStr = "";
            let dataLines = 0;

            if (currentView === 'pretty') {
                const cType = (lastResponse.contentType || '').toLowerCase();
                if (cType.includes('json') || (typeof lastResponse.data === 'object')) {
                    try {
                        let data = lastResponse.data;
                        if (typeof data === 'string') data = JSON.parse(data);
                        
                        dataStr = JSON.stringify(data, null, 2);
                        dataLines = dataStr.split('\\n').length;
                        
                        const tree = document.createElement('div');
                        tree.className = 'json-tree';
                        tree.appendChild(buildJsonTree(data));
                        contentEl.appendChild(tree);
                    } catch(e) {
                         dataStr = typeof lastResponse.data === 'string' ? lastResponse.data : JSON.stringify(lastResponse.data, null, 2);
                         contentEl.textContent = dataStr;
                         dataLines = dataStr.split('\\n').length;
                    }
                } else {
                    dataStr = typeof lastResponse.data === 'string' ? lastResponse.data : JSON.stringify(lastResponse.data, null, 2);
                    contentEl.textContent = dataStr;
                    dataLines = dataStr.split('\\n').length;
                }
            } else {
                dataStr = typeof lastResponse.data === 'string' 
                    ? lastResponse.data 
                    : JSON.stringify(lastResponse.data, null, 2);
                contentEl.textContent = dataStr;
                dataLines = dataStr.split('\\n').length;
            }
            
            lineVal.textContent = dataLines + ' lines';
        }

        function createSpan(text, cls) {
            const span = document.createElement('span');
            span.textContent = text;
            if(cls) span.className = cls;
            return span;
        }

        function buildJsonTree(data) {
            if (data === null) return createSpan('null', 'null');
            if (typeof data === 'boolean') return createSpan(data.toString(), 'boolean');
            if (typeof data === 'number') return createSpan(data.toString(), 'number');
            if (typeof data === 'string') return createSpan('"' + data + '"', 'string');

            if (Object.keys(data).length === 0) {
                 return createSpan(Array.isArray(data) ? '[]' : '{}', 'bracket');
            }

            const isArray = Array.isArray(data);
            const container = document.createElement('div');
            
            const openSpan = document.createElement('span');
            openSpan.className = 'collapsible';
            openSpan.innerHTML = '<span class="bracket">' + (isArray ? '[' : '{') + '</span>';
            openSpan.onclick = function(e) {
                e.stopPropagation();
                this.classList.toggle('collapsed');
            };
            container.appendChild(openSpan);

            const contentDiv = document.createElement('div');
            contentDiv.className = 'json-content';
            
            const keys = Object.keys(data);
            keys.forEach((key, index) => {
                const itemDiv = document.createElement('div');
                
                if (!isArray) {
                    const keySpan = createSpan('"' + key + '":', 'key');
                    itemDiv.appendChild(keySpan);
                    itemDiv.appendChild(document.createTextNode(' '));
                }
                
                itemDiv.appendChild(buildJsonTree(data[key]));
                
                if (index < keys.length - 1) {
                    itemDiv.appendChild(createSpan(',', 'bracket'));
                }
                
                contentDiv.appendChild(itemDiv);
            });
            
            container.appendChild(contentDiv);
            container.appendChild(createSpan(isArray ? ']' : '}', 'bracket'));

            return container;
        }

        function loadFromItem(item) {
            const tab = getActiveTab();
            tab.title = item.name || item.url || 'Request';
            tab.customName = item.name;
            tab.method = item.method;
            tab.url = item.url;
            tab.headers = item.headers || '';
            tab.body = item.body || '';
            tab.auth = item.auth || { type: 'none' };
            tab.lastResponse = null;

            loadTabState(tab.id);
            const headersTab = document.querySelector('.tab[data-tab="headers"]');
            if (headersTab) {
                headersTab.click();
            }
        }

        function updateHistoryList(history) {
            const container = document.getElementById('history-container');
            if(!container) return;
            container.innerHTML = '';

            if (history.length === 0) {
                container.innerHTML = '<div class="empty-state">No requests in history yet.</div>';
                return;
            }

            history.forEach(item => {
                const el = document.createElement('div');
                el.className = 'list-item';
                el.innerHTML = 
                    '<span class="method m-' + item.method + '">' + item.method + '</span>' +
                    '<div class="info">' +
                        '<span class="url">' + item.url + '</span>' +
                        '<span class="meta">' + item.timestamp + '</span>' +
                    '</div>';
                el.onclick = () => loadFromItem(item);
                container.appendChild(el);
            });
        }

        function updateSavedList(saved) {
            rawSavedRequests = Array.isArray(saved) ? saved : [];
            const container = document.getElementById('saved-container');
            if (!container) return;
            container.innerHTML = '';

            if (!rawSavedRequests || rawSavedRequests.length === 0) {
                container.innerHTML = '<div class="empty-state">No saved requests. Click SAVE in the top bar to store your requests.</div>';
                existingCollections = ['General'];
                return;
            }

            // Group requests by collection
            const collectionsMap = new Map();
            rawSavedRequests.forEach(item => {
                const col = (item.collection || 'General').trim() || 'General';
                if (!collectionsMap.has(col)) {
                    collectionsMap.set(col, []);
                }
                collectionsMap.get(col).push(item);
            });

            existingCollections = Array.from(collectionsMap.keys()).sort();

            existingCollections.forEach(colName => {
                const reqs = collectionsMap.get(colName);
                const folderEl = document.createElement('div');
                folderEl.className = 'collection-folder open';
                folderEl.dataset.collection = colName;

                const headerEl = document.createElement('div');
                headerEl.className = 'collection-header';
                headerEl.innerHTML = 
                    '<div class="collection-title-group">' +
                        '<span class="collection-icon">›</span>' +
                        '<span>' + colName + '</span>' +
                        '<span class="collection-count-badge">' + reqs.length + '</span>' +
                    '</div>' +
                    '<div class="collection-actions">' +
                        '<button class="icon-btn" title="Rename Collection" onclick="openRenameCollectionModal(\\'' + colName.replace(/'/g, "\\\\'") + '\\', event)">Rename</button>' +
                        '<button class="icon-btn danger" title="Delete Collection" onclick="deleteCollection(\\'' + colName.replace(/'/g, "\\\\'") + '\\', event)">✕</button>' +
                    '</div>';

                headerEl.onclick = (e) => {
                    if (e.target.closest('.collection-actions')) return;
                    folderEl.classList.toggle('open');
                };

                const bodyEl = document.createElement('div');
                bodyEl.className = 'collection-body';
                bodyEl.ondragover = (e) => onFolderDragOver(e, colName);
                bodyEl.ondragleave = (e) => onFolderDragLeave(e);
                bodyEl.ondrop = (e) => onFolderDrop(e, colName);

                reqs.forEach(item => {
                    const itemEl = document.createElement('div');
                    itemEl.className = 'list-item';
                    itemEl.draggable = true;
                    itemEl.dataset.id = item.id;
                    itemEl.dataset.collection = colName;

                    itemEl.ondragstart = (e) => onItemDragStart(e, item.id);
                    itemEl.ondragend = (e) => onItemDragEnd(e);
                    itemEl.ondragover = (e) => onItemDragOver(e, item.id);
                    itemEl.ondragleave = (e) => onItemDragLeave(e);
                    itemEl.ondrop = (e) => onItemDrop(e, item.id);

                    itemEl.innerHTML = 
                        '<span class="drag-handle" title="Drag to reorder or move">⋮⋮</span>' +
                        '<span class="method m-' + item.method + '">' + item.method + '</span>' +
                        '<div class="info">' +
                            '<span class="name">' + item.name + '</span>' +
                            '<span class="url">' + item.url + '</span>' +
                        '</div>' +
                        '<div class="actions">' +
                            '<button class="icon-btn" title="Edit Request" onclick="openEditRequestModal(\\'' + item.id + '\\', event)">Edit</button>' +
                            '<button class="icon-btn danger" title="Delete Request" onclick="deleteSaved(\\'' + item.id + '\\', event)">✕</button>' +
                        '</div>';

                    itemEl.onclick = (e) => {
                        if (e.target.closest('.actions') || e.target.closest('.drag-handle')) return;
                        loadFromItem(item);
                    };
                    bodyEl.appendChild(itemEl);
                });

                folderEl.appendChild(headerEl);
                folderEl.appendChild(bodyEl);
                container.appendChild(folderEl);
            });
        }

        // Message Listener
        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'response') {
                lastResponse = message;
                const tab = getActiveTab();
                if (tab) {
                    tab.lastResponse = message;
                }
                sendBtn.textContent = 'SEND';
                sendBtn.disabled = false;
                loader.style.width = '0';
                setTimeout(() => { loader.style.display = 'none'; }, 300);

                const statusVal = document.getElementById('status-val');
                statusVal.textContent = message.status + ' ' + (message.statusText || '');
                statusVal.className = (typeof message.status === 'number' && message.status >= 200 && message.status < 300) 
                    ? 'status-txt' 
                    : 'status-err';
                
                document.getElementById('time-val').textContent = message.time + 'ms';
                document.getElementById('v-control').style.display = 'flex';
                
                renderResponse();
                if (message.history) {
                    updateHistoryList(message.history);
                }
            } else if (message.command === 'historyData') {
                updateHistoryList(message.history);
            } else if (message.command === 'savedRequestsData') {
                updateSavedList(message.saved);
            } else if (message.command === 'loadRequest') {
                loadFromItem(message.request);
            } else if (message.command === 'importSuccess') {
                document.getElementById('import-loading-modal').style.display = 'none';
                showSuccess('Successfully imported ' + message.count + ' request(s)!');
            } else if (message.command === 'importCancelled') {
                document.getElementById('import-loading-modal').style.display = 'none';
            } else if (message.command === 'importError') {
                document.getElementById('import-loading-modal').style.display = 'none';
                showAlert('Import failed: ' + (message.error || 'Unknown error'));
            }
        });

        // Initialize tabs on startup
        renderRequestTabs();
    </script>
</body>
</html>`;
}


