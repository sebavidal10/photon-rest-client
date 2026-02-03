import * as vscode from 'vscode';
import axios from 'axios';

let activePanel: vscode.WebviewPanel | undefined = undefined;

interface SavedRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  auth: any;
  timestamp: string;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('photon.open', () => {
      openWebview(context);
    }),
  );
}

function openWebview(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (activePanel) {
    activePanel.reveal(vscode.ViewColumn.Beside);
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

  panel.webview.html = getWebviewContent(context);

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
        if (history.length > 20) {
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
        let errorStatus = 'Error';
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
      const newSaved: SavedRequest = {
        id: Date.now().toString(),
        name: message.name,
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
      vscode.window.showInformationMessage(`Request "${message.name}" saved!`);
    } else if (message.command === 'getSavedRequests') {
      const saved = context.globalState.get('savedRequests') || [];
      panel.webview.postMessage({ command: 'savedRequestsData', saved: saved });
    } else if (message.command === 'deleteSavedRequest') {
      let saved: SavedRequest[] =
        context.globalState.get('savedRequests') || [];
      saved = saved.filter((r) => r.id !== message.id);
      await context.globalState.update('savedRequests', saved);
      panel.webview.postMessage({ command: 'savedRequestsData', saved: saved });
    } else if (message.command === 'exportSaved') {
      const saved: SavedRequest[] =
        context.globalState.get('savedRequests') || [];
      const postmanCollection = {
        info: {
          name: 'Photon Export ' + new Date().toLocaleDateString(),
          schema:
            'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: saved.map((req) => {
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
          const importedItems = data.item || [];

          const currentSaved: SavedRequest[] =
            context.globalState.get('savedRequests') || [];

          importedItems.forEach((item: any) => {
            if (item.request) {
              currentSaved.push({
                id: Date.now().toString() + Math.random(),
                name: item.name || 'Imported Request',
                method: item.request.method || 'GET',
                url:
                  typeof item.request.url === 'string'
                    ? item.request.url
                    : item.request.url?.raw || '',
                headers: JSON.stringify(
                  (item.request.header || []).reduce(
                    (acc: any, h: any) => ({ ...acc, [h.key]: h.value }),
                    {},
                  ),
                  null,
                  2,
                ),
                body: item.request.body?.raw || '',
                auth: { type: 'none' },
                timestamp: new Date().toLocaleDateString(),
              });
            }
          });

          await context.globalState.update('savedRequests', currentSaved);
          panel.webview.postMessage({
            command: 'savedRequestsData',
            saved: currentSaved,
          });
          vscode.window.showInformationMessage(
            `Imported ${importedItems.length} requests!`,
          );
        } catch (e) {
          vscode.window.showErrorMessage('Failed to parse import file.');
        }
      }
    }
  });

  return panel;
}

function getWebviewContent(context: vscode.ExtensionContext) {
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
            --border: #1a1a1a;
            --accent: #00f2ff;
            --error: #ff0055;
            --success: #00ffaa;
            --text: #e0e0e0;
            --text-dim: #808080;
            --neon-pink: #ff00ff;
        }

        body {
            background-color: var(--bg);
            color: var(--text);
            font-family: 'Inter', -apple-system, system-ui, sans-serif;
            margin: 0;
            padding: 12px;
            display: flex;
            flex-direction: column;
            height: 100vh;
            box-sizing: border-box;
            font-size: 13px;
        }

        .minimal-input-group {
            display: flex;
            gap: 4px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 4px;
            margin-bottom: 12px;
        }

        select, input {
            background: transparent;
            color: var(--text);
            border: none;
            outline: none;
            font-family: inherit;
            font-size: 13px;
            padding: 4px 8px;
        }

        select#method { 
            width: 100px; 
            font-weight: 800; 
            cursor: pointer;
            border-right: 1px solid var(--border);
            transition: all 0.2s;
        }

        .m-GET { color: var(--accent) !important; text-shadow: 0 0 5px var(--accent); }
        .m-POST { color: var(--success) !important; text-shadow: 0 0 5px var(--success); }
        .m-PUT { color: #ffcc00 !important; text-shadow: 0 0 5px #ffcc00; }
        .m-PATCH { color: #ff8800 !important; text-shadow: 0 0 5px #ff8800; }
        .m-DELETE { color: var(--neon-pink) !important; text-shadow: 0 0 5px var(--neon-pink); }

        input.url { flex: 1; font-family: monospace; }

        button.action-btn {
            background: transparent;
            color: var(--text-dim);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 0 12px;
            font-weight: 700;
            font-size: 10px;
            cursor: pointer;
            transition: all 0.2s;
            margin-left: 4px;
        }
        button.action-btn:hover {
            color: var(--text);
            border-color: var(--text);
        }

        button.send-btn {
            background: transparent;
            color: var(--accent);
            border: 1px solid var(--accent);
            border-radius: 6px;
            padding: 0 16px;
            font-weight: 800;
            text-transform: uppercase;
            font-size: 10px;
            letter-spacing: 0.1em;
            cursor: pointer;
            transition: all 0.2s;
        }

        button.send-btn:hover, button.send-btn:active {
            background: var(--accent);
            color: var(--bg);
            box-shadow: 0 0 12px var(--accent);
        }

        .tabs {
            display: flex;
            gap: 20px;
            margin-bottom: 8px;
        }

        .tab {
            font-size: 10px;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            color: var(--text-dim);
            cursor: pointer;
            padding-bottom: 4px;
            border-bottom: 2px solid transparent;
            transition: 0.2s;
        }

        .tab.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
        }

        .tab-content { display: none; height: 15vh; }
        .tab-content.active { display: flex; flex-direction: column; }

        textarea {
            width: 100%;
            flex: 1;
            background: var(--surface);
            color: var(--text);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px;
            font-family: monospace;
            font-size: 12px;
            resize: none;
            outline: none;
        }

        .beautify-bar {
            display: flex;
            justify-content: flex-end;
            margin-top: 4px;
        }

        .sec-btn {
            font-size: 9px;
            background: transparent;
            color: var(--text-dim);
            border: 1px solid var(--border);
            padding: 2px 8px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .sec-btn:hover { color: var(--text); border-color: var(--text); }

        .response-meta {
            margin-top: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-top: 1px solid var(--border);
        }

        .status-info { display: flex; align-items: center; gap: 12px; font-size: 11px; font-weight: 800; }
        .status-txt { color: var(--success); }
        .status-err { color: var(--error); }
        .time-txt { color: var(--text-dim); font-family: monospace; }
        .line-txt { color: var(--text-dim); font-family: monospace; border-left: 1px solid var(--border); padding-left: 12px; }

        .view-btns { display: flex; gap: 8px; }
        .v-btn {
            font-size: 9px;
            color: var(--text-dim);
            cursor: pointer;
            font-weight: 800;
            text-transform: uppercase;
        }
        .v-btn.active { color: var(--accent); }

        .response-viewport {
            flex: 1;
            overflow: auto;
            border-top: 1px solid var(--border);
            padding-top: 8px;
        }

        pre {
            margin: 0;
            font-family: monospace;
            font-size: 12px;
            line-height: 1.4;
            color: #dcdcdc;
            white-space: pre-wrap;
        }

        .list-container {
            overflow: auto;
            display: flex;
            flex-direction: column;
            gap: 4px;
            flex: 1;
        }
        .list-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 8px 10px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 6px;
            cursor: pointer;
            transition: 0.2s;
            position: relative;
        }
        .list-item:hover { border-color: var(--accent); }
        .list-item .method { font-size: 9px; font-weight: 800; color: var(--accent); width: 45px; }
        .list-item .info { flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 2px;}
        .list-item .name { font-size: 12px; font-weight: 600; color: var(--text); }
        .list-item .url { font-size: 10px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .list-item .meta { font-size: 9px; color: var(--text-dim); }
        .list-item .actions { display: none; margin-left: auto; gap: 8px;}
        .list-item:hover .actions { display: flex; }
        
        .icon-btn { 
            background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 12px; padding: 2px;
        }
        .icon-btn:hover { color: var(--error); }

        .loader {
            display: none;
            height: 1px;
            background: var(--accent);
            box-shadow: 0 0 8px var(--accent);
            width: 0;
            transition: width 0.3s;
            margin-bottom: 8px;
        }

        /* JSON Syntax Highlighting & Collapsible */
        .string { color: var(--success); }
        .number { color: var(--neon-pink); }
        .boolean { color: var(--neon-pink); }
        .null { color: var(--neon-pink); }
        .key { color: var(--accent); }
        
        .json-tree { font-family: monospace; font-size: 13px; line-height: 1.5; }
        .collapsible { cursor: pointer; user-select: none; display: inline-flex; align-items: center; }
        .collapsible::before { 
            content: '▼'; 
            display: inline-block; 
            font-size: 8px; 
            margin-right: 4px; 
            color: var(--text-dim); 
            transition: transform 0.2s; 
            vertical-align: middle;
        }
        .collapsible.collapsed::before { transform: rotate(-90deg); }
        .collapsible.collapsed + .json-content { display: none; }
        .collapsible.collapsed::after { content: '...'; color: var(--text-dim); margin-left: 2px; font-size: 10px; }
        
        .json-content { margin-left: 18px; border-left: 1px solid rgba(255,255,255,0.05); padding-left: 4px; }
        .json-item { display: flex; }
        .json-val { margin-left: 4px; }
        .bracket { color: #dcdcdc; }

        /* Modal */

        /* Modal */
        .modal-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.8);
            display: none; justify-content: center; align-items: center;
            z-index: 100;
            backdrop-filter: blur(2px);
        }
        .modal {
            background: var(--surface);
            border: 1px solid var(--border);
            padding: 24px;
            border-radius: 12px;
            width: 300px;
            display: flex; flex-direction: column; gap: 16px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }
        .modal h3 { margin: 0; font-size: 14px; color: var(--text); }
        .modal input { 
            border: 1px solid var(--border); 
            background: var(--bg);
            padding: 8px; border-radius: 6px;
        }
        .modal input:focus { border-color: var(--accent); }
        .modal-btns { display: flex; justify-content: flex-end; gap: 8px; }
    </style>
</head>
<body>
    <div class="minimal-input-group">
        <select id="method">
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
        </select>
        <input type="text" id="url" class="url" placeholder="https://api.endpoint.com">
        <button class="action-btn" onclick="openSaveModal()">SAVE</button>
        <button id="send" class="send-btn">SEND</button>
    </div>

    <div class="loader" id="loader"></div>

    <div class="tabs">
        <div class="tab active" data-tab="headers">Headers</div>
        <div class="tab" data-tab="body">Body</div>
        <div class="tab" data-tab="auth">Auth</div>
        <div class="tab" data-tab="saved" onclick="loadSaved()">Saved</div>
        <div class="tab" data-tab="history" onclick="requestHistory()">History</div>
    </div>

    <div id="headers" class="tab-content active">
        <textarea id="headers-input" placeholder='{ "Content-Type": "application/json" }'></textarea>
    </div>

    <div id="body" class="tab-content">
        <textarea id="body-input" placeholder='{ "id": 1 }'></textarea>
        <div class="beautify-bar">
            <button class="sec-btn" onclick="beautifyBody()">Format JSON</button>
        </div>
    </div>

    <div id="auth" class="tab-content">
        <select id="auth-type" style="width: 100%; background: var(--surface); border: 1px solid var(--border); margin-bottom: 8px;">
            <option value="none">NO AUTH</option>
            <option value="bearer">BEARER TOKEN</option>
            <option value="basic">BASIC AUTH</option>
        </select>
        <div id="auth-bearer" style="display: none;">
            <input type="text" id="token" placeholder="Bearer Token" style="width: 100%; border-bottom: 1px solid var(--border);">
        </div>
        <div id="auth-basic" style="display: none; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <input type="text" id="username" placeholder="User" style="border-bottom: 1px solid var(--border);">
            <input type="password" id="password" placeholder="Pass" style="border-bottom: 1px solid var(--border);">
        </div>
    </div>

    <div id="saved" class="tab-content">
        <div class="list-container" id="saved-container"></div>
        <div class="beautify-bar">
            <button class="sec-btn" onclick="importSaved()">Import</button>
            <button class="sec-btn" onclick="exportSaved()">Export</button>
        </div>
    </div>

    <div id="history" class="tab-content">
        <div class="list-container" id="history-container"></div>
        <div class="beautify-bar">
            <button class="sec-btn" onclick="clearHistory()">Clear History</button>
        </div>
    </div>

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
        <pre id="response-content">Ready.</pre>
    </div>

    <!-- SAVE MODAL -->
    <div class="modal-overlay" id="save-modal">
        <div class="modal">
            <h3>Save Request</h3>
            <input type="text" id="req-name" placeholder="Request Name (e.g., Get Users)">
            <div class="modal-btns">
                <button class="sec-btn" onclick="closeSaveModal()">Cancel</button>
                <button class="send-btn" onclick="confirmSave()">SAVE</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let lastResponse = null;
        let currentView = 'pretty';

        const methodEl = document.getElementById('method');

        function updateMethodColor() {
            const method = methodEl.value;
            methodEl.className = 'm-' + method;
        }

        methodEl.addEventListener('change', updateMethodColor);
        updateMethodColor();

        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab).classList.add('active');
            });
        });

        document.getElementById('auth-type').addEventListener('change', (e) => {
            document.getElementById('auth-bearer').style.display = e.target.value === 'bearer' ? 'block' : 'none';
            document.getElementById('auth-basic').style.display = e.target.value === 'basic' ? 'grid' : 'none';
        });

        document.querySelectorAll('.v-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.v-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentView = btn.dataset.view;
                renderResponse();
            });
        });

        function beautifyBody() {
            const el = document.getElementById('body-input');
            try {
                const obj = JSON.parse(el.value);
                el.value = JSON.stringify(obj, null, 2);
            } catch (e) {}
        }

        function requestHistory() {
            vscode.postMessage({ command: 'loadHistory' });
        }

        function clearHistory() {
            vscode.postMessage({ command: 'clearHistory' });
        }

        function loadSaved() {
            vscode.postMessage({ command: 'getSavedRequests' });
        }

        function exportSaved() {
            vscode.postMessage({ command: 'exportSaved' });
        }

        function importSaved() {
            vscode.postMessage({ command: 'importSaved' });
        }

        // Save Modal
        function openSaveModal() {
            document.getElementById('save-modal').style.display = 'flex';
            document.getElementById('req-name').focus();
        }

        function closeSaveModal() {
            document.getElementById('save-modal').style.display = 'none';
            document.getElementById('req-name').value = '';
        }

        function confirmSave() {
            const name = document.getElementById('req-name').value;
            if(!name) return;

            const req = {
                method: document.getElementById('method').value,
                url: document.getElementById('url').value,
                headers: document.getElementById('headers-input').value,
                body: document.getElementById('body-input').value,
                auth: {
                    type: document.getElementById('auth-type').value,
                    token: document.getElementById('token').value,
                    username: document.getElementById('username').value,
                    password: document.getElementById('password').value
                }
            };
            
            vscode.postMessage({ command: 'saveRequest', name, req });
            closeSaveModal();
        }

        function deleteSaved(id, event) {
            event.stopPropagation();
            if(confirm('Delete this saved request?')) {
                vscode.postMessage({ command: 'deleteSavedRequest', id });
            }
        }

        const sendBtn = document.getElementById('send');
        const loader = document.getElementById('loader');

        sendBtn.addEventListener('click', () => {
            const url = document.getElementById('url').value;
            if(!url) return; 

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
                    dataStr = lastResponse.data;
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
            document.getElementById('method').value = item.method;
            updateMethodColor();
            document.getElementById('url').value = item.url;
            document.getElementById('headers-input').value = item.headers || '';
            document.getElementById('body-input').value = item.body || '';
            
            const auth = item.auth || { type: 'none' };
            document.getElementById('auth-type').value = auth.type;
            document.getElementById('token').value = auth.token || '';
            document.getElementById('username').value = auth.username || '';
            document.getElementById('password').value = auth.password || '';
            
            document.getElementById('auth-type').dispatchEvent(new Event('change'));
            document.querySelector('.tab[data-tab="headers"]').click();
        }

        function updateHistoryList(history) {
            const container = document.getElementById('history-container');
            if(!container) return;
            container.innerHTML = '';
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

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'response') {
                lastResponse = message;
                sendBtn.textContent = 'SEND';
                sendBtn.disabled = false;
                loader.style.width = '0';
                setTimeout(() => { loader.style.display = 'none'; }, 300);

                const statusVal = document.getElementById('status-val');
                statusVal.textContent = message.status;
                statusVal.className = (message.status >= 200 && message.status < 300) ? 'status-txt' : 'status-err';
                
                document.getElementById('time-val').textContent = message.time + 'ms';
                document.getElementById('v-control').style.display = 'flex';
                
                renderResponse();
                if (message.history) {
                    updateHistoryList(message.history);
                }
            } else if (message.command === 'historyData') {
                updateHistoryList(message.history);
            }
 else if (message.command === 'savedRequestsData') {
                const container = document.getElementById('saved-container');
                container.innerHTML = '';
                message.saved.forEach(item => {
                    const el = document.createElement('div');
                    el.className = 'list-item';
                    el.innerHTML = 
                        '<span class="method m-' + item.method + '">' + item.method + '</span>' +
                        '<div class="info">' +
                            '<span class="name">' + item.name + '</span>' +
                            '<span class="url">' + item.url + '</span>' +
                        '</div>' +
                        '<div class="actions">' +
                            '<button class="icon-btn" onclick="deleteSaved(\\'' + item.id + '\\', event)">✕</button>' +
                        '</div>';
                    el.onclick = () => loadFromItem(item);
                    container.appendChild(el);
                });
            }
        });
    </script>
</body>
</html>`;
}
